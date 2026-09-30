import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  DISABLED_CAPABILITY, MaintenanceError, authorizeActiveTermination, authorizeDormantStorage,
  canonicalPathWithMissingTail, disabledCapabilities, expandPath, isContained,
  probeWorkspacePath, requireKnownOwnership, requireRaceSafeMutation, resolveMappedPath,
  resolveTrustedRoots, sameProcessIdentity, sessionId, validateConfig, withMaintenanceLocks,
  discoverProcessIds, probeProcessIdentity, probeProcessLiveness,
  supportsKernelFileLocks,
  isSupportedLocalLockFilesystem,
} from '../../src/index.ts';
import type { ProcessIdentity } from '../../src/types.ts';

test('unknown ownership values fail closed', () => {
  assert.throws(() => requireKnownOwnership('IDLE'), (error: unknown) => error instanceof MaintenanceError && error.code === 'UNKNOWN_OWNERSHIP_STATE');
  const decision = authorizeDormantStorage({
    ownership: 'UNKNOWN', externalActivity: { state: 'QUIESCENT', evidence: 'fixture' },
    externalWriterExclusion: DISABLED_CAPABILITY('not established'), raceSafeFileOperations: DISABLED_CAPABILITY('not established'),
  });
  assert.equal(decision.allowed, false);
});

test('dormant storage requires every safety gate', () => {
  const input = { ownership: 'DORMANT', externalActivity: { state: 'QUIESCENT' as const, evidence: 'validated-fixture' },
    externalWriterExclusion: { enabled: true, reason: 'verified' }, raceSafeFileOperations: { enabled: true, reason: 'verified' } };
  assert.equal(authorizeDormantStorage(input).allowed, true);
  assert.equal(authorizeDormantStorage({ ...input, externalActivity: { state: 'UNKNOWN', evidence: 'none' } }).allowed, false);
  assert.equal(authorizeDormantStorage({ ...input, ownership: 'ACTIVE' }).allowed, false);
  assert.equal(authorizeDormantStorage({ ...input, externalWriterExclusion: DISABLED_CAPABILITY('no native gate') }).allowed, false);
});

test('termination requires matching process identity and verified ownership', () => {
  const identity: ProcessIdentity = { pid: 123, startTime: 'Tue Sep 30 10:00:00 2026', command: 'agent --session x' };
  assert.equal(sameProcessIdentity(identity, { ...identity, pid: 124 }), false);
  assert.equal(sameProcessIdentity(identity, { ...identity, startTime: 'Tue Sep 30 11:00:00 2026' }), false);
  const common = { ownership: 'ACTIVE', expectedIdentity: identity, expectedOwnership: { agentId: 'codex_cli' as const, sessionId: sessionId('session-1') }, currentIdentity: identity,
    verifiedOwnership: { state: 'VERIFIED_ACTIVE' as const, evidenceId: 'fixture', agentId: 'codex_cli' as const, sessionId: sessionId('session-1') },
    capability: { enabled: true, reason: 'validated fixture' } };
  assert.equal(authorizeActiveTermination(common).allowed, true);
  assert.equal(authorizeActiveTermination({ ...common, expectedOwnership: { agentId: 'claude_code_cli', sessionId: sessionId('other-session') } }).allowed, false);
  assert.equal(authorizeActiveTermination({ ...common, currentIdentity: { ...identity, pid: 999 } }).allowed, false);
  const withoutOwnershipEvidence = { ownership: common.ownership, expectedIdentity: common.expectedIdentity,
    expectedOwnership: common.expectedOwnership, currentIdentity: common.currentIdentity, capability: common.capability };
  assert.equal(authorizeActiveTermination(withoutOwnershipEvidence).allowed, false);
  assert.equal(authorizeActiveTermination({ ...common, capability: DISABLED_CAPABILITY('Phase 0 evidence missing') }).allowed, false);
  assert.equal(authorizeActiveTermination({ ...common, ownership: 'DORMANT' }).allowed, false);
});

test('process probes capture identity or return a structured fail-closed denial', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  assert.equal(probeProcessLiveness(process.pid), 'ALIVE');
  try {
    assert.equal(discoverProcessIds().includes(process.pid), true);
    const identity = probeProcessIdentity(process.pid);
    assert.equal(identity?.pid, process.pid);
    assert.equal(typeof identity?.startTime, 'string');
    assert.equal(typeof identity?.command, 'string');
  } catch (error) {
    assert.ok(error instanceof MaintenanceError);
    assert.equal(error.code, 'PROCESS_PROBE_FAILED');
  }
});

