import assert from 'node:assert/strict';
import test from 'node:test';
import { platform } from 'node:os';
import { nativeTerminationCapabilities } from '../../src/mutations/capabilities.ts';
import { terminateOwnedSession } from '../../src/mutations/termination.ts';
import { controlledProcessAdapter, spawnFixture, type ChildFixture } from './support/controlled-processes.ts';

const supportedProbeOS = platform() === 'darwin' || platform() === 'linux';

async function cleanup(children: readonly ChildFixture[]) {
  await Promise.all(children.map(async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }));
}

test('native process termination is disabled until session ownership and stable handles are evidenced', () => {
  assert.ok(Object.values(nativeTerminationCapabilities).every((capability) => !capability.enabled));
});

test('a spread native termination capability cannot signal a child', { skip: !supportedProbeOS }, async (t) => {
  const owned = await spawnFixture('setInterval(()=>{},1000)'); t.after(() => cleanup([owned]));
  let signals = 0;
  const adapter = controlledProcessAdapter([{ ...owned, role: 'session', depth: 0 }]);
  const forged = { ...adapter, capability: { ...nativeTerminationCapabilities.codex_cli, enabled: true,
    adapterId: 'codex_cli' as const, version: 'disposable-process-fixture', controlBoundary: 'controlled-test' as const } };
  const signal = adapter.signal;
  await assert.rejects(terminateOwnedSession({ ...forged, signal: async (...args) => { signals += 1; return signal(...args); } }, 'fixture-session', async () => true), /capability issuance/i);
  assert.equal(signals, 0); assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
});

test('confirmation cancellation leaves owned and unrelated disposable children alive', { skip: !supportedProbeOS }, async (t) => {
  const owned = await spawnFixture('setInterval(()=>{},1000)'); const unrelated = await spawnFixture('setInterval(()=>{},1000)');
  t.after(() => cleanup([owned, unrelated]));
  const adapter = controlledProcessAdapter([{ ...owned, role: 'session', depth: 0 }]);
  const disabled = { ...adapter, capability: nativeTerminationCapabilities.codex_cli };
  await assert.rejects(terminateOwnedSession(disabled, 'fixture-session', async () => true), /No session-specific ownership binding/);
  assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
  const result = await terminateOwnedSession(adapter, 'fixture-session', async () => false);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
  assert.equal(unrelated.child.exitCode, null); assert.equal(unrelated.child.signalCode, null);
});

test('confirmed termination signals only exact owned targets and leaves unrelated workloads alive', { skip: !supportedProbeOS }, async (t) => {
  const owned = await spawnFixture('setInterval(()=>{},1000)'); const unrelated = await spawnFixture('setInterval(()=>{},1000)');
  t.after(() => cleanup([owned, unrelated]));
  const adapter = controlledProcessAdapter([{ ...owned, role: 'session', depth: 0 }]);
  const result = await terminateOwnedSession(adapter, 'fixture-session', async (targets) => targets.length === 1, 1_000);
  assert.equal(result.status, 'TERMINATED', JSON.stringify(result));
  assert.equal(result.targets[0]?.gracefulSignalSent, true);
  assert.equal(result.targets[0]?.exited, true);
  assert.equal(unrelated.child.exitCode, null); assert.equal(unrelated.child.signalCode, null);
});

test('owned descendants receive graceful signals before the session process', { skip: !supportedProbeOS }, async (t) => {
  const child = await spawnFixture('setInterval(()=>{},1000)'); const session = await spawnFixture('setInterval(()=>{},1000)');
  t.after(() => cleanup([child, session]));
  const order: number[] = [];
  const adapter = controlledProcessAdapter([{ ...child, role: 'child', depth: 1 }, { ...session, role: 'session', depth: 0 }], {
    beforeSignal: (target, signal) => { if (signal === 'SIGTERM') order.push(target.identity.pid); },
  });
  const result = await terminateOwnedSession(adapter, 'fixture-session', async () => true, 1_000);
  assert.equal(result.status, 'TERMINATED');
  assert.deepEqual(order, [child.identity.pid, session.identity.pid]);
});

test('termination escalates only after the bounded wait and a fresh identity and ownership check', { skip: !supportedProbeOS }, async (t) => {
  const resistant = await spawnFixture("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)");
  t.after(() => cleanup([resistant]));
  const adapter = controlledProcessAdapter([{ ...resistant, role: 'session', depth: 0 }]);
  const result = await terminateOwnedSession(adapter, 'fixture-session', async () => true, 40);
  assert.equal(result.status, 'TERMINATED', JSON.stringify(result));
  assert.equal(result.targets[0]?.gracefulSignalSent, true);
  assert.equal(result.targets[0]?.escalationSignalSent, true);
  assert.equal(result.targets[0]?.exited, true);
});

test('ownership becoming unknown stops later per-target signals', { skip: !supportedProbeOS }, async (t) => {
  const child = await spawnFixture('setInterval(()=>{},1000)'); const session = await spawnFixture('setInterval(()=>{},1000)');
  t.after(() => cleanup([child, session]));
  const adapter = controlledProcessAdapter([{ ...child, role: 'child', depth: 1 }, { ...session, role: 'session', depth: 0 }], { invalidateInspectionFor: session.identity.pid });
  const result = await terminateOwnedSession(adapter, 'fixture-session', async () => true, 20);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.targets.find((row) => row.identity.pid === child.identity.pid)?.gracefulSignalSent, true);
  assert.equal(result.targets.find((row) => row.identity.pid === session.identity.pid)?.gracefulSignalSent, false);
  assert.equal(session.child.exitCode, null); assert.equal(session.child.signalCode, null);
});
