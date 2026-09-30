import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CONFIG_DEFAULTS, validateConfig } from '../../src/core/config.ts';
import { FileSettingsStore } from '../../src/tui/settings.ts';

test('settings store writes validated internal preferences in a disposable app root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileSettingsStore(join(root, 'preferences', 'settings.json'));
  assert.equal((await store.load()).confirmDelete, true);
  const updated = validateConfig({ ...CONFIG_DEFAULTS, confirmDelete: false, defaultPort: 4580, tempFolder: join(root, 'temp') });
  await store.save(updated);
  assert.deepEqual(await store.load(), updated);
  const metadata = await stat(store.path); assert.equal(metadata.mode & 0o777, 0o600);
  assert.match(await readFile(store.path, 'utf8'), /"confirmDelete": false/);
});
