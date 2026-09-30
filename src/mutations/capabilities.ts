import { platform } from 'node:os';
import { AGENT_IDS, MaintenanceError, type AdapterCapabilities, type AgentId, type SchemaVersion } from '../types.ts';

type MutationOperation = 'database' | 'trust-edit';
export type CapabilityBoundary = 'controlled-test' | 'protected-production';
interface MutationAuthority { readonly operation: MutationOperation; readonly boundary: CapabilityBoundary; readonly adapterId: AgentId; readonly version: string; readonly schemaKey: string; readonly os: string; readonly enabled: boolean }
interface TerminationAuthority { readonly boundary: CapabilityBoundary; readonly adapterId: AgentId; readonly version: string; readonly os: string; readonly enabled: boolean }
const mutationAuthorities = new WeakMap<object, MutationAuthority>();
const terminationAuthorities = new WeakMap<object, TerminationAuthority>();

export interface MutationEvidence {
  readonly operation: MutationOperation;
  readonly controlBoundary: CapabilityBoundary;
  readonly adapterId: AgentId;
  readonly version: string;
  readonly schema: SchemaVersion;
  readonly dependencyCoverage: 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
  readonly exclusionProtocol: string | null;
  readonly raceSafeFileOperations: 'VALIDATED' | 'UNAVAILABLE';
  readonly testedOS: string;
  readonly evidenceRef: string | null;
}

export interface MutationCapability {
  readonly enabled: boolean;
  readonly reason: string;
  readonly adapterId: AgentId;
  readonly version: string;
  readonly schemaKey: string;
  readonly operation: MutationOperation;
  readonly controlBoundary: CapabilityBoundary;
  readonly testedOS: string;
}

export function assessMutationCapability(evidence: MutationEvidence): MutationCapability {
  const currentOS = platform();
  const schemaKey = `${evidence.schema.name}@${evidence.schema.version}:${evidence.schema.fingerprint ?? 'unfingerprinted'}`;
  const missing: string[] = [];
  if (!AGENT_IDS.includes(evidence.adapterId) || !['database', 'trust-edit'].includes(evidence.operation)) missing.push('operation or adapter identity is invalid');
  if (!['controlled-test', 'protected-production'].includes(evidence.controlBoundary)) missing.push('control boundary is invalid');
  if (!evidence.version.trim()) missing.push('exact installed version is unknown');
  if (!evidence.schema.name.trim() || !evidence.schema.version.trim()) missing.push('exact schema name or version is missing');
  if (!evidence.schema.fingerprint || !/^[0-9a-f]{64}$/i.test(evidence.schema.fingerprint)) missing.push('schema fingerprint is missing or invalid');
  if (evidence.dependencyCoverage !== 'COMPLETE') missing.push('database and payload dependency closure is not complete');
  if (!evidence.exclusionProtocol?.trim()) missing.push('no validated external-writer exclusion protocol exists');
  if (evidence.raceSafeFileOperations !== 'VALIDATED') missing.push('race-safe paths and object operations are unavailable');
  if (evidence.testedOS !== currentOS) missing.push(`adapter was not validated on ${currentOS}`);
  if (!evidence.evidenceRef?.trim()) missing.push('capability evidence reference is missing');
  const capability = Object.freeze({
    enabled: missing.length === 0,
    reason: missing.length ? missing.join('; ') : 'Exact schema, dependency closure, OS, and writer exclusion are evidenced',
    adapterId: evidence.adapterId,
    version: evidence.version,
    schemaKey,
    operation: evidence.operation,
    controlBoundary: evidence.controlBoundary,
    testedOS: evidence.testedOS,
  });
  mutationAuthorities.set(capability, Object.freeze({ operation: evidence.operation, boundary: evidence.controlBoundary,
    adapterId: evidence.adapterId, version: evidence.version, schemaKey, os: evidence.testedOS, enabled: capability.enabled }));
  return capability;
}

export interface TerminationEvidence {
  readonly controlBoundary: CapabilityBoundary;
  readonly adapterId: AgentId;
  readonly version: string;
  readonly ownershipBinding: string | null;
  readonly stableProcessHandle: string | null;
  readonly testedOS: string;
  readonly evidenceRef: string | null;
}

export interface TerminationCapability {
  readonly enabled: boolean;
  readonly reason: string;
  readonly adapterId: AgentId;
  readonly version: string;
  readonly controlBoundary: CapabilityBoundary;
  readonly testedOS: string;
}

export function assessTerminationCapability(evidence: TerminationEvidence): TerminationCapability {
  const currentOS = platform();
  const missing: string[] = [];
  if (!AGENT_IDS.includes(evidence.adapterId)) missing.push('adapter identity is invalid');
  if (!['controlled-test', 'protected-production'].includes(evidence.controlBoundary)) missing.push('control boundary is invalid');
  if (!evidence.version.trim()) missing.push('exact agent version is unknown');
  if (!evidence.ownershipBinding?.trim()) missing.push('session-to-process ownership binding is unverified');
  if (!evidence.stableProcessHandle?.trim()) missing.push('stable PID-reuse-resistant process handles are unavailable');
  if (evidence.testedOS !== currentOS) missing.push(`termination was not validated on ${currentOS}`);
  if (!evidence.evidenceRef?.trim()) missing.push('termination evidence reference is missing');
  const capability = Object.freeze({ enabled: missing.length === 0,
    reason: missing.length ? missing.join('; ') : 'Ownership and stable process-handle evidence is complete', adapterId: evidence.adapterId, version: evidence.version,
    controlBoundary: evidence.controlBoundary, testedOS: evidence.testedOS });
  terminationAuthorities.set(capability, Object.freeze({ boundary: evidence.controlBoundary, adapterId: evidence.adapterId,
    version: evidence.version, os: evidence.testedOS, enabled: capability.enabled }));
  return capability;
}

