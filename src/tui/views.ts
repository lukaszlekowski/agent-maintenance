import React from 'react';
import { Box, Text } from 'ink';
import type { AgentId, AgentInventory, InventorySession } from '../types.ts';
import type { ArchiveRecord } from '../storage/contracts.ts';
import type { MaintenanceConfig } from '../core/config.ts';
import { AGENT_LABELS, sessionRows } from './model.ts';
import type { TuiModal, TuiTab } from './contracts.ts';

export type UiRow = { readonly kind: 'agent'; readonly agentId: AgentId; readonly count: number; readonly expanded: boolean }
  | { readonly kind: 'session'; readonly session: InventorySession }
  | { readonly kind: 'archive'; readonly archive: ArchiveRecord }
  | { readonly kind: 'trust'; readonly entry: NonNullable<AgentInventory>['trustEntries'][number] }
  | { readonly kind: 'trust-capability'; readonly agentId: AgentId; readonly version: string | null; readonly read: string; readonly edit: string; readonly reason: string }
  | { readonly kind: 'adapter'; readonly agentId: AgentId; readonly reason: string; readonly version: string | null }
  | { readonly kind: 'setting'; readonly key: string; readonly label: string; readonly value: string }
  | { readonly kind: 'help'; readonly label: string; readonly value: string };

export function uiRowKey(row: UiRow): string {
  if (row.kind === 'agent' || row.kind === 'adapter' || row.kind === 'trust-capability') return `${row.kind}:${row.agentId}`;
  if (row.kind === 'session') return `session:${row.session.id}`;
  if (row.kind === 'archive') return `archive:${row.archive.archiveId}`;
  if (row.kind === 'trust') return `trust:${row.entry.agentId}:${row.entry.path}`;
  if (row.kind === 'setting') return `setting:${row.key}`;
  return `help:${row.label}`;
}

export function visibleRows(tab: TuiTab, inventory: AgentInventory | undefined, archives: readonly ArchiveRecord[], expanded: ReadonlySet<AgentId>, settings: MaintenanceConfig, agentFilter: AgentId | null, trustFilter: AgentId | null = null): readonly UiRow[] {
  if (tab === 'Overview') return (inventory?.adapters ?? []).map((adapter) => ({ kind: 'adapter', agentId: adapter.agentId, reason: adapter.explanation, version: adapter.version }));
  if (tab === 'Sessions') return inventory ? sessionRows(inventory, expanded).filter((row) => agentFilter === null || row.agentId === agentFilter).map((row) => row.kind === 'agent'
    ? ({ kind: 'agent', agentId: row.agentId, count: [...inventory.sessions, ...inventory.verifiedSubagents].filter((s) => s.agentId === row.agentId).length, expanded: expanded.has(row.agentId) })
    : ({ kind: 'session', session: row.session! })) : [];
  if (tab === 'Storage') return archives.map((archive) => ({ kind: 'archive', archive }));
  if (tab === 'Trust') return [
    ...(inventory?.trustEntries ?? []).filter((entry) => trustFilter === null || entry.agentId === trustFilter).map((entry) => ({ kind: 'trust' as const, entry })),
    ...(inventory?.adapters ?? []).filter((adapter) => trustFilter === null || adapter.agentId === trustFilter).map((adapter) => ({ kind: 'trust-capability' as const, agentId: adapter.agentId, version: adapter.version,
      read: adapter.capabilities.trustRead.enabled ? 'available' : 'disabled', edit: adapter.capabilities.trustEdit.enabled ? 'available' : 'disabled',
      reason: adapter.capabilities.trustRead.enabled ? adapter.capabilities.trustEdit.reason : adapter.capabilities.trustRead.reason })),
  ];
  if (tab === 'Settings') return settingRows(settings);
  if (tab === 'Help') return helpRows();
  return [];
}

export function renderRow(row: UiRow, selected: boolean, inventory: AgentInventory | undefined, columns: number) {
  const h = React.createElement; const prefix = selected ? '❯ ' : '  '; const width = Math.max(12, columns - 4); const style = selected ? { color: 'cyan' as const } : {};
  if (row.kind === 'agent') return h(Text, { key: `agent-${row.agentId}`, ...style, bold: selected }, fit(`${prefix}${row.expanded ? '▼' : '▶'} ${AGENT_LABELS[row.agentId]} • ${row.count} validated session records`, width));
  if (row.kind === 'session') {
    const prefixKind = row.session.workloadKind === 'logical-subagent' ? 'Verified logical subagent (parent unresolved)' : 'Session';
    return h(Text, { key: `session-${row.session.id}`, ...style }, fit(`${prefix}${prefixKind}: ${row.session.title} • ${row.session.ownership} • ${row.session.id}`, width));
  }
  if (row.kind === 'archive') return h(Box, { key: row.archive.archiveId, flexDirection: 'column' },
    h(Text, { ...style }, fit(`${prefix}[${row.archive.category.toUpperCase()}] ${AGENT_LABELS[row.archive.agentId]} ${row.archive.sessionId} • ${row.archive.createdAt}`, width)),
    h(Text, { color: 'gray' }, `    Archive ID: ${row.archive.archiveId}`));
  if (row.kind === 'trust') return h(Text, { key: `${row.entry.agentId}:${row.entry.path}`, ...style }, fit(`${prefix}${row.entry.path} • ${AGENT_LABELS[row.entry.agentId]} ${row.entry.trustLevel} • ${row.entry.state}`, width));
  if (row.kind === 'trust-capability') return h(Text, { key: `trust-${row.agentId}`, ...style }, fit(`${prefix}${AGENT_LABELS[row.agentId]} ${row.version ?? '(version unknown)'} • trust read ${row.read}; edit ${row.edit} • ${row.reason}`, width));
  if (row.kind === 'adapter') {
    const count = inventory?.sessions.filter((session) => session.agentId === row.agentId).length ?? 0;
    const unknown = inventory?.sessions.filter((session) => session.agentId === row.agentId && session.ownership === 'UNKNOWN').length ?? 0;
    const capabilities = inventory?.adapters.find((adapter) => adapter.agentId === row.agentId)?.capabilities;
    const read = capabilities?.sessionRead.enabled ? 'read ready' : 'read disabled';
    const storage = capabilities?.dormantStorage.enabled ? 'storage ready' : 'storage disabled';
    const trust = capabilities?.trustRead.enabled ? 'trust read ready' : 'trust read disabled';
    return h(Text, { key: row.agentId, ...style }, fit(`${prefix}${AGENT_LABELS[row.agentId]} ${row.version ?? '(version unknown)'} • ${count} indexed; ${unknown} ownership unknown • ${read}; ${storage}; ${trust}`, width));
  }
  if (row.kind === 'setting') return h(Text, { key: row.key, ...style }, fit(`${prefix}${row.label}: ${row.value}`, width));
  return h(Text, { key: row.label, ...style }, fit(`${prefix}${row.label} ${row.value}`, width));
}

