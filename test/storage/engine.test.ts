import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodeTest from 'node:test';
import { durableStorageTest as test } from './support/platform-test.ts';
import type { FaultHook } from "../../src/storage/durable-fs.ts";

import { StorageTransactionEngine } from '../../src/storage/engine.ts';
import { controlledTestBackend } from '../../src/storage/safety.ts';
import { MaintenanceError, sessionId, type AgentRoot } from '../../src/types.ts';
import { ControlledStorageAdapter } from './support/controlled-adapter.ts';

async function setup(t: { after(fn: () => void | Promise<void>): void }, hook?: FaultHook) {
  const root = await mkdtemp(join(tmpdir(), 'agent-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'agent-data'); const storage = join(root, 'managed'); const adapterHome = join(root, 'adapter');
  await Promise.all([mkdir(data), mkdir(storage, { mode: 0o700 }), mkdir(adapterHome)]);
  const payload = join(data, 'session.json'); await writeFile(payload, '{"messages":[1,2]}', { mode: 0o600 });
  const roots: AgentRoot[] = [{ id: 'AGENT_DATA', path: data }];
  const adapter = new ControlledStorageAdapter(adapterHome, { baseRoot: 'AGENT_DATA', relativePath: 'session.json' });
  await adapter.seedIndex({ present: true, session: 'session-1' });
  const engine = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: storage, trustedRoots: roots, ...(hook ? { faultHook: hook } : {}) }, adapter);
  return { root, data, storage, payload, adapter, engine, sid: sessionId('session-1') };
}

test('archive stages durable payload, removes only unchanged source, and restore retains archive', async (t) => {
  const x = await setup(t);
  const archived = await x.engine.archive(x.sid, 'archive');
  await assert.rejects(access(x.payload));
  assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: false, session: 'session-1' });
  const rows = await x.engine.listArchives('codex_cli', x.sid);
  assert.equal(rows.length, 1);
  await x.engine.restore('codex_cli', x.sid, archived.archiveId);
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
  assert.equal((await x.engine.listArchives('codex_cli', x.sid)).length, 1);
});

test('archive interruption after index side effect is reconciled idempotently', async (t) => {
  let thrown = false;
  const x = await setup(t, (boundary) => { if (!thrown && boundary === 'after-side-effect:index') { thrown = true; throw new Error('power loss'); } });
  await assert.rejects(x.engine.archive(x.sid, 'archive'));
  const resumed = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const first = await resumed.recover();
  assert.ok(first.some((row) => row.status === 'RECOVERED'), JSON.stringify(first));
  assert.equal(first.filter((row) => row.status === 'RECOVERED').length, 1);
  const second = await resumed.recover();
  assert.ok(second.some((row) => row.status === 'TERMINAL'));
  await assert.rejects(access(x.payload));
});

test('source resumed after archive index commit is preserved with pending diagnostic', async (t) => {
  let resumed = false;
  const x = await setup(t, async (boundary) => {
    if (!resumed && boundary === 'after-side-effect:index') {
      resumed = true;
      await writeFile(x.payload, 'new session data', { mode: 0o600 });
      throw new Error('interrupted after external session resumed');
    }
  });
  await assert.rejects(x.engine.archive(x.sid, 'archive'));
  const engine = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const results = await engine.recover();
  assert.ok(results.some((row) => row.status === 'PENDING'));
  assert.equal(await readFile(x.payload, 'utf8'), 'new session data');
});

test('restore target collision and archive corruption fail without overwriting', async (t) => {
  const x = await setup(t);
  const archived = await x.engine.archive(x.sid, 'archive');
  await writeFile(x.payload, 'user data', { mode: 0o600 });
  await assert.rejects(x.engine.restore('codex_cli', x.sid, archived.archiveId), (e: unknown) => e instanceof MaintenanceError && e.code === 'RESTORE_COLLISION');
  assert.equal(await readFile(x.payload, 'utf8'), 'user data');
});

