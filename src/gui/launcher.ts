import { fork, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { probeProcessIdentity } from '../core/process.ts';
import { withMaintenanceLocks } from '../core/locks.ts';
import type { GuiLauncher, GuiLaunchResult } from '../launcher/contracts.ts';
import type { GuiInstanceRecord, ChildServerConfig } from './contracts.ts';
import { launchBrowser } from './browser.ts';
import { defaultCoordinationPath, defaultGuiRoot, defaultRecordPath, ensurePrivateRuntimeRoot, makeInstanceRecord, readStoredRecord, removeRecordIfUnchanged, writeRecordAtomic } from './instance-record.ts';
import type { SettingsStore } from '../tui/settings.ts';

interface PendingServer {
  readonly pid: number;
  readonly processStartTime?: string;
  start(config: ChildServerConfig): Promise<void>;
  stop(): Promise<void>;
}
export interface GuiLauncherDependencies {
  readonly root?: string;
  readonly probeIdentity?: (pid: number) => { readonly pid: number; readonly startTime: string; readonly command: string } | null;
  readonly healthChallenge?: (record: GuiInstanceRecord) => Promise<boolean>;
  readonly spawnPendingServer?: () => Promise<PendingServer>;
  readonly openBrowser?: (url: string) => Promise<unknown>;
  readonly now?: () => Date;
  readonly firstPort?: number;
  readonly portAttempts?: number;
  readonly settings?: SettingsStore;
}

export function createGuiLauncher(dependencies: GuiLauncherDependencies = {}): GuiLauncher {
  return Object.freeze({ launch: () => launch(dependencies) });
}

export async function launch(dependencies: GuiLauncherDependencies = {}): Promise<GuiLaunchResult> {
  try {
    const root = await ensurePrivateRuntimeRoot(dependencies.root ?? defaultGuiRoot());
    const recordPath = defaultRecordPath(root);
    const result = await withMaintenanceLocks(['maintenance', 'launcher'], { lockDirectory: defaultCoordinationPath(root), timeoutMs: 30_000 }, async () => {
      const existing = await readStoredRecord(recordPath);
      if (existing) {
        const observed = (dependencies.probeIdentity ?? probeProcessIdentity)(existing.record.pid);
        if (!observed || observed.startTime !== existing.record.processStartTime) {
          if (!await removeRecordIfUnchanged(recordPath, existing)) throw new Error('Stale GUI record changed during reconciliation; preserving the newer record');
        } else {
          const healthy = await (dependencies.healthChallenge ?? challengeServer)(existing.record).catch(() => false);
          if (!healthy) throw new Error('A matching GUI process is alive but failed authenticated health verification; its record is preserved');
          const confirmed = (dependencies.probeIdentity ?? probeProcessIdentity)(existing.record.pid);
          if (!confirmed || confirmed.startTime !== existing.record.processStartTime) throw new Error('GUI process identity changed during authenticated health verification; preserving its record');
          const unchanged = await readStoredRecord(recordPath);
          if (!unchanged || unchanged.fingerprint !== existing.fingerprint) throw new Error('GUI instance record changed during health verification; preserving the current record');
          return existing.record;
        }
      }
      return startNew(root, recordPath, dependencies);
    });
    const url = `http://127.0.0.1:${result.port}/#token=${result.authToken}`;
    await (dependencies.openBrowser ?? launchBrowser)(url);
    return Object.freeze({ launched: true });
  } catch (error) {
    return Object.freeze({ launched: false, reason: error instanceof Error ? error.message : 'GUI launch failed safely' });
  }
}

async function startNew(root: string, recordPath: string, dependencies: GuiLauncherDependencies): Promise<GuiInstanceRecord> {
  const spawnPending = dependencies.spawnPendingServer ?? spawnPendingServer;
  const configuredPort = dependencies.settings ? (await dependencies.settings.load()).defaultPort : undefined;
  const firstPort = dependencies.firstPort ?? configuredPort ?? 4567; const attempts = dependencies.portAttempts ?? 11;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = firstPort + attempt;
    if (port > 65535) break;
    const token = randomBytes(32).toString('hex'); const instanceId = randomUUID();
      const child = await spawnPending();
      try {
        const identity = (dependencies.probeIdentity ?? probeProcessIdentity)(child.pid);
        if (!identity) throw new Error('Cannot establish the server process start identity');
        if (child.processStartTime && child.processStartTime !== identity.startTime) throw new Error('Spawned GUI child identity changed before startup');
      const record = makeInstanceRecord({ instanceId, pid: child.pid, processStartTime: identity.startTime, port, authToken: token }, dependencies.now?.());
      await writeRecordAtomic(recordPath, record);
      try { await child.start({ instanceId, authToken: token, port, root, processStartTime: identity.startTime }); }
      catch (error) {
        const stored = await readStoredRecord(recordPath).catch(() => null);
        if (stored?.record.instanceId === record.instanceId) await removeRecordIfUnchanged(recordPath, stored).catch(() => false);
        throw error;
      }
      return record;
    } catch (error) {
      try { await child.stop(); }
      catch (cleanupError) { throw new Error(`GUI startup failed and its child could not be verified stopped: ${errorMessage(cleanupError)}`, { cause: error }); }
      lastError = error;
      if (errorCode(error) === 'EADDRINUSE') continue;
      throw error;
    }
  }
  throw new Error(`The GUI could not bind within ${attempts} loopback ports${lastError ? `: ${errorMessage(lastError)}` : ''}`);
}

