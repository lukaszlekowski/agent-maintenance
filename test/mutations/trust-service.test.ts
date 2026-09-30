import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { withMaintenanceLocks } from '../../src/core/locks.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import test from 'node:test';
import { assessMutationCapability, nativeTrustEditCapabilities } from '../../src/mutations/capabilities.ts';
import { pruneTrustConfigsIndependently, TrustConfigService, type TrustConfigAdapter } from '../../src/mutations/trust-service.ts';

const initial = `model = "gpt-5"
approval_policy = "on-request"

[projects."/tmp/kept"]
trust_level = "trusted"

[projects."/tmp/obsolete"]
trust_level = "trusted"
`;

async function fixture(t: { after(fn: () => void | Promise<void>): void }, suffix = 'config') {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, `${suffix}.toml`); const backupDirectory = join(root, 'backups');
  const lockDirectory = join(root, 'locks');
  await Promise.all([mkdir(backupDirectory), mkdir(lockDirectory)]); await writeFile(configPath, initial, { mode: 0o600 });
  const fingerprint = createHash('sha256').update('fixture-codex-config-v1').digest('hex');
  const adapter: TrustConfigAdapter = {
    agentId: 'codex_cli', version: 'fixture-0.159.2', configPath, backupDirectory, schemaFingerprint: fingerprint,
    capability: assessMutationCapability({ operation: 'trust-edit', controlBoundary: 'controlled-test', adapterId: 'codex_cli', version: 'fixture-0.159.2',
      schema: { name: 'codex ConfigToml.projects', version: '0.159.2', fingerprint }, dependencyCoverage: 'COMPLETE',
      exclusionProtocol: 'OS advisory lock for cooperating disposable fixture writers only', raceSafeFileOperations: 'VALIDATED', testedOS: process.platform, evidenceRef: 'fixture adapter, no native Codex config access' }),
    withExternalExclusion: async (action) => withMaintenanceLocks(['maintenance'], { lockDirectory }, action),
    parse: (text) => parse(text),
    cloneDocument: (document) => parse(stringify(document as object)),
    pathStates: (document) => Object.keys((document as { projects: Record<string, unknown> }).projects).map((path) => ({
      path, state: path === '/tmp/obsolete' ? 'CONFIRMED_OBSOLETE' as const
        : path.startsWith('/Volumes/') ? 'UNAVAILABLE_VOLUME' as const
          : path === '/tmp/inaccessible' ? 'INACCESSIBLE' as const : 'VALID' as const,
    })),
    removePaths: (document, paths) => {
      const copy = parse(stringify(document as object)) as { projects: Record<string, unknown> };
      for (const path of paths) delete copy.projects[path];
      return copy;
    },
    serialize: (document) => stringify(document as object),
  };
  return { root, configPath, backupDirectory, adapter, service: new TrustConfigService(adapter) };
}

test('trust pruning shows an exact diff, confirms, backs up, and semantically preserves the config', async (t) => {
  const x = await fixture(t); let confirmed = false;
  const result = await x.service.prune(async (diff) => {
    confirmed = true;
    assert.deepEqual(diff.paths, ['/tmp/obsolete']);
    assert.equal('before' in diff, false); assert.equal('after' in diff, false);
    return true;
  });
  assert.equal(confirmed, true); assert.equal(result.committed, true);
  const after = parse(await readFile(x.configPath, 'utf8')) as { projects: Record<string, { trust_level: string }>; model: string; approval_policy: string };
  assert.deepEqual(Object.keys(after.projects), ['/tmp/kept']);
  assert.equal(after.projects['/tmp/kept']?.trust_level, 'trusted');
  assert.equal(after.model, 'gpt-5'); assert.equal(after.approval_policy, 'on-request');
  assert.equal(await readFile(result.backupPath!, 'utf8'), initial);
  assert.equal((await readdir(x.backupDirectory)).length, 1);
});

test('trust edit cancellation creates no backup and leaves the source bytes unchanged', async (t) => {
  const x = await fixture(t);
  const result = await x.service.prune(async (diff) => { assert.equal(diff.paths.length, 1); return false; });
  assert.equal(result.committed, false);
  assert.equal(await readFile(x.configPath, 'utf8'), initial);
  assert.deepEqual(await readdir(x.backupDirectory), []);
});

test('pruning preserves unavailable and inaccessible trust paths', async (t) => {
  const x = await fixture(t);
  await writeFile(x.configPath, `${initial}\n[projects."/Volumes/offline"]\ntrust_level = "trusted"\n\n[projects."/tmp/inaccessible"]\ntrust_level = "trusted"\n`);
  const result = await x.service.prune(async (diff) => { assert.deepEqual(diff.paths, ['/tmp/obsolete']); return true; });
  assert.equal(result.committed, true);
  const document = parse(await readFile(x.configPath, 'utf8')) as { projects: Record<string, unknown> };
  assert.deepEqual(Object.keys(document.projects).sort(), ['/Volumes/offline', '/tmp/inaccessible', '/tmp/kept']);
});

test('expected-state change after confirmation prevents atomic config replacement', async (t) => {
  const x = await fixture(t);
  await assert.rejects(x.service.prune(async () => {
    await writeFile(x.configPath, 'model = "external writer"\n');
    return true;
  }), /changed after the pruning diff/);
  assert.equal(await readFile(x.configPath, 'utf8'), 'model = "external writer"\n');
  assert.equal((await readdir(x.backupDirectory)).length, 1);
  assert.deepEqual((await readdir(x.root)).sort(), ['backups', 'config.toml', 'locks']);
});

test('cross-agent trust sync reports each config as its own commit', async (t) => {
  const first = await fixture(t, 'first'); const second = await fixture(t, 'second');
  const disabled = new TrustConfigService({ ...second.adapter, capability: nativeTrustEditCapabilities.codex_cli });
  const results = await pruneTrustConfigsIndependently([first.service, disabled], async () => true);
  assert.equal(results.length, 2); assert.equal(results[0]?.committed, true);
  assert.equal(results[0]?.configPath, first.configPath);
  assert.equal(results[1]?.committed, false); assert.equal(results[1]?.configPath, second.configPath);
  assert.equal(await readFile(second.configPath, 'utf8'), initial);
});

test('a spread capability cannot authorize a trust edit', async (t) => {
  const x = await fixture(t); let enteredExclusion = false;
  const forged = { ...x.adapter, capability: { ...x.adapter.capability, enabled: true, version: 'fixture-0.159.2', adapterId: 'codex_cli' as const } };
  const service = new TrustConfigService({ ...forged, withExternalExclusion: async (action) => { enteredExclusion = true; return forged.withExternalExclusion(action); } });
  await assert.rejects(service.prune(async () => true), /capability issuance/i);
  assert.equal(enteredExclusion, false);
  assert.equal(await readFile(x.configPath, 'utf8'), initial);
});
