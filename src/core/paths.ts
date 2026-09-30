import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MaintenanceError, type AgentRoot, type CapabilityDecision, type PathMapping, type WorkspacePathState } from '../types.ts';

export type MountEvidence = 'MOUNTED' | 'NOT_MOUNTED' | 'UNKNOWN';
export type MountProbe = (path: string) => Promise<MountEvidence>;

export interface PathProbeResult { readonly state: WorkspacePathState; readonly reason: string; }

function assertSafeRelativePath(value: string): void {
  if (!value || value.includes('\0') || isAbsolute(value) || value.split(/[\\/]+/).some((part) => part === '..')) {
    throw new MaintenanceError('UNSAFE_PATH_MAPPING', 'Path mapping must be relative and contain no traversal components');
  }
}

export async function resolveTrustedRoots(roots: readonly AgentRoot[]): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  for (const root of roots) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(root.id)) throw new MaintenanceError('UNKNOWN_ROOT_ID', `Invalid trusted root identifier: ${root.id}`);
    if (!isAbsolute(root.path)) throw new MaintenanceError('ROOT_NOT_ABSOLUTE', `Trusted root ${root.id} must be absolute`);
    let canonical: string;
    try { canonical = await realpath(root.path); }
    catch (error) { throw new MaintenanceError('TRUSTED_ROOT_UNAVAILABLE', `Trusted root ${root.id} cannot be resolved`, { cause: (error as NodeJS.ErrnoException).code }); }
    if (!(await stat(canonical)).isDirectory()) throw new MaintenanceError('TRUSTED_ROOT_NOT_DIRECTORY', `Trusted root ${root.id} is not a directory`);
    if (result.has(root.id)) throw new MaintenanceError('DUPLICATE_ROOT_ID', `Trusted root ${root.id} is duplicated`);
    result.set(root.id, canonical);
  }
  return result;
}

export function canonicalizePath(input: string): string {
  if (!isAbsolute(input) || input.includes('\0')) throw new MaintenanceError('INVALID_PATH', 'Canonical path input must be absolute and contain no NUL bytes');
  return resolve(input);
}

/** Resolve a target or its nearest existing parent so symlinked ancestors are reflected. */
export async function canonicalPathWithMissingTail(input: string): Promise<string> {
  const absolute = canonicalizePath(input);
  let cursor = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const actual = await realpath(cursor);
      return resolve(actual, ...tail.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new MaintenanceError('PATH_CANONICALIZATION_FAILED', `Cannot resolve path ancestor ${cursor}`, { code });
      try {
        const entry = await lstat(cursor);
        if (entry.isSymbolicLink()) throw new MaintenanceError('BROKEN_OR_UNRESOLVABLE_SYMLINK', `Cannot canonicalize symbolic link ${cursor}`);
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== 'ENOENT' && lstatCode !== 'ENOTDIR') throw lstatError;
      }
      const parent = resolve(cursor, '..');
      if (parent === cursor) throw new MaintenanceError('PATH_CANONICALIZATION_FAILED', 'No existing ancestor was found');
      tail.push(cursor.slice(parent.length).replace(/^[/\\]/, ''));
      cursor = parent;
    }
  }
}

export function isContained(canonicalRoot: string, canonicalTarget: string): boolean {
  const rel = relative(canonicalRoot, canonicalTarget);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function resolveMappedPath(roots: ReadonlyMap<string, string>, mapping: PathMapping): Promise<string> {
  assertSafeRelativePath(mapping.relativePath);
  const root = roots.get(mapping.baseRoot);
  if (!root) throw new MaintenanceError('UNKNOWN_ROOT', `Path references unknown trusted root ${mapping.baseRoot}`);
  const target = resolve(root, mapping.relativePath);
  if (!isContained(root, target)) throw new MaintenanceError('PATH_ESCAPES_ROOT', 'Mapped path escapes its trusted root');
  const canonicalTarget = await canonicalPathWithMissingTail(target);
  if (!isContained(root, canonicalTarget)) throw new MaintenanceError('PATH_ESCAPES_ROOT', 'Mapped path escapes its trusted root through a symlink');
  return canonicalTarget;
}

async function nearestAccessibleDirectory(target: string): Promise<string | null> {
  let cursor = resolve(target, '..');
  while (true) {
    try {
      const info = await stat(cursor);
      return info.isDirectory() ? cursor : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = resolve(cursor, '..');
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

export async function probeWorkspacePath(path: string, mountProbe?: MountProbe): Promise<PathProbeResult> {
  if (!isAbsolute(path)) return Object.freeze({ state: 'INACCESSIBLE', reason: 'Path is not absolute' });
  try {
    const info = await stat(path);
    return info.isDirectory()
      ? Object.freeze({ state: 'VALID', reason: 'Accessible directory confirmed' })
      : Object.freeze({ state: 'INACCESSIBLE', reason: 'Existing target is not a directory' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return Object.freeze({ state: 'INACCESSIBLE', reason: `Path probe failed with ${code ?? 'unknown error'}` });
    const ancestor = await nearestAccessibleDirectory(path);
    if (!ancestor) return Object.freeze({ state: 'INACCESSIBLE', reason: 'No accessible parent directory confirms the target is absent' });
    if (mountProbe) {
      const mount = await mountProbe(path).catch(() => 'UNKNOWN' as const);
      if (mount === 'NOT_MOUNTED') return Object.freeze({ state: 'UNAVAILABLE_VOLUME', reason: 'Mount probe confirms the required volume is unavailable' });
      if (mount === 'UNKNOWN') return Object.freeze({ state: 'INACCESSIBLE', reason: 'Volume availability could not be determined' });
    }
    return Object.freeze({ state: 'CONFIRMED_OBSOLETE', reason: 'Accessible parent and ENOENT/ENOTDIR confirm the target is absent' });
  }
}

export const RACE_SAFE_FILE_OPERATIONS: CapabilityDecision = Object.freeze({
  enabled: false,
  reason: 'No Phase 0 evidence validates handle-relative, no-follow mutation support for this platform and filesystem',
});

export function requireRaceSafeMutation(): never {
  throw new MaintenanceError('CAPABILITY_DISABLED', RACE_SAFE_FILE_OPERATIONS.reason);
}

/** Diagnostic only: lstat reports a final symlink but does not close ancestor replacement races. */
export async function finalComponentIsSymlink(path: string): Promise<boolean> {
  try { return (await lstat(path)).isSymbolicLink(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