test('configuration applies validated defaults and explicit expansion', () => {
  const config = validateConfig({}, { home: '/home/test', env: { DATA_DIR: '/mnt/data' } });
  assert.equal(config.storageRoot, '/home/test/.agent-maintenance');
  assert.equal(config.tempFolder, '/home/test/agent-maintenance-temp');
  assert.equal(expandPath('${DATA_DIR}/sessions', { home: '/home/test', env: { DATA_DIR: '/mnt/data' } }), '/mnt/data/sessions');
  assert.throws(() => expandPath('$SECRET/x', { home: '/home/test', env: {} }));
  assert.throws(() => validateConfig({ defaultPort: 0 }, { home: '/home/test', env: {} }));
  assert.throws(() => validateConfig({ newDangerousOption: true }, { home: '/home/test', env: {} }));
});

test('trusted roots resolve symlinks and mappings reject traversal and escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'inside'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-maintenance-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'escape'));
  await symlink(join(outside, 'not-yet-created'), join(root, 'dangling-link'));
  const roots = await resolveTrustedRoots([{ id: 'AGENT_HOME', path: root }]);
  assert.equal(await resolveMappedPath(roots, { baseRoot: 'AGENT_HOME', relativePath: 'inside/new.json' }), join(roots.get('AGENT_HOME')!, 'inside/new.json'));
  await assert.rejects(resolveMappedPath(roots, { baseRoot: 'AGENT_HOME', relativePath: '../outside' }));
  await assert.rejects(resolveMappedPath(roots, { baseRoot: 'AGENT_HOME', relativePath: 'escape/new.json' }));
  await assert.rejects(resolveMappedPath(roots, { baseRoot: 'AGENT_HOME', relativePath: 'dangling-link/new.json' }));
  assert.equal(isContained(root, join(root, 'inside')), true);
  assert.equal(isContained(root, outside), false);
  assert.equal(await canonicalPathWithMissingTail(join(root, 'missing', 'file')), join(roots.get('AGENT_HOME')!, 'missing', 'file'));
});

test('workspace probing preserves unknown and unavailable states', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'regular-file'), 'data');
  assert.equal((await probeWorkspacePath(root)).state, 'VALID');
  assert.equal((await probeWorkspacePath(join(root, 'regular-file'))).state, 'INACCESSIBLE');
  assert.equal((await probeWorkspacePath(join(root, 'missing'))).state, 'CONFIRMED_OBSOLETE');
  assert.equal((await probeWorkspacePath(join(root, 'missing-volume'), async () => 'NOT_MOUNTED')).state, 'UNAVAILABLE_VOLUME');
  assert.equal((await probeWorkspacePath(join(root, 'missing-unknown'), async () => 'UNKNOWN')).state, 'INACCESSIBLE');
});

test('race-sensitive mutation capability remains disabled without Phase 0 evidence', () => {
  assert.equal(disabledCapabilities().processTermination.enabled, false);
  assert.throws(requireRaceSafeMutation, (error: unknown) => error instanceof MaintenanceError && error.code === 'CAPABILITY_DISABLED');
  assert.equal(supportsKernelFileLocks('win32'), false);
  assert.equal(supportsKernelFileLocks('darwin'), true);
  assert.equal(supportsKernelFileLocks('linux'), true);
  assert.equal(isSupportedLocalLockFilesystem('apfs'), true);
  assert.equal(isSupportedLocalLockFilesystem('ext4'), true);
  assert.equal(isSupportedLocalLockFilesystem('nfs'), false);
  assert.equal(isSupportedLocalLockFilesystem('smbfs'), false);
});

