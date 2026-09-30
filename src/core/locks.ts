import { constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { platform } from 'node:os';
import { MaintenanceError } from '../types.ts';

export type LockName = 'maintenance' | 'launcher';
const ORDER: Readonly<Record<LockName, number>> = Object.freeze({ maintenance: 10, launcher: 20 });
const heldLocks = new AsyncLocalStorage<readonly LockName[]>();
type FlockAddon = { flock(fd: number, flags: 'exnb' | 'un', callback: (error?: NodeJS.ErrnoException | null) => void): void };
let addon: Promise<FlockAddon> | undefined;

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly lockDirectory: string;
}

export function supportsKernelFileLocks(os: NodeJS.Platform = platform()): boolean {
  return os === 'darwin' || os === 'linux';
}

const LOCAL_FS_TYPES = new Set([
  'apfs', 'hfs', 'ufs', 'devfs', 'tmpfs', 'ramfs', 'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'zfs',
  'vfat', 'msdos', 'exfat', 'ntfs3', 'overlay', 'proc',
]);

function isWithin(parent: string, target: string): boolean {
  const child = relative(parent, target);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function isSupportedLocalLockFilesystem(type: string): boolean {
  return LOCAL_FS_TYPES.has(type.toLowerCase());
}

async function assertLocalLockFilesystem(path: string): Promise<void> {
  let entries: Array<{ mountPoint: string; type: string }>;
  if (platform() === 'linux') {
    let data: string;
    try { data = await readFile('/proc/self/mountinfo', 'utf8'); }
    catch (error) { throw new MaintenanceError('LOCK_FILESYSTEM_UNKNOWN', 'Cannot inspect Linux mount table; lock backend is disabled', { code: (error as NodeJS.ErrnoException).code }); }
    entries = data.split(/\r?\n/).flatMap((line) => {
      const [left, right] = line.split(' - ');
      const mountPoint = left?.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
      const type = right?.split(' ')[0];
      return mountPoint && type ? [{ mountPoint, type }] : [];
    });
  } else {
    const result = spawnSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5_000, maxBuffer: 2_000_000 });
    if (result.error || result.status !== 0) {
      throw new MaintenanceError('LOCK_FILESYSTEM_UNKNOWN', 'Cannot inspect macOS mount table; lock backend is disabled', { cause: result.error?.message ?? result.stderr.trim() });
    }
    entries = result.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(.+) on (.+) \(([^,]+)(?:,([^)]*))?\)$/);
      if (!match) return [];
      const mountPoint = match[2]!.replace(/\\([0-7]{3})/g, (_full, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
      const flags = match[4] ?? '';
      return flags.split(',').some((flag) => flag.trim() === 'local') ? [{ mountPoint, type: match[3]! }] : [{ mountPoint, type: 'remote-or-unknown' }];
    });
  }
  const mount = entries.filter((entry) => isWithin(entry.mountPoint, path)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  if (!mount || !isSupportedLocalLockFilesystem(mount.type)) {
    throw new MaintenanceError('LOCK_FILESYSTEM_UNSUPPORTED', `Kernel lock filesystem ${mount?.type ?? 'unknown'} is not in the validated local-filesystem set`);
  }
}

function loadFlockAddon(): Promise<FlockAddon> {
  addon ??= import('fs-ext').then((native) => {
    if (typeof native.flock !== 'function') throw new Error('fs-ext does not export flock');
    return native as unknown as FlockAddon;
  }).catch((error: unknown) => {
    addon = undefined;
    throw new MaintenanceError('LOCK_BACKEND_UNAVAILABLE', 'The fs-ext kernel-lock binding is unavailable; maintenance operations are disabled', {
      cause: error instanceof Error ? error.message : String(error),
    });
  });
  return addon;
}

async function flock(fd: number, flag: 'exnb' | 'un'): Promise<void> {
  const native = await loadFlockAddon();
  return new Promise((resolveFlock, rejectFlock) => {
    native.flock(fd, flag, (error) => error ? rejectFlock(error) : resolveFlock());
  });
}

