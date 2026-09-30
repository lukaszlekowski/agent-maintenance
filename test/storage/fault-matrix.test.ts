import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StorageTransactionEngine } from '../../src/storage/engine.ts';
import type { DurableOperation, FaultHook, OperationFault } from '../../src/storage/durable-fs.ts';
import { controlledTestBackend } from '../../src/storage/safety.ts';
import { sessionId, type AgentRoot } from '../../src/types.ts';
import { ControlledStorageAdapter } from './support/controlled-adapter.ts';
import { captureStorageState } from './support/durable-snapshot.ts';

async function setup(t: { after(fn: () => void | Promise<void>): void }, hook?: FaultHook) {
  const root = await mkdtemp(join(tmpdir(), 'agent-storage-fault-'));
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

test('ancestor replacement by a symlink blocks subsequent source access', async (t) => {
  const x = await setup(t);
  const movedRoot = `${x.data}-original`;
  const outside = join(x.root, 'outside-root');
  await mkdir(outside);
  await writeFile(join(outside, 'session.json'), 'outside user file');
  let replaced = false;
  const engine = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: async (boundary) => {
    if (!replaced && boundary === 'after-side-effect:index') {
      replaced = true;
      await (await import('node:fs/promises')).rename(x.data, movedRoot);
      await (await import('node:fs/promises')).symlink(outside, x.data);
    }
  } }, x.adapter);
  await assert.rejects(engine.archive(x.sid, 'archive'));
  assert.equal(await readFile(join(outside, 'session.json'), 'utf8'), 'outside user file');
  assert.equal(await readFile(join(movedRoot, 'session.json'), 'utf8'), '{"messages":[1,2]}');
});

test('durable operation fault injection preserves evidence and recovery is repeatable', async (t) => {
  const scenarios: readonly { name: string; operation: DurableOperation; select: (path: string) => boolean; fault: OperationFault }[] = [
    { name: 'staging ENOSPC', operation: 'write', select: (path) => path.endsWith('.part'), fault: { kind: 'error', code: 'ENOSPC' } },
    { name: 'payload publication EXDEV', operation: 'publish', select: (path) => path.endsWith('.bin'), fault: { kind: 'error', code: 'EXDEV' } },
    { name: 'source drain EACCES', operation: 'unlink', select: (path) => path.endsWith('session.json'), fault: { kind: 'error', code: 'EACCES' } },
    { name: 'real partial writes', operation: 'write', select: (path) => path.endsWith('.part'), fault: { kind: 'short-write', maximumBytes: 3 } },
  ];
  for (const scenario of scenarios) {
    let injected = false;
    const hook: FaultHook = Object.assign(() => undefined, {
      injectOperation: async (operation: DurableOperation, path: string) => {
        if (!injected && operation === scenario.operation && scenario.select(path)) {
          injected = true;
          return scenario.fault;
        }
        return undefined;
      },
    });
    const x = await setup(t, hook);
    try { await x.engine.archive(x.sid, 'archive'); } catch { /* Expected for injected syscall failures. */ }
    assert.equal(injected, true, scenario.name);
    await x.engine.recover();
    const first = await captureStorageState(x);
    await x.engine.recover();
    assert.deepEqual(await captureStorageState(x), first, `${scenario.name}: repeated recovery changed durable state`);
    if (scenario.name === 'real partial writes') {
      assert.equal(await readFile(x.payload).catch(() => null), null);
      assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: false, session: 'session-1' });
    }
  }
});

test('archive write-ahead, side-effect, sync, and completion fault matrix is idempotent', async (t) => {
  const boundaries = [
    'after-intent:archive-reservation',
    'after-side-effect:archive-reservation:mkdir',
    'after-sync:archive-layout',
    'after-completion:archive-reservation',
    'after-intent:stage:0',
    'after-side-effect:payload:0:create',
    'before-sync:payload:0:file',
    'after-sync:payload:0:file',
    'after-side-effect:payload:0:write',
    'after-intent:payload:0:publish',
    'after-side-effect:payload:0:publish',
    'after-completion:stage:0',
    'after-intent:manifest',
    'after-completion:journal:STAGED',
    'after-intent:index',
    'after-side-effect:index',
    'after-completion:index',
    'after-intent:drain:0',
    'after-side-effect:drain:0:unlink',
    'after-completion:drain:0',
  ];
  for (const boundary of boundaries) {
    let injected = false;
    const x = await setup(t, (seen) => {
      if (!injected && seen === boundary) { injected = true; throw new Error(`injected ${boundary}`); }
    });
    try { await x.engine.archive(x.sid, 'archive'); } catch { /* Recovery observes the durable boundary. */ }
    assert.equal(injected, true, `checkpoint was not reached: ${boundary}`);
    await x.engine.recover();
    const first = await captureStorageState(x);
    await x.engine.recover();
    assert.deepEqual(await captureStorageState(x), first, `recovery changed durable state after ${boundary}`);
  }
});

