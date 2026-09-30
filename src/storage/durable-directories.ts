import { mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, relative, isAbsolute, sep } from 'node:path';
import { MaintenanceError } from '../types.ts';
import type { ObjectIdentity } from './schema.ts';

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function directoryIdentity(path: string): Promise<ObjectIdentity> {
  const s = await lstat(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) throw new MaintenanceError('STORAGE_OBJECT_INVALID', 'Expected a real directory');
  return Object.freeze({ dev: String(s.dev), ino: String(s.ino), size: Number(s.size), mtimeNs: String(s.mtimeNs), mode: Number(s.mode & 0o777n) });
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new MaintenanceError('STORAGE_DIRECTORY_UNSAFE', 'Managed storage directories must be real, current-user-owned, and private');
  }
  const canonical = await realpath(path);
  if (!contained(await realpath(dirname(path)), canonical)) throw new MaintenanceError('STORAGE_PATH_ESCAPE', 'Managed storage directory escaped its configured parent');
}

