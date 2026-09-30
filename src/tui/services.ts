import { collectInventory } from '../cli.ts';
import { nativeMutationCapabilities, nativeTerminationCapabilities, nativeTrustEditCapabilities } from '../mutations/capabilities.ts';
import type { AgentId } from '../types.ts';
import type { TuiServices, ActionResult, TrustSyncResult } from './contracts.ts';
import { FileSettingsStore } from './settings.ts';
import { createGuiLauncher } from '../gui/launcher.ts';

const unavailableArchiveReason = 'Managed archives cannot be safely inspected until the protected-root storage backend is available';

export function createDefaultTuiServices(): TuiServices {
  const settings = new FileSettingsStore();
  const services: TuiServices = {
    loadInventory: () => collectInventory(),
    listArchives: async () => Object.freeze({ records: Object.freeze([]), available: false, reason: unavailableArchiveReason }),
    performSessionAction: async (action, session) => {
      if (action === 'terminate' && session.ownership !== 'ACTIVE') {
        return denied(`Termination requires verified ACTIVE ownership; this session is ${session.ownership}. ${session.ownershipExplanation}`);
      }
      if (action !== 'terminate' && session.ownership !== 'DORMANT') {
        return denied(`Storage actions require DORMANT ownership; this session is ${session.ownership}. ${session.ownershipExplanation}`);
      }
      const capability = action === 'terminate' ? nativeTerminationCapabilities[session.agentId] : nativeMutationCapabilities[session.agentId];
      if (!capability.enabled) return denied(capability.reason);
      return denied('No native transaction/termination adapter is enabled for this agent; the shared service rejected the action');
    },
    restoreArchive: async (agentId, _sessionId, archiveId) => {
      if (!archiveId) return denied('Select an exact archive ID before requesting restore');
      return denied(`Restore is disabled for ${agentId}: protected-root storage operations are unavailable`);
    },
    pruneTrust: async (agentId) => denied(nativeTrustEditCapabilities[agentId].reason),
    addTrustedPath: async (agentId) => denied(nativeTrustEditCapabilities[agentId].reason),
    syncTrust: async (sourceAgentId, path): Promise<readonly TrustSyncResult[]> => Object.freeze((['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli'] as const).map((agentId) => Object.freeze({
      agentId, ok: false, message: `Sync ${path} from ${sourceAgentId} is disabled. ${nativeTrustEditCapabilities[agentId].reason}`,
    }))),
    settings, guiLauncher: createGuiLauncher({ settings }),
  };
  return Object.freeze(services);
}

export function defaultTrustCapabilityReason(agentId: AgentId): string { return nativeTrustEditCapabilities[agentId].reason; }

function denied(message: string): ActionResult { return Object.freeze({ ok: false, message }); }