export function renderModal(modal: TuiModal, columns: number, maxHeight = 8, offset = 0) {
  const h = React.createElement; const detail = modal.kind === 'field' ? `${modal.title}\n${modal.field}: ${modal.value}` : `${modal.title}\n${modal.message}`;
  const width = Math.max(8, columns - 6); const lines = wrapLines(detail, width);
  const detailBudget = Math.max(1, maxHeight - 3); const start = modal.kind === 'field' ? Math.max(0, lines.length - detailBudget) : Math.max(0, Math.min(offset, lines.length - detailBudget));
  const shown = lines.slice(start, start + detailBudget);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: modal.kind === 'notice' ? 'yellow' : 'cyan', paddingX: 1, width: Math.max(12, columns - 2), height: Math.max(4, maxHeight), overflow: 'hidden' },
    ...shown.map((line, index) => h(Text, { key: index, bold: index === 0 && start === 0 }, line)),
    modal.kind === 'confirm' ? h(Text, { color: 'gray' }, '[/] scroll • Y/N confirm') : modal.kind === 'field' ? h(Text, { color: 'cyan' }, `${start > 0 ? '…' : ''}> ${fit(modal.value, width - 4)} • Enter/Esc`) : h(Text, { color: 'gray' }, '[/] scroll • Enter close'));
}

export function emptyMessage(tab: TuiTab, inventory: AgentInventory | undefined, reason: string): string {
  if (tab === 'Sessions' && !inventory) return 'Waiting for read-only inventory…';
  if (tab === 'Sessions') return 'No session records were returned by validated readers. Unsupported adapters remain visible on Overview.';
  if (tab === 'Storage') return reason || 'No registered archives are available.';
  if (tab === 'Trust') return 'No validated trust entries were returned.';
  return 'No items.';
}

function settingRows(settings: MaintenanceConfig): UiRow[] {
  return [
    { kind: 'setting', key: 'tempFolder', label: 'Temporary folder (t)', value: settings.tempFolder },
    { kind: 'setting', key: 'defaultPort', label: 'Default loopback port (p)', value: String(settings.defaultPort) },
    { kind: 'setting', key: 'confirmDelete', label: 'Confirm destructive requests (c)', value: String(settings.confirmDelete) },
    { kind: 'setting', key: 'displayWarnings', label: 'Display safety warnings (w)', value: String(settings.displayWarnings) },
    { kind: 'setting', key: 'showArchiveNotice', label: 'Show archive notice (n)', value: String(settings.showArchiveNotice) },
    { kind: 'setting', key: 'theme', label: 'Theme (h)', value: settings.theme },
    { kind: 'setting', key: 'gui', label: 'Open desktop interface (g)', value: 'Phase 6 launcher' },
  ];
}

function helpRows(): UiRow[] {
  return [
    { kind: 'help', label: 'Tabs', value: '←/→, Tab/Shift+Tab, 1–6; ? opens Help' },
    { kind: 'help', label: 'Lists', value: '↑/↓ select; Enter opens details; [ / ] changes page' },
    { kind: 'help', label: 'Overview', value: 'Enter filters Sessions by agent; i shows capability details' },
    { kind: 'help', label: 'Sessions', value: 'r refresh; a archive, d soft-delete, m temp move, k terminate (gated)' },
    { kind: 'help', label: 'Storage', value: 'u or Enter restores the exact selected archive ID' },
    { kind: 'help', label: 'Trust', value: 'f filters agent; a/+ adds a directory; s synchronizes the selected path; c prunes' },
    { kind: 'help', label: 'Settings', value: 't/p edit; c/w/n toggles; h theme; g GUI launcher' },
    { kind: 'help', label: 'Modal', value: 'Enter/y confirms, Esc/n cancels; shortcuts are scoped away' },
    { kind: 'help', label: 'Ownership', value: 'UNKNOWN blocks storage and termination; no activity is inferred' },
    { kind: 'help', label: 'GUI', value: 'Settings → g requests the shared launcher; GUI server is Phase 6' },
  ];
}

function fit(value: string, width: number): string { return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`; }
function wrapLines(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (word.length > width) {
        if (line) lines.push(line);
        line = '';
        for (let index = 0; index < word.length; index += width) {
          const chunk = word.slice(index, index + width);
          if (chunk.length === width) lines.push(chunk); else line = chunk;
        }
      } else if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}
