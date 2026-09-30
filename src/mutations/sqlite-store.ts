import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MaintenanceError } from '../types.ts';
import type { StorageTransactionEngine } from '../storage/engine.ts';
import type { ManagedDatabaseParticipant, ManagedDatabaseRecoveryParticipant, RecoveryDiagnostic } from '../storage/contracts.ts';
import { requireMutationCapability } from './capabilities.ts';
import { actualSchemaFingerprint, buildArchive, closureFingerprint, encodeArchive, insertClosure, parseDatabaseArchive, validateClosure } from './sqlite-codec.ts';
import { quoteIdentifier, type DatabaseArchive, type DatabaseTransactionJournal, type RelationalSessionAdapter, type SqlValue } from './sqlite-contracts.ts';

export interface DatabaseExportResult { readonly archive: DatabaseArchive; readonly archiveId: string; readonly transactionId: string }
export type DatabaseFaultHook = (boundary: string) => void | Promise<void>;

export class SqliteDependencyStore implements ManagedDatabaseRecoveryParticipant {
  private readonly adapter: RelationalSessionAdapter;
  private readonly coordinator: StorageTransactionEngine;
  private readonly faultHook: DatabaseFaultHook | undefined;
  constructor(adapter: RelationalSessionAdapter, coordinator: StorageTransactionEngine, faultHook?: DatabaseFaultHook) {
    this.adapter = adapter; this.coordinator = coordinator; this.faultHook = faultHook;
    coordinator.registerDatabaseRecoveryParticipant(`${adapter.agentId}:${adapter.version}`, this);
  }

  async recoverManagedTransactions(): Promise<readonly RecoveryDiagnostic[]> {
    const refs = await this.coordinator.listDatabaseJournalRefs(this.adapter.agentId);
    const results: RecoveryDiagnostic[] = [];
    for (const ref of refs) {
      try {
        const journal = await this.recover(ref.sessionId, ref.archiveId, ref.txId);
        const terminal = journal.state === 'DB_COMMITTED' || journal.state === 'RESTORE_COMMITTED' || journal.state === 'ABORTED';
        results.push(Object.freeze({ txId: journal.transactionId, archiveId: journal.archiveId, state: journal.state,
          status: terminal ? 'RECOVERED' : 'PENDING', reasons: Object.freeze(journal.reason ? [journal.reason] : []) }));
      } catch (error) {
        results.push(Object.freeze({ txId: ref.txId, archiveId: ref.archiveId, state: 'RECOVERY_PENDING', status: 'PENDING',
          reasons: Object.freeze([error instanceof Error ? error.message : 'Database participant recovery failed']) }));
      }
    }
    return Object.freeze(results);
  }

  async exportAndDelete(sessionId: string): Promise<DatabaseExportResult> {
    this.assertCapability(this.coordinator.mutationBoundary);
    return this.coordinator.withDatabaseParticipant({ sessionId, operation: 'create', schemaFingerprint: this.adapter.schemaFingerprint }, async (participant) =>
      this.adapter.withExternalExclusion(sessionId, async () => this.exportLocked(sessionId, participant)));
  }

  async restore(sessionId: string, archiveId: string): Promise<string> {
    this.assertCapability(this.coordinator.mutationBoundary);
    return this.coordinator.withDatabaseParticipant({ sessionId, operation: 'restore', archiveId, schemaFingerprint: this.adapter.schemaFingerprint }, async (participant) =>
      this.adapter.withExternalExclusion(sessionId, async () => this.restoreLocked(sessionId, participant)));
  }

  async recover(sessionId: string, archiveId: string, transactionId: string): Promise<DatabaseTransactionJournal> {
    this.assertCapability(this.coordinator.mutationBoundary);
    return this.coordinator.withDatabaseParticipant({ sessionId, operation: 'recover', archiveId, txId: transactionId, schemaFingerprint: this.adapter.schemaFingerprint }, async (participant) =>
      this.adapter.withExternalExclusion(sessionId, async () => this.recoverLocked(participant)));
  }

