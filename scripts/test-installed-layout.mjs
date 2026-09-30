import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const tarball = process.argv[2];
if (!tarball) throw new Error('Usage: node scripts/test-installed-layout.mjs /path/to/package.tgz');
const root = await mkdtemp(join(tmpdir(), 'agent-maintenance-installed-'));
const prefix = join(root, 'libexec');
const extracted = join(root, 'extract');
const home = join(root, 'home');
const codex = join(root, 'codex');
const browserDir = join(root, 'browser');
await Promise.all([mkdir(prefix), mkdir(extracted), mkdir(home), mkdir(codex), mkdir(browserDir)]);
let serverPid;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error}): ${result.stderr ?? ''}`);
  return result.stdout;
}
function identity(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const match = result.stdout.trim().match(/^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  return match ? { startTime: match[1], command: match[2] } : null;
}

try {
  run('tar', ['-xzf', resolve(tarball), '-C', extracted]);
  const stageRoot = join(extracted, 'package');
  const stagedEntries = await readdir(stageRoot);
  assert.ok(stagedEntries.includes('package.json') && stagedEntries.includes('bin') && stagedEntries.includes('dist'));
  const formulaEntries = run('ruby', ['-e', 'puts Dir["*"]'], { cwd: stageRoot }).trim().split('\n').filter(Boolean);
  for (const entry of formulaEntries) await cp(join(stageRoot, entry), join(prefix, entry), { recursive: true });
  for (const entry of ['package.json', 'bin/agent-maintenance.js', 'dist/main.js', 'dist/gui/public/index.html']) {
    await stat(join(prefix, entry));
  }
  run('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  run('npm', ['rebuild', '--prefix', prefix, 'fs-ext', '--build-from-source']);
  const executable = join(prefix, 'bin/agent-maintenance.js');
  assert.match(run(process.execPath, [executable, '--help']), /Commands:/);
  assert.match(run(process.execPath, [executable, '--version']), /^0\.1\.0\s*$/);
  const inventory = run(process.execPath, [executable, 'inventory', '--json', '--codex-home', codex]);
  assert.equal(JSON.parse(inventory).sessions.length, 0);

  const fakeBrowser = join(browserDir, 'chromium');
  await writeFile(fakeBrowser, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(fakeBrowser, 0o700);
  run(process.execPath, [executable, '--gui'], { env: { ...process.env, HOME: home, PATH: `${browserDir}:${process.env.PATH ?? ''}` } });
  const recordPath = join(home, '.agent-maintenance/server.lock');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  serverPid = record.pid;
  const observed = identity(record.pid);
  assert.ok(observed && observed.startTime === record.processStartTime && observed.command.includes('server-entry.js'), 'packaged GUI child identity must match its private record');
  const headers = { 'X-Auth-Token': record.authToken, 'X-Instance-Id': record.instanceId };
  const response = await fetch(`http://127.0.0.1:${record.port}/`, { headers });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Agent Maintenance/);
  const health = await fetch(`http://127.0.0.1:${record.port}/api/health`, { headers });
  assert.equal(health.status, 200);
} finally {
  if (serverPid) {
    const recordPath = join(home, '.agent-maintenance/server.lock');
    try {
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      const beforeSignal = identity(serverPid);
      if (record.pid === serverPid && beforeSignal?.startTime === record.processStartTime && beforeSignal.command.includes('server-entry.js')) {
        process.kill(serverPid, 'SIGTERM');
        for (let i = 0; i < 50 && identity(serverPid); i += 1) await delay(100);
        const stillSame = identity(serverPid);
        if (stillSame?.startTime === record.processStartTime && stillSame.command.includes('server-entry.js')) process.kill(serverPid, 'SIGKILL');
      } else throw new Error('Refusing to stop a GUI process whose identity no longer matches the disposable record');
    } finally { await rm(root, { recursive: true, force: true }); }
  } else await rm(root, { recursive: true, force: true });
}
console.log('Isolated installed layout passed CLI, inventory, GUI HTTP and verified child cleanup checks.');
