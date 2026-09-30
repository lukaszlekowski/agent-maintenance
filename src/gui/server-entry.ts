import { withMaintenanceLocks } from '../core/locks.ts';
import { probeProcessIdentity } from '../core/process.ts';
import { createDefaultTuiServices } from '../tui/services.ts';
import type { ChildServerConfig } from './contracts.ts';
import { createGuiServer } from './server.ts';
import { defaultCoordinationPath, defaultRecordPath, ensurePrivateRuntimeRoot, readStoredRecord, removeRecordIfUnchanged } from './instance-record.ts';

type EntryState = 'pending' | 'starting' | 'running' | 'stopping' | 'failed' | 'stopped';
let state: EntryState = 'pending'; let cancellationRequested = false;
let server: Awaited<ReturnType<typeof createGuiServer>> | undefined;
let startupPublished = false; let rejectReadyAcknowledgement: ((error: Error) => void) | undefined;

process.on('message', (message: unknown) => {
  if (state !== 'pending' || !isRecord(message) || message.type !== 'start' || !isConfig(message.config)) return;
  state = 'starting'; void start(message.config);
});
process.on('disconnect', () => {
  if (state === 'running' || state === 'stopping' || state === 'stopped' || state === 'failed') return;
  if (startupPublished) { state = 'running'; return; }
  cancellationRequested = true;
  if (state === 'pending') { state = 'stopped'; process.exitCode = 0; }
});
process.on('SIGTERM', requestStop);
process.on('SIGINT', requestStop);

async function start(config: ChildServerConfig): Promise<void> {
  try {
    const canonicalRoot = await ensurePrivateRuntimeRoot(config.root);
    if (canonicalRoot !== config.root) throw new Error('GUI startup root is not canonical');
    checkCancellation();
    const identity = probeProcessIdentity(process.pid);
    if (!identity || identity.startTime !== config.processStartTime) throw new Error('Server process start identity changed before startup');
    const recordPath = defaultRecordPath(config.root); const stored = await readStoredRecord(recordPath);
    if (!stored || stored.record.pid !== process.pid || stored.record.processStartTime !== identity.startTime
      || stored.record.instanceId !== config.instanceId || stored.record.authToken !== config.authToken || stored.record.port !== config.port) {
      throw new Error('Private instance record does not match the starting server process');
    }
    checkCancellation();
    server = await createGuiServer({ port: config.port, instanceId: config.instanceId, authToken: config.authToken,
      services: createDefaultTuiServices(), onShutdown: () => startupPublished ? removeOwnRecord(config, recordPath) : Promise.resolve() });
    checkCancellation();
    try { await send({ type: 'ready' }); }
    catch (error) { if (process.connected) throw error; }
    await waitForReadyAcknowledgement();
  } catch (error) {
    state = 'failed';
    if (server) await server.shutdown().catch(() => undefined);
    const failure = cancellationRequested ? new StartupCancelledError() : error;
    await send({ type: 'startup-error', message: errorMessage(failure), code: errorCode(failure) }).catch(() => undefined);
    process.exitCode = cancellationRequested ? 0 : 1;
    disconnect();
  }
}

function requestStop(): void {
  cancellationRequested = true;
  if (state === 'stopped' || state === 'failed' || state === 'stopping') return;
  if (state === 'pending') { state = 'stopped'; process.exitCode = 0; disconnect(); return; }
  if (state === 'starting' && !startupPublished) { rejectReadyAcknowledgement?.(new StartupCancelledError()); return; }
  if (!server) return;
  state = 'stopping';
  void server.shutdown().then(() => { state = 'stopped'; process.exitCode = 0; }, () => { state = 'failed'; process.exitCode = 1; });
}

function checkCancellation(): void { if (cancellationRequested) throw new StartupCancelledError(); }

async function removeOwnRecord(config: ChildServerConfig, recordPath: string): Promise<void> {
  const locks = { lockDirectory: defaultCoordinationPath(config.root), timeoutMs: 10_000 };
  await withMaintenanceLocks(['maintenance', 'launcher'], locks, async () => {
    const identity = probeProcessIdentity(process.pid);
    if (!identity || identity.startTime !== config.processStartTime) return;
    const current = await readStoredRecord(recordPath);
    if (!current || current.record.pid !== process.pid || current.record.processStartTime !== identity.startTime || current.record.instanceId !== config.instanceId) return;
    await removeRecordIfUnchanged(recordPath, current);
  });
}

function send(message: Record<string, unknown>): Promise<void> {
  if (!process.send || !process.connected) return Promise.reject(new Error('GUI launcher IPC channel is closed'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { disconnect(); reject(new Error('GUI launcher IPC acknowledgement timed out')); }, 1000);
    process.send!(message, (error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
  });
}

function waitForReadyAcknowledgement(): Promise<void> {
  if (cancellationRequested) return Promise.reject(new StartupCancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      process.off('message', onMessage); process.off('disconnect', onDisconnect); rejectReadyAcknowledgement = undefined;
      if (error) reject(error); else resolve();
    };
    const onMessage = (message: unknown) => {
      if (!isRecord(message) || message.type !== 'ready-ack') return;
      startupPublished = true; state = 'running'; finish();
    };
    const onDisconnect = () => finish(new Error('GUI launcher disconnected before acknowledging server startup'));
    const timer = setTimeout(() => finish(new Error('GUI launcher startup acknowledgement timed out')), 1500);
    rejectReadyAcknowledgement = finish;
    process.on('message', onMessage); process.once('disconnect', onDisconnect);
  });
}

function disconnect(): void { if (process.connected) process.disconnect(); }
function isConfig(value: unknown): value is ChildServerConfig {
  return isRecord(value) && typeof value.instanceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.instanceId)
    && typeof value.authToken === 'string' && /^[a-f0-9]{64}$/.test(value.authToken)
    && Number.isSafeInteger(value.port) && (value.port as number) >= 1 && (value.port as number) <= 65535
    && typeof value.root === 'string' && value.root.length > 0 && typeof value.processStartTime === 'string' && value.processStartTime.length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'GUI server startup failed'; }
class StartupCancelledError extends Error { readonly code = 'ECANCELED'; constructor() { super('GUI server startup was cancelled'); } }
