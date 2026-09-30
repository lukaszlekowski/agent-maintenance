import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withMaintenanceLocks } from '../../../src/core/locks.ts';
import { atomicWriteJson } from '../../../src/storage/durable-fs.ts';
import type { AgentId, SchemaVersion } from '../../../src/types.ts';
import type { StorageAdapter } from '../../../src/storage/engine.ts';
import type { StoragePathMapping } from '../../../src/storage/schema.ts';
import type { StorageSafetyEvidence } from '../../../src/storage/safety.ts';

export class ControlledStorageAdapter implements StorageAdapter {
  readonly agentId: AgentId = 'codex_cli';
  readonly schema: SchemaVersion = Object.freeze({ name: 'controlled-test-index', version: '1' });
  readonly lockDirectory: string;
  readonly indexPath: string;
  readonly root: string;
  readonly mappings: readonly StoragePathMapping[];
  safety: Partial<StorageSafetyEvidence> = {};
  constructor(root: string, mapping: StoragePathMapping | readonly StoragePathMapping[]) {
    this.root = root; this.mappings = Array.isArray(mapping) ? mapping : [mapping as StoragePathMapping];
    this.lockDirectory = join(root, 'adapter-locks');
    this.indexPath = join(root, 'index.json');
  }
  async inspectSafety(sessionId: string): Promise<StorageSafetyEvidence> {
    return { agentId: this.agentId, sessionId, adapterSchema: `${this.schema.name}@${this.schema.version}:unfingerprinted`, observedAt: new Date().toISOString(), ownership: 'DORMANT', activity: 'QUIESCENT', ownershipEvidence: 'controlled-test-owner', activityEvidence: 'controlled-test-activity', externalWriterExclusion: { enabled: true, evidence: 'controlled-test-lock-held' }, raceSafeFileOperations: { enabled: true, evidence: 'controlled-test-private-root' }, ...this.safety } as StorageSafetyEvidence;
  }
  async withExternalExclusion<T>(_sessionId: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.lockDirectory, { recursive: true, mode: 0o700 });
    return withMaintenanceLocks(['launcher'], { lockDirectory: this.lockDirectory }, action);
  }
  async snapshotPayload(): Promise<readonly StoragePathMapping[]> { return this.mappings; }
  async readIndexState(sessionId: string): Promise<unknown> {
    void sessionId;
    try { return JSON.parse(await readFile(this.indexPath, 'utf8')) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async planIndexRemoval(_sessionId: string, before: unknown): Promise<unknown> {
    if (!before || typeof before !== 'object') throw new Error('missing controlled index');
    return { ...(before as Record<string, unknown>), present: false };
  }
  async applyIndexState(_sessionId: string, expected: unknown, next: unknown): Promise<void> {
    const current = await this.readIndexState('controlled');
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('controlled index compare-and-swap failed');
    await atomicWriteJson(this.indexPath, next, undefined, 'controlled-index');
  }
  async seedIndex(state: unknown): Promise<void> { await writeFile(this.indexPath, `${JSON.stringify(state)}\n`, { mode: 0o600 }); }
}
