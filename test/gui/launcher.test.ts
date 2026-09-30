import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launch, spawnPendingServer } from '../../src/gui/launcher.ts';
import { defaultRecordPath, readStoredRecord } from '../../src/gui/instance-record.ts';
import type { ChildServerConfig } from '../../src/gui/contracts.ts';
import { probeProcessIdentity } from '../../src/core/process.ts';

test('GUI launcher reuses only the same live authenticated instance and reconciles stale process identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-gui-'));
  let nextPid = 12001; let spawns = 0; let health = true; let stalePid: number | undefined; let reusedPid = false; let healthSwap = false; let healthProbeCount = 0;
  const opened: string[] = []; const configs: ChildServerConfig[] = [];
  const dependencies = {
    root, firstPort: 4567, portAttempts: 2,
    probeIdentity: (pid: number) => pid === stalePid ? (reusedPid ? { pid, startTime: 'different-process-start', command: 'unrelated-process' } : null)
      : pid === 12001 && healthSwap && ++healthProbeCount >= 2 ? { pid, startTime: 'replacement-process', command: 'unrelated-process' }
        : { pid, startTime: `start-${pid}`, command: 'fixture-gui-server' },
    healthChallenge: async () => health,
    spawnPendingServer: async () => {
      spawns += 1; const pid = nextPid++;
      return { pid, async start(config: ChildServerConfig) { configs.push(config); }, async stop() {} };
    },
    openBrowser: async (url: string) => { opened.push(url); },
  };
  try {
    assert.deepEqual(await launch(dependencies), { launched: true });
    const first = await readStoredRecord(defaultRecordPath(root));
    assert.ok(first);
    assert.equal(spawns, 1);
    assert.equal(configs[0]?.port, first.record.port);
    assert.match(opened[0] ?? '', new RegExp(`#token=${first.record.authToken}$`));

    assert.deepEqual(await launch(dependencies), { launched: true });
    assert.equal(spawns, 1, 'authenticated live server should be reused');
    assert.equal(opened.length, 2);

    healthSwap = true;
    assert.equal((await launch(dependencies)).launched, false, 'server PID identity is rechecked after health verification');
    healthSwap = false; healthProbeCount = 0;
    assert.equal(spawns, 1);

    health = false;
    assert.equal((await launch(dependencies)).launched, false);
    assert.equal(spawns, 1, 'unhealthy matching PID must not trigger a second server');
    assert.equal((await readStoredRecord(defaultRecordPath(root)))?.fingerprint, first.fingerprint, 'unhealthy record is preserved');

    health = true; stalePid = first.record.pid;
    assert.deepEqual(await launch(dependencies), { launched: true });
    assert.equal(spawns, 2, 'stale process identity permits replacement');
    const replacement = await readStoredRecord(defaultRecordPath(root));
    assert.ok(replacement);
    assert.notEqual(replacement.record.instanceId, first.record.instanceId);
    assert.equal(replacement.record.pid, 12002);

    stalePid = replacement.record.pid; reusedPid = true;
    assert.deepEqual(await launch(dependencies), { launched: true });
    assert.equal(spawns, 3, 'a reused PID with a different process-start identity is stale');
    assert.equal((await readStoredRecord(defaultRecordPath(root)))?.record.pid, 12003);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed GUI instance records are preserved and block unsafe replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-gui-malformed-'));
  const path = defaultRecordPath(root); const bytes = '{"version":1,"authToken":"partial"}\n';
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    const result = await launch({ root, spawnPendingServer: async () => { throw new Error('must not spawn'); }, openBrowser: async () => undefined });
    assert.equal(result.launched, false);
    assert.match(result.reason ?? '', /malformed|invalid fields/);
    assert.equal(await readFile(path, 'utf8'), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('GUI launcher retries the next loopback port after a bind collision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-gui-port-'));
  let pid = 14001; const attempted: number[] = [];
  try {
    const result = await launch({ root, firstPort: 4780, portAttempts: 2,
      probeIdentity: (value) => ({ pid: value, startTime: `start-${value}`, command: 'fixture-gui-server' }),
      spawnPendingServer: async () => {
        const childPid = pid++;
        return { pid: childPid, async start(config) { attempted.push(config.port); if (config.port === 4780) throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }); }, async stop() {} };
      }, openBrowser: async () => undefined,
    });
    assert.deepEqual(result, { launched: true });
    assert.deepEqual(attempted, [4780, 4781]);
    assert.equal((await readStoredRecord(defaultRecordPath(root)))?.record.port, 4781);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent GUI launches serialize publication and publish only one server identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-gui-race-'));
  let pid = 13001; let spawns = 0; let starts = 0;
  const dependencies = {
    root, firstPort: 4567, portAttempts: 1,
    probeIdentity: (value: number) => ({ pid: value, startTime: `start-${value}`, command: 'fixture-gui-server' }),
    healthChallenge: async () => true,
    spawnPendingServer: async () => {
      spawns += 1; const childPid = pid++;
      return { pid: childPid, async start() { starts += 1; await new Promise((resolve) => setTimeout(resolve, 30)); }, async stop() {} };
    },
    openBrowser: async () => undefined,
  };
  try {
    const outcomes = await Promise.all([launch(dependencies), launch(dependencies)]);
    assert.deepEqual(outcomes, [{ launched: true }, { launched: true }]);
    assert.equal(spawns, 1);
    assert.equal(starts, 1);
    assert.equal((await readStoredRecord(defaultRecordPath(root)))?.record.pid, 13001);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real GUI children propagate EADDRINUSE, retry the next port, and exit after failed startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-gui-child-'));
  const occupied = await reservePortPair(); const children: Awaited<ReturnType<typeof spawnPendingServer>>[] = [];
  let browserUrl = '';
  try {
    const result = await launch({ root, firstPort: occupied.port, portAttempts: 2,
      spawnPendingServer: async () => { const child = await spawnPendingServer(); children.push(child); return child; },
      openBrowser: async (url) => { browserUrl = url; },
    });
    assert.deepEqual(result, { launched: true });
    const record = await readStoredRecord(defaultRecordPath(root));
    assert.ok(record);
    assert.equal(record.record.port, occupied.port + 1);
    assert.equal(children.length, 2, 'the real first child reported EADDRINUSE and a fresh child started the fallback port');
    assert.equal(probeProcessIdentity(children[0]!.pid), null, 'the failed first child has exited before retry returns');
    assert.equal(probeProcessIdentity(record.record.pid)?.startTime, record.record.processStartTime);
    const opened = new URL(browserUrl);
    assert.equal(opened.port, String(record.record.port));
    assert.equal(opened.hash, `#token=${record.record.authToken}`);
  } finally {
    await new Promise<void>((resolve) => occupied.server.close(() => resolve()));
    for (const child of children) await child.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('real pending server child honors early cancellation and exits within its bound', async () => {
  const child = await spawnPendingServer();
  await child.stop();
  assert.equal(probeProcessIdentity(child.pid), null);
});

async function reservePortPair(): Promise<{ readonly server: ReturnType<typeof createServer>; readonly port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string' || address.port >= 65535) { await new Promise<void>((resolve) => server.close(() => resolve())); continue; }
    const next = createServer();
    try {
      await new Promise<void>((resolve, reject) => { next.once('error', reject); next.listen(address.port + 1, '127.0.0.1', resolve); });
      await new Promise<void>((resolve) => next.close(() => resolve()));
      return { server, port: address.port };
    } catch { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
  throw new Error('Could not reserve an ephemeral port with its next port available');
}
