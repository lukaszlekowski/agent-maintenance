import { createHash } from 'node:crypto';
import { AGENT_IDS, MaintenanceError, archiveId, sessionId, transactionId, type AgentId, type ArchiveId, type SessionId, type TransactionId } from '../types.ts';

export const MANIFEST_VERSION = 1 as const;
export const JOURNAL_VERSION = 2 as const;
export const REGISTRY_VERSION = 1 as const;

export type StorageAction = 'archive' | 'soft-delete' | 'temp-move' | 'restore';
export type ArchiveCategory = 'archived' | 'deleted' | 'temp';
export type JournalState =
  | 'INITIATED' | 'STAGED' | 'PUBLISH_INTENT' | 'TARGET_PUBLISHED'
  | 'INDEX_INTENT' | 'INDEX_COMMITTED' | 'DRAIN_INTENT' | 'SOURCE_DRAINED'
  | 'COMPLETED' | 'ROLLED_BACK' | 'RECOVERY_PENDING' | 'RECOVERY_FAILED';

export interface StoragePathMapping {
  readonly baseRoot: string;
  readonly relativePath: string;
}

export interface ObjectIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly mode: number;
}

export interface PayloadDescriptor {
  readonly source: StoragePathMapping;
  readonly archiveRelPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
  readonly sourceIdentity: ObjectIdentity;
  readonly archiveIdentity: ObjectIdentity;
}

export interface IndexPlan {
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
}

export interface ArchiveManifest {
  readonly manifestVersion: typeof MANIFEST_VERSION;
  readonly archiveId: ArchiveId;
  readonly txId: TransactionId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly adapterSchema: string;
  readonly category: ArchiveCategory;
  readonly createdAt: string;
  readonly trustedRootIds: readonly string[];
  readonly payload: readonly PayloadDescriptor[];
  readonly index: IndexPlan;
}

export interface JournalPayload extends Omit<PayloadDescriptor, 'archiveIdentity'> {
  readonly archiveIdentity?: ObjectIdentity;
  readonly stageRelPath: string;
  readonly stageIdentity?: ObjectIdentity;
  readonly staged?: boolean;
  readonly archivePublishIntent?: boolean;
  readonly drainIntent?: boolean;
  readonly drained?: boolean;
  readonly targetStageRelPath?: string;
  readonly targetStageIdentity?: ObjectIdentity;
  readonly targetPublished?: boolean;
  readonly targetWasAbsent?: boolean;
  readonly publishIntent?: boolean;
}

export interface StorageJournal {
  readonly journalVersion: typeof JOURNAL_VERSION;
  readonly txId: TransactionId;
  readonly archiveId: ArchiveId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly adapterSchema: string;
  readonly category: ArchiveCategory;
  readonly action: Exclude<StorageAction, 'restore'> | 'restore';
  readonly state: JournalState;
  readonly progressState: Exclude<JournalState, 'RECOVERY_PENDING' | 'RECOVERY_FAILED'>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archiveRootId: string;
  readonly archiveRelPath: string;
  readonly archiveCreationTxId?: TransactionId;
  readonly payload: readonly JournalPayload[];
  readonly index: IndexPlan;
  readonly indexIntent?: boolean;
  readonly indexCommitted?: boolean;
  readonly reservationIdentity?: ObjectIdentity;
  readonly reservationIntent?: boolean;
  readonly manifestIdentity?: ObjectIdentity;
  readonly manifestIntent?: boolean;
  readonly rollbackIntent?: boolean;
  readonly rollbackCleanupProven?: boolean;
  readonly diagnostics: readonly string[];
}

export interface RegistryEntry {
  readonly participant?: 'session' | 'database';
  readonly archiveId: ArchiveId;
  readonly txId: TransactionId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly category: ArchiveCategory;
  readonly rootId: string;
  readonly relativePath: string;
  readonly status: 'RESERVED' | 'REGISTERED' | 'RECOVERY_PENDING';
}

export interface StorageRegistry {
  readonly registryVersion: typeof REGISTRY_VERSION;
  readonly entries: readonly RegistryEntry[];
  readonly diagnostics: readonly string[];
}