function checkOrder(names: readonly LockName[]): void {
  const current = heldLocks.getStore() ?? [];
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new MaintenanceError('INVALID_LOCK_REQUEST', 'Lock requests must contain unique lock names');
  }
  if (names.includes('launcher') && !current.includes('maintenance') && !names.includes('maintenance')) {
    throw new MaintenanceError('LOCK_ORDER_VIOLATION', 'Launcher coordination must acquire maintenance before launcher');
  }
  const highest = current.reduce((value, name) => Math.max(value, ORDER[name]), 0);
  let previous = highest;
  for (const name of names) {
    if (ORDER[name] <= previous) {
      throw new MaintenanceError('LOCK_ORDER_VIOLATION', 'Acquire locks in maintenance then launcher order', { held: current, requested: names });
    }
    previous = ORDER[name];
  }
}

async function trustedLockDirectory(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new MaintenanceError('LOCK_PATH_NOT_ABSOLUTE', 'Lock directory must be an explicit absolute path');
  const directory = resolve(input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new MaintenanceError('UNSAFE_LOCK_DIRECTORY', 'Lock path is not a directory');
  if ((info.mode & 0o022) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new MaintenanceError('UNSAFE_LOCK_DIRECTORY', 'Lock directory must be owned by the current user and not writable by group or others');
  }
  await assertLocalLockFilesystem(canonical);
  return canonical;
}

async function acquire(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
  const os = platform();
  if (!supportsKernelFileLocks(os)) {
    throw new MaintenanceError('LOCKING_UNSUPPORTED', `Kernel file locking is not implemented for ${os}; maintenance actions are disabled`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new MaintenanceError('INVALID_LOCK_TIMEOUT', 'Lock timeout must be non-negative');

  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const info = await handle.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) {
      throw new MaintenanceError('UNSAFE_LOCK_FILE', 'Lock file must be a private regular file owned by the current user');
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('LOCK_OPEN_FAILED', `Cannot safely open lock file ${lockPath}`, { code: (error as NodeJS.ErrnoException).code });
  }

  const lockHandle = handle;
  if (!lockHandle) throw new MaintenanceError('LOCK_OPEN_FAILED', 'Lock file handle was not created');
  const deadline = performance.now() + timeoutMs;
  try {
    for (;;) {
      try {
        await flock(lockHandle.fd, 'exnb');
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EWOULDBLOCK' && code !== 'EAGAIN') throw error;
        if (timeoutMs === 0 || performance.now() >= deadline) {
          throw new MaintenanceError('LOCK_TIMEOUT', 'Timed out waiting for the OS-backed maintenance lock', { timeoutMs });
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10, Math.max(1, deadline - performance.now()))));
      }
    }
  } catch (error) {
    await lockHandle.close().catch(() => undefined);
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('LOCK_ACQUISITION_FAILED', `Could not acquire kernel lock ${lockPath}`, { code: (error as NodeJS.ErrnoException).code });
  }

  // The Node process running the protected callback owns both this FileHandle and flock.
  // If that process exits, its callback stops and the kernel releases the lock together.
  return async () => {
    try { await flock(lockHandle.fd, 'un'); }
    finally { await lockHandle.close(); }
  };
}

/** Serialize this tool's writers across processes. This lock never claims to exclude agent-native writers. */
export async function withMaintenanceLocks<T>(
  names: readonly LockName[], options: LockOptions, action: () => Promise<T>,
): Promise<T> {
  const requested = [...names];
  checkOrder(requested);
  if (!supportsKernelFileLocks()) {
    throw new MaintenanceError('LOCKING_UNSUPPORTED', `Kernel file locking is not implemented for ${platform()}; maintenance actions are disabled`);
  }
  await loadFlockAddon();
  const directory = await trustedLockDirectory(options.lockDirectory);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const releases: Array<() => Promise<void>> = [];
  const inherited = heldLocks.getStore() ?? [];
  try {
    for (const name of requested) releases.push(await acquire(join(directory, `${name}.lock`), timeoutMs));
    return await heldLocks.run([...inherited, ...requested], action);
  } finally {
    for (const release of releases.reverse()) await release();
  }
}