test('ambiguous archive selection requires an exact archive ID', async (t) => {
  const x = await setup(t);
  const first = await x.engine.archive(x.sid, 'archive');
  await x.engine.restore('codex_cli', x.sid, first.archiveId);
  const second = await x.engine.archive(x.sid, 'archive');
  assert.notEqual(first.archiveId, second.archiveId);
  await assert.rejects(x.engine.restore('codex_cli', x.sid), (error: unknown) => error instanceof MaintenanceError && error.code === 'ARCHIVE_SELECTION_AMBIGUOUS');
  await x.engine.restore('codex_cli', x.sid, first.archiveId);
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
});

test('partial restore publication is recovered without draining its archive', async (t) => {
  const x = await setup(t);
  const archive = await x.engine.archive(x.sid, 'archive');
  let crashed = false;
  const interrupted = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (boundary) => {
    if (!crashed && boundary === 'after-side-effect:restore-target:0:publish') { crashed = true; throw new Error('interrupted restore publication'); }
  } }, x.adapter);
  await assert.rejects(interrupted.restore('codex_cli', x.sid, archive.archiveId));
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const result = await recovery.recover();
  assert.ok(result.some((row) => row.status === 'RECOVERED'));
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
  assert.equal((await recovery.listArchives('codex_cli', x.sid)).length, 1);
  const again = await recovery.recover();
  assert.ok(again.some((row) => row.status === 'TERMINAL'));
});

test('payload publication interruptions before and after side effect recover to completion', async (t) => {
  for (const boundary of ['after-sync:payload:0:file', 'after-intent:payload:0:publish', 'after-side-effect:payload:0:publish']) {
    const x = await setup(t);
    let crashed = false;
    const interrupted = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (seen) => {
      if (!crashed && seen === boundary) { crashed = true; throw new Error('interrupted payload publication'); }
    } }, x.adapter);
    await assert.rejects(interrupted.archive(x.sid, 'archive'));
    const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
    const results = await recovery.recover();
    assert.ok(results.some((row) => row.status === 'RECOVERED'));
    await assert.rejects(access(x.payload));
    assert.equal((await recovery.listArchives('codex_cli', x.sid)).length, 1);
  }
});

test('checksum corruption is rejected before restore publishes any target', async (t) => {
  const x = await setup(t);
  const archive = await x.engine.archive(x.sid, 'archive');
  const archiveDir = join(x.storage, archive.relativePath);
  const payloadPath = join(archiveDir, 'payload', '000000.bin');
  await writeFile(payloadPath, 'tampered payload', { mode: 0o600 });
  await assert.rejects(x.engine.restore('codex_cli', x.sid, archive.archiveId), (error: unknown) => error instanceof MaintenanceError && error.code === 'CHECKSUM_MISMATCH');
  await assert.rejects(access(x.payload));
});

test('staging sync interruption is made durable before recovery publication', async (t) => {
  let failed = false;
  const x = await setup(t, (boundary) => { if (!failed && boundary === 'before-sync:payload:0:file') { failed = true; throw new Error('simulated storage sync failure'); } });
  await assert.rejects(x.engine.archive(x.sid, 'archive'));
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const diagnostics = await recovery.recover();
  assert.ok(diagnostics.some((row) => row.status === 'RECOVERED'));
  await assert.rejects(access(x.payload));
});

test('registry write interruption remains visible through recovery diagnostics', async (t) => {
  let interrupted = false;
  const x = await setup(t, (boundary) => { if (!interrupted && boundary === 'after-side-effect:registry:rename') { interrupted = true; throw new Error('registry interrupted after atomic replace'); } });
  await assert.rejects(x.engine.archive(x.sid, 'archive'));
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const diagnostics = await recovery.recover();
  assert.ok(diagnostics.some((row) => row.status === 'PENDING'));
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
});

test('exclusive-create failure leaves source and adapter index unchanged', async (t) => {
  let denied = false;
  const x = await setup(t, (boundary) => { if (!denied && boundary === 'before-side-effect:payload:0:create') { denied = true; throw new Error('simulated access denial'); } });
  await assert.rejects(x.engine.archive(x.sid, 'archive'));
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
  assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: true, session: 'session-1' });
});