test('restore publication, index, completion, rollback, and terminal registry boundaries converge or remain explained', async (t) => {
  const boundaries = [
    'after-completion:restore-stage:0',
    'after-intent:restore-publication',
    'after-intent:restore-publish:0',
    'after-side-effect:restore-target:0:publish',
    'after-sync:restore-target:0:published',
    'after-completion:restore-publish:0',
    'after-intent:restore-index',
    'after-side-effect:restore-index',
    'after-completion:journal:INDEX_COMMITTED',
    'after-completion:journal:COMPLETED',
  ];
  for (const boundary of boundaries) {
    const x = await setup(t);
    const archive = await x.engine.archive(x.sid, 'archive');
    let injected = false;
    const restoring = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (seen) => {
      if (!injected && seen === boundary) { injected = true; throw new Error(`interrupted at ${boundary}`); }
    } }, x.adapter);
    try { await restoring.restore('codex_cli', x.sid, archive.archiveId); } catch { /* Durable journal and filesystem state drive recovery. */ }
    assert.equal(injected, true, `restore boundary not reached: ${boundary}`);
    const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
    const first = await recovery.recover();
    assert.ok(first.every((row) => ['RECOVERED','TERMINAL','PENDING'].includes(row.status)), `${boundary}: ${JSON.stringify(first)}`);
    const state = await captureStorageState(x);
    const second = await recovery.recover();
    assert.deepEqual(await captureStorageState(x), state, `${boundary}: repeated recovery changed journals, files, index, or registry`);
    assert.ok(second.every((row) => row.status === 'TERMINAL' || row.status === 'PENDING'), `${boundary}: second recovery did not settle: ${JSON.stringify(second)}`);
  }
});

test('proof-gated restore rollback survives interruption at intent, cleanup, and terminal completion', async (t) => {
  for (const boundary of ['after-completion:journal:INITIATED', 'after-side-effect:restore-rollback-stage:unlink', 'after-completion:journal:ROLLED_BACK']) {
    const x = await setup(t);
    const archive = await x.engine.archive(x.sid, 'archive');
    const initial = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (seen) => {
      if (seen === 'after-completion:restore-stage:0') throw new Error('leave transaction-owned restore stage');
    } }, x.adapter);
    await assert.rejects(initial.restore('codex_cli', x.sid, archive.archiveId));
    await writeFile(join(x.storage, archive.relativePath, 'payload', '000000.bin'), 'corrupt archive to require rollback');
    let injected = false;
    const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (seen) => {
      if (!injected && seen === boundary) { injected = true; throw new Error(`rollback interrupted at ${boundary}`); }
    } }, x.adapter);
    await recovery.recover();
    assert.equal(injected, true, `rollback boundary not reached: ${boundary}`);
    await recovery.recover();
    const settled = await captureStorageState(x);
    const repeat = await recovery.recover();
    assert.ok(repeat.every((row) => row.status === 'PENDING' || row.status === 'TERMINAL'));
    assert.deepEqual(await captureStorageState(x), settled, `${boundary}: repeated rollback recovery changed proof state`);
    assert.equal(await readFile(x.payload).catch(() => null), null);
    assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: false, session: 'session-1' });
  }
});

test('restore rollback cleans only unchanged transaction staging before publication', async (t) => {
  const x = await setup(t);
  const archive = await x.engine.archive(x.sid, 'archive');
  let interrupted = false;
  const fault: FaultHook = (boundary) => {
    if (!interrupted && boundary === 'after-completion:restore-stage:0') { interrupted = true; throw new Error('interrupted before publication'); }
  };
  const restoring = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: fault }, x.adapter);
  await assert.rejects(restoring.restore('codex_cli', x.sid, archive.archiveId));
  const archivePayload = join(x.storage, archive.relativePath, 'payload', '000000.bin');
  await writeFile(archivePayload, 'corrupt retained archive');
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const outcome = await recovery.recover();
  assert.ok(outcome.some((row) => row.state === 'ROLLED_BACK' && ['TERMINAL','PENDING'].includes(row.status)), JSON.stringify(outcome));
  assert.equal(await readFile(x.payload).catch(() => null), null);
  assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: false, session: 'session-1' });
  const files = (await readdir(join(x.storage, 'transactions'))).filter((name) => name.endsWith('.json'));
  const journals = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(x.storage, 'transactions', name), 'utf8')) as { action: string; state: string; rollbackIntent?: boolean; rollbackCleanupProven?: boolean; payload: readonly { targetStageRelPath?: string }[] }));
  const journal = journals.find((row) => row.action === 'restore')!;
  assert.equal(journal.state, 'ROLLED_BACK');
  assert.equal(journal.rollbackIntent, true);
  assert.equal(journal.rollbackCleanupProven, true);
  for (const row of journal.payload) if (row.targetStageRelPath) await assert.rejects(access(join(x.data, row.targetStageRelPath)));
  const stable = await captureStorageState(x);
  assert.ok((await recovery.recover()).every((row) => row.status === 'PENDING'));
  assert.deepEqual(await captureStorageState(x), stable);
});

