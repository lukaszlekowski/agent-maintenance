import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import test from 'node:test';
import { assertDurableRoot } from '../../src/storage/durable-fs.ts';

test('durable root admission fails closed off macOS before filesystem mutation', async () => {
  if (platform() === 'darwin') return;
  const root = await mkdtemp(join(tmpdir(), 'durability-gate-'));
  try {
    await assert.rejects(assertDurableRoot(root), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DURABILITY_UNSUPPORTED');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