  private async exportLocked(sessionId: string, participant: ManagedDatabaseParticipant): Promise<DatabaseExportResult> {
    await requireDormant(this.adapter, sessionId);
    const database = this.openCheckedDatabase(); let transactionOpen = false; let archiveWritten = false;
    let journal: DatabaseTransactionJournal | undefined; let terminalJournalWritten = false;
    try {
      database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE'); transactionOpen = true;
      const archive = buildArchive(this.adapter, participant.archiveId, participant.creationTxId, sessionId, this.adapter.captureClosure(database, sessionId));
      const beforeFingerprint = closureFingerprint(archive.tables);
      const afterFingerprint = closureFingerprint(emptyClosure(this.adapter));
      const bytes = encodeArchive(archive); const archiveHash = createHash('sha256').update(bytes).digest('hex');
      journal = makeJournal(this.adapter, participant, 'export-delete', beforeFingerprint, afterFingerprint, archiveHash);
      await participant.writeJournal(journal); await this.checkpoint('after-intent:db-delete');
      await participant.writeArchive(Buffer.from(bytes)); archiveWritten = true;
      deleteClosure(database, this.adapter, archive);
      const remaining = this.adapter.captureClosure(database, sessionId); validateClosure(this.adapter, remaining);
      if (closureFingerprint(remaining) !== afterFingerprint) throw new MaintenanceError('DB_DELETE_INCOMPLETE', 'Database adapter left rows in the declared session dependency closure');
      database.exec('COMMIT'); transactionOpen = false; await this.checkpoint('after-side-effect:db-delete');
      await this.writeJournal(participant, journal, { ...journal, state: 'DB_COMMITTED' }); terminalJournalWritten = true;
      await this.checkpoint('after-terminal:db-delete-before-registry'); await participant.setArchiveStatus('REGISTERED');
      return Object.freeze({ archive, archiveId: participant.archiveId, transactionId: participant.txId });
    } catch (error) {
      if (transactionOpen) { database.exec('ROLLBACK'); transactionOpen = false; }
      if (journal && !terminalJournalWritten) {
        await this.writeJournal(participant, journal, { ...journal, state: 'RECOVERY_PENDING', reason: archiveWritten ? 'Database commit outcome requires reconciliation' : 'Transaction stopped before durable archive publication' });
        await participant.setArchiveStatus('RECOVERY_PENDING');
      }
      throw error;
    } finally { database.close(); }
  }

  private async restoreLocked(sessionId: string, participant: ManagedDatabaseParticipant): Promise<string> {
    const archive = parseDatabaseArchive((await participant.readArchive()).toString('utf8'));
    validateArchiveIdentity(archive, this.adapter, participant, sessionId);
    validateClosure(this.adapter, archive.tables);
    await requireDormant(this.adapter, sessionId);
    const database = this.openCheckedDatabase(); let transactionOpen = false;
    try {
      database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE'); transactionOpen = true;
      const existing = this.adapter.captureClosure(database, sessionId); validateClosure(this.adapter, existing);
      const beforeFingerprint = closureFingerprint(existing);
      if (beforeFingerprint !== closureFingerprint(emptyClosure(this.adapter))) throw new MaintenanceError('DB_RESTORE_CONFLICT', 'Target session rows already exist; strict no-clobber restore is required');
      insertClosure(database, this.adapter, archive.tables);
      const restored = this.adapter.captureClosure(database, sessionId);
      if (closureFingerprint(restored) !== closureFingerprint(archive.tables)) throw new MaintenanceError('DB_RESTORE_VERIFY_FAILED', 'Restored dependency closure does not match the archive');
      const journal = makeJournal(this.adapter, participant, 'restore', beforeFingerprint, closureFingerprint(restored));
      await participant.writeJournal(journal); await this.checkpoint('after-intent:db-restore');
      database.exec('COMMIT'); transactionOpen = false; await this.checkpoint('after-side-effect:db-restore');
      await this.writeJournal(participant, journal, { ...journal, state: 'RESTORE_COMMITTED' });
      return participant.txId;
    } catch (error) { if (transactionOpen) database.exec('ROLLBACK'); throw error; }
    finally { database.close(); }
  }

