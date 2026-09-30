import { probeWorkspacePath, type MountProbe } from './core/paths.ts';
import { nativeAdapterCapabilities } from './mutations/capabilities.ts';
import { type AdapterInventoryStatus, type AgentId, type AgentInventory, type InventorySession, type InventoryTrustEntry, type TrustPathObservation } from './types.ts';

export function unsupportedAdapter(agentId: AgentId, version: string | null, explanation: string): AdapterInventoryStatus {
  return Object.freeze({ agentId, version, schema: null, capabilities: nativeAdapterCapabilities(agentId, explanation), explanation });
}

export async function buildInventory(input: {
  readonly sessions: readonly InventorySession[];
  readonly adapters: readonly AdapterInventoryStatus[];
  readonly trustPaths?: readonly TrustPathObservation[];
  readonly mountProbe?: MountProbe;
  readonly generatedAt?: string;
}): Promise<AgentInventory> {
  const trustEntries: InventoryTrustEntry[] = [];
  const mountProbe = input.mountProbe ?? (async () => 'UNKNOWN' as const);
  for (const entry of input.trustPaths ?? []) {
    const result = await probeWorkspacePath(entry.path, mountProbe);
    trustEntries.push(Object.freeze({ agentId: entry.agentId, path: entry.path, trustLevel: entry.trustLevel, state: result.state, explanation: result.reason }));
  }
  const ordered = [...input.sessions].sort((a, b) => a.agentId.localeCompare(b.agentId)
    || (a.updatedAt === 'unknown' ? 1 : 0) - (b.updatedAt === 'unknown' ? 1 : 0)
    || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const sessions = ordered.filter((session) => session.workloadKind !== 'logical-subagent');
  const verifiedSubagents = ordered.filter((session) => session.workloadKind === 'logical-subagent');
  return Object.freeze({
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sessions: Object.freeze(sessions), verifiedSubagents: Object.freeze(verifiedSubagents),
    trustEntries: Object.freeze(trustEntries), adapters: Object.freeze([...input.adapters]),
  });
}
