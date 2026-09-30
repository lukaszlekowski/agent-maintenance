import { MaintenanceError, type AgentId, type ProcessIdentity } from '../types.ts';
import { requireTerminationCapability, type TerminationCapability } from './capabilities.ts';

export type TerminationSignal = 'SIGTERM' | 'SIGKILL';

export interface OwnedProcessTarget {
  readonly identity: ProcessIdentity;
  readonly sessionId: string;
  readonly agentId: AgentId;
  readonly ownershipEvidenceId: string;
  readonly depth: number;
  readonly role: 'child' | 'session';
}

export interface TerminationInspection {
  readonly identity: ProcessIdentity;
  readonly sessionId: string;
  readonly agentId: AgentId;
  readonly ownershipEvidenceId: string;
  readonly ownership: 'VERIFIED_ACTIVE' | 'UNKNOWN';
}

export interface OwnedTerminationAdapter {
  readonly agentId: AgentId;
  readonly version: string;
  readonly capability: TerminationCapability;
  discoverOwnedTargets(sessionId: string): Promise<readonly OwnedProcessTarget[]>;
  inspectTarget(pid: number, sessionId: string): Promise<TerminationInspection | null>;
  isAlive(pid: number): Promise<boolean>;
  signal(target: OwnedProcessTarget, signal: TerminationSignal): Promise<void>;
}

export interface TargetTerminationResult {
  readonly identity: ProcessIdentity;
  readonly gracefulSignalSent: boolean;
  readonly escalationSignalSent: boolean;
  readonly exited: boolean;
}

export interface TerminationResult {
  readonly confirmed: boolean;
  readonly status: 'CANCELLED' | 'TERMINATED' | 'PARTIAL' | 'UNKNOWN';
  readonly targets: readonly TargetTerminationResult[];
  readonly reason?: string;
}

