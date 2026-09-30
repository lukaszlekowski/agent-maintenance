import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { GuiInstanceRecord } from './contracts.ts';
import { syncDirectory } from '../storage/durable-fs.ts';

const MAX_RECORD_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredRecord { readonly record: GuiInstanceRecord; readonly fingerprint: string }

export function defaultGuiRoot(): string { return join(homedir(), '.agent-maintenance'); }
export function defaultRecordPath(root = defaultGuiRoot()): string { return join(root, 'server.lock'); }
export function defaultCoordinationPath(root = defaultGuiRoot()): string { return join(root, 'locks'); }

export async function ensurePrivateRuntimeRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || !['darwin', 'linux'].includes(platform())) throw new Error(`Private GUI lifecycle storage is unsupported for ${platform()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('GUI runtime root must be a real directory');
  const canonical = await realpath(root);
  if (process.getuid && info.uid !== process.getuid()) throw new Error('GUI runtime root is not owned by the current user');
  if ((info.mode & 0o777) !== 0o700) throw new Error('GUI runtime root must be private (mode 0700)');
  return canonical;
}

export async function readStoredRecord(path: string): Promise<StoredRecord | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o777) !== 0o600) {
    throw new Error('GUI instance record must be a private regular file owned by the current user');
  }
  if (info.size > MAX_RECORD_BYTES) throw new Error('GUI instance record exceeds the permitted size');
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) { throw new Error(`Cannot open the GUI instance record safely: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`); }
  let bytes: string;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) throw new Error('GUI instance record changed while opening');
    bytes = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const record = parseRecord(bytes);
  return Object.freeze({ record, fingerprint: createHash('sha256').update(bytes).digest('hex') });
}

export function parseRecord(serialized: string): GuiInstanceRecord {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error('GUI instance record is malformed; preserving it for manual recovery'); }
  if (!isRecord(value) || value.version !== 1 || typeof value.instanceId !== 'string' || !UUID.test(value.instanceId)
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.processStartTime !== 'string' || !value.processStartTime
    || !Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535
    || typeof value.authToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.authToken)
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error('GUI instance record has invalid fields; preserving it for manual recovery');
  }
  return Object.freeze({ version: 1, instanceId: value.instanceId, pid: value.pid as number,
    processStartTime: value.processStartTime, port: value.port as number, authToken: value.authToken, startedAt: value.startedAt });
}

export async function writeRecordAtomic(path: string, record: GuiInstanceRecord): Promise<void> {
  parseRecord(JSON.stringify(record));
  const directory = dirname(path); const temp = join(directory, `.server-${randomUUID()}.tmp`);
  const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temp).catch(() => undefined); throw error; }
  await handle.close();
  try { await chmod(temp, 0o600); await link(temp, path); await unlink(temp); await syncDirectory(directory, undefined, 'gui-instance-record'); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

export async function removeRecordIfUnchanged(path: string, expected: StoredRecord): Promise<boolean> {
  const current = await readStoredRecord(path);
  if (!current || current.fingerprint !== expected.fingerprint || current.record.instanceId !== expected.record.instanceId) return false;
  await unlink(path); await syncDirectory(dirname(path), undefined, 'gui-instance-record-remove'); return true;
}

export function makeInstanceRecord(fields: Omit<GuiInstanceRecord, 'version' | 'startedAt'>, now = new Date()): GuiInstanceRecord {
  return Object.freeze({ version: 1, ...fields, startedAt: now.toISOString() });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
