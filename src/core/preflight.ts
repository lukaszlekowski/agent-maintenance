import { MaintenanceError, requireKnownOwnership, type CapabilityDecision, type OwnershipState, type VerifiedOwnership, type ProcessIdentity } from '../types.ts';
import { sameProcessIdentity } from './process.ts';

export interface ExternalActivityProbe {
  readonly state: 'QUIESCENT' | 'ACTIVE' | 'UNKNOWN';
  readonly evidence: string;
}

export interface StoragePolicyInput {
  readonly ownership: unknown;
  readonly externalActivity: ExternalActivityProbe;
  readonly externalWriterExclusion: CapabilityDecision;
  readonly raceSafeFileOperations: CapabilityDecision;
}

export interface PolicyDecision { readonly allowed: boolean; readonly reason: string; }

export function authorizeDormantStorage(input: StoragePolicyInput): PolicyDecision {
  const ownership = requireKnownOwnership(input.ownership);
  if (ownership !== 'DORMANT') return Object.freeze({ allowed: false, reason: `Storage operations require DORMANT ownership; observed ${ownership}` });
  if (input.externalActivity.state !== 'QUIESCENT') return Object.freeze({ allowed: false, reason: `External activity is ${input.externalActivity.state}` });
  if (!input.externalWriterExclusion.enabled) return Object.freeze({ allowed: false, reason: input.externalWriterExclusion.reason });
  if (!input.raceSafeFileOperations.enabled) return Object.freeze({ allowed: false, reason: input.raceSafeFileOperations.reason });
  return Object.freeze({ allowed: true, reason: 'Dormant ownership, external exclusion, and race-safe operations are verified' });
}

export interface TerminationPolicyInput {
  readonly ownership: unknown;
  readonly currentIdentity: ProcessIdentity | null;
  readonly expectedIdentity: ProcessIdentity;
  readonly expectedOwnership: Pick<VerifiedOwnership, 'agentId' | 'sessionId'>;
  readonly verifiedOwnership?: VerifiedOwnership;
  readonly capability: CapabilityDecision;
}

export function authorizeActiveTermination(input: TerminationPolicyInput): PolicyDecision {
  const ownership: OwnershipState = requireKnownOwnership(input.ownership);
  if (ownership !== 'ACTIVE') return Object.freeze({ allowed: false, reason: `Termination requires ACTIVE ownership; observed ${ownership}` });
  if (!sameProcessIdentity(input.expectedIdentity, input.currentIdentity)) return Object.freeze({ allowed: false, reason: 'Process identity is missing or mismatched' });
  if (!input.verifiedOwnership || input.verifiedOwnership.state !== 'VERIFIED_ACTIVE') return Object.freeze({ allowed: false, reason: 'Adapter has not verified process-to-session ownership' });
  if (input.verifiedOwnership.agentId !== input.expectedOwnership.agentId || input.verifiedOwnership.sessionId !== input.expectedOwnership.sessionId) {
    return Object.freeze({ allowed: false, reason: 'Adapter ownership evidence refers to a different agent or session' });
  }
  if (!input.capability.enabled) return Object.freeze({ allowed: false, reason: input.capability.reason });
  return Object.freeze({ allowed: true, reason: 'Active process identity and adapter ownership are verified' });
}

export function requireCapability(decision: CapabilityDecision, operation: string): void {
  if (!decision.enabled) throw new MaintenanceError('CAPABILITY_DISABLED', `${operation} is disabled: ${decision.reason}`);
}

/** No native activity protocol is asserted until Phase 0 evidence validates one. */
export function unresolvedExternalActivity(reason = 'No validated adapter activity probe is registered'): ExternalActivityProbe {
  return Object.freeze({ state: 'UNKNOWN', evidence: reason });
}
