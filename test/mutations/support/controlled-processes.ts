import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ProcessIdentity } from '../../../src/types.ts';
import { assessTerminationCapability } from '../../../src/mutations/capabilities.ts';
import type { OwnedProcessTarget, OwnedTerminationAdapter, TerminationInspection, TerminationSignal } from '../../../src/mutations/termination.ts';

export interface ChildFixture { readonly child: ChildProcess; readonly identity: ProcessIdentity }

export async function spawnFixture(code: string): Promise<ChildFixture> {
  const child = spawn(process.execPath, ['-e', `${code}; console.log('__fixture-ready__')`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child, 'spawn');
  await once(child.stdout!, 'data');
  const identity: ProcessIdentity = Object.freeze({ pid: child.pid!, startTime: randomUUID(), command: `${process.execPath} controlled-test-child` });
  return Object.freeze({ child, identity });
}

export function controlledProcessAdapter(targets: readonly { readonly child: ChildProcess; readonly identity: ProcessIdentity; readonly role: 'child' | 'session'; readonly depth: number }[],
  options: { readonly beforeSignal?: (target: OwnedProcessTarget, signal: TerminationSignal) => void; readonly invalidateInspectionFor?: number } = {}): OwnedTerminationAdapter {
  const ownershipEvidenceId = new Map(targets.map((target) => [target.identity.pid, `fixture-owned-${target.identity.pid}`]));
  const processByPid = new Map(targets.map((target) => [target.identity.pid, target.child]));
  const ownedTargets = targets.map((target) => Object.freeze({ identity: target.identity, sessionId: 'fixture-session', agentId: 'codex_cli' as const,
    ownershipEvidenceId: ownershipEvidenceId.get(target.identity.pid)!, depth: target.depth, role: target.role }));
  return Object.freeze({
    agentId: 'codex_cli' as const, version: 'disposable-process-fixture',
    capability: assessTerminationCapability({ adapterId: 'codex_cli', version: 'disposable-process-fixture', controlBoundary: 'controlled-test', ownershipBinding: 'exact ChildProcess handle map',
      stableProcessHandle: 'controlled ChildProcess object; fixture-only', testedOS: platform(), evidenceRef: 'test/mutations/termination.test.ts' }),
    discoverOwnedTargets: async () => Object.freeze(ownedTargets),
    inspectTarget: async (pid: number, sessionId: string): Promise<TerminationInspection | null> => {
      const child = processByPid.get(pid); const original = ownedTargets.find((target) => target.identity.pid === pid);
      if (!child || !original || sessionId !== 'fixture-session' || child.exitCode !== null || child.signalCode !== null) return null;
      const identity = child.exitCode === null && child.signalCode === null ? original.identity : null;
      return identity ? Object.freeze({ identity, sessionId, agentId: 'codex_cli', ownershipEvidenceId: original.ownershipEvidenceId,
        ownership: pid === options.invalidateInspectionFor ? 'UNKNOWN' : 'VERIFIED_ACTIVE' }) : null;
    },
    isAlive: async (pid: number) => {
      const child = processByPid.get(pid);
      return child ? child.exitCode === null && child.signalCode === null : false;
    },
    signal: async (target: OwnedProcessTarget, signal: TerminationSignal) => {
      options.beforeSignal?.(target, signal);
      const child = processByPid.get(target.identity.pid);
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
    },
  });
}
