import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { TuiServices } from '../tui/contracts.ts';
import { createGuiApi, parseGuiCommand } from './api.ts';
import { canonicalOrigin, constantTimeTokenEqual, hasValidAuth, MAX_HTTP_BODY_BYTES, MAX_PREAUTH_SOCKETS, MAX_WS_MESSAGE_BYTES, validateRequestOriginAndHost, validateWebSocketUpgrade, WS_AUTH_TIMEOUT_MS } from './security.ts';

export interface GuiServerOptions {
  readonly port: number;
  readonly instanceId: string;
  readonly authToken: string;
  readonly services: TuiServices;
  readonly heartbeatMs?: number;
  readonly clientGraceMs?: number;
  readonly authTimeoutMs?: number;
  readonly maxPreauthSockets?: number;
  readonly onShutdown?: () => Promise<void>;
}

export interface GuiServerHandle {
  readonly port: number;
  readonly origin: string;
  readonly url: string;
  readonly activeClients: () => number;
  readonly activeMutations: () => number;
  shutdown(): Promise<void>;
}

type JsonValue = Record<string, unknown>;
const ASSETS: Readonly<Record<string, string>> = Object.freeze({ '/': 'index.html', '/index.html': 'index.html', '/app.css': 'app.css', '/app.js': 'app.js' });

export async function createGuiServer(options: GuiServerOptions): Promise<GuiServerHandle> {
  let port = options.port; const api = createGuiApi(options.services);
  const httpServer = createServer((request, response) => { void handleHttp(request, response); });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES, perMessageDeflate: false, clientTracking: false });
  const preauth = new Set<WebSocket>(); const clients = new Map<WebSocket, number>();
  const heartbeatMs = options.heartbeatMs ?? 5000; const graceMs = options.clientGraceMs ?? 60_000;
  const authTimeoutMs = options.authTimeoutMs ?? WS_AUTH_TIMEOUT_MS;
  const maxPreauthSockets = options.maxPreauthSockets ?? MAX_PREAUTH_SOCKETS;
  let activeMutations = 0; let shutdownPending = false; let closePromise: Promise<void> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const shutdownWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const startZeroClientGrace = () => {
    if (graceTimer || closePromise || clients.size > 0) return;
    graceTimer = setTimeout(() => { graceTimer = undefined; void requestShutdown(); }, graceMs);
    graceTimer.unref?.();
  };

  httpServer.on('upgrade', (request, socket, head) => {
    const policy = validateWebSocketUpgrade(request, port);
    if (!policy.allowed || request.url !== '/ws') { rejectUpgrade(socket, policy.allowed ? 404 : policy.status, policy.reason || 'Unknown WebSocket path'); return; }
    if (preauth.size >= maxPreauthSockets) { rejectUpgrade(socket, 503, 'Too many unauthenticated clients'); return; }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit('connection', websocket, request));
  });

  websocketServer.on('connection', (websocket) => {
    preauth.add(websocket);
    const authTimer = setTimeout(() => websocket.close(4401, 'Authentication timeout'), authTimeoutMs);
    authTimer.unref?.();
    websocket.on('message', (raw, binary) => {
      const text = binary ? '' : raw.toString();
      if (preauth.has(websocket)) {
        let message: unknown;
        try { message = JSON.parse(text); } catch { websocket.close(4401, 'Authentication required'); return; }
        if (!isRecord(message) || message.type !== 'AUTH' || typeof message.token !== 'string' || !constantTimeTokenEqual(message.token, options.authToken)) {
          websocket.close(4401, 'Authentication required'); return;
        }
        preauth.delete(websocket); clearTimeout(authTimer); clients.set(websocket, Date.now());
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = undefined; }
        websocket.send(JSON.stringify({ type: 'AUTH_OK', instanceId: options.instanceId }));
        return;
      }
      if (!clients.has(websocket)) return;
      let message: unknown;
      try { message = JSON.parse(text); } catch { websocket.close(4400, 'Invalid message'); return; }
      if (isRecord(message) && message.type === 'PING' && Object.keys(message).length === 1) {
        clients.set(websocket, Date.now()); websocket.send(JSON.stringify({ type: 'PONG' }));
      } else websocket.close(4400, 'Unsupported WebSocket message');
    });
    websocket.on('close', () => { clearTimeout(authTimer); preauth.delete(websocket); clients.delete(websocket); startZeroClientGrace(); });
    websocket.on('error', () => { clearTimeout(authTimer); preauth.delete(websocket); clients.delete(websocket); });
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [client, lastSeen] of clients) if (now - lastSeen > heartbeatMs * 3) client.close(4408, 'Heartbeat expired');
    if (clients.size === 0) startZeroClientGrace();
  }, heartbeatMs);
  heartbeatTimer.unref?.();
  httpServer.on('close', () => { clearInterval(heartbeatTimer); if (graceTimer) clearTimeout(graceTimer); });
  port = await listen(httpServer, options.port);
  const origin = canonicalOrigin(port);
  startZeroClientGrace();

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (shutdownPending) { sendJson(response, 503, { error: 'Server is shutting down' }); return; }
    const hostCheck = validateRequestOriginAndHost(request, port, 'api-read');
    if (!hostCheck.allowed) { sendJson(response, hostCheck.status, { error: hostCheck.reason }); return; }
    const pathname = safePathname(request.url);
    if (!pathname) { sendJson(response, 400, { error: 'Malformed request target' }); return; }
    const asset = ASSETS[pathname];
    if (asset) {
      const allowed = validateRequestOriginAndHost(request, port, 'static');
      if (!allowed.allowed) { sendJson(response, allowed.status, { error: allowed.reason }); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { sendJson(response, 405, { error: 'Static assets are read-only' }); return; }
      await serveAsset(asset, request.method === 'HEAD', response, port); return;
    }
    const mutation = request.method === 'POST' && pathname === '/api/actions';
    const health = request.method === 'GET' && pathname === '/api/health';
    const snapshot = request.method === 'GET' && pathname === '/api/snapshot';
    const settings = request.method === 'GET' && pathname === '/api/settings';
    if (!mutation && !health && !snapshot && !settings) { sendJson(response, 404, { error: 'Not found' }); return; }
    const allowed = validateRequestOriginAndHost(request, port, mutation ? 'api-mutation' : 'api-read');
    if (!allowed.allowed) { sendJson(response, allowed.status, { error: allowed.reason }); return; }
    if (!hasValidAuth(request, options.authToken)) { sendJson(response, 401, { error: 'Authentication required' }); return; }
    if (health) {
      if (request.headers['x-instance-id'] !== options.instanceId) { sendJson(response, 404, { error: 'Instance mismatch' }); return; }
      sendJson(response, 200, { instanceId: options.instanceId, healthy: true }); return;
    }
    if (snapshot) { try { sendJson(response, 200, await api.snapshot()); } catch { sendJson(response, 503, { error: 'Inventory is unavailable' }); } return; }
    if (settings) { try { sendJson(response, 200, await api.loadSettings()); } catch { sendJson(response, 503, { error: 'Preferences are unavailable' }); } return; }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { sendJson(response, 415, { error: 'Application JSON is required' }); return; }
    activeMutations += 1;
    try {
      const body = await readBoundedJson(request);
      if (body === undefined) { sendJson(response, 400, { error: 'Invalid JSON request' }); return; }
      const command = parseGuiCommand(body);
      if (!command) { sendJson(response, 400, { error: 'Unsupported command shape' }); return; }
      sendJson(response, 200, await api.dispatch(command));
    } catch (error) {
      sendJson(response, error instanceof BodyTooLarge ? 413 : 400, { error: error instanceof BodyTooLarge ? 'Request body exceeds the size limit' : 'Request body could not be read' });
    } finally {
      activeMutations -= 1;
      if (shutdownPending && activeMutations === 0) void closeNow().then(() => settleShutdown(), (error: Error) => settleShutdown(error));
    }
  }

  function requestShutdown(): Promise<void> {
    if (closePromise) return closePromise;
    shutdownPending = true;
    if (activeMutations > 0) return new Promise<void>((resolve, reject) => shutdownWaiters.push({ resolve, reject }));
    return closeNow();
  }

  function settleShutdown(error?: Error): void {
    for (const waiter of shutdownWaiters.splice(0)) {
      if (error) waiter.reject(error); else waiter.resolve();
    }
  }

  function closeNow(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = new Promise<void>((resolve, reject) => {
      shutdownPending = true; clearInterval(heartbeatTimer); if (graceTimer) clearTimeout(graceTimer);
      for (const client of clients.keys()) client.close(1001, 'Server shutting down');
      for (const client of preauth) client.close(1001, 'Server shutting down');
      httpServer.close((error) => {
        if (error) { reject(error); return; }
        websocketServer.close((closeError) => {
          if (closeError) { reject(closeError); return; }
          const pending = new Set([...clients.keys(), ...preauth]);
          if (pending.size === 0) { finishShutdown(); return; }
          let finished = false;
          const finishSockets = () => {
            if (finished) return; finished = true; clearTimeout(socketTimer); finishShutdown();
          };
          const socketTimer = setTimeout(() => { for (const client of pending) client.terminate(); finishSockets(); }, 1000);
          socketTimer.unref?.();
          for (const client of pending) {
            const closed = () => { pending.delete(client); if (pending.size === 0) finishSockets(); };
            client.once('close', closed); client.once('error', closed);
          }
        });
        function finishShutdown(): void {
          if (options.onShutdown) void options.onShutdown().then(resolve, reject); else resolve();
        }
      });
    });
    return closePromise;
  }

  return Object.freeze({ port, origin, url: `${origin}/#token=${options.authToken}`, activeClients: () => clients.size,
    activeMutations: () => activeMutations, shutdown: requestShutdown });
}

