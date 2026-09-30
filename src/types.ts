export const AGENT_IDS = ['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

declare const sessionIdBrand: unique symbol;
declare const archiveIdBrand: unique symbol;
declare const transactionIdBrand: unique symbol;
export type SessionId = string & { readonly [sessionIdBrand]: true };
export type ArchiveId = string & { readonly [archiveIdBrand]: true };
export type TransactionId = string & { readonly [transactionIdBrand]: true };

export type OwnershipState = 'ACTIVE' | 'DORMANT' | 'UNKNOWN';
export type WorkspacePathState = 'VALID' | 'UNAVAILABLE_VOLUME' | 'INACCESSIBLE' | 'CONFIRMED_OBSOLETE';
export type CapabilityName =
  | 'sessionRead' | 'dormantStorage' | 'restore' | 'trustEdit' | 'processTermination'
  | 'externalWriterExclusion' | 'raceSafeFileOperations';

export interface CapabilityDecision {
  readonly enabled: boolean;
  readonly reason: string;
}

export interface AdapterCapabilities {
  readonly [capability: string]: CapabilityDecision;
  readonly sessionRead: CapabilityDecision;
  readonly dormantStorage: CapabilityDecision;
  readonly restore: CapabilityDecision;
  readonly trustEdit: CapabilityDecision;
  readonly processTermination: CapabilityDecision;
  readonly externalWriterExclusion: CapabilityDecision;
  readonly raceSafeFileOperations: CapabilityDecision;
}

export interface SchemaVersion {
  readonly name: string;
  readonly version: string;
  readonly fingerprint?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly capabilities: AdapterCapabilities;
  readonly schema: SchemaVersion | null;
}

export interface AgentRoot {
  readonly id: string;
  readonly path: string;
}

export interface PathMapping {
  readonly baseRoot: string;
  readonly relativePath: string;
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly command: string;
}

export interface ProcessCandidate {
  readonly identity: ProcessIdentity;
  readonly parentPid: number | null;
  readonly depth: number;
}

export interface VerifiedOwnership {
  readonly state: 'VERIFIED_ACTIVE';
  readonly evidenceId: string;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
}

export interface StructuredErrorData {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class MaintenanceError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'MaintenanceError';
    this.code = code;
    if (details !== undefined) this.details = Object.freeze({ ...details });
  }

  toJSON(): StructuredErrorData {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function immutableId<T extends string>(value: string, label: string): T {
  if (!ID_RE.test(value) || value === '.' || value === '..') {
    throw new MaintenanceError('INVALID_ID', `${label} is not a valid immutable identifier`);
  }
  return value as T;
}

export const sessionId = (value: string): SessionId => immutableId<SessionId>(value, 'Session ID');
export const archiveId = (value: string): ArchiveId => immutableId<ArchiveId>(value, 'Archive ID');
export const transactionId = (value: string): TransactionId => immutableId<TransactionId>(value, 'Transaction ID');

export function isOwnershipState(value: unknown): value is OwnershipState {
  return value === 'ACTIVE' || value === 'DORMANT' || value === 'UNKNOWN';
}

export function requireKnownOwnership(value: unknown): OwnershipState {
  if (!isOwnershipState(value)) throw new MaintenanceError('UNKNOWN_OWNERSHIP_STATE', 'Unrecognized ownership state; actions are blocked');
  return value;
}

export const DISABLED_CAPABILITY = (reason: string): CapabilityDecision => Object.freeze({ enabled: false, reason });

export function disabledCapabilities(reason = 'Phase 0 integration evidence is unavailable'): AdapterCapabilities {
  return Object.freeze({
    sessionRead: DISABLED_CAPABILITY(reason), dormantStorage: DISABLED_CAPABILITY(reason),
    restore: DISABLED_CAPABILITY(reason), trustEdit: DISABLED_CAPABILITY(reason),
    processTermination: DISABLED_CAPABILITY(reason), externalWriterExclusion: DISABLED_CAPABILITY(reason),
    raceSafeFileOperations: DISABLED_CAPABILITY(reason),
  });
}