export function requireTerminationCapability(capability: TerminationCapability, operation: string, expected?: { adapterId: AgentId; version: string; boundary: CapabilityBoundary }): void {
  const authority = capability && terminationAuthorities.get(capability as object);
  if (!authority || !authority.enabled || !capability.enabled || capability.adapterId !== authority.adapterId || capability.version !== authority.version
      || capability.controlBoundary !== authority.boundary || capability.testedOS !== authority.os
      || (expected && (expected.adapterId !== authority.adapterId || expected.version !== authority.version || expected.boundary !== authority.boundary))) {
    const adapter = capability?.adapterId ?? 'unknown adapter'; const reason = capability?.reason ?? 'no valid issued capability';
    throw new MaintenanceError('CAPABILITY_DISABLED', `${operation} is disabled for ${adapter}: capability issuance or identity did not validate; ${reason}`);
  }
}

export const nativeTerminationCapabilities: Readonly<Record<AgentId, TerminationCapability>> = Object.freeze({
  codex_cli: terminationDisabled('codex_cli'), claude_code_cli: terminationDisabled('claude_code_cli'),
  agy_cli: terminationDisabled('agy_cli'), opencode_cli: terminationDisabled('opencode_cli'),
});

export function requireMutationCapability(capability: MutationCapability, operation: MutationOperation, expected?: { adapterId: AgentId; version: string; schemaKey: string; boundary: CapabilityBoundary }): void {
  const authority = capability && mutationAuthorities.get(capability as object);
  if (!authority || !authority.enabled || !capability.enabled || capability.operation !== authority.operation || capability.controlBoundary !== authority.boundary
      || capability.adapterId !== authority.adapterId || capability.version !== authority.version || capability.schemaKey !== authority.schemaKey || capability.testedOS !== authority.os
      || operation !== authority.operation || (expected && (expected.adapterId !== authority.adapterId || expected.version !== authority.version || expected.schemaKey !== authority.schemaKey || expected.boundary !== authority.boundary))) {
    const adapter = capability?.adapterId ?? 'unknown adapter'; const reason = capability?.reason ?? 'no valid issued capability';
    throw new MaintenanceError('CAPABILITY_DISABLED', `${operation} is disabled for ${adapter}: capability issuance, identity, schema, OS, or control boundary did not validate; ${reason}`);
  }
}

/** Current native integrations have no Phase 0 evidence and therefore cannot mutate. */
export const nativeMutationCapabilities: Readonly<Record<AgentId, MutationCapability>> = Object.freeze({
  codex_cli: disabled('codex_cli', 'Codex session, writer-exclusion, and complete dependency evidence is not established'),
  claude_code_cli: disabled('claude_code_cli', 'Claude session, writer-exclusion, and complete dependency evidence is not established'),
  agy_cli: disabled('agy_cli', 'Antigravity database schema, writer-exclusion, and dependency closure are hypotheses'),
  opencode_cli: disabled('opencode_cli', 'OpenCode mutation schema and writer-exclusion evidence is not established'),
});

export const nativeTrustEditCapabilities: Readonly<Record<AgentId, MutationCapability>> = Object.freeze({
  codex_cli: disabled('codex_cli', 'Codex trust schema is readable at version 0.159.2, but no config-writer exclusion or race-safe replacement protocol is validated', 'trust-edit'),
  claude_code_cli: disabled('claude_code_cli', 'Claude trust mutation schema and config-writer exclusion are not established', 'trust-edit'),
  agy_cli: disabled('agy_cli', 'Antigravity trust mutation schema and config-writer exclusion are not established', 'trust-edit'),
  opencode_cli: disabled('opencode_cli', 'OpenCode trust mutation schema and config-writer exclusion are not established', 'trust-edit'),
});

export function nativeAdapterCapabilities(adapterId: AgentId, readReason = 'No validated read-only adapter is registered'): AdapterCapabilities {
  const storage = nativeMutationCapabilities[adapterId];
  const trust = nativeTrustEditCapabilities[adapterId];
  const termination = nativeTerminationCapabilities[adapterId];
  const disabled = (reason: string) => Object.freeze({ enabled: false, reason });
  return Object.freeze({
    sessionRead: disabled(readReason), dormantStorage: disabled(storage.reason), restore: disabled(storage.reason),
    trustRead: disabled(readReason), trustEdit: disabled(trust.reason), processTermination: disabled(termination.reason),
    externalWriterExclusion: disabled('No adapter protocol has been validated to exclude external writers for the full operation'),
    raceSafeFileOperations: disabled('Production handle-relative protected-root operations are unavailable'),
  });
}

function disabled(adapterId: AgentId, reason: string, operation: MutationOperation = 'database'): MutationCapability {
  const capability = Object.freeze({ enabled: false, reason, adapterId, version: 'unvalidated', schemaKey: 'unvalidated', operation, controlBoundary: 'protected-production' as const, testedOS: 'unvalidated' });
  mutationAuthorities.set(capability, Object.freeze({ operation, boundary: 'protected-production', adapterId, version: 'unvalidated', schemaKey: 'unvalidated', os: 'unvalidated', enabled: false }));
  return capability;
}

function terminationDisabled(adapterId: AgentId): TerminationCapability {
  const capability = Object.freeze({ enabled: false, adapterId, version: 'unvalidated', controlBoundary: 'protected-production' as const, testedOS: 'unvalidated',
    reason: 'No session-specific ownership binding or stable PID-reuse-resistant termination handle has been validated' });
  terminationAuthorities.set(capability, Object.freeze({ boundary: 'protected-production', adapterId, version: 'unvalidated', os: 'unvalidated', enabled: false }));
  return capability;
}
