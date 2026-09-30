import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { selectPlatformTests } from './test-platform-selection.mjs';

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testFiles(path) : entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
  }));
  return nested.flat().sort();
}

const all = await testFiles('test');
const selected = selectPlatformTests(process.platform, all);
console.log(`Platform ${process.platform}: running ${selected.length}/${all.length} test files.`);
if (process.platform === 'linux') console.log('APFS transaction fixtures remain visible as explicit skips; durable-storage fail-closed gate runs.');
if (process.platform === 'win32') console.log('Windows scope is read-only inventory/schema and platform fail-closed checks.');
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...selected], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
