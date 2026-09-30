import { nativeAdapterCapabilities } from '../../src/mutations/capabilities.ts';
import { sessionId, type AgentInventory, type InventorySession } from '../../src/types.ts';
import type { ArchiveRecord } from '../../src/storage/contracts.ts';
import type { TuiServices } from '../../src/tui/contracts.ts';
import { MemorySettingsStore } from '../../src/tui/settings.ts';
import { validateConfig, CONFIG_DEFAULTS } from '../../src/core/config.ts';

export const fixtureSession: InventorySession = Object.freeze({ id: sessionId('session-1'), agentId: 'codex_cli', title: 'Fixture session', updatedAt: 'unknown',
  ownership: 'UNKNOWN', ownershipExplanation: 'Fixture has no ownership binding', workloadKind: 'unknown' });

export function fixtureInventory(): AgentInventory {
  const agents = ['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli'] as const;
  return Object.freeze({ generatedAt: '2026-01-01T00:00:00Z', sessions: Object.freeze([fixtureSession]), verifiedSubagents: Object.freeze([]),
    trustEntries: Object.freeze([{ agentId: 'codex_cli' as const, path: '/tmp/project', trustLevel: 'trusted' as const, state: 'VALID' as const, explanation: 'fixture path' }]),
    adapters: Object.freeze(agents.map((agentId) => Object.freeze({ agentId, version: 'fixture', schema: null,
      capabilities: nativeAdapterCapabilities(agentId, 'Fixture capability state'), explanation: 'Fixture adapter state' }))) });
}

export function fixtureArchive(id: string): ArchiveRecord {
  return Object.freeze({ archiveId: id, txId: `tx-${id}`, agentId: 'codex_cli', sessionId: 'session-1', category: 'archived',
    createdAt: '2026-01-01T00:00:00Z', status: 'REGISTERED', rootId: 'MAINTENANCE', relativePath: `archived/codex_cli/session-1/${id}` });
}

export function fixtureServices(overrides: Partial<TuiServices> = {}): TuiServices {
  return {
    loadInventory: async () => fixtureInventory(), listArchives: async () => ({ records: [], available: true }),
    performSessionAction: async () => ({ ok: false, message: 'Action is disabled' }),
    restoreArchive: async (_agent, _session, id) => ({ ok: false, message: id ? `Blocked exact archive ${id}` : 'An exact archive ID is required' }),
    pruneTrust: async () => ({ ok: false, message: 'Trust edit is disabled' }),
    addTrustedPath: async () => ({ ok: false, message: 'Trust edit is disabled' }),
    syncTrust: async () => Object.freeze(['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli'].map((agentId) => ({ agentId: agentId as 'codex_cli' | 'claude_code_cli' | 'agy_cli' | 'opencode_cli', ok: false, message: 'Trust edit is disabled' }))),
    settings: new MemorySettingsStore(validateConfig(CONFIG_DEFAULTS)),
    guiLauncher: { launch: async () => ({ launched: false, reason: 'GUI unavailable in fixture' }) },
    ...overrides,
  };
}
