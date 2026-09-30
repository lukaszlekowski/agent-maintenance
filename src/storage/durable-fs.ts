import { constants as fsConstants } from 'node:fs';
import { open, link, unlink, rename, mkdir, lstat, realpath, stat, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute, dirname, join, relative, sep } from 'node:path';
import { platform } from 'node:os';
import { MaintenanceError } from '../types.ts';
import { isObjectIdentity, type ObjectIdentity } from './schema.ts';

export type OperationFault =
  | { readonly kind: 'error'; readonly code: 'ENOSPC' | 'EACCES' | 'EXDEV' }
  | { readonly kind: 'short-write'; readonly maximumBytes: number };
export type DurableOperation = 'write' | 'sync' | 'publish' | 'unlink';
export type FaultHook = ((boundary: string) => void | Promise<void>) & {
  readonly injectOperation?: (operation: DurableOperation, path: string) => OperationFault | undefined | Promise<OperationFault | undefined>;
};

async function operationFault(hook: FaultHook | undefined, operation: DurableOperation, path: string): Promise<OperationFault | undefined> {
  return hook?.injectOperation?.(operation, path);
}

export async function injectOperationError(hook: FaultHook | undefined, operation: DurableOperation, path: string): Promise<void> {
  throwInjected(await operationFault(hook, operation, path));
}

function throwInjected(fault: OperationFault | undefined): void {
  if (fault?.kind !== 'error') return;
  throw Object.assign(new Error(`Injected ${fault.code} at durable ${fault.code === 'EXDEV' ? 'publish' : 'filesystem'} operation`), { code: fault.code });
}

export async function checkpoint(hook: FaultHook | undefined, boundary: string): Promise<void> {
  await hook?.(boundary);
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function mountInfo(path: string): { readonly mountPoint: string; readonly type: string; readonly local: boolean } {
  if (platform() !== 'darwin') throw new MaintenanceError('DURABILITY_UNSUPPORTED', `Durable transaction writes are not validated on ${platform()}`);
  const result = spawnSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5_000, maxBuffer: 2_000_000 });
  if (result.error || result.status !== 0) throw new MaintenanceError('DURABILITY_FILESYSTEM_UNKNOWN', 'Cannot inspect macOS mount table; storage mutations are disabled');
  const rows = result.stdout.split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^(.+) on (.+) \(([^,]+)(?:,([^)]*))?\)$/);
    if (!m) return [];
    const mountPoint = m[2]!.replace(/\\([0-7]{3})/g, (_full, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    return [{ mountPoint, type: m[3]!, local: (m[4] ?? '').split(',').some((part) => part.trim() === 'local') }];
  }).filter((entry) => contained(entry.mountPoint, path)).sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  const best = rows[0];
  if (!best) throw new MaintenanceError('DURABILITY_FILESYSTEM_UNKNOWN', `Cannot identify filesystem for ${path}`);
  return best;
}

/** Phase 3 enables only local APFS on macOS where fsync and link no-replace are validated. */
export async function assertDurableRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new MaintenanceError('STORAGE_ROOT_INVALID', 'Storage root must be absolute');
  const canonical = await realpath(path).catch((error: unknown) => {
    throw new MaintenanceError('STORAGE_ROOT_UNAVAILABLE', 'Storage root cannot be resolved', { code: (error as NodeJS.ErrnoException).code });
  });
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new MaintenanceError('STORAGE_ROOT_INVALID', 'Storage root must be a directory');
  const mount = mountInfo(canonical);
  if (mount.type !== 'apfs' || !mount.local) throw new MaintenanceError('DURABILITY_FILESYSTEM_UNSUPPORTED', `Storage mutation requires local APFS; found ${mount.type}${mount.local ? '' : ' non-local'}`);
  return canonical;
}

export async function syncDirectory(path: string, hook?: FaultHook, label = 'directory'): Promise<void> {
  await checkpoint(hook, `before-sync:${label}`);
  throwInjected(await operationFault(hook, 'sync', path));
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isDirectory()) throw new MaintenanceError('DURABILITY_SYNC_FAILED', `Sync target ${label} is not a directory`);
    await handle.sync();
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('DURABILITY_SYNC_FAILED', `Cannot sync directory ${label}`, { code: (error as NodeJS.ErrnoException).code });
  } finally { await handle?.close().catch(() => undefined); }
  await checkpoint(hook, `after-sync:${label}`);
}

export async function syncFile(path: string, hook?: FaultHook, label = 'file'): Promise<void> {
  await checkpoint(hook, `before-sync:${label}`);
  throwInjected(await operationFault(hook, 'sync', path));
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) throw new MaintenanceError('DURABILITY_SYNC_FAILED', `Sync target ${label} is not a regular file`);
    await handle.sync();
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('DURABILITY_SYNC_FAILED', `Cannot sync file ${label}`, { code: (error as NodeJS.ErrnoException).code });
  } finally { await handle?.close().catch(() => undefined); }
  await checkpoint(hook, `after-sync:${label}`);
}

