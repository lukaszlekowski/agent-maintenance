import { MaintenanceError, type AgentId, type SchemaVersion } from '../types.ts';

export type OwnershipObservation = 'ACTIVE' | 'DORMANT' | 'UNKNOWN';
export type ActivityObservation = 'ACTIVE' | 'QUIESCENT' | 'UNKNOWN';

export interface StorageSafetyEvidence {
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly adapterSchema: string;
  readonly observedAt: string;
  readonly ownership: OwnershipObservation;
  readonly activity: ActivityObservation;
  readonly ownershipEvidence: string;
  readonly activityEvidence: string;
  readonly externalWriterExclusion: { readonly enabled: boolean; readonly evidence: string };
  readonly raceSafeFileOperations: { readonly enabled: boolean; readonly evidence: string };
}

export interface StorageFilesystemBackend {
  readonly kind: 'protected-root' | 'controlled-test';
  assertAvailable(): void;
}

const authorizedBackends = new WeakSet<object>();
function issueBackend<T extends StorageFilesystemBackend>(backend: T): T { authorizedBackends.add(backend); return Object.freeze(backend); }
export function isAuthorizedStorageBackend(backend: StorageFilesystemBackend): boolean { return Boolean(backend && authorizedBackends.has(backend)); }

/** No production backend is registered until handle-relative protected-root operations are implemented. */
export const protectedRootBackend: StorageFilesystemBackend = issueBackend({
  kind: 'protected-root',
  assertAvailable(): never {
    throw new MaintenanceError('RACE_SAFE_BACKEND_UNAVAILABLE', 'Handle-relative protected-root operations are unavailable; storage mutation is disabled');
  },
});

/** Explicit test-only backend. Path-based helpers are permitted only against disposable controlled roots. */
export function controlledTestBackend(): StorageFilesystemBackend {
  return issueBackend({ kind: 'controlled-test', assertAvailable: () => undefined });
}

export function adapterSchemaKey(schema: SchemaVersion): string {
  return `${schema.name}@${schema.version}:${schema.fingerprint ?? 'unfingerprinted'}`;
}

export function assertStorageSafety(evidence: StorageSafetyEvidence, expected: {
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly adapterSchema: string;
  readonly backend: StorageFilesystemBackend;
}): void {
  if (!isAuthorizedStorageBackend(expected.backend)) throw new MaintenanceError('STORAGE_BACKEND_UNISSUED', 'Filesystem backend did not originate from the supported backend issuer');
  if (expected.backend.kind !== 'controlled-test') {
    expected.backend.assertAvailable();
    throw new MaintenanceError('RACE_SAFE_BACKEND_UNAVAILABLE', 'No registered storage filesystem backend can prove race-safe object operations');
  }
  const observed = Date.parse(evidence.observedAt);
  if (evidence.agentId !== expected.agentId || evidence.sessionId !== expected.sessionId || evidence.adapterSchema !== expected.adapterSchema
    || !Number.isFinite(observed) || Date.now() - observed > 30_000 || observed > Date.now() + 1_000) {
    throw new MaintenanceError('STORAGE_SAFETY_EVIDENCE_INVALID', 'Storage readiness evidence is stale or belongs to another adapter/session');
  }
  if (evidence.ownership !== 'DORMANT' || evidence.activity !== 'QUIESCENT') {
    throw new MaintenanceError('SESSION_NOT_DORMANT', 'Storage actions require current dormant ownership and quiescent external activity', {
      ownership: evidence.ownership, activity: evidence.activity,
    });
  }
  const evidenceIds = [evidence.ownershipEvidence, evidence.activityEvidence,
    evidence.externalWriterExclusion.evidence, evidence.raceSafeFileOperations.evidence];
  if (evidenceIds.some((value) => typeof value !== 'string' || value.trim().length === 0)
    || !evidence.externalWriterExclusion.enabled || !evidence.raceSafeFileOperations.enabled) {
    throw new MaintenanceError('STORAGE_CAPABILITY_UNAVAILABLE', 'Storage requires evidence-backed external exclusion and race-safe filesystem operations');
  }
}
