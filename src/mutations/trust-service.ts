import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MaintenanceError, type WorkspacePathState } from '../types.ts';
import { syncDirectory } from '../storage/durable-fs.ts';
import { requireMutationCapability, type MutationCapability } from './capabilities.ts';

export interface TrustConfigAdapter {
  readonly agentId: import('../types.ts').AgentId;
  readonly version: string;
  readonly configPath: string;
  readonly backupDirectory: string;
  readonly schemaFingerprint: string;
  readonly capability: MutationCapability;
  withExternalExclusion<T>(action: () => Promise<T>): Promise<T>;
  parse(text: string): unknown;
  cloneDocument(document: unknown): unknown;
  pathStates(document: unknown): readonly { readonly path: string; readonly state: WorkspacePathState }[];
  removePaths(document: unknown, paths: readonly string[]): unknown;
  serialize(document: unknown): string;
}

export interface TrustPruneDiff {
  readonly configPath: string;
  readonly expectedSha256: string;
  readonly paths: readonly string[];
}

export interface TrustConfigCommit {
  readonly configPath: string;
  readonly committed: boolean;
  readonly backupPath?: string;
  readonly removedPaths: readonly string[];
  readonly reason?: string;
}

export class TrustConfigService {
  private readonly adapter: TrustConfigAdapter;
  constructor(adapter: TrustConfigAdapter) { this.adapter = adapter; }
  get configPath(): string { return this.adapter.configPath; }

  async prune(confirm: (diff: TrustPruneDiff) => Promise<boolean>): Promise<TrustConfigCommit> {
    requireMutationCapability(this.adapter.capability, 'trust-edit', { adapterId: this.adapter.agentId, version: this.adapter.version,
      schemaKey: this.adapter.capability.schemaKey, boundary: this.adapter.capability.controlBoundary });
    if (this.adapter.capability.adapterId !== this.adapter.agentId || this.adapter.capability.version !== this.adapter.version
        || !this.adapter.capability.schemaKey.endsWith(`:${this.adapter.schemaFingerprint}`)) {
      throw new MaintenanceError('CAPABILITY_SCHEMA_MISMATCH', 'Trust edit evidence does not match the adapter identity, version, or config schema');
    }
    if (this.adapter.capability.controlBoundary !== 'controlled-test') throw new MaintenanceError('CAPABILITY_DISABLED', 'Production trust replacement remains disabled until protected-root object operations are validated');
    return this.adapter.withExternalExclusion(async () => {
      const snapshot = await readStableFile(this.adapter.configPath);
      const beforeDocument = this.adapter.parse(snapshot.text);
      const removals = Object.freeze([...new Set(this.adapter.pathStates(beforeDocument)
        .filter((entry) => entry.state === 'CONFIRMED_OBSOLETE').map((entry) => entry.path))].sort());
      const candidate = this.adapter.removePaths(this.adapter.cloneDocument(beforeDocument), removals);
      const output = this.adapter.serialize(candidate);
      const afterDocument = this.adapter.parse(output);
      if (!isDeepStrictEqual(candidate, afterDocument)) throw new MaintenanceError('TRUST_SCHEMA_ROUNDTRIP_FAILED', 'Serialized trust config does not preserve its parsed schema and values');
      const diff = Object.freeze({ configPath: this.adapter.configPath, expectedSha256: snapshot.sha256, paths: removals });
      if (!removals.length || !(await confirm(diff))) return Object.freeze({ configPath: this.adapter.configPath, committed: false, removedPaths: removals, reason: removals.length ? 'Pruning was cancelled' : 'No confirmed obsolete paths were found' });
      return this.commit(snapshot, diff, output);
    });
  }

  private async commit(snapshot: StableFile, diff: TrustPruneDiff, output: string): Promise<TrustConfigCommit> {
    const backupPath = join(this.adapter.backupDirectory, `${basename(this.adapter.configPath)}.${snapshot.sha256}.${randomUUID()}.bak`);
    await writeNewDurable(backupPath, snapshot.bytes, snapshot.mode);
    const tempPath = join(dirname(this.adapter.configPath), `.${basename(this.adapter.configPath)}.${randomUUID()}.tmp`);
    await writeNewDurable(tempPath, Buffer.from(output, 'utf8'), snapshot.mode);
    const stage = await readStableFile(tempPath);
    try {
      const latest = await readStableFile(this.adapter.configPath);
      if (latest.sha256 !== snapshot.sha256 || latest.identity !== snapshot.identity) {
        throw new MaintenanceError('TRUST_EXPECTED_STATE_CHANGED', 'Trust config changed after the pruning diff; backup was retained and no replacement was published');
      }
      await rename(tempPath, this.adapter.configPath);
      await syncDirectory(dirname(this.adapter.configPath), undefined, 'trust-config-replace');
    } catch (error) {
      await removeStageIfSame(tempPath, stage).catch(() => undefined);
      throw error;
    }
    const replaced = await readStableFile(this.adapter.configPath);
    if (replaced.text !== output) throw new MaintenanceError('TRUST_REPLACEMENT_UNVERIFIED', 'Replacement config does not match the confirmed pruning diff');
    return Object.freeze({ configPath: this.adapter.configPath, committed: true, backupPath, removedPaths: diff.paths });
  }
}

export async function pruneTrustConfigsIndependently(
  services: readonly TrustConfigService[], confirm: (diff: TrustPruneDiff) => Promise<boolean>,
): Promise<readonly TrustConfigCommit[]> {
  const commits: TrustConfigCommit[] = [];
  for (const service of services) {
    try { commits.push(await service.prune(confirm)); }
    catch (error) {
      commits.push(Object.freeze({ configPath: service.configPath, committed: false, removedPaths: Object.freeze([]),
        reason: error instanceof Error ? error.message : 'Trust config commit failed' }));
    }
  }
  return Object.freeze(commits);
}

interface StableFile { readonly bytes: Buffer; readonly text: string; readonly sha256: string; readonly identity: string; readonly mode: number }
async function readStableFile(path: string): Promise<StableFile> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new MaintenanceError('TRUST_CONFIG_UNSAFE_PATH', 'Trust config must be an existing regular file, not a symlink');
  const bytes = await readFile(path); const current = await lstat(path);
  if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs) {
    throw new MaintenanceError('TRUST_CONFIG_CHANGED_DURING_READ', 'Trust config changed while it was being inspected');
  }
  return Object.freeze({ bytes, text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex'),
    identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, mode: info.mode & 0o777 });
}

async function writeNewDurable(path: string, bytes: Buffer, mode = 0o600): Promise<void> {
  const handle = await open(path, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(dirname(path), undefined, `trust-file:${basename(path)}`);
}

async function removeStageIfSame(path: string, stage: StableFile): Promise<void> {
  const latest = await readStableFile(path);
  if (latest.identity !== stage.identity || latest.sha256 !== stage.sha256) return;
  const { unlink } = await import('node:fs/promises');
  await unlink(path);
  await syncDirectory(dirname(path), undefined, 'trust-stage-cleanup');
}
