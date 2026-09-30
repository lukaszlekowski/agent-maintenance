import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { sessionId, type AgentId, type AgentRoot, type SchemaVersion, type SessionId, MaintenanceError } from '../types.ts';
import { adapterSchemaKey, type StorageFilesystemBackend, type StorageSafetyEvidence } from './safety.ts';
import { type FaultHook } from './durable-fs.ts';
import { REGISTRY_VERSION, type ArchiveCategory, type RegistryEntry, type StoragePathMapping, type StorageRegistry } from './schema.ts';

export interface StorageAdapter {
  readonly agentId: AgentId;
  readonly schema: SchemaVersion;
  inspectSafety(sessionId: string): Promise<StorageSafetyEvidence>;
  /** This callback must hold adapter-specific exclusion for all relevant writers until it resolves. */
  withExternalExclusion<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  snapshotPayload(sessionId: string): Promise<readonly StoragePathMapping[]>;
  readIndexState(sessionId: string): Promise<unknown>;
  planIndexRemoval(sessionId: string, before: unknown, action: Exclude<ArchiveCategory, 'temp'> | 'temp-move'): Promise<unknown>;
  /** Must apply the next index state only when current state equals expected, and durably verify the commit. */
  applyIndexState(sessionId: string, expected: unknown, next: unknown): Promise<void>;
}

export interface StorageEngineOptions {
  readonly storageRoot: string;
  readonly trustedRoots: readonly AgentRoot[];
  readonly tempRoot?: AgentRoot;
  readonly faultHook?: FaultHook;
  readonly backend?: StorageFilesystemBackend;
}

export interface ArchiveRecord {
  readonly participant?: 'session' | 'database';
  readonly archiveId: string;
  readonly txId: string;
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly category: ArchiveCategory;
  readonly createdAt: string;
  readonly status: RegistryEntry['status'];
  readonly rootId: string;
  readonly relativePath: string;
}

export interface ManagedDatabaseParticipant {
  readonly txId: string;
  readonly archiveId: string;
  readonly creationTxId: string;
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly schemaFingerprint: string;
  readonly boundary: 'controlled-test' | 'protected-production';
  writeArchive(bytes: Uint8Array): Promise<void>;
  readArchive(): Promise<Buffer>;
  writeJournal(value: unknown): Promise<void>;
  readJournal(): Promise<unknown | null>;
  setArchiveStatus(status: RegistryEntry['status']): Promise<void>;
}

export interface ManagedDatabaseRecoveryParticipant {
  recoverManagedTransactions(): Promise<readonly RecoveryDiagnostic[]>;
}

export interface ManagedDatabaseJournalRef { readonly txId: string; readonly archiveId: string; readonly sessionId: string }

export interface RecoveryDiagnostic {
  readonly txId: string;
  readonly archiveId: string;
  readonly state: string;
  readonly status: 'RECOVERED' | 'PENDING' | 'FAILED' | 'TERMINAL';
  readonly reasons: readonly string[];
}

export const ACTIVE_STATES = new Set(['INITIATED','STAGED','PUBLISH_INTENT','TARGET_PUBLISHED','INDEX_INTENT','INDEX_COMMITTED','DRAIN_INTENT','SOURCE_DRAINED','RECOVERY_PENDING']);
export const TERMINAL_STATES = new Set(['COMPLETED','ROLLED_BACK']);
export const ROOT_ID_STORAGE = 'MAINTENANCE';
export const ROOT_ID_TEMP = 'TEMP';

export function adapterSchemaId(schema: SchemaVersion): string {
  return adapterSchemaKey(schema);
}

export function posixRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function nativeRel(value: string): string { return value.split('/').join(requirePathSeparator()); }
export function requirePathSeparator(): string { return process.platform === 'win32' ? '\\' : '/'; }

export function categoryFor(action: Exclude<StorageAction, 'restore'>): ArchiveCategory {
  return action === 'archive' ? 'archived' : action === 'soft-delete' ? 'deleted' : 'temp';
}
export type StorageAction = 'archive' | 'soft-delete' | 'temp-move';

export function safeSessionId(value: string): SessionId { return sessionId(value); }

export function sameCreatedObject(a: { readonly dev: string; readonly ino: string }, b: { readonly dev: string; readonly ino: string }): boolean { return a.dev === b.dev && a.ino === b.ino; }

export function isNotFound(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

export async function readJson(path: string, code: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new MaintenanceError(code, 'Managed metadata file is not a bounded regular file');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof MaintenanceError) throw error;
    if (error instanceof SyntaxError) throw new MaintenanceError(code, 'Managed metadata JSON is malformed');
    throw new MaintenanceError(code, 'Cannot read managed metadata', { code: (error as NodeJS.ErrnoException).code });
  } finally { await handle?.close().catch(() => undefined); }
}

export function emptyRegistry(): StorageRegistry { return Object.freeze({ registryVersion: REGISTRY_VERSION, entries: Object.freeze([]), diagnostics: Object.freeze([]) }); }