export async function terminateOwnedSession(adapter: OwnedTerminationAdapter, sessionId: string,
  confirm: (targets: readonly OwnedProcessTarget[]) => Promise<boolean>, graceMs = 5_000): Promise<TerminationResult> {
  requireTerminationCapability(adapter.capability, 'Process termination', { adapterId: adapter.agentId, version: adapter.version, boundary: adapter.capability.controlBoundary });
  if (adapter.capability.controlBoundary !== 'controlled-test') throw new MaintenanceError('CAPABILITY_DISABLED', 'Production termination remains disabled until a protected, PID-reuse-resistant process handle is validated');
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 5_000) throw new MaintenanceError('TERMINATION_WAIT_INVALID', 'Grace period must be a bounded integer from zero to 5000ms');
  const discovered = await adapter.discoverOwnedTargets(sessionId);
  if (adapter.capability.adapterId !== adapter.agentId || adapter.capability.version !== adapter.version) {
    throw new MaintenanceError('CAPABILITY_ADAPTER_MISMATCH', 'Termination capability does not match the adapter identity and exact version');
  }
  const targets = discovered.map((target) => Object.freeze({ ...target, identity: Object.freeze({ ...target.identity }) }))
    .sort((a, b) => (b.role === 'child' ? b.depth : -1) - (a.role === 'child' ? a.depth : -1));
  validateTargets(targets, sessionId);
  if (!(await confirm(Object.freeze(targets)))) return Object.freeze({ confirmed: false, status: 'CANCELLED', targets: Object.freeze([]) });
  const progress = new Map<number, { readonly target: OwnedProcessTarget; gracefulSignalSent: boolean; escalationSignalSent: boolean; exited: boolean }>();
  for (const target of targets) progress.set(target.identity.pid, { target, gracefulSignalSent: false, escalationSignalSent: false, exited: false });
  for (const target of targets) {
    if (target.agentId !== adapter.agentId) throw new MaintenanceError('TERMINATION_ADAPTER_MISMATCH', 'Termination adapter returned a target for a different agent');
    const reason = await revalidate(adapter, target);
    if (reason) return result('UNKNOWN', progress, reason);
    try { await adapter.signal(target, 'SIGTERM'); progress.get(target.identity.pid)!.gracefulSignalSent = true; }
    catch (error) { return result('UNKNOWN', progress, error instanceof Error ? error.message : 'Graceful signal failed'); }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    for (const row of progress.values()) row.exited = !(await adapter.isAlive(row.target.identity.pid));
    if ([...progress.values()].every((row) => row.exited)) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  }
  for (const target of targets) {
    const row = progress.get(target.identity.pid)!;
    if (row.exited) continue;
    const reason = await revalidate(adapter, target);
    if (reason) return result('UNKNOWN', progress, reason);
    try { await adapter.signal(target, 'SIGKILL'); row.escalationSignalSent = true; }
    catch (error) { return result('UNKNOWN', progress, error instanceof Error ? error.message : 'Escalation signal failed'); }
  }
  const reapDeadline = Date.now() + 1_000;
  while (Date.now() < reapDeadline) {
    for (const row of progress.values()) row.exited = !(await adapter.isAlive(row.target.identity.pid));
    if ([...progress.values()].every((row) => row.exited)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (const row of progress.values()) row.exited = !(await adapter.isAlive(row.target.identity.pid));
  const rows = Object.freeze([...progress.values()].map(({ target, ...entry }) => Object.freeze({ identity: target.identity, ...entry })));
  return Object.freeze({ confirmed: true, status: rows.every((row) => row.exited) ? 'TERMINATED' : 'PARTIAL', targets: rows });
}

async function revalidate(adapter: OwnedTerminationAdapter, target: OwnedProcessTarget): Promise<string | null> {
  const inspection = await adapter.inspectTarget(target.identity.pid, target.sessionId);
  if (!inspection || inspection.ownership !== 'VERIFIED_ACTIVE') return `PID ${target.identity.pid} ownership is no longer verified; remaining signals were cancelled`;
  if (!sameIdentity(inspection.identity, target.identity) || inspection.agentId !== target.agentId || inspection.sessionId !== target.sessionId
      || inspection.ownershipEvidenceId !== target.ownershipEvidenceId) return `PID ${target.identity.pid} identity or ownership changed; remaining signals were cancelled`;
  return null;
}

function validateTargets(targets: readonly OwnedProcessTarget[], sessionId: string): void {
  const seen = new Set<number>();
  if (!targets.length) throw new MaintenanceError('NO_OWNED_TARGETS', 'No adapter-verified process targets were found for this session');
  for (const target of targets) {
    if (!Number.isSafeInteger(target.identity.pid) || target.identity.pid <= 0 || target.sessionId !== sessionId
        || !target.identity.startTime.trim() || !target.identity.command.trim() || !target.ownershipEvidenceId.trim()
        || !Number.isSafeInteger(target.depth) || target.depth < 0 || seen.has(target.identity.pid)
        || (target.role !== 'child' && target.role !== 'session')) {
      throw new MaintenanceError('TERMINATION_TARGET_INVALID', 'Adapter returned an invalid or duplicate owned target');
    }
    seen.add(target.identity.pid);
  }
  if (targets.filter((target) => target.role === 'session').length !== 1) throw new MaintenanceError('TERMINATION_ROOT_INVALID', 'Adapter must identify exactly one owned session process');
}

function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean { return a.pid === b.pid && a.startTime === b.startTime && a.command === b.command; }

function result(status: 'UNKNOWN', progress: Map<number, { readonly target: OwnedProcessTarget; gracefulSignalSent: boolean; escalationSignalSent: boolean; exited: boolean }>, reason: string): TerminationResult {
  const targets = Object.freeze([...progress.values()].map(({ target, ...entry }) => Object.freeze({ identity: target.identity, ...entry })));
  return Object.freeze({ confirmed: true, status, targets, reason });
}
