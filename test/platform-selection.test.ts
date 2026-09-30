import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPlatformTests } from '../scripts/test-platform-selection.mjs';

const files = ['test/storage/engine.test.ts', 'test/storage/platform-gate.test.ts', 'test/adapters/inventory.test.ts'];

test('macOS and Linux retain the full suite including APFS-gated cases', () => {
  assert.deepEqual(selectPlatformTests('darwin', files), [...files].sort());
  assert.deepEqual(selectPlatformTests('linux', files), [...files].sort());
});

test('Windows selects only declared portable read-only and gate checks', () => {
  assert.deepEqual(selectPlatformTests('win32', files), ['test/adapters/inventory.test.ts', 'test/storage/platform-gate.test.ts']);
});

test('unknown platforms fail instead of silently dropping assurance', () => {
  assert.throws(() => selectPlatformTests('freebsd', files), /No validated test selection/);
});
