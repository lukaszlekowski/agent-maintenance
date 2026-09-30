import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { findChromium, launchBrowser } from '../../src/gui/browser.ts';

test('browser launcher prefers Chromium app mode and falls back to the system URL opener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gui-browser-'));
  const executable = join(directory, 'chromium'); const calls: Array<{ command: string; args: readonly string[] }> = [];
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700);
  const runner = { async spawn(command: string, args: readonly string[]) { calls.push({ command, args }); if (command === executable) throw new Error('Chromium unavailable'); } };
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ''}`;
    assert.equal(await findChromium(directory), executable);
    const result = await launchBrowser('http://127.0.0.1:4567/#token=private', runner);
    assert.equal(result, 'system-browser');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { command: executable, args: ['--app=http://127.0.0.1:4567/#token=private'] });
    assert.equal(calls[1]?.args[0], 'http://127.0.0.1:4567/#token=private');
  } finally { process.env.PATH = originalPath; await rm(directory, { recursive: true, force: true }); }
});
