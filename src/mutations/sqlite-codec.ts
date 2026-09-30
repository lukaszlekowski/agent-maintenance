import { createHash } from 'node:crypto';
import { MaintenanceError } from '../types.ts';
import type { DatabaseArchive, RelationalSessionAdapter, SqlValue } from './sqlite-contracts.ts';
import { quoteIdentifier } from './sqlite-contracts.ts';
import type { DatabaseSync } from 'node:sqlite';

type EncodedValue = null | string | number | boolean | { readonly $bigint: string } | { readonly $blob: string };

export function actualSchemaFingerprint(database: DatabaseSync): string {
  const rows = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return hashJson(rows);
}

export function closureFingerprint(tables: DatabaseArchive['tables']): string {
  return hashJson(tables.map((table) => ({ name: table.name, rows: table.rows.map(encodeRow).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })));
}

export function validateClosure(adapter: RelationalSessionAdapter, tables: DatabaseArchive['tables']): void {
  if (tables.length !== adapter.tablesInRestoreOrder.length) throw new MaintenanceError('DB_CLOSURE_INCOMPLETE', 'Adapter did not return every table in the validated dependency closure');
  const received = new Map(tables.map((table) => [table.name, table]));
  if (received.size !== tables.length) throw new MaintenanceError('DB_CLOSURE_DUPLICATE_TABLE', 'Database closure contains duplicate tables');
  for (const contract of adapter.tablesInRestoreOrder) {
    const table = received.get(contract.name);
    if (!table) throw new MaintenanceError('DB_CLOSURE_INCOMPLETE', `Database closure omitted ${contract.name}`);
    const seen = new Set<string>();
    for (const row of table.rows) {
      if (Object.keys(row).length !== contract.columns.length || contract.columns.some((column) => !(column in row))) {
        throw new MaintenanceError('DB_ROW_SCHEMA_MISMATCH', `Closure row does not match ${contract.name} columns`);
      }
      const key = JSON.stringify(contract.primaryKey.map((column) => row[column]));
      if (contract.primaryKey.some((column) => row[column] === null) || seen.has(key)) throw new MaintenanceError('DB_CLOSURE_KEY_INVALID', `Closure contains a null or duplicate key in ${contract.name}`);
      seen.add(key);
      for (const value of Object.values(row)) if (!(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array)) {
        throw new MaintenanceError('DB_VALUE_UNSUPPORTED', `SQLite value in ${contract.name} cannot be safely serialized`);
      }
    }
  }
}

export function buildArchive(adapter: RelationalSessionAdapter, archiveId: string, creationTransactionId: string, sessionId: string, tables: DatabaseArchive['tables']): DatabaseArchive {
  validateClosure(adapter, tables);
  const body = { formatVersion: 1 as const, archiveId, creationTransactionId, agentId: adapter.agentId, adapterVersion: adapter.version,
    schemaFingerprint: adapter.schemaFingerprint, sessionId, exportedAt: new Date().toISOString(),
    tables: Object.freeze(adapter.tablesInRestoreOrder.map((contract) => {
      const table = tables.find((row) => row.name === contract.name)!;
      return Object.freeze({ name: table.name, rows: Object.freeze(table.rows.map((row) => Object.freeze({ ...row }))) });
    })) };
  return Object.freeze({ ...body, integrityHash: archiveHash(body) });
}

export function parseDatabaseArchive(text: string): DatabaseArchive {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new MaintenanceError('DB_ARCHIVE_INVALID', 'Database archive is missing or invalid JSON'); }
  if (!isObject(raw) || raw.formatVersion !== 1 || typeof raw.archiveId !== 'string' || typeof raw.creationTransactionId !== 'string'
      || typeof raw.agentId !== 'string' || typeof raw.adapterVersion !== 'string'
      || typeof raw.schemaFingerprint !== 'string' || typeof raw.sessionId !== 'string'
      || typeof raw.integrityHash !== 'string'
      || !Array.isArray(raw.tables) || raw.tables.some((table) => !isObject(table) || typeof table.name !== 'string' || !Array.isArray(table.rows))) {
    throw new MaintenanceError('DB_ARCHIVE_INVALID', 'Database archive does not match the supported format');
  }
  const { integrityHash, ...body } = raw;
  if (archiveHash(body as Omit<DatabaseArchive, 'integrityHash'>) !== integrityHash) throw new MaintenanceError('DB_ARCHIVE_CHECKSUM_FAILED', 'Database archive integrity checksum does not match');
  return decodeJson(raw) as DatabaseArchive;
}

export function encodeArchive(archive: DatabaseArchive): string {
  return JSON.stringify(archive, (_key, value: unknown) => encodeValue(value as SqlValue), 2) + '\n';
}

export function hashJson(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function archiveHash(body: Pick<DatabaseArchive, 'formatVersion' | 'archiveId' | 'creationTransactionId' | 'agentId' | 'adapterVersion' | 'schemaFingerprint' | 'sessionId' | 'exportedAt' | 'tables'>): string {
  return hashJson({ ...body, tables: body.tables.map((table) => ({ name: table.name, rows: table.rows.map(encodeRow) })) });
}

function encodeRow(row: Readonly<Record<string, SqlValue>>): Readonly<Record<string, EncodedValue>> {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, encodeValue(value)]));
}
function encodeValue(value: SqlValue): EncodedValue {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString('base64') };
  return value;
}
function decodeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJson);
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.$blob === 'string') return new Uint8Array(Buffer.from(value.$blob, 'base64'));
  if (keys.length === 1 && typeof value.$bigint === 'string' && /^-?\d+$/.test(value.$bigint)) return BigInt(value.$bigint);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeJson(entry)]));
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function insertClosure(database: DatabaseSync, adapter: RelationalSessionAdapter, tables: DatabaseArchive['tables']): void {
  validateClosure(adapter, tables);
  for (const contract of adapter.tablesInRestoreOrder) {
    const closure = tables.find((table) => table.name === contract.name)!;
    if (!closure.rows.length) continue;
    const columns = contract.columns.map(quoteIdentifier).join(', ');
    const placeholders = contract.columns.map(() => '?').join(', ');
    const insert = database.prepare(`INSERT INTO ${quoteIdentifier(contract.name)} (${columns}) VALUES (${placeholders})`);
    for (const row of closure.rows) {
      const values = contract.columns.map((column) => row[column]!);
      insert.run(...values);
    }
  }
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new MaintenanceError('DB_RELATIONSHIP_CONFLICT', 'Restored dependency closure violates SQLite foreign keys');
}
