import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { platform } from 'node:os';
import test from 'node:test';
import { assessMutationCapability, assessTerminationCapability, nativeAdapterCapabilities, nativeMutationCapabilities, nativeTerminationCapabilities, nativeTrustEditCapabilities, requireMutationCapability, requireTerminationCapability } from '../../src/mutations/capabilities.ts';
import { controlledTestBackend, isAuthorizedStorageBackend } from '../../src/storage/safety.ts';

test('native mutation and termination integrations remain disabled without Phase 0 evidence', () => {
  assert.ok(Object.values(nativeMutationCapabilities).every((capability) => !capability.enabled && capability.reason.length > 0));
  assert.ok(Object.values(nativeTrustEditCapabilities).every((capability) => !capability.enabled && capability.reason.length > 0));
  assert.ok(Object.values(nativeTerminationCapabilities).every((capability) => !capability.enabled && capability.reason.length > 0));
  const agy = nativeAdapterCapabilities('agy_cli');
  assert.equal(agy.dormantStorage.enabled, false);
  assert.match(agy.dormantStorage.reason, /dependency closure/i);
  assert.equal(agy.trustEdit.enabled, false);
  assert.equal(agy.processTermination.enabled, false);
});

test('mutation gate requires exact schema, complete closure, writer exclusion, OS, and race-safe filesystem evidence', () => {
  const complete = { operation: 'database' as const, controlBoundary: 'controlled-test' as const, adapterId: 'agy_cli' as const, version: 'fixture-1', schema: { name: 'fixture', version: '1', fingerprint: createHash('sha256').update('schema').digest('hex') },
    dependencyCoverage: 'COMPLETE' as const, exclusionProtocol: 'SQLite writer transaction in isolated fixture',
    raceSafeFileOperations: 'VALIDATED' as const, testedOS: platform(), evidenceRef: 'controlled fixture evidence' };
  assert.equal(assessMutationCapability(complete).enabled, true);
  const incomplete = assessMutationCapability({ ...complete, dependencyCoverage: 'UNKNOWN', exclusionProtocol: null, raceSafeFileOperations: 'UNAVAILABLE' });
  assert.equal(incomplete.enabled, false);
  assert.match(incomplete.reason, /dependency closure.*external-writer exclusion.*race-safe/i);
});

test('termination gate independently requires ownership binding and a stable process handle', () => {
  const incomplete = assessTerminationCapability({ adapterId: 'codex_cli', version: 'fixture-1', controlBoundary: 'controlled-test', ownershipBinding: 'fixture session map',
    stableProcessHandle: null, testedOS: platform(), evidenceRef: 'fixture' });
  assert.equal(incomplete.enabled, false);
  assert.match(incomplete.reason, /stable PID-reuse-resistant/);
  assert.equal(assessTerminationCapability({ adapterId: 'codex_cli', version: 'fixture-1', controlBoundary: 'controlled-test', ownershipBinding: 'fixture session map',
    stableProcessHandle: 'controlled ChildProcess handle', testedOS: platform(), evidenceRef: 'fixture' }).enabled, true);
});

test('capability runtime authority rejects spreads, reflected clones, prototypes, plain objects, and altered metadata', () => {
  const evidence = { operation: 'database' as const, controlBoundary: 'controlled-test' as const, adapterId: 'agy_cli' as const, version: 'fixture-1',
    schema: { name: 'fixture', version: '1', fingerprint: createHash('sha256').update('x').digest('hex') }, dependencyCoverage: 'COMPLETE' as const,
    exclusionProtocol: 'controlled DB lock', raceSafeFileOperations: 'VALIDATED' as const, testedOS: platform(), evidenceRef: 'fixture' };
  const cap = assessMutationCapability(evidence);
  const expected = { adapterId: 'agy_cli' as const, version: 'fixture-1', schemaKey: cap.schemaKey, boundary: 'controlled-test' as const };
  requireMutationCapability(cap, 'database', expected);
  assert.deepEqual(Object.getOwnPropertySymbols(cap), []);
  assert.throws(() => requireMutationCapability({ ...cap, enabled: true }, 'database', expected));
  assert.throws(() => requireMutationCapability(Object.assign(Object.create(cap), {}), 'database', expected));
  assert.throws(() => requireMutationCapability(Object.fromEntries(Reflect.ownKeys(cap).map((key) => [key, (cap as unknown as Record<PropertyKey, unknown>)[key]])) as never, 'database', expected));
  assert.throws(() => requireMutationCapability({ enabled: true, adapterId: 'agy_cli', version: 'fixture-1', schemaKey: cap.schemaKey,
    operation: 'database', controlBoundary: 'controlled-test', testedOS: platform(), reason: 'forged' }, 'database', expected));
  assert.throws(() => Object.defineProperty(cap, 'version', { value: 'forged' }));
  assert.throws(() => requireMutationCapability({ ...nativeMutationCapabilities.agy_cli, enabled: true, adapterId: 'agy_cli', version: 'fixture-1', schemaKey: cap.schemaKey }, 'database', expected));
  const termination = assessTerminationCapability({ adapterId: 'agy_cli', version: 'fixture-1', controlBoundary: 'controlled-test', ownershipBinding: 'fixture exact map',
    stableProcessHandle: 'fixture handle', testedOS: platform(), evidenceRef: 'fixture' });
  const termExpected = { adapterId: 'agy_cli' as const, version: 'fixture-1', boundary: 'controlled-test' as const };
  requireTerminationCapability(termination, 'termination', termExpected);
  assert.throws(() => requireTerminationCapability({ ...termination, enabled: true }, 'termination', termExpected));
  assert.throws(() => requireTerminationCapability(Object.create(termination), 'termination', termExpected));
  assert.throws(() => requireTerminationCapability({ ...nativeTerminationCapabilities.agy_cli, enabled: true, adapterId: 'agy_cli', version: 'fixture-1' }, 'termination', termExpected));
});

test('controlled storage backend authority cannot be copied or structurally impersonated', () => {
  const backend = controlledTestBackend();
  assert.equal(isAuthorizedStorageBackend(backend), true);
  assert.equal(isAuthorizedStorageBackend({ ...backend }), false);
  assert.equal(isAuthorizedStorageBackend(Object.create(backend)), false);
  assert.equal(isAuthorizedStorageBackend({ kind: 'controlled-test', assertAvailable: () => undefined }), false);
});
