import type { AgentInventory, InventorySession } from '../types.ts';

export type SessionMaintenanceAction = 'archive' | 'soft-delete' | 'temp-move' | 'terminate';

export interface ActionPolicyDecision { readonly allowed: boolean; readonly reason: string }

export function sessionActionPolicy(inventory: AgentInventory, action: SessionMaintenanceAction, session: InventorySession): ActionPolicyDecision {
  const adapter = inventory.adapters.find((row) => row.agentId === session.agentId);
  if (!adapter) return deny('No adapter status is registered for this session');
  if (action === 'terminate') {
    if (session.ownership !== 'ACTIVE') return deny(`Termination requires confirmed ACTIVE ownership; observed ${session.ownership}. ${session.ownershipExplanation}`);
    return deny('Inventory does not carry a validated session-to-process identity binding; termination is unavailable');
  }
  if (session.ownership !== 'DORMANT') return deny(`Storage actions require DORMANT ownership; observed ${session.ownership}. ${session.ownershipExplanation}`);
  if (session.workloadKind !== 'user-session') return deny('Only a validated user-session identity can be sent to storage services');
  const capability = adapter.capabilities.dormantStorage;
  return capability.enabled ? allow() : deny(capability.reason);
}

export function restorePolicy(inventory: AgentInventory, agentId: string, archiveId?: string): ActionPolicyDecision {
  if (!archiveId) return deny('An exact archive ID is required; ambiguous restores are never selected implicitly');
  const adapter = inventory.adapters.find((row) => row.agentId === agentId);
  if (!adapter) return deny('No adapter status is registered for this archive');
  return adapter.capabilities.restore.enabled ? allow() : deny(adapter.capabilities.restore.reason);
}

export function trustEditPolicy(inventory: AgentInventory, agentId: string): ActionPolicyDecision {
  const adapter = inventory.adapters.find((row) => row.agentId === agentId);
  if (!adapter) return deny('No adapter status is registered for this trust entry');
  return adapter.capabilities.trustEdit.enabled ? allow() : deny(adapter.capabilities.trustEdit.reason);
}

export function trustSyncPolicy(inventory: AgentInventory, sourceAgentId: string): ActionPolicyDecision {
  const adapter = inventory.adapters.find((row) => row.agentId === sourceAgentId);
  if (!adapter) return deny('No adapter status is registered for the selected trust source');
  if (!adapter.capabilities.trustRead.enabled) return deny(adapter.capabilities.trustRead.reason);
  return allow();
}

function allow(): ActionPolicyDecision { return Object.freeze({ allowed: true, reason: 'Adapter capability gate is enabled; transaction services must still revalidate authorization' }); }
function deny(reason: string): ActionPolicyDecision { return Object.freeze({ allowed: false, reason }); }