export async function spawnPendingServer(): Promise<PendingServer> {
  const entry = await resolveServerEntry();
  const child = fork(entry, [], { execArgv: ['--experimental-strip-types'], detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
  const childPid = child.pid;
  if (!childPid) throw new Error('GUI server process has no PID');
  let spawnedIdentity: { readonly pid: number; readonly startTime: string };
  try { spawnedIdentity = await waitForProcessIdentity(childPid); }
  catch (error) { await stopFreshChild(child); throw error; }
  return {
    pid: childPid,
    processStartTime: spawnedIdentity.startTime,
      start: async (config) => {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let acknowledging = false;
        function finish(error?: Error): void {
          if (settled) return; settled = true; clearTimeout(timer);
          child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); child.off('disconnect', onDisconnect);
          if (error) reject(error); else resolve();
        }
        const timer = setTimeout(() => finish(new Error('GUI server startup timed out')), 10_000);
        const onMessage = (message: unknown) => {
          if (!isRecord(message)) return;
          if (message.type === 'ready' && !acknowledging) {
            acknowledging = true;
            try {
              child.send({ type: 'ready-ack' }, (error) => {
                if (error) { finish(error); return; }
                finish(); child.disconnect(); child.unref();
              });
            } catch (error) { finish(error instanceof Error ? error : new Error('Could not acknowledge GUI server startup')); }
          }
          if (message.type === 'startup-error') {
            const err = new Error(typeof message.message === 'string' ? message.message : 'GUI server failed to start');
            if (typeof message.code === 'string') Object.assign(err, { code: message.code });
            finish(err);
          }
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`GUI child exited before startup completed (code ${code ?? 'none'}, signal ${signal ?? 'none'})`));
        const onError = (error: Error) => finish(error);
        const onDisconnect = () => finish(new Error('GUI child disconnected before reporting startup status'));
        child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError); child.once('disconnect', onDisconnect);
        try { child.send({ type: 'start', config }, (error) => { if (error) finish(error); }); }
        catch (error) { finish(error instanceof Error ? error : new Error('Could not send GUI startup configuration')); }
      });
    },
    stop: async () => {
      if (isExited(child)) return;
      const beforeSignal = probeProcessIdentity(childPid);
      if (!beforeSignal || beforeSignal.startTime !== spawnedIdentity.startTime) {
        if (await waitForExit(child, 250)) return;
        throw new Error('GUI child identity cannot be verified; refusing to signal a possibly reused PID');
      }
      child.kill('SIGTERM');
      if (await waitForExit(child, 1500)) return;
      const beforeEscalation = probeProcessIdentity(childPid);
      if (!beforeEscalation || beforeEscalation.startTime !== spawnedIdentity.startTime) {
        if (await waitForExit(child, 250)) return;
        throw new Error('GUI child identity changed before bounded termination escalation');
      }
      child.kill('SIGKILL');
      if (await waitForExit(child, 1500)) return;
      throw new Error('GUI child remained alive after bounded SIGTERM/SIGKILL cleanup');
    },
  };
}

export async function resolveServerEntry(moduleUrl: string = import.meta.url): Promise<string> {
  const candidates = [new URL('./server-entry.ts', moduleUrl), new URL('./gui/server-entry.js', moduleUrl)];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    try { await access(path); return path; } catch { /* Try the source-tree fallback for packaged bundles. */ }
  }
  throw new Error('GUI server child entry is missing from both the source tree and packaged bundle');
}

async function challengeServer(record: GuiInstanceRecord): Promise<boolean> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/health`, { headers: { 'X-Auth-Token': record.authToken, 'X-Instance-Id': record.instanceId }, redirect: 'error', signal: controller.signal });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return isRecord(body) && body.healthy === true && body.instanceId === record.instanceId;
  } finally { clearTimeout(timer); }
}

async function waitForProcessIdentity(pid: number): Promise<{ readonly pid: number; readonly startTime: string }> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const identity = probeProcessIdentity(pid);
    if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Cannot establish the spawned GUI child process identity');
}

async function stopFreshChild(child: ChildProcess): Promise<void> {
  if (isExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 1000)) return;
  child.kill('SIGKILL');
  if (await waitForExit(child, 1000)) return;
  throw new Error('Newly forked GUI child could not be stopped after identity probing failed');
}

function isExited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isExited(child)) return true;
  if (timeoutMs <= 0) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer); child.off('exit', onExit); child.off('close', onClose); resolve(exited);
    };
    const onExit = () => finish(true); const onClose = () => finish(true);
    const timer = setTimeout(() => finish(isExited(child)), timeoutMs);
    child.once('exit', onExit); child.once('close', onClose);
  });
}
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'unknown error'; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
