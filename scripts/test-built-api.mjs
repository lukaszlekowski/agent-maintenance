import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/index.js';
const require = createRequire(import.meta.url);
const cjs = require('../dist/index.cjs');

const variants = (base, operation, version, schemaKey) => {
  const common = { enabled: true, version, adapterId: 'agy_cli', schemaKey, operation, controlBoundary: 'controlled-test', testedOS: process.platform };
  const spread = { ...base, ...common };
  const reflected = Object.fromEntries(Reflect.ownKeys(base).map((key) => [key, base[key]])); Object.assign(reflected, common);
  const prototype = Object.create(base);
  for (const [key, value] of Object.entries(common)) Object.defineProperty(prototype, key, { value, enumerable: true, writable: true, configurable: true });
  const plain = { ...common, reason: 'forged' };
  return [spread, reflected, prototype, plain];
};

async function check(module) {
  assert.equal('assessMutationCapability' in module, false);
  assert.equal('assessTerminationCapability' in module, false);
  const schemaKey = 'fixture@1:' + 'a'.repeat(64);
  for (const capability of variants(module.nativeMutationCapabilities.agy_cli, 'database', 'fixture-1', schemaKey)) {
    const adapter = { agentId: 'agy_cli', version: 'fixture-1', schemaFingerprint: 'a'.repeat(64), capability };
    const store = new module.SqliteDependencyStore(adapter, { mutationBoundary: 'controlled-test', registerDatabaseRecoveryParticipant() {} });
    await assert.rejects(store.exportAndDelete('session'), /capability issuance/);
  }
  for (const capability of variants(module.nativeTrustEditCapabilities.agy_cli, 'trust-edit', 'fixture-1', schemaKey)) {
    let entered = false;
    const service = new module.TrustConfigService({ agentId: 'agy_cli', version: 'fixture-1', capability, schemaFingerprint: 'a'.repeat(64),
      configPath: '/private/tmp/no-read.toml', backupDirectory: '/private/tmp/no-write', withExternalExclusion: async (run) => { entered = true; return run(); } });
    await assert.rejects(service.prune(async () => true), /capability issuance/);
    assert.equal(entered, false);
  }
  for (const capability of variants(module.nativeTerminationCapabilities.agy_cli, undefined, 'fixture-1', schemaKey)) {
    let signals = 0;
    const adapter = { agentId: 'agy_cli', version: 'fixture-1', capability, discoverOwnedTargets: async () => [], inspectTarget: async () => null,
      isAlive: async () => false, signal: async () => { signals += 1; } };
    await assert.rejects(module.terminateOwnedSession(adapter, 'session', async () => true), /capability issuance/);
    assert.equal(signals, 0);
  }
}

await check(esm);
await check(cjs);
console.log('built ESM/CommonJS capability ingress checks passed');