test('partial multi-file source drain resumes safely after repeated recovery', async (t) => {
  const x = await setup(t);
  const second = join(x.data, 'session-extra.json');
  await writeFile(second, 'second payload', { mode: 0o600 });
  const adapter = new ControlledStorageAdapter(join(x.root, 'adapter-multi'), [
    { baseRoot: 'AGENT_DATA', relativePath: 'session.json' },
    { baseRoot: 'AGENT_DATA', relativePath: 'session-extra.json' },
  ]);
  await mkdir(adapter.lockDirectory, { recursive: true, mode: 0o700 });
  await adapter.seedIndex({ present: true, session: 'session-1' });
  const interrupted = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (boundary) => {
    if (boundary === 'after-completion:drain:0') throw new Error('interrupted between source drains');
  } }, adapter);
  await assert.rejects(interrupted.archive(x.sid, 'archive'));
  await assert.rejects(access(x.payload));
  assert.equal(await readFile(second, 'utf8'), 'second payload');
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, adapter);
  assert.ok((await recovery.recover()).some((row) => row.status === 'RECOVERED'));
  await assert.rejects(access(second));
  assert.ok((await recovery.recover()).some((row) => row.status === 'TERMINAL'));
});

test('soft delete and temp move share the adapter transaction engine and trusted root registry', async (t) => {
  const x = await setup(t);
  const deleted = await x.engine.archive(x.sid, 'soft-delete');
  assert.equal(deleted.category, 'deleted');
  await x.engine.restore('codex_cli', x.sid, deleted.archiveId);
  const tempRoot = await mkdtemp(join(tmpdir(), 'agent-temp-store-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const adapter = new ControlledStorageAdapter(join(x.root, 'adapter-temp'), { baseRoot: 'AGENT_DATA', relativePath: 'session.json' });
  await mkdir(adapter.root, { recursive: true, mode: 0o700 });
  await adapter.seedIndex({ present: true, session: 'session-1' });
  const engine = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], tempRoot: { id: 'TEMP', path: tempRoot } }, adapter);
  const moved = await engine.archive(x.sid, 'temp-move');
  assert.equal(moved.category, 'temp');
  assert.equal(moved.rootId, 'TEMP');
  assert.equal(moved.relativePath.startsWith('codex_cli/session-1/'), true);
  assert.equal((await engine.listArchives('codex_cli', x.sid)).length, 2);
});

test('pre-existing archive-ID reservation collision is preserved and retried with a new ID', async (t) => {
  let reserved = false;
  let collidedPath = '';
  const x = await setup(t, async (boundary) => {
    if (reserved || boundary !== 'after-intent:archive-reservation') return;
    reserved = true;
    const transactionFiles = await readdir(join(x.storage, 'transactions'));
    const journal = JSON.parse(await readFile(join(x.storage, 'transactions', transactionFiles[0]!), 'utf8')) as { archiveRelPath: string };
    collidedPath = join(x.storage, journal.archiveRelPath);
    await mkdir(collidedPath, { mode: 0o700 });
  });
  const archived = await x.engine.archive(x.sid, 'archive');
  assert.notEqual(archived.relativePath, collidedPath.slice(x.storage.length + 1));
  await access(collidedPath);
  assert.equal((await x.engine.listArchives('codex_cli', x.sid)).length, 1);
});

test('active and unknown ownership/activity block archive and recovery mutations', async (t) => {
  for (const safety of [{ ownership: 'ACTIVE' as const }, { ownership: 'UNKNOWN' as const }, { activity: 'ACTIVE' as const }, { activity: 'UNKNOWN' as const }]) {
    const x = await setup(t);
    x.adapter.safety = safety;
    await assert.rejects(x.engine.archive(x.sid, 'archive'), (error: unknown) => error instanceof MaintenanceError && error.code === 'SESSION_NOT_DORMANT');
    assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
    assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: true, session: 'session-1' });
  }
});

