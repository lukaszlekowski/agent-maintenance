import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const GUI_HOST = '127.0.0.1';
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
export const MAX_WS_MESSAGE_BYTES = 4096;
export const MAX_PREAUTH_SOCKETS = 16;
export const WS_AUTH_TIMEOUT_MS = 1000;

export type RequestClass = 'static' | 'api-read' | 'api-mutation' | 'websocket';
export interface SecurityResult { readonly allowed: boolean; readonly status: number; readonly reason: string }

export function canonicalOrigin(port: number): string { return `http://${GUI_HOST}:${port}`; }

export function validateRequestOriginAndHost(request: IncomingMessage, port: number, requestClass: RequestClass): SecurityResult {
  const expectedHost = `${GUI_HOST}:${port}`;
  if (request.headers.host !== expectedHost) return deny(421, 'Host must exactly match the bound loopback address and port');
  const origin = request.headers.origin;
  if (requestClass === 'static') {
    if (origin !== undefined && origin !== canonicalOrigin(port)) return deny(403, 'Foreign Origin is not allowed');
    return allow();
  }
  if (requestClass === 'api-read') {
    if (origin !== undefined && origin !== canonicalOrigin(port)) return deny(403, 'Foreign Origin is not allowed');
    return allow();
  }
  if (origin !== canonicalOrigin(port)) return deny(403, 'This operation requires the exact GUI Origin');
  return allow();
}

export function hasValidAuth(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers['x-auth-token'];
  return typeof supplied === 'string' && constantTimeTokenEqual(supplied, token);
}

export function constantTimeTokenEqual(candidate: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(candidate) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const left = Buffer.from(candidate, 'hex'); const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateWebSocketUpgrade(request: IncomingMessage, port: number): SecurityResult {
  return validateRequestOriginAndHost(request, port, 'websocket');
}

function allow(): SecurityResult { return Object.freeze({ allowed: true, status: 200, reason: '' }); }
function deny(status: number, reason: string): SecurityResult { return Object.freeze({ allowed: false, status, reason }); }
