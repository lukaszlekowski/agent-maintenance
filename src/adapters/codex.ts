import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MaintenanceError, sessionId, type AdapterCapabilities, type AdapterInventoryStatus, type AgentId, type InventorySession, type SchemaVersion, type TrustPathObservation } from '../types.ts';
import { CODEX_TRUST_CONFIG_FINGERPRINT, CODEX_TRUST_CONFIG_SCHEMA, readCodexProjectTrust } from './codex-trust.ts';
import { nativeAdapterCapabilities } from '../mutations/capabilities.ts';

// 0.160.0 retains the validated index and project-trust contracts.
export const CODEX_SUPPORTED_VERSIONS = Object.freeze(['codex-cli 0.159.2', 'codex-cli 0.159.3', 'codex-cli 0.160.0']);
export const CODEX_INDEX_SCHEMA_VERSION = 'openai/codex rust-v0.159.2 SessionIndexEntry';
export const CODEX_INDEX_SCHEMA_FINGERPRINT = createHash('sha256')
  .update('SessionIndexEntry{id:ThreadId,thread_name:string,updated_at:string};append-only;last-line-wins')
  .digest('hex');

export interface CodexIndexEntry {
  readonly id: string;
  readonly thread_name: string;
  readonly updated_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCodexSessionIndex(text: string): readonly CodexIndexEntry[] {
  const latest = new Map<string, CodexIndexEntry>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { throw new MaintenanceError('ADAPTER_MALFORMED_INDEX', `Codex session index line ${i + 1} is not valid JSON`); }
    if (!isRecord(value) || typeof value.id !== 'string' || !UUID.test(value.id)
      || typeof value.thread_name !== 'string' || typeof value.updated_at !== 'string'
      || (value.updated_at !== 'unknown' && (!Number.isFinite(Date.parse(value.updated_at)) || !/^\d{4}-\d\d-\d\dT/.test(value.updated_at)))) {
      throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', `Codex session index line ${i + 1} does not match the validated ${CODEX_INDEX_SCHEMA_VERSION} schema`);
    }
    latest.set(value.id, Object.freeze({ id: value.id, thread_name: value.thread_name, updated_at: value.updated_at }));
  }
  return Object.freeze([...latest.values()]);
}

function supportedCapabilities(reason: string, sessionRead: AdapterCapabilities['sessionRead']): AdapterCapabilities {
  const disabled = nativeAdapterCapabilities('codex_cli', reason);
  return Object.freeze({ ...disabled, sessionRead, trustRead: Object.freeze({ enabled: true, reason: `Read-only ${CODEX_TRUST_CONFIG_SCHEMA} extraction is validated for versions ${CODEX_SUPPORTED_VERSIONS.join(' and ')}` }) });
}

export async function readCodexInventory(root: string, detectedVersion: string | null): Promise<{
  readonly sessions: readonly InventorySession[];
  readonly trustPaths: readonly TrustPathObservation[];
  readonly status: AdapterInventoryStatus;
}> {
  const baseReason = 'Phase 0 provides no external-writer exclusion, session ownership, or mutation evidence';
  if (detectedVersion === null || !CODEX_SUPPORTED_VERSIONS.includes(detectedVersion)) {
    const reason = detectedVersion === null
      ? 'Codex executable version is unavailable; supported schema/version is not established'
      : `Codex ${detectedVersion} is outside the validated parser versions ${CODEX_SUPPORTED_VERSIONS.join(', ')}`;
    return Object.freeze({ sessions: Object.freeze([]), trustPaths: Object.freeze([]), status: Object.freeze({
      agentId: 'codex_cli', version: detectedVersion, schema: null, capabilities: nativeAdapterCapabilities('codex_cli', reason), explanation: reason,
    }) });
  }

  const trust = await readCodexProjectTrust(root);
  const trustSchema: SchemaVersion = Object.freeze({ name: 'codex-project-trust-config', version: CODEX_TRUST_CONFIG_SCHEMA, fingerprint: CODEX_TRUST_CONFIG_FINGERPRINT });

  const indexPath = join(root, 'session_index.jsonl');
  let text: string;
  try { text = await readFile(indexPath, 'utf8'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return Object.freeze({ sessions: Object.freeze([]), trustPaths: trust.entries, status: Object.freeze({
        agentId: 'codex_cli', version: detectedVersion, schema: trustSchema, capabilities: supportedCapabilities(`${baseReason}; session index is absent`, { enabled: true, reason: 'Read-only index discovery is supported for this exact version' }), explanation: 'Validated version; project trust config inspected; no session index was found',
      }) });
    }
    throw new MaintenanceError('ADAPTER_READ_FAILED', `Cannot read Codex session index (${code ?? 'unknown error'})`);
  }
  const entries = parseCodexSessionIndex(text);
  const sessions = entries.map((entry) => Object.freeze({
    id: sessionId(entry.id), agentId: 'codex_cli' as AgentId, title: entry.thread_name, updatedAt: entry.updated_at,
    ownership: 'UNKNOWN' as const,
    ownershipExplanation: 'The session index contains no validated session-to-process ownership binding',
    workloadKind: 'unknown' as const,
  }));
  return Object.freeze({ sessions: Object.freeze(sessions), trustPaths: trust.entries, status: Object.freeze({
    agentId: 'codex_cli', version: detectedVersion, schema: trustSchema,
    capabilities: supportedCapabilities(baseReason, { enabled: true, reason: 'Read-only session index discovery is supported for this exact version' }),
    explanation: `Index metadata and ${trust.entries.length} configured project trust entries are inspected; session ownership and logical-subagent classification remain unknown`,
  }) });
}