nodeTest('production protected-root backend fails closed before creating managed storage', async (t) => {
  const x = await setup(t);
  const disabled = new StorageTransactionEngine({ storageRoot: join(x.root, 'uncreated-managed'), trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  await assert.rejects(disabled.archive(x.sid, 'archive'), (error: unknown) => error instanceof MaintenanceError && error.code === 'RACE_SAFE_BACKEND_UNAVAILABLE');
  await assert.rejects(access(join(x.root, 'uncreated-managed')));
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
});

test('non-throwing resumed source leaves archive pending and never records terminal completion', async (t) => {
  const x = await setup(t);
  let resumed = false;
  const engine = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: async (boundary) => {
    if (!resumed && boundary === 'after-side-effect:index') {
      resumed = true;
      await writeFile(x.payload, 'resumed session contents', { mode: 0o600 });
    }
  } }, x.adapter);
  const result = await engine.archive(x.sid, 'archive');
  assert.equal(result.status, 'RECOVERY_PENDING');
  assert.equal(await readFile(x.payload, 'utf8'), 'resumed session contents');
  const transactions = await readdir(join(x.storage, 'transactions'));
  const journal = JSON.parse(await readFile(join(x.storage, 'transactions', transactions[0]!), 'utf8')) as { state: string; progressState: string };
  assert.equal(journal.state, 'RECOVERY_PENDING');
  assert.notEqual(journal.progressState, 'COMPLETED');
  assert.ok((await x.engine.recover()).some((row) => row.status === 'PENDING'));
});

test('restore recovery reconstructs a missing target at target-published, index-intent, and index-committed progress', async (t) => {
  for (const boundary of ['after-completion:journal:TARGET_PUBLISHED', 'after-intent:restore-index', 'after-completion:journal:INDEX_COMMITTED']) {
    const x = await setup(t);
    const archive = await x.engine.archive(x.sid, 'archive');
    let interrupted = false;
    const restore = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (point) => {
      if (!interrupted && point === boundary) { interrupted = true; throw new Error('restore interrupted'); }
    } }, x.adapter);
    await assert.rejects(restore.restore('codex_cli', x.sid, archive.archiveId));
    await rm(x.payload, { force: true });
    const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
    assert.ok((await recovery.recover()).some((row) => row.status === 'RECOVERED'));
    assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
    assert.equal((await recovery.listArchives('codex_cli', x.sid)).length, 1);
  }
});

test('changed restore target remains pending and the index is not advanced', async (t) => {
  const x = await setup(t);
  const archive = await x.engine.archive(x.sid, 'archive');
  let interrupted = false;
  const restore = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (point) => {
    if (!interrupted && point === 'after-completion:journal:TARGET_PUBLISHED') { interrupted = true; throw new Error('pause before index'); }
  } }, x.adapter);
  await assert.rejects(restore.restore('codex_cli', x.sid, archive.archiveId));
  await writeFile(x.payload, 'externally changed target', { mode: 0o600 });
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  assert.ok((await recovery.recover()).some((row) => row.status === 'PENDING'));
  assert.equal(await readFile(x.payload, 'utf8'), 'externally changed target');
  assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: false, session: 'session-1' });
});

test('recovery does not change journals, registry, index, or source while safety evidence is active', async (t) => {
  let crashed = false;
  const x = await setup(t, (boundary) => { if (!crashed && boundary === 'after-side-effect:index') { crashed = true; throw new Error('interrupt before drain'); } });
  await assert.rejects(x.engine.archive(x.sid, 'archive'));
  const adapter = x.adapter;
  adapter.safety = { ownership: 'ACTIVE' };
  const blocked = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, adapter);
  const beforeJournals = await readdir(join(x.storage, 'transactions'));
  const result = await blocked.recover();
  assert.ok(result.some((row) => row.status === 'PENDING'));
  assert.deepEqual(await readdir(join(x.storage, 'transactions')), beforeJournals);
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
  assert.deepEqual(await adapter.readIndexState(x.sid), { present: false, session: 'session-1' });
});

