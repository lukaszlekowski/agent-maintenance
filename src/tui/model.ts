import type { AgentId, AgentInventory, InventorySession } from '../types.ts';
import type { ArchiveRecord } from '../storage/contracts.ts';
import type { TuiTab } from './contracts.ts';

export const TABS: readonly TuiTab[] = Object.freeze(['Overview', 'Sessions', 'Storage', 'Trust', 'Settings', 'Help']);
export const AGENT_LABELS: Readonly<Record<AgentId, string>> = Object.freeze({
  codex_cli: 'Codex', claude_code_cli: 'Claude', agy_cli: 'Agy', opencode_cli: 'OpenCode',
});

export function tabForKey(input: string): TuiTab | undefined {
  if (input === '?') return 'Help';
  const number = Number(input);
  return Number.isInteger(number) && number >= 1 && number <= TABS.length ? TABS[number - 1] : undefined;
}

export function moveTab(current: TuiTab, direction: -1 | 1): TuiTab {
  const index = TABS.indexOf(current);
  return TABS[(index + direction + TABS.length) % TABS.length]!;
}

export function pageStart(page: number, pageSize: number, count: number): number {
  const pages = Math.max(1, Math.ceil(count / Math.max(1, pageSize)));
  return Math.min(Math.max(0, page), pages - 1) * Math.max(1, pageSize);
}

export interface SessionRow { readonly kind: 'agent' | 'session'; readonly agentId: AgentId; readonly key: string; readonly session?: InventorySession }

export function sessionRows(inventory: AgentInventory, expanded: ReadonlySet<AgentId>): readonly SessionRow[] {
  const rows: SessionRow[] = [];
  for (const adapter of inventory.adapters) {
    const sessions = [...inventory.sessions, ...inventory.verifiedSubagents].filter((row) => row.agentId === adapter.agentId);
    rows.push(Object.freeze({ kind: 'agent', agentId: adapter.agentId, key: `agent:${adapter.agentId}` }));
    if (expanded.has(adapter.agentId)) for (const session of sessions) rows.push(Object.freeze({ kind: 'session', agentId: adapter.agentId, key: `session:${session.id}`, session }));
  }
  return Object.freeze(rows);
}

export function exactArchiveSelection(records: readonly ArchiveRecord[], chosenArchiveId?: string):
  | { readonly kind: 'selected'; readonly record: ArchiveRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous'; readonly archiveIds: readonly string[] } {
  if (chosenArchiveId !== undefined) {
    const matches = records.filter((row) => row.archiveId === chosenArchiveId);
    return matches.length === 1 ? { kind: 'selected', record: matches[0]! } : { kind: 'missing' };
  }
  if (records.length === 0) return { kind: 'missing' };
  if (records.length > 1) return { kind: 'ambiguous', archiveIds: Object.freeze(records.map((row) => row.archiveId)) };
  return { kind: 'selected', record: records[0]! };
}

export function trustRows(inventory: AgentInventory) {
  return inventory.trustEntries.map((entry) => Object.freeze({ ...entry, label: AGENT_LABELS[entry.agentId] }));
}