export async function readIdentity(path: string): Promise<ObjectIdentity> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const s = await handle.stat({ bigint: true });
    if (!s.isFile()) throw new MaintenanceError('STORAGE_OBJECT_INVALID', 'Storage payloads must be regular files');
    return Object.freeze({ dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeNs: String(s.mtimeNs), mode: Number(s.mode & 0o777n) });
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('STORAGE_OBJECT_READ_FAILED', 'Cannot inspect storage file identity', { code: (error as NodeJS.ErrnoException).code });
  } finally { await handle?.close().catch(() => undefined); }
}

export function sameIdentity(a: ObjectIdentity, b: ObjectIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.mode === b.mode;
}

export async function hashFile(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new MaintenanceError('STORAGE_OBJECT_INVALID', 'Storage payloads must be regular files');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(256 * 1024); let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new MaintenanceError('STORAGE_OBJECT_CHANGED', 'Storage file changed while it was being read');
    }
    return Object.freeze({ sha256: hash.digest('hex'), bytes });
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('STORAGE_OBJECT_READ_FAILED', 'Cannot hash storage file', { code: (error as NodeJS.ErrnoException).code });
  } finally { await handle?.close().catch(() => undefined); }
}

export async function copyToExclusive(source: string, target: string, expected: ObjectIdentity, mode: number, hook: FaultHook | undefined, label: string,
  onCreated: (identity: ObjectIdentity) => Promise<void>): Promise<{ readonly identity: ObjectIdentity; readonly sha256: string; readonly bytes: number }> {
  await checkpoint(hook, `before-side-effect:${label}:create`);
  let src: FileHandle | undefined; let dst: FileHandle | undefined;
  const hash = createHash('sha256'); let bytes = 0;
  try {
    src = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const initial = await src.stat({ bigint: true });
    const actual: ObjectIdentity = Object.freeze({ dev: String(initial.dev), ino: String(initial.ino), size: Number(initial.size), mtimeNs: String(initial.mtimeNs), mode: Number(initial.mode & 0o777n) });
    if (!initial.isFile() || !sameIdentity(actual, expected)) throw new MaintenanceError('SOURCE_CHANGED', `Source ${label} changed before staging`);
    dst = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const created = await dst.stat({ bigint: true });
    const createdIdentity: ObjectIdentity = Object.freeze({ dev: String(created.dev), ino: String(created.ino), size: Number(created.size), mtimeNs: String(created.mtimeNs), mode: Number(created.mode & 0o777n) });
    await syncDirectory(dirname(target), hook, `${label}:stage-created`);
    await onCreated(createdIdentity);
    await checkpoint(hook, `after-side-effect:${label}:create`);
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const { bytesRead } = await src.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const fault = await operationFault(hook, 'write', target);
        throwInjected(fault);
        const requested = fault?.kind === 'short-write' ? Math.min(bytesRead - offset, Math.max(1, fault.maximumBytes)) : bytesRead - offset;
        const { bytesWritten } = await dst.write(buffer, offset, requested, null);
        if (!bytesWritten) throw new MaintenanceError('STORAGE_WRITE_FAILED', `Short write while staging ${label}`);
        offset += bytesWritten;
      }
      bytes += bytesRead;
    }
    const finalSource = await src.stat({ bigint: true });
    if (initial.dev !== finalSource.dev || initial.ino !== finalSource.ino || initial.size !== finalSource.size || initial.mtimeNs !== finalSource.mtimeNs) {
      throw new MaintenanceError('SOURCE_CHANGED', `Source ${label} changed while staging`);
    }
    await dst.chmod(mode & 0o777);
    await checkpoint(hook, `before-sync:${label}:file`);
    await dst.sync();
    const identity = await identityFromHandle(dst);
    await onCreated(identity);
    await checkpoint(hook, `after-sync:${label}:file`);
    await syncDirectory(dirname(target), hook, `${label}:stage-content`);
    await checkpoint(hook, `after-side-effect:${label}:write`);
    return Object.freeze({ identity, sha256: hash.digest('hex'), bytes });
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('STORAGE_COPY_FAILED', `Could not stage ${label}`, { code: (error as NodeJS.ErrnoException).code });
  } finally { await dst?.close().catch(() => undefined); await src?.close().catch(() => undefined); }
}

async function identityFromHandle(handle: FileHandle): Promise<ObjectIdentity> {
  const s = await handle.stat({ bigint: true });
  if (!s.isFile()) throw new MaintenanceError('STORAGE_OBJECT_INVALID', 'Staged object is not a regular file');
  return Object.freeze({ dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeNs: String(s.mtimeNs), mode: Number(s.mode & 0o777n) });
}

