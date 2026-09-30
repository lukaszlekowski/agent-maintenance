import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { MaintenanceError, type ProcessCandidate } from '../types.ts';
import { probeProcessIdentity } from './process.ts';

function parentMap(): Map<number, number> {
  if (platform() !== 'darwin' && platform() !== 'linux') {
    throw new MaintenanceError('PROCESS_TREE_UNSUPPORTED', `Process ancestry is disabled on ${platform()} until validated`);
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } });
  if (result.error || result.status !== 0) throw new MaintenanceError('PROCESS_TREE_PROBE_FAILED', result.error?.message ?? result.stderr.trim());
  const map = new Map<number, number>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) map.set(Number(match[1]), Number(match[2]));
  }
  return map;
}

/** Ancestry returns candidates only. It does not establish session ownership or termination authority. */
export function discoverDescendantCandidates(rootPid: number): readonly ProcessCandidate[] {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new MaintenanceError('INVALID_PID', 'PID must be a positive safe integer');
  const parents = parentMap();
  if (!parents.has(rootPid)) return Object.freeze([]);
  const depths = new Map<number, number>([[rootPid, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of parents) {
      const parentDepth = depths.get(ppid);
      if (parentDepth !== undefined && !depths.has(pid)) {
        depths.set(pid, parentDepth + 1);
        changed = true;
      }
    }
  }
  const candidates: ProcessCandidate[] = [];
  for (const [pid, depth] of depths) {
    if (pid === rootPid) continue;
    const identity = probeProcessIdentity(pid);
    if (identity) candidates.push(Object.freeze({ identity, parentPid: parents.get(pid) ?? null, depth }));
  }
  return Object.freeze(candidates.sort((a, b) => b.depth - a.depth || a.identity.pid - b.identity.pid));
}