test('OS locks serialize concurrent writer processes', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return t.skip('OS lock helper is intentionally unavailable on this platform');
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'events.log');
  const moduleUrl = JSON.stringify(new URL('../../src/core/locks.ts', import.meta.url).href);
  const worker = (tag: string, rounds = 1, holdMs = 50) => `import {appendFile} from 'node:fs/promises';\n` +
    `import {withMaintenanceLocks} from ${moduleUrl};\n` +
    `for (let i=0;i<${rounds};i++) await withMaintenanceLocks(['maintenance'], {lockDirectory:${JSON.stringify(root)}}, async () => { await appendFile(${JSON.stringify(logPath)}, 'start ${tag}-'+i+'\\n'); console.log('READY'); await new Promise(r=>setTimeout(r,${holdMs})); await appendFile(${JSON.stringify(logPath)}, 'end ${tag}-'+i+'\\n'); });`;
  const launch = (tag: string, rounds = 1, holdMs = 50) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', worker(tag, rounds, holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      readyResolve = resolveReady;
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (chunk.includes('READY')) resolveReady(); });
      child.once('error', rejectReady);
      child.once('exit', (code) => { if (readyResolve) rejectReady(new Error(`worker exited before ready (${code})`)); });
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { error += chunk; });
    return {
      child,
      ready,
      exit: new Promise<void>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code) => code === 0 ? resolveExit() : rejectExit(new Error(error || `worker exited ${code}`)));
      }),
    };
  };
  const first = launch('a', 2, 20);
  const second = launch('b', 2, 20);
  const third = launch('c', 2, 20);
  await Promise.all([first.exit, second.exit, third.exit]);
  const events = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/);
  assert.equal(events.length, 12);
  for (let index = 0; index < events.length; index += 2) {
    assert.equal(events[index]?.startsWith('start '), true);
    assert.equal(events[index + 1], `end ${events[index]?.slice(6)}`);
  }
  const lockPath = join(root, 'maintenance.lock');
  const persistentIdentity = (await stat(lockPath)).ino;
  assert.equal((await stat(lockPath)).isFile(), true);

  const holder = launch('holder', 1, 1_500);
  await holder.ready;
  const immediateStart = performance.now();
  await assert.rejects(withMaintenanceLocks(['maintenance'], { lockDirectory: root, timeoutMs: 0 }, async () => undefined),
    (error: unknown) => error instanceof MaintenanceError && error.code === 'LOCK_TIMEOUT');
  assert.ok(performance.now() - immediateStart < 250, 'zero timeout must make one immediate kernel attempt');
  const boundedStart = performance.now();
  await assert.rejects(withMaintenanceLocks(['maintenance'], { lockDirectory: root, timeoutMs: 30 }, async () => undefined),
    (error: unknown) => error instanceof MaintenanceError && error.code === 'LOCK_TIMEOUT');
  assert.ok(performance.now() - boundedStart >= 20 && performance.now() - boundedStart < 300, 'positive timeout is a millisecond deadline');
  holder.child.kill('SIGKILL');
  await assert.rejects(holder.exit);
  assert.equal((await stat(lockPath)).ino, persistentIdentity, 'lock file identity remains stable after holder death');

  const lifecyclePath = join(root, 'lifecycle.log');
  const lifecycleWorker = (tag: string, holdMs: number) => `import {appendFile} from 'node:fs/promises';\n` +
    `import {withMaintenanceLocks} from ${moduleUrl};\n` +
    `await withMaintenanceLocks(['maintenance'],{lockDirectory:${JSON.stringify(root)}},async()=>{await appendFile(${JSON.stringify(lifecyclePath)},'start ${tag}\\n'); console.log('READY'); await new Promise(r=>setTimeout(r,${holdMs})); await appendFile(${JSON.stringify(lifecyclePath)},'end ${tag}\\n');});`;
  const killed = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', lifecycleWorker('killed', 5_000)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolveReady, rejectReady) => {
    killed.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (chunk.includes('READY')) resolveReady(); });
    killed.once('error', rejectReady);
    killed.once('exit', (code) => rejectReady(new Error(`holder exited before ready (${code})`)));
  });
  const killedExit = new Promise<void>((resolveExit) => killed.once('exit', () => resolveExit()));
  killed.kill('SIGKILL');
  await killedExit;
  const afterDeath = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', lifecycleWorker('successor', 30)], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolveExit, rejectExit) => {
    let error = '';
    afterDeath.stderr.setEncoding('utf8').on('data', (chunk: string) => { error += chunk; });
    afterDeath.once('error', rejectExit);
    afterDeath.once('exit', (code) => code === 0 ? resolveExit() : rejectExit(new Error(error || `successor exited ${code}`)));
  });
  assert.deepEqual((await readFile(lifecyclePath, 'utf8')).trim().split(/\r?\n/), ['start killed', 'start successor', 'end successor']);
  const nested = withMaintenanceLocks(['maintenance'], { lockDirectory: root }, () =>
    withMaintenanceLocks(['launcher', 'maintenance'], { lockDirectory: root }, async () => undefined));
  await assert.rejects(nested, (error: unknown) => error instanceof MaintenanceError && error.code === 'LOCK_ORDER_VIOLATION');
  await assert.rejects(withMaintenanceLocks(['launcher'], { lockDirectory: root }, async () => undefined),
    (error: unknown) => error instanceof MaintenanceError && error.code === 'LOCK_ORDER_VIOLATION');
});