export async function publishNoReplace(stage: string, target: string, hook: FaultHook | undefined, label: string): Promise<void> {
  await checkpoint(hook, `before-side-effect:${label}:publish`);
  throwInjected(await operationFault(hook, 'publish', target));
  try { await link(stage, target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new MaintenanceError('DESTINATION_COLLISION', `Destination already exists for ${label}`);
    if (code === 'EXDEV') throw new MaintenanceError('NO_REPLACE_UNSUPPORTED', `No-replace publication crossed filesystems for ${label}`);
    throw new MaintenanceError('PUBLISH_FAILED', `Could not publish ${label}`, { code });
  }
  await checkpoint(hook, `after-side-effect:${label}:publish`);
  await syncDirectory(dirname(target), hook, `${label}:published`);
}

export async function removeIfSame(path: string, expected: ObjectIdentity, expectedHash: string, hook: FaultHook | undefined, label: string): Promise<boolean> {
  let current: ObjectIdentity;
  try { current = await readIdentity(path); }
  catch (error) {
    if ((error as MaintenanceError).code === 'STORAGE_OBJECT_READ_FAILED' && (error as MaintenanceError).details?.code === 'ENOENT') return false;
    throw error;
  }
  if (!sameIdentity(current, expected)) throw new MaintenanceError('OBJECT_CHANGED', `Refusing to remove changed transaction object ${label}`);
  const hash = await hashFile(path);
  if (hash.sha256 !== expectedHash || hash.bytes !== current.size) throw new MaintenanceError('OBJECT_CHANGED', `Refusing to remove transaction object with changed content ${label}`);
  await checkpoint(hook, `before-side-effect:${label}:unlink`);
  throwInjected(await operationFault(hook, 'unlink', path));
  await unlink(path);
  await checkpoint(hook, `after-side-effect:${label}:unlink`);
  await syncDirectory(dirname(path), hook, `${label}:unlinked`);
  return true;
}

export async function atomicWriteJson(path: string, value: unknown, hook: FaultHook | undefined, label: string): Promise<ObjectIdentity> {
  const parent = dirname(path); const temp = join(parent, `.${randomUUID()}.tmp`);
  const contents = `${JSON.stringify(value)}\n`;
  let handle: FileHandle | undefined;
  await checkpoint(hook, `before-side-effect:${label}:write-temp`);
  try {
    handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    throwInjected(await operationFault(hook, 'write', temp));
    await handle.writeFile(contents, 'utf8');
    await checkpoint(hook, `before-sync:${label}:file`);
    await handle.sync();
    await checkpoint(hook, `after-sync:${label}:file`);
    const identity = await identityFromHandle(handle);
    await handle.close(); handle = undefined;
    await rename(temp, path);
    await checkpoint(hook, `after-side-effect:${label}:rename`);
    await syncDirectory(parent, hook, `${label}:published`);
    return identity;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('DURABLE_WRITE_FAILED', `Could not persist ${label}`, { code: (error as NodeJS.ErrnoException).code });
  }
}

export async function writeNewJson(path: string, value: unknown, hook: FaultHook | undefined, label: string): Promise<ObjectIdentity> {
  const parent = dirname(path);
  let handle: FileHandle | undefined;
  await checkpoint(hook, `before-side-effect:${label}:create`);
  try {
    handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    throwInjected(await operationFault(hook, 'write', path));
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await checkpoint(hook, `before-sync:${label}:file`);
    await handle.sync();
    await checkpoint(hook, `after-sync:${label}:file`);
    const identity = await identityFromHandle(handle);
    await handle.close(); handle = undefined;
    await syncDirectory(parent, hook, `${label}:published`);
    await checkpoint(hook, `after-side-effect:${label}:create`);
    return identity;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('DURABLE_CREATE_FAILED', `Could not create immutable ${label}`, { code: (error as NodeJS.ErrnoException).code });
  }
}

export async function reserveDirectoryNoReplace(path: string, hook: FaultHook | undefined, label: string): Promise<ObjectIdentity> {
  await checkpoint(hook, `before-side-effect:${label}:mkdir`);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MaintenanceError('RESERVATION_COLLISION', `Archive ID collision at ${label}`);
    throw new MaintenanceError('RESERVATION_FAILED', `Could not reserve ${label}`, { code: (error as NodeJS.ErrnoException).code });
  }
  await checkpoint(hook, `after-side-effect:${label}:mkdir`);
  const st = await lstat(path, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink()) throw new MaintenanceError('RESERVATION_UNSAFE', `Reserved ${label} is not a real directory`);
  const identity: ObjectIdentity = Object.freeze({ dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeNs: String(st.mtimeNs), mode: Number(st.mode & 0o777n) });
  await syncDirectory(dirname(path), hook, `${label}:parent`);
  return identity;
}

export function identityIsValid(value: unknown): value is ObjectIdentity { return isObjectIdentity(value); }
