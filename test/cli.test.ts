import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveInvocation } from '../src/main.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('interface defaults are TTY-aware and explicit flags have strict precedence', () => {
  assert.deepEqual(resolveInvocation([], true), { mode: 'tui', args: [] });
  assert.deepEqual(resolveInvocation([], false), { mode: 'command', args: ['inventory', '--json'] });
  assert.deepEqual(resolveInvocation(['inventory', '--json'], true), { mode: 'command', args: ['inventory', '--json'] });
  assert.deepEqual(resolveInvocation(['--gui'], false), { mode: 'gui', args: [] });
  assert.throws(() => resolveInvocation(['--gui', '--tui'], false), /cannot be combined/);
  assert.throws(() => resolveInvocation(['--tui', 'trust'], true), /cannot be combined/);
});

async function invoke(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts', ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject); child.once('close', (value) => resolve(value ?? 1));
  });
  return { code, stdout, stderr };
}

test('version and help are stable and command-independent', async () => {
  const version = await invoke(['--version', '--gui']);
  assert.equal(version.code, 0); assert.equal(version.stdout.trim(), '0.1.0');
  const help = await invoke(['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /restore AGENT\/SESSION/); assert.match(help.stdout, /trust sync AGENT PATH/);
});

test('invalid selectors and conflicting modes use stable JSON error codes', async () => {
  const invalid = await invoke(['restore', 'session-without-agent', '--json']);
  assert.equal(invalid.code, 64); assert.deepEqual(JSON.parse(invalid.stdout), { error: { code: 'CLI_SELECTOR_INVALID', message: 'Restore selector must be AGENT/SESSION using a supported agent ID' } });
  const conflicting = await invoke(['--tui', '--gui', '--json']);
  assert.equal(conflicting.code, 64); assert.equal(JSON.parse(conflicting.stdout).error.code, 'CLI_MODE_CONFLICT');
});

test('unsupported archive, restore and trust actions fail closed with actionable status', async () => {
  const archives = await invoke(['archived', '--json']);
  assert.equal(archives.code, 3); assert.equal(JSON.parse(archives.stdout).error.code, 'CAPABILITY_DISABLED');
  const deleted = await invoke(['deleted', '--json']);
  assert.equal(deleted.code, 3); assert.equal(JSON.parse(deleted.stdout).error.code, 'CAPABILITY_DISABLED');
  const restore = await invoke(['restore', 'codex_cli/session-1', '--archive-id', 'archive-1', '--json']);
  assert.equal(restore.code, 3); assert.equal(JSON.parse(restore.stdout).error.code, 'CAPABILITY_DISABLED');
  const trust = await invoke(['trust', 'add', 'codex_cli', '/tmp/project', '--json']);
  assert.equal(trust.code, 3); assert.equal(JSON.parse(trust.stdout).error.code, 'CAPABILITY_DISABLED');
  const prune = await invoke(['trust', 'prune', 'codex_cli', '/tmp/project', '--json']);
  assert.equal(prune.code, 3); assert.equal(JSON.parse(prune.stdout).error.code, 'CAPABILITY_DISABLED');
  const sync = await invoke(['trust', 'sync', 'codex_cli', '/tmp/project', '--json']);
  assert.equal(sync.code, 3); assert.equal(JSON.parse(sync.stdout).error.code, 'CAPABILITY_DISABLED');
});

test('headless inventory emits JSON to redirected output with isolated Codex root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-maintenance-cli-'));
  try {
    const result = await invoke(['inventory', '--json', '--codex-home', directory]);
    assert.equal(result.code, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.equal(Array.isArray(inventory.sessions), true);
    assert.equal(Array.isArray(inventory.adapters), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