  private async recoverLocked(participant: ManagedDatabaseParticipant): Promise<DatabaseTransactionJournal> {
    const journal = parseJournal(await participant.readJournal());
    if (journal.transactionId !== participant.txId || journal.archiveId !== participant.archiveId || journal.creationTransactionId !== participant.creationTxId || journal.sessionId !== participant.sessionId
        || journal.adapterId !== this.adapter.agentId || journal.adapterVersion !== this.adapter.version || journal.schemaFingerprint !== this.adapter.schemaFingerprint) {
      throw new MaintenanceError('DB_JOURNAL_IDENTITY_MISMATCH', 'Managed journal identity does not match the requested participant');
    }
    await requireDormant(this.adapter, participant.sessionId);
    if (journal.state === 'DB_COMMITTED') {
      if (journal.action !== 'export-delete') throw new MaintenanceError('DB_JOURNAL_INVALID', 'Creation completion has the wrong action');
      const bytes = await participant.readArchive();
      const archive = parseDatabaseArchive(bytes.toString('utf8'));
      validateArchiveIdentity(archive, this.adapter, participant, journal.sessionId);
      if (createHash('sha256').update(bytes).digest('hex') !== journal.archiveHash) {
        throw new MaintenanceError('DB_ARCHIVE_INTEGRITY', 'Committed database creation archive does not match its journal');
      }
      // The committed journal is the immutable creation proof. Registry repair must not
      // compare today's live rows with the creation-time snapshot: later restores and
      // legitimate edits make that comparison historical, not transactional evidence.
      await participant.setArchiveStatus('REGISTERED');
      return journal;
    }
    if (journal.state === 'RESTORE_COMMITTED') {
      if (journal.action !== 'restore') throw new MaintenanceError('DB_JOURNAL_INVALID', 'Restore completion has the wrong action');
      const archive = parseDatabaseArchive((await participant.readArchive()).toString('utf8'));
      validateArchiveIdentity(archive, this.adapter, participant, journal.sessionId);
      return journal;
    }
    if (journal.state === 'ABORTED') return journal;
    const database = this.openCheckedDatabase();
    try {
      database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      const actual = closureFingerprint(this.adapter.captureClosure(database, journal.sessionId));
      if (actual === journal.afterFingerprint) {
        if (journal.action === 'export-delete') {
          const archive = parseDatabaseArchive((await participant.readArchive()).toString('utf8'));
          const hash = createHash('sha256').update(await participant.readArchive()).digest('hex');
          validateArchiveIdentity(archive, this.adapter, participant, journal.sessionId);
          if (hash !== journal.archiveHash) {
            await participant.setArchiveStatus('RECOVERY_PENDING');
            return this.writeJournal(participant, journal, { ...journal, state: 'RECOVERY_PENDING', reason: 'Committed database deletion lacks its matching durable archive' });
          }
          await participant.setArchiveStatus('REGISTERED');
        }
        return this.writeJournal(participant, journal, { ...journal, state: journal.action === 'restore' ? 'RESTORE_COMMITTED' : 'DB_COMMITTED' });
      }
      if (actual === journal.beforeFingerprint) {
        if (journal.action === 'export-delete') await participant.setArchiveStatus('RECOVERY_PENDING');
        return this.writeJournal(participant, journal, { ...journal, state: 'ABORTED', reason: 'Database remains at the recorded pre-transaction state; managed reservation retained for review' });
      }
      if (journal.action === 'export-delete') await participant.setArchiveStatus('RECOVERY_PENDING');
      return this.writeJournal(participant, journal, { ...journal, state: 'RECOVERY_PENDING', reason: 'Database rows match neither recorded transaction state' });
    } finally { database.close(); }
  }

  private openCheckedDatabase(): DatabaseSync {
    const database = this.adapter.openDatabase();
    if (actualSchemaFingerprint(database) !== this.adapter.schemaFingerprint) { database.close(); throw new MaintenanceError('DB_SCHEMA_DRIFT', 'Live SQLite schema fingerprint differs from the evidence-gated adapter'); }
    try { validateTableContracts(database, this.adapter); } catch (error) { database.close(); throw error; }
    return database;
  }

  private assertCapability(boundary: 'controlled-test' | 'protected-production'): void {
    const schemaKey = this.adapter.capability.schemaKey;
    requireMutationCapability(this.adapter.capability, 'database', { adapterId: this.adapter.agentId, version: this.adapter.version, schemaKey, boundary });
    if (!schemaKey.endsWith(`:${this.adapter.schemaFingerprint}`)) throw new MaintenanceError('CAPABILITY_SCHEMA_MISMATCH', 'Database evidence does not match the live adapter schema');
  }
  private async checkpoint(boundary: string): Promise<void> { await this.faultHook?.(boundary); }
  private async writeJournal(participant: ManagedDatabaseParticipant, current: DatabaseTransactionJournal, next: DatabaseTransactionJournal): Promise<DatabaseTransactionJournal> {
    if (current.state === next.state && current.reason === next.reason) return current;
    const updated = Object.freeze({ ...next, updatedAt: new Date().toISOString() }); await participant.writeJournal(updated); return updated;
  }
}