test('restore recovery resumes INITIATED work from retained archive evidence', async (t) => {
  const x = await setup(t);
  const archive = await x.engine.archive(x.sid, 'archive');
  let interrupted = false;
  const restoring = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (boundary) => {
    if (!interrupted && boundary === 'after-completion:restore-stage:0') { interrupted = true; throw new Error('pause with INITIATED restore journal'); }
  } }, x.adapter);
  await assert.rejects(restoring.restore('codex_cli', x.sid, archive.archiveId));
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const first = await recovery.recover();
  assert.ok(first.some((row) => row.state === 'COMPLETED' && row.status === 'RECOVERED'));
  const stable = await captureStorageState(x);
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
  assert.deepEqual(await x.adapter.readIndexState(x.sid), { present: true, session: 'session-1' });
  const second = await recovery.recover();
  assert.ok(second.every((row) => row.state === 'COMPLETED' && row.status === 'TERMINAL'));
  assert.deepEqual(await captureStorageState(x), stable);
  assert.equal((await recovery.listArchives('codex_cli', x.sid)).length, 1);
});

test('restore conflict preserves and repairs retained archive registration, then resumes idempotently', async (t) => {
  const x = await setup(t);
  const archive = await x.engine.archive(x.sid, 'archive');
  let interrupted = false;
  const restoring = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }], faultHook: (boundary) => {
    if (!interrupted && boundary === 'after-side-effect:restore-target:0:publish') { interrupted = true; throw new Error('target published before journal completion'); }
  } }, x.adapter);
  await assert.rejects(restoring.restore('codex_cli', x.sid, archive.archiveId));
  await rm(x.payload);
  await writeFile(x.payload, 'conflicting replacement');
  const registryPath = join(x.storage, 'registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { entries: { archiveId: string; status: string }[] };
  registry.entries[0]!.status = 'RECOVERY_PENDING';
  await writeFile(registryPath, JSON.stringify(registry));
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const blocked = await recovery.recover();
  assert.ok(blocked.some((row) => row.status === 'PENDING'));
  assert.equal((await recovery.listArchives('codex_cli', x.sid))[0]?.status, 'REGISTERED');
  assert.equal(await readFile(x.payload, 'utf8'), 'conflicting replacement');
  await rm(x.payload);
  const resumed = await recovery.recover();
  assert.ok(resumed.some((row) => row.state === 'COMPLETED' && row.status === 'RECOVERED'), JSON.stringify(resumed));
  assert.equal(await readFile(x.payload, 'utf8'), '{"messages":[1,2]}');
  assert.equal((await recovery.listArchives('codex_cli', x.sid))[0]?.archiveId, archive.archiveId);
  const stable = await captureStorageState(x);
  const terminal = await recovery.recover();
  assert.ok(terminal.every((row) => row.status === 'TERMINAL'));
  assert.deepEqual(await captureStorageState(x), stable);
});

test('terminal archive journal repairs registry publication gap from creation evidence', async (t) => {
  let injected = false;
  const x = await setup(t, (boundary) => {
    if (!injected && boundary === 'after-completion:journal:COMPLETED') { injected = true; throw new Error('crash after terminal journal write'); }
  });
  try { await x.engine.archive(x.sid, 'archive'); } catch { /* Terminal journal is durable before registry publication. */ }
  assert.equal(injected, true);
  const before = JSON.parse(await readFile(join(x.storage, 'registry.json'), 'utf8')) as { entries: { status: string }[] };
  assert.equal(before.entries[0]?.status, 'RECOVERY_PENDING');
  const recovery = new StorageTransactionEngine({ backend: controlledTestBackend(), storageRoot: x.storage, trustedRoots: [{ id: 'AGENT_DATA', path: x.data }] }, x.adapter);
  const terminal = await recovery.recover();
  assert.ok(terminal.some((row) => row.state === 'COMPLETED' && row.status === 'TERMINAL'));
  assert.equal((await recovery.listArchives('codex_cli', x.sid))[0]?.status, 'REGISTERED');
  const stable = await captureStorageState(x);
  assert.deepEqual(await recovery.recover(), terminal);
  assert.deepEqual(await captureStorageState(x), stable);
});
