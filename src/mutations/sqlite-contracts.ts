import type { DatabaseSync } from 'node:sqlite';
import type { MutationCapability } from './capabilities.ts';
import type { AgentId } from '../types.ts';

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqliteTableContract {
  readonly name: string;
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
}

export interface ClosureTable {
  readonly name: string;
  readonly rows: readonly Readonly<Record<string, SqlValue>>[];
}

export interface RelationalSessionAdapter {
  readonly agentId: AgentId;
  readonly version: string;
  readonly databasePath: string;
  readonly schemaFingerprint: string;
  readonly tablesInRestoreOrder: readonly SqliteTableContract[];
  readonly capability: MutationCapability;
  inspectOwnership(sessionId: string): Promise<'ACTIVE' | 'DORMANT' | 'UNKNOWN'>;
  withExternalExclusion<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  openDatabase(): DatabaseSync;
  captureClosure(database: DatabaseSync, sessionId: string): readonly ClosureTable[];
}

export interface DatabaseArchive {
  readonly formatVersion: 1;
  readonly archiveId: string;
  readonly creationTransactionId: string;
  readonly agentId: AgentId;
  readonly adapterVersion: string;
  readonly schemaFingerprint: string;
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly integrityHash: string;
  readonly tables: readonly ClosureTable[];
}

export type DatabaseTransactionState = 'PREPARED' | 'DB_COMMITTED' | 'RESTORE_COMMITTED' | 'ABORTED' | 'RECOVERY_PENDING';

export interface DatabaseTransactionJournal {
  readonly formatVersion: 1;
  readonly adapterId: AgentId;
  readonly adapterVersion: string;
  readonly transactionId: string;
  readonly archiveId: string;
  readonly creationTransactionId: string;
  readonly action: 'export-delete' | 'restore';
  readonly sessionId: string;
  readonly schemaFingerprint: string;
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
  readonly archiveHash?: string;
  readonly state: DatabaseTransactionState;
  readonly updatedAt: string;
  readonly reason?: string;
}

export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQLite identifier ${value}`);
  return `"${value}"`;
}
