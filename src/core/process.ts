import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { MaintenanceError, type ProcessIdentity } from '../types.ts';

function positivePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new MaintenanceError('INVALID_PID', 'PID must be a positive safe integer');
}

export function discoverProcessIds(): readonly number[] {
  const os = platform();
  if (os === 'darwin' || os === 'linux') {
    const result = spawnSync('ps', ['-axo', 'pid='], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } });
    if (result.error || result.status !== 0 || result.stdout === null) {
      throw new MaintenanceError('PROCESS_PROBE_FAILED', result.error?.message ?? (result.stderr.trim() || 'ps could not enumerate processes'));
    }
    return result.stdout.split(/\r?\n/).flatMap((line) => {
      const pid = Number(line.trim());
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
  }
  throw new MaintenanceError('PROCESS_DISCOVERY_UNSUPPORTED', `Process discovery is disabled on ${os} until its identity probe is validated`);
}

export function probeProcessIdentity(pid: number): ProcessIdentity | null {
  positivePid(pid);
  const os = platform();
  if (os === 'darwin' || os === 'linux') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } });
    if (result.error) throw new MaintenanceError('PROCESS_PROBE_FAILED', result.error.message, { pid });
    if (result.status !== 0) {
      if (result.stderr.trim()) throw new MaintenanceError('PROCESS_PROBE_FAILED', result.stderr.trim(), { pid });
      return null;
    }
    if (!result.stdout.trim()) return null;
    const line = result.stdout.trim();
    const match = line.match(/^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) throw new MaintenanceError('PROCESS_IDENTITY_UNPARSEABLE', 'OS returned an unrecognized process identity format', { pid });
    return Object.freeze({ pid, startTime: match[1]!, command: match[2]! });
  }
  throw new MaintenanceError('PROCESS_IDENTITY_UNSUPPORTED', `Process identity probes are disabled on ${os} until validated`);
}

export type Liveness = 'ALIVE' | 'NOT_RUNNING' | 'UNKNOWN';

export function probeProcessLiveness(pid: number): Liveness {
  positivePid(pid);
  try {
    process.kill(pid, 0);
    return 'ALIVE';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'NOT_RUNNING';
    return 'UNKNOWN';
  }
}

export function sameProcessIdentity(expected: ProcessIdentity, actual: ProcessIdentity | null): boolean {
  return actual !== null && expected.pid === actual.pid && expected.startTime === actual.startTime && expected.command === actual.command;
}
