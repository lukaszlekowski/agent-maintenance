import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { MaintenanceError } from '../types.ts';

export const OPENCODE_SUPPORTED_VERSION = '1.18.33';
export const OPENCODE_SESSION_LIST_FINGERPRINT = createHash('sha256')
  .update('opencode-v1.18.33:session-list-json{id,title,updated,created,projectId,directory};roots-only')
  .digest('hex');

export interface OpenCodeSessionListEntry {
  readonly id: string;
  readonly title: string;
  readonly updated: number;
  readonly created: number;
  readonly projectId: string;
  readonly directory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOpenCodeSessionList(text: string): readonly OpenCodeSessionListEntry[] {
  // The pinned CLI returns without writing stdout for an empty list.
  if (text.trim() === '') return Object.freeze([]);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new MaintenanceError('ADAPTER_MALFORMED_OUTPUT', 'OpenCode session list output is not valid JSON'); }
  if (!Array.isArray(value)) throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', 'OpenCode session list output must be a JSON array');
  const result: OpenCodeSessionListEntry[] = [];
  for (const [index, row] of value.entries()) {
    if (!isRecord(row) || typeof row.id !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(row.id)
      || typeof row.title !== 'string' || typeof row.updated !== 'number' || !Number.isSafeInteger(row.updated) || row.updated < 0
      || typeof row.created !== 'number' || !Number.isSafeInteger(row.created) || row.created < 0
      || typeof row.projectId !== 'string' || typeof row.directory !== 'string' || !isAbsolute(row.directory)) {
      throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', `OpenCode session row ${index + 1} does not match the validated 1.18.33 list schema`);
    }
    if (!Number.isFinite(new Date(row.updated).getTime())) throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', `OpenCode session row ${index + 1} has an out-of-range update time`);
    result.push(Object.freeze({ id: row.id, title: row.title, updated: row.updated, created: row.created, projectId: row.projectId, directory: row.directory }));
  }
  return Object.freeze(result);
}