function deleteClosure(database: DatabaseSync, adapter: RelationalSessionAdapter, archive: DatabaseArchive): void {
  const byName = new Map(archive.tables.map((table) => [table.name, table]));
  for (const contract of [...adapter.tablesInRestoreOrder].reverse()) {
    const table = byName.get(contract.name)!; const predicate = contract.primaryKey.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
    const statement = database.prepare(`DELETE FROM ${quoteIdentifier(contract.name)} WHERE ${predicate}`);
    for (const row of table.rows) if (statement.run(...contract.primaryKey.map((column) => row[column] as SqlValue)).changes !== 1) throw new MaintenanceError('DB_DELETE_CONFLICT', `Database row changed while deleting ${contract.name}`);
  }
}
function validateTableContracts(database: DatabaseSync, adapter: RelationalSessionAdapter): void {
  const actual = (database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  const described = adapter.tablesInRestoreOrder.map((row) => row.name).sort();
  if (new Set(described).size !== described.length || JSON.stringify(actual) !== JSON.stringify(described)) throw new MaintenanceError('DB_DEPENDENCY_COVERAGE_INCOMPLETE', 'Adapter contracts must cover each live user table exactly once');
  if (database.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name NOT LIKE 'sqlite_%'").all().length) throw new MaintenanceError('DB_TRIGGER_SIDE_EFFECTS_UNSUPPORTED', 'Trigger side effects require a schema-specific adapter');
  const order = new Map(adapter.tablesInRestoreOrder.map((table, index) => [table.name, index]));
  for (const contract of adapter.tablesInRestoreOrder) {
    const cols = database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(contract.name)})`).all() as { name: string; pk: number; hidden: number }[];
    if (cols.some((row) => row.hidden !== 0) || JSON.stringify(cols.map((row) => row.name)) !== JSON.stringify(contract.columns)) throw new MaintenanceError('DB_TABLE_COLUMNS_CHANGED', `Table ${contract.name} differs from its evidence-bound column contract`);
    const keys = cols.filter((row) => row.pk > 0).sort((a,b) => a.pk-b.pk).map((row) => row.name);
    if (JSON.stringify(keys) !== JSON.stringify(contract.primaryKey)) throw new MaintenanceError('DB_TABLE_KEY_CHANGED', `Primary key contract for ${contract.name} changed`);
    const references = database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(contract.name)})`).all() as { table: string }[];
    for (const reference of references) if (order.get(reference.table) === undefined || order.get(reference.table)! >= order.get(contract.name)!) throw new MaintenanceError('DB_DEPENDENCY_ORDER_INVALID', `Restore order must place ${reference.table} before ${contract.name}`);
  }
}
function emptyClosure(adapter: RelationalSessionAdapter): DatabaseArchive['tables'] { return adapter.tablesInRestoreOrder.map((row) => ({ name: row.name, rows: [] })); }
function makeJournal(adapter: RelationalSessionAdapter, participant: ManagedDatabaseParticipant, action: DatabaseTransactionJournal['action'], beforeFingerprint: string, afterFingerprint: string, archiveHash?: string): DatabaseTransactionJournal {
  return Object.freeze({ formatVersion: 1, adapterId: adapter.agentId, adapterVersion: adapter.version, transactionId: participant.txId, archiveId: participant.archiveId, creationTransactionId: participant.creationTxId,
    action, sessionId: participant.sessionId, schemaFingerprint: adapter.schemaFingerprint, beforeFingerprint, afterFingerprint,
    ...(archiveHash ? { archiveHash } : {}), state: 'PREPARED', updatedAt: new Date().toISOString() });
}
function parseJournal(value: unknown): DatabaseTransactionJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MaintenanceError('DB_JOURNAL_INVALID', 'Managed transaction journal is missing or malformed');
  const row = value as Partial<DatabaseTransactionJournal>;
  const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  if (row.formatVersion !== 1 || !uuid(row.transactionId) || !uuid(row.archiveId) || !uuid(row.creationTransactionId) || typeof row.adapterId !== 'string' || typeof row.adapterVersion !== 'string'
      || (row.action !== 'restore' && row.action !== 'export-delete') || typeof row.sessionId !== 'string' || !row.sessionId.trim()
      || !/^[a-f0-9]{64}$/i.test(row.schemaFingerprint ?? '') || !/^[a-f0-9]{64}$/i.test(row.beforeFingerprint ?? '') || !/^[a-f0-9]{64}$/i.test(row.afterFingerprint ?? '')
      || !['PREPARED','DB_COMMITTED','RESTORE_COMMITTED','ABORTED','RECOVERY_PENDING'].includes(row.state ?? '')
      || (row.action === 'export-delete' && !/^[a-f0-9]{64}$/i.test(row.archiveHash ?? '')) || (row.action === 'restore' && row.archiveHash !== undefined)) {
    throw new MaintenanceError('DB_JOURNAL_INVALID', 'Managed transaction journal fields are invalid');
  }
  return row as DatabaseTransactionJournal;
}
function validateArchiveIdentity(archive: DatabaseArchive, adapter: RelationalSessionAdapter, participant: ManagedDatabaseParticipant, sessionId: string): void {
  if (archive.archiveId !== participant.archiveId || archive.creationTransactionId !== participant.creationTxId || archive.agentId !== adapter.agentId || archive.adapterVersion !== adapter.version || archive.sessionId !== sessionId || archive.schemaFingerprint !== adapter.schemaFingerprint) throw new MaintenanceError('DB_ADAPTER_MISMATCH', 'Database archive belongs to another managed ID, transaction, adapter, version, session, or schema');
}
async function requireDormant(adapter: RelationalSessionAdapter, sessionId: string): Promise<void> {
  const ownership = await adapter.inspectOwnership(sessionId);
  if (ownership !== 'DORMANT') throw new MaintenanceError('SESSION_NOT_DORMANT', `Database mutation requires DORMANT ownership; observed ${ownership}`);
}