export function stableFingerprint(value: unknown): string {
  let encoded: string;
  try { encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  }); }
  catch { throw new MaintenanceError('ADAPTER_INDEX_EVIDENCE_INVALID', 'Adapter index evidence is not JSON-serializable'); }
  if (encoded === undefined) throw new MaintenanceError('ADAPTER_INDEX_EVIDENCE_INVALID', 'Adapter index evidence cannot be undefined');
  return createHash('sha256').update(encoded).digest('hex');
}

export function makeIndexPlan(before: unknown, after: unknown): IndexPlan {
  return Object.freeze({ before, after, beforeFingerprint: stableFingerprint(before), afterFingerprint: stableFingerprint(after) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string { return typeof value === 'string'; }
function isGeneratedUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSafeRel(value: unknown): value is string {
  return isString(value) && value.length > 0 && !value.includes('\0') && !value.startsWith('/')
    && !value.split(/[\\/]+/).some((part) => part === '..' || part === '.');
}

export function parseManifest(value: unknown): ArchiveManifest {
  if (!isRecord(value) || value.manifestVersion !== MANIFEST_VERSION) throw new MaintenanceError('MANIFEST_SCHEMA_INVALID', 'Archive manifest version or root shape is invalid');
  let id: ArchiveId; let tx: TransactionId; let sid: SessionId;
  try {
    if (!isString(value.archiveId) || !isGeneratedUuid(value.archiveId) || !isString(value.txId) || !isGeneratedUuid(value.txId) || !isString(value.sessionId)) throw new Error('identifier type');
    id = archiveId(value.archiveId); tx = transactionId(value.txId); sid = sessionId(value.sessionId);
  }
  catch { throw new MaintenanceError('MANIFEST_SCHEMA_INVALID', 'Archive manifest identifiers are invalid'); }
  if (!AGENT_IDS.includes(value.agentId as AgentId) || !['archived','deleted','temp'].includes(String(value.category)) || !isString(value.createdAt) || !isString(value.adapterSchema)) {
    throw new MaintenanceError('MANIFEST_SCHEMA_INVALID', 'Archive manifest identity fields are invalid');
  }
  if (!Array.isArray(value.trustedRootIds) || !value.trustedRootIds.every((root) => isString(root) && /^[A-Z][A-Z0-9_]{0,63}$/.test(root))) throw new MaintenanceError('MANIFEST_SCHEMA_INVALID', 'Archive manifest trusted roots are invalid');
  if (!Array.isArray(value.payload) || value.payload.length === 0) throw new MaintenanceError('MANIFEST_SCHEMA_INVALID', 'Archive manifest payload must contain at least one file');
  const payload = value.payload.map((item): PayloadDescriptor => {
    if (!isRecord(item) || !isRecord(item.source) || !isString(item.source.baseRoot) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.source.baseRoot) || !isSafeRel(item.source.relativePath)
      || !isSafeRel(item.archiveRelPath) || !item.archiveRelPath.startsWith('payload/') || !/^[a-f0-9]{64}$/.test(String(item.sha256)) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0
      || !Number.isSafeInteger(item.mode) || Number(item.mode) < 0 || Number(item.mode) > 0o777 || !isObjectIdentity(item.sourceIdentity) || !isObjectIdentity(item.archiveIdentity)
      || item.sourceIdentity.size !== Number(item.bytes) || item.archiveIdentity.size !== Number(item.bytes)) {
      throw new MaintenanceError('MANIFEST_SCHEMA_INVALID', 'Archive manifest payload entry is invalid');
    }
    return Object.freeze({ source: Object.freeze({ baseRoot: item.source.baseRoot, relativePath: item.source.relativePath }), archiveRelPath: item.archiveRelPath,
      sha256: String(item.sha256), bytes: Number(item.bytes), mode: Number(item.mode), sourceIdentity: item.sourceIdentity, archiveIdentity: item.archiveIdentity });
  });
  const sourceKeys = new Set<string>(); const archiveKeys = new Set<string>();
  for (const row of payload) { const sourceKey = `${row.source.baseRoot}\0${row.source.relativePath}`; if (sourceKeys.has(sourceKey) || archiveKeys.has(row.archiveRelPath)) throw new MaintenanceError('MANIFEST_SCHEMA_INVALID', 'Manifest payload paths must be unique'); sourceKeys.add(sourceKey); archiveKeys.add(row.archiveRelPath); }
  const index = parseIndexPlan(value.index, 'MANIFEST_SCHEMA_INVALID');
  return Object.freeze({ manifestVersion: MANIFEST_VERSION, archiveId: id, txId: tx, agentId: value.agentId as AgentId, sessionId: sid, adapterSchema: value.adapterSchema,
    category: value.category as ArchiveCategory, createdAt: value.createdAt, trustedRootIds: Object.freeze([...value.trustedRootIds] as string[]), payload: Object.freeze(payload), index });
}

export function parseJournal(value: unknown): StorageJournal {
  if (!isRecord(value) || value.journalVersion !== JOURNAL_VERSION || !Array.isArray(value.payload) || !Array.isArray(value.diagnostics) || !value.diagnostics.every(isString)) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Journal version or root shape is invalid');
  let archive: ArchiveId; let tx: TransactionId; let sid: SessionId;
  try {
    if (!isString(value.archiveId) || !isGeneratedUuid(value.archiveId) || !isString(value.txId) || !isGeneratedUuid(value.txId) || !isString(value.sessionId)) throw new Error('identifier type');
    archive = archiveId(value.archiveId); tx = transactionId(value.txId); sid = sessionId(value.sessionId);
  }
  catch { throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Journal identifiers are invalid'); }
  const states: readonly string[] = ['INITIATED','STAGED','PUBLISH_INTENT','TARGET_PUBLISHED','INDEX_INTENT','INDEX_COMMITTED','DRAIN_INTENT','SOURCE_DRAINED','COMPLETED','ROLLED_BACK','RECOVERY_PENDING','RECOVERY_FAILED'];
  const progressStates: readonly string[] = ['INITIATED','STAGED','PUBLISH_INTENT','TARGET_PUBLISHED','INDEX_INTENT','INDEX_COMMITTED','DRAIN_INTENT','SOURCE_DRAINED','COMPLETED','ROLLED_BACK'];
  const actionCategoryValid = value.action === 'restore' || (value.action === 'archive' && value.category === 'archived') || (value.action === 'soft-delete' && value.category === 'deleted') || (value.action === 'temp-move' && value.category === 'temp');
  if (!AGENT_IDS.includes(value.agentId as AgentId) || !['archived','deleted','temp'].includes(String(value.category)) || !states.includes(String(value.state)) || !actionCategoryValid
    || !['archive','soft-delete','temp-move','restore'].includes(String(value.action)) || !progressStates.includes(String(value.progressState)) || !isString(value.adapterSchema) || !isString(value.createdAt) || !isString(value.updatedAt) || !isString(value.archiveRootId) || !isSafeRel(value.archiveRelPath)) {
    throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Journal transaction fields are invalid');
  }
  for (const key of ['indexIntent','indexCommitted','reservationIntent','manifestIntent']) { if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', `Journal ${key} flag is invalid`); }
  if (value.archiveCreationTxId !== undefined && (!isString(value.archiveCreationTxId) || !isGeneratedUuid(value.archiveCreationTxId))) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Restore source creation transaction ID is invalid');
  for (const key of ['reservationIdentity','manifestIdentity']) { if (value[key] !== undefined && !isObjectIdentity(value[key])) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', `Journal ${key} is invalid`); }
  const payload = value.payload.map((row): JournalPayload => {
    if (!isRecord(row) || !isRecord(row.source) || !isString(row.source.baseRoot) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(row.source.baseRoot) || !isSafeRel(row.source.relativePath)
      || !isSafeRel(row.archiveRelPath) || !row.archiveRelPath.startsWith('payload/') || !isSafeRel(row.stageRelPath) || !row.stageRelPath.startsWith('staging/') || !/^[a-f0-9]{64}$/.test(String(row.sha256))
      || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || !Number.isSafeInteger(row.mode) || Number(row.mode) < 0 || Number(row.mode) > 0o777
      || !isObjectIdentity(row.sourceIdentity) || row.sourceIdentity.size !== Number(row.bytes) || (row.archiveIdentity !== undefined && (!isObjectIdentity(row.archiveIdentity) || row.archiveIdentity.size !== Number(row.bytes)))
      || (row.stageIdentity !== undefined && !isObjectIdentity(row.stageIdentity))
      || (row.archiveIdentity !== undefined && (!isObjectIdentity(row.archiveIdentity) || row.archiveIdentity.size !== Number(row.bytes)))
      || (row.targetStageIdentity !== undefined && !isObjectIdentity(row.targetStageIdentity))
      || (row.targetStageRelPath !== undefined && !isSafeRel(row.targetStageRelPath))
      || ['staged','archivePublishIntent','drainIntent','drained','targetPublished','targetWasAbsent','publishIntent'].some((key) => row[key] !== undefined && typeof row[key] !== 'boolean')) {
      throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Journal payload entry is invalid');
    }
    return Object.freeze({
      source: Object.freeze({ baseRoot: row.source.baseRoot, relativePath: row.source.relativePath }),
      archiveRelPath: row.archiveRelPath, sha256: String(row.sha256), bytes: Number(row.bytes), mode: Number(row.mode),
      sourceIdentity: row.sourceIdentity,
      ...(row.archiveIdentity === undefined ? {} : { archiveIdentity: row.archiveIdentity as ObjectIdentity }),
      stageRelPath: row.stageRelPath,
      ...(row.stageIdentity === undefined ? {} : { stageIdentity: row.stageIdentity as ObjectIdentity }),
      ...(row.staged === undefined ? {} : { staged: row.staged as boolean }),
      ...(row.archivePublishIntent === undefined ? {} : { archivePublishIntent: row.archivePublishIntent as boolean }),
      ...(row.drainIntent === undefined ? {} : { drainIntent: row.drainIntent as boolean }),
      ...(row.drained === undefined ? {} : { drained: row.drained as boolean }),
      ...(row.targetStageRelPath === undefined ? {} : { targetStageRelPath: row.targetStageRelPath as string }),
      ...(row.targetStageIdentity === undefined ? {} : { targetStageIdentity: row.targetStageIdentity as ObjectIdentity }),
      ...(row.targetPublished === undefined ? {} : { targetPublished: row.targetPublished as boolean }),
      ...(row.targetWasAbsent === undefined ? {} : { targetWasAbsent: row.targetWasAbsent as boolean }),
      ...(row.publishIntent === undefined ? {} : { publishIntent: row.publishIntent as boolean }),
    });
  });
  if (!payload.length) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Journal payload cannot be empty');
  const sourceKeys = new Set<string>(); const archiveKeys = new Set<string>();
  for (const row of payload) { const sourceKey = `${row.source.baseRoot}\0${row.source.relativePath}`; if (sourceKeys.has(sourceKey) || archiveKeys.has(row.archiveRelPath)) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Journal payload paths must be unique'); sourceKeys.add(sourceKey); archiveKeys.add(row.archiveRelPath); }
  validateJournalInvariants(value, payload);
  return Object.freeze({ ...value, journalVersion: JOURNAL_VERSION, txId: tx, archiveId: archive, sessionId: sid, progressState: value.progressState as StorageJournal['progressState'],
    agentId: value.agentId as AgentId, adapterSchema: value.adapterSchema, category: value.category as ArchiveCategory, state: value.state as JournalState,
    payload: Object.freeze(payload), index: parseIndexPlan(value.index, 'JOURNAL_SCHEMA_INVALID'), diagnostics: Object.freeze(value.diagnostics as string[]) }) as StorageJournal;
}

function validateJournalInvariants(value: Record<string, unknown>, payload: readonly JournalPayload[]): void {
  const state = value.state as JournalState;
  const action = value.action as StorageAction;
  const intent = value.indexIntent === true;
  const committed = value.indexCommitted === true;
  const allPublished = payload.every((row) => row.targetPublished === true && row.targetStageIdentity !== undefined && row.targetWasAbsent === true);
  const allDrained = payload.every((row) => row.drained === true && row.drainIntent === true);
  if (committed && !intent) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Index completion requires recorded intent');
  if (value.rollbackIntent !== undefined && typeof value.rollbackIntent !== 'boolean') throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Rollback intent must be a boolean');
  if (value.rollbackCleanupProven !== undefined && typeof value.rollbackCleanupProven !== 'boolean') throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Rollback proof must be a boolean');
  if (state === 'ROLLED_BACK' && (value.rollbackIntent !== true || value.rollbackCleanupProven !== true)) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Rollback requires durable intent and cleanup proof');
  if (state === 'ROLLED_BACK' && action !== 'restore') throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Only guarded prepublication restore rollback is supported');
  if (state === 'ROLLED_BACK' && action === 'restore' && (intent || committed || payload.some((row) => row.targetPublished === true))) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Restore rollback is only valid before publication and index mutation');
  if (['INDEX_COMMITTED','DRAIN_INTENT','SOURCE_DRAINED','COMPLETED'].includes(state) && !committed) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Journal progress claims an unproven index commit');
  if (action === 'restore' && payload.some((row) => row.targetPublished && row.targetWasAbsent !== true)) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Published targets require durable prior-absence evidence');
  if (action === 'restore' && ['TARGET_PUBLISHED','INDEX_INTENT','INDEX_COMMITTED'].includes(state) && !allPublished) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Restore progress lacks verified target publication');
  if (state === 'SOURCE_DRAINED' && (action === 'restore' || !allDrained)) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Source-drained progress lacks per-file drain completion');
  if (state === 'COMPLETED' && (action === 'restore' ? !allPublished : !allDrained)) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Terminal completion lacks verified per-file evidence');
  if (action === 'restore' && payload.some((row) => row.drained || row.drainIntent)) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Restore journals cannot contain source-drain progress');
  if (value.state === 'RECOVERY_PENDING' && !value.progressState) throw new MaintenanceError('JOURNAL_SCHEMA_INVALID', 'Pending recovery must preserve its underlying progress state');
}

function parseIndexPlan(value: unknown, code: string): IndexPlan {
  if (!isRecord(value) || !/^[a-f0-9]{64}$/.test(String(value.beforeFingerprint)) || !/^[a-f0-9]{64}$/.test(String(value.afterFingerprint))
    || stableFingerprint(value.before) !== value.beforeFingerprint || stableFingerprint(value.after) !== value.afterFingerprint) {
    throw new MaintenanceError(code, 'Index before/after evidence is invalid or has a mismatched fingerprint');
  }
  return Object.freeze({ before: value.before, after: value.after, beforeFingerprint: value.beforeFingerprint, afterFingerprint: value.afterFingerprint });
}

export function isObjectIdentity(value: unknown): value is ObjectIdentity {
  return isRecord(value) && isString(value.dev) && value.dev.length > 0 && isString(value.ino) && value.ino.length > 0 && Number.isSafeInteger(value.size) && Number(value.size) >= 0
    && isString(value.mtimeNs) && Number.isSafeInteger(value.mode) && Number(value.mode) >= 0 && Number(value.mode) <= 0o777;
}

export function parseRegistry(value: unknown): StorageRegistry {
  if (!isRecord(value) || value.registryVersion !== REGISTRY_VERSION || !Array.isArray(value.entries) || !Array.isArray(value.diagnostics) || !value.diagnostics.every(isString)) throw new MaintenanceError('REGISTRY_SCHEMA_INVALID', 'Storage registry shape is invalid');
  const entries = value.entries.map((row): RegistryEntry => {
    if (!isRecord(row) || !isString(row.rootId) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(row.rootId) || !isSafeRel(row.relativePath) || !['archived','deleted','temp'].includes(String(row.category))
      || !['RESERVED','REGISTERED','RECOVERY_PENDING'].includes(String(row.status)) || !AGENT_IDS.includes(row.agentId as AgentId)) throw new MaintenanceError('REGISTRY_SCHEMA_INVALID', 'Storage registry entry is invalid');
    try { if (!isString(row.archiveId) || !isGeneratedUuid(row.archiveId) || !isString(row.txId) || !isGeneratedUuid(row.txId) || !isString(row.sessionId)
      || (row.participant !== undefined && row.participant !== 'session' && row.participant !== 'database')) throw new Error('identifier type'); return Object.freeze({ ...row, archiveId: archiveId(row.archiveId), txId: transactionId(row.txId), sessionId: sessionId(row.sessionId), agentId: row.agentId as AgentId, category: row.category as ArchiveCategory, rootId: row.rootId, relativePath: row.relativePath, status: row.status as RegistryEntry['status'], ...(row.participant === undefined ? {} : { participant: row.participant as 'session' | 'database' }) }); }
    catch { throw new MaintenanceError('REGISTRY_SCHEMA_INVALID', 'Storage registry identifiers are invalid'); }
  });
  const seen = new Set<string>();
  for (const row of entries) { if (seen.has(row.archiveId)) throw new MaintenanceError('REGISTRY_DUPLICATE_ARCHIVE_ID', 'Registry contains duplicate archive IDs'); seen.add(row.archiveId); }
  return Object.freeze({ registryVersion: REGISTRY_VERSION, entries: Object.freeze(entries), diagnostics: Object.freeze(value.diagnostics as string[]) });
}
