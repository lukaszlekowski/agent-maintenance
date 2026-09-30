import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constantTimeTokenEqual, validateRequestOriginAndHost } from '../../src/gui/security.ts';

function request(headers: Record<string, string | undefined>) {
  return { headers } as import('node:http').IncomingMessage;
}

test('GUI security requires the exact IPv4 loopback Host and rejects foreign Origins', () => {
  const port = 4567;
  assert.equal(validateRequestOriginAndHost(request({ host: `127.0.0.1:${port}` }), port, 'static').allowed, true);
  for (const host of [`localhost:${port}`, `127.0.0.2:${port}`, `[::1]:${port}`, `127.0.0.1:${port}.`]) {
    assert.equal(validateRequestOriginAndHost(request({ host }), port, 'static').allowed, false, host);
  }
  assert.equal(validateRequestOriginAndHost(request({ host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` }), port, 'static').status, 403);
  assert.equal(validateRequestOriginAndHost(request({ host: `127.0.0.1:${port}` }), port, 'api-mutation').status, 403);
  assert.equal(validateRequestOriginAndHost(request({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }), port, 'api-mutation').allowed, true);
});

test('GUI tokens require canonical 256-bit hex and compare equal without prefix acceptance', () => {
  const token = 'a'.repeat(64);
  assert.equal(constantTimeTokenEqual(token, token), true);
  assert.equal(constantTimeTokenEqual(`${token}00`, token), false);
  assert.equal(constantTimeTokenEqual('A'.repeat(64), token), false);
  assert.equal(constantTimeTokenEqual('a'.repeat(63), token), false);
});
