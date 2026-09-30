import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createGuiServer } from '../../src/gui/server.ts';
import { fixtureServices } from '../tui/fixtures.ts';
import { CONFIG_DEFAULTS, validateConfig } from '../../src/core/config.ts';

const token = 'b'.repeat(64);

test('GUI HTTP enforces Host, auth, and mutation Origin while serving safe static assets', async () => {
  const server = await createGuiServer({ port: 0, instanceId: 'instance-test', authToken: token, services: fixtureServices(), clientGraceMs: 60_000 });
  try {
    const page = await fetch(server.origin, { headers: { Host: `127.0.0.1:${server.port}` } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Maintenance/);
    const application = await fetch(`${server.origin}/app.js`);
    assert.match(await application.text(), /history\.replaceState/);
    const wrongHost = await rawGet(server.port, '/api/health', { Host: `localhost:${server.port}`, 'X-Auth-Token': token, 'X-Instance-Id': 'instance-test' });
    assert.equal(wrongHost.status, 421);
    const unauthenticated = await fetch(`${server.origin}/api/health`, { headers: { 'X-Instance-Id': 'instance-test' } });
    assert.equal(unauthenticated.status, 401);
    const foreign = await fetch(`${server.origin}/api/health`, { headers: { Origin: 'http://localhost', 'X-Auth-Token': token, 'X-Instance-Id': 'instance-test' } });
    assert.equal(foreign.status, 403);
    const health = await fetch(`${server.origin}/api/health`, { headers: { 'X-Auth-Token': token, 'X-Instance-Id': 'instance-test' } });
    assert.deepEqual(await health.json(), { instanceId: 'instance-test', healthy: true });
    const forbiddenMutation = await fetch(`${server.origin}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token }, body: '{}' });
    assert.equal(forbiddenMutation.status, 403);
    const oversizedBody = 'x'.repeat(70_000);
    const tooLarge = await fetch(`${server.origin}/api/actions`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', 'X-Auth-Token': token, 'Content-Length': String(oversizedBody.length) }, body: oversizedBody });
    assert.equal(tooLarge.status, 413);
  } finally { await server.shutdown(); }
});

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      response.resume(); response.once('end', () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once('error', reject); request.end();
  });
}

test('GUI WebSocket sends no authenticated message before token proof and then handles heartbeat', async () => {
  const server = await createGuiServer({ port: 0, instanceId: 'instance-ws', authToken: token, services: fixtureServices(), clientGraceMs: 60_000 });
  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.origin });
    await once(socket, 'open');
    let preauthData = false;
    const observeUnauthenticatedData = () => { preauthData = true; };
    socket.on('message', observeUnauthenticatedData);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(preauthData, false, 'server sends no application data before in-band authentication');
    socket.off('message', observeUnauthenticatedData);
    const early = new Promise<string>((resolve) => socket!.once('message', (data) => resolve(data.toString())));
    socket.send(JSON.stringify({ type: 'AUTH', token }));
    assert.deepEqual(JSON.parse(await early), { type: 'AUTH_OK', instanceId: 'instance-ws' });
    const pong = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'PING' }));
    assert.deepEqual(JSON.parse((await pong)[0].toString()), { type: 'PONG' });
    assert.equal(server.activeClients(), 1);
  } finally { socket?.close(); await server.shutdown(); }
});

test('GUI WebSocket bounds unauthenticated clients and closes peers that miss the auth deadline', async () => {
  const server = await createGuiServer({ port: 0, instanceId: 'instance-preauth', authToken: token, services: fixtureServices(),
    clientGraceMs: 60_000, authTimeoutMs: 80, maxPreauthSockets: 1 });
  let first: WebSocket | undefined; let second: WebSocket | undefined; let foreign: WebSocket | undefined;
  try {
    first = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.origin });
    await once(first, 'open');
    await new Promise((resolve) => setTimeout(resolve, 10));
    second = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: server.origin });
    const overloadStatus = new Promise<number>((resolve, reject) => {
      second!.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
      second!.once('open', () => reject(new Error('Unauthenticated socket limit was not enforced')));
      second!.once('error', () => undefined);
    });
    assert.equal(await overloadStatus, 503);
    const closed = once(first, 'close');
    assert.equal((await closed)[0], 4401);

    foreign = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin: 'http://localhost' });
    const denied = new Promise<number>((resolve, reject) => {
      foreign!.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
      foreign!.once('open', () => reject(new Error('Foreign-origin WebSocket was accepted')));
      foreign!.once('error', () => undefined);
    });
    assert.equal(await denied, 403);
  } finally { first?.close(); second?.close(); foreign?.close(); await server.shutdown(); }
});

test('GUI server enforces authenticated-client heartbeat and zero-client grace shutdown', async () => {
  const heartbeatServer = await createGuiServer({ port: 0, instanceId: 'instance-heartbeat', authToken: token, services: fixtureServices(), heartbeatMs: 25, clientGraceMs: 60_000 });
  const socket = new WebSocket(`ws://127.0.0.1:${heartbeatServer.port}/ws`, { origin: heartbeatServer.origin });
  await once(socket, 'open'); socket.send(JSON.stringify({ type: 'AUTH', token }));
  const closeEvent = once(socket, 'close');
  assert.equal((await closeEvent)[0], 4408);
  await heartbeatServer.shutdown();

  let stopped = false;
  const server = await createGuiServer({ port: 0, instanceId: 'instance-grace', authToken: token, services: fixtureServices(), clientGraceMs: 20,
    onShutdown: async () => { stopped = true; } });
  const deadline = Date.now() + 1000;
  while (!stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, true, 'a server with no authenticated clients shuts down after its grace interval');
  assert.equal(server.activeClients(), 0);
});

test('GUI shutdown waits for a transaction already in flight and then rejects new work', async () => {
  let release!: (value: { ok: boolean; message: string }) => void;
  let started!: () => void;
  const workStarted = new Promise<void>((resolve) => { started = resolve; });
  const action = new Promise<{ ok: boolean; message: string }>((resolve) => { release = resolve; });
  const settings = { load: async () => validateConfig(CONFIG_DEFAULTS), save: async () => { started(); await action; } };
  const services = fixtureServices({ settings });
  let shutdownFinished = false;
  const server = await createGuiServer({ port: 0, instanceId: 'instance-close', authToken: token, services, clientGraceMs: 60_000,
    onShutdown: async () => { shutdownFinished = true; } });
  const mutation = fetch(`${server.origin}/api/actions`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', 'X-Auth-Token': token },
    body: JSON.stringify({ kind: 'settings-save', settings: CONFIG_DEFAULTS }) });
  await workStarted;
  const closing = server.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(shutdownFinished, false);
  const rejected = await fetch(`${server.origin}/api/snapshot`, { headers: { 'X-Auth-Token': token } });
  assert.equal(rejected.status, 503);
  release({ ok: true, message: 'transaction completed' });
  assert.equal((await mutation).status, 200);
  await closing;
  assert.equal(shutdownFinished, true);
});