async function serveAsset(name: string, head: boolean, response: ServerResponse, port: number): Promise<void> {
  const path = fileURLToPath(new URL(`./public/${name}`, import.meta.url));
  try {
    const content = await readFile(path);
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.byteLength, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; connect-src 'self' ws://127.0.0.1:${port}; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` });
    response.end(head ? undefined : content);
  } catch { sendJson(response, 404, { error: 'Public asset unavailable' }); }
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown | undefined> {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_HTTP_BODY_BYTES)) throw new BodyTooLarge();
  let size = 0; const chunks: Buffer[] = []; let exceeded = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length; if (size > MAX_HTTP_BODY_BYTES) { exceeded = true; continue; }
    chunks.push(buffer);
  }
  if (exceeded) throw new BodyTooLarge();
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue; } catch { return undefined; }
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => {
    server.off('error', reject); const address = server.address();
    if (!address || typeof address === 'string') { reject(new Error('GUI server did not bind a TCP port')); return; }
    resolve(address.port);
  }); });
}
function safePathname(target: string | undefined): string | null { try { return target ? new URL(target, 'http://127.0.0.1').pathname : null; } catch { return null; } }
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(data);
}
function rejectUpgrade(socket: import('node:stream').Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  const phrase = status === 421 ? 'Misdirected Request' : status === 403 ? 'Forbidden' : status === 503 ? 'Service Unavailable' : 'Not Found';
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  void reason;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
class BodyTooLarge extends Error {}
