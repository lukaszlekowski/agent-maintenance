import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { CONFIG_DEFAULTS, validateConfig, type MaintenanceConfig } from '../core/config.ts';
import path from 'node:path';
import { restorePolicy, sessionActionPolicy, trustEditPolicy, trustSyncPolicy } from '../core/action-policy.ts';
import type { AgentId, AgentInventory, InventorySession } from '../types.ts';
import type { ArchiveRecord } from '../storage/contracts.ts';
import { AGENT_LABELS, TABS, exactArchiveSelection, moveTab, pageStart } from './model.ts';
import type { TuiIntent, TuiModal, TuiServices, TuiState } from './contracts.ts';
import { emptyMessage, renderModal, renderRow, uiRowKey, visibleRows, type UiRow } from './views.ts';

export interface TuiAppProps {
  readonly services: TuiServices;
  readonly initialInventory?: AgentInventory;
  readonly initialArchives?: readonly ArchiveRecord[];
  readonly initialSettings?: MaintenanceConfig;
  readonly viewport?: { readonly rows: number; readonly columns: number };
}

const h = React.createElement;
const AGENTS: readonly AgentId[] = ['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli'];

export function TuiApp(props: TuiAppProps) {
  const [inventory, setInventory] = useState<AgentInventory | undefined>(props.initialInventory);
  const [archives, setArchives] = useState<readonly ArchiveRecord[]>(props.initialArchives ?? []);
  const [archiveReason, setArchiveReason] = useState('Loading managed archives…');
  const [state, setState] = useState<TuiState>({ tab: 'Overview', selected: 0, selectedKey: null, page: 0, agentFilter: null, trustFilter: null, expandedAgents: new Set(AGENTS), modal: null, modalOffset: 0,
    statusMessage: 'Loading read-only inventory…', settings: props.initialSettings ?? validateConfig(CONFIG_DEFAULTS) });
  const [viewport, setViewport] = useState(props.viewport ?? { rows: process.stdout.rows ?? 24, columns: process.stdout.columns ?? 80 });

  useEffect(() => {
    if (props.viewport) { setViewport(props.viewport); return; }
    const onResize = () => setViewport({ rows: process.stdout.rows ?? 24, columns: process.stdout.columns ?? 80 });
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, [props.viewport]);

  useEffect(() => {
    let alive = true;
    if (!props.initialInventory) props.services.loadInventory().then((value) => { if (alive) setInventory(value); })
      .catch((error: unknown) => { if (alive) setState((current) => ({ ...current, statusMessage: `Inventory unavailable: ${message(error)}` })); });
    if (!props.initialArchives) props.services.listArchives().then((value) => {
      if (!alive) return; setArchives(value.records); setArchiveReason(value.reason ?? (value.available ? '' : 'Archive listing unavailable'));
    }).catch((error: unknown) => { if (alive) setArchiveReason(`Archive listing unavailable: ${message(error)}`); });
    if (!props.initialSettings) props.services.settings.load().then((value) => { if (alive) setState((current) => ({ ...current, settings: value })); })
      .catch((error: unknown) => { if (alive) setState((current) => ({ ...current, statusMessage: `Settings unavailable: ${message(error)}` })); });
    return () => { alive = false; };
  }, [props.services, props.initialInventory, props.initialArchives, props.initialSettings]);

  const rows = useMemo(() => visibleRows(state.tab, inventory, archives, state.expandedAgents, state.settings, state.agentFilter, state.trustFilter), [state.tab, inventory, archives, state.expandedAgents, state.settings, state.agentFilter, state.trustFilter]);
  const compact = viewport.rows < 10;
  const pageSize = state.tab === 'Storage' ? 1 : Math.max(1, viewport.rows - (compact ? 5 : 4));
  const keyedIndex = state.selectedKey === null ? -1 : rows.findIndex((row) => uiRowKey(row) === state.selectedKey);
  const selectedIndex = rows.length === 0 ? -1 : keyedIndex >= 0 ? keyedIndex
    : state.selectedKey !== null ? 0 : Math.max(0, Math.min(rows.length - 1, state.selected));
  useEffect(() => {
    const selectedKey = selectedIndex < 0 ? null : uiRowKey(rows[selectedIndex]!);
    setState((current) => current.selected === selectedIndex && current.selectedKey === selectedKey ? current
      : { ...current, selected: selectedIndex, selectedKey, page: Math.floor(Math.max(0, selectedIndex) / pageSize) });
  }, [rows, selectedIndex, pageSize]);
  const start = pageStart(Math.floor(selectedIndex / pageSize), pageSize, rows.length);
  const visible = rows.slice(start, start + pageSize);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  async function runIntent(intent: TuiIntent) {
    setState((current) => ({ ...current, modal: null, statusMessage: 'Working…' }));
    try {
      let result;
      if (intent.kind === 'session') {
        const gate = inventory ? sessionActionPolicy(inventory, intent.action, intent.session) : { allowed: false, reason: 'Read-only inventory has not loaded' };
        result = gate.allowed ? await props.services.performSessionAction(intent.action, intent.session) : { ok: false, message: gate.reason };
      } else if (intent.kind === 'restore') {
        const gate = inventory ? restorePolicy(inventory, intent.archive.agentId, intent.archive.archiveId) : { allowed: false, reason: 'Read-only inventory has not loaded' };
        result = gate.allowed ? await props.services.restoreArchive(intent.archive.agentId, intent.archive.sessionId, intent.archive.archiveId) : { ok: false, message: gate.reason };
      } else if (intent.kind === 'prune') {
        const gate = inventory ? trustEditPolicy(inventory, intent.agentId) : { allowed: false, reason: 'Read-only inventory has not loaded' };
        result = gate.allowed ? await props.services.pruneTrust(intent.agentId, intent.path) : { ok: false, message: gate.reason };
      } else if (intent.kind === 'trust-add') {
        const gate = inventory ? trustEditPolicy(inventory, intent.agentId) : { allowed: false, reason: 'Read-only inventory has not loaded' };
        result = gate.allowed ? await props.services.addTrustedPath(intent.agentId, intent.path) : { ok: false, message: gate.reason };
      } else if (intent.kind === 'trust-sync') {
        const gate = inventory ? trustSyncPolicy(inventory, intent.agentId) : { allowed: false, reason: 'Read-only inventory has not loaded' };
        const outcomes = gate.allowed ? await props.services.syncTrust(intent.agentId, intent.path)
          : [{ agentId: intent.agentId, ok: false, message: gate.reason }];
        const ok = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
        result = { ok, message: outcomes.map((outcome) => `${AGENT_LABELS[outcome.agentId]}: ${outcome.ok ? 'synced' : `blocked — ${outcome.message}`}`).join('\n') || 'No installed agent configurations are available' };
      }
      else {
        const launched = await props.services.guiLauncher.launch();
        result = { ok: launched.launched, message: launched.reason ?? 'GUI launch requested' };
      }
      setState((current) => ({ ...current, modal: { kind: 'notice', title: result.ok ? 'Complete' : 'Unavailable', message: result.message }, statusMessage: result.message }));
    } catch (error) { setState((current) => ({ ...current, modal: { kind: 'notice', title: 'Action blocked', message: message(error) }, statusMessage: message(error) })); }
  }

  async function saveSetting(next: MaintenanceConfig) {
    try {
      const valid = validateConfig(next); await props.services.settings.save(valid);
      setState((current) => ({ ...current, settings: valid, modal: null, statusMessage: 'Settings saved to agent-maintenance preferences' }));
    } catch (error) { setState((current) => ({ ...current, modal: { kind: 'notice', title: 'Settings not saved', message: message(error) } })); }
  }

  function openIntent(intent: TuiIntent, title: string, detail: string) {
    setState((current) => ({ ...current, modal: { kind: 'confirm', title, message: detail, intent } }));
  }

  useInput((input, key) => {
    if (state.modal) {
      if (state.modal.kind !== 'field' && (key.upArrow || key.downArrow || input === '[' || input === ']')) {
        setState((current) => ({ ...current, modalOffset: Math.max(0, current.modalOffset + (key.upArrow || input === '[' ? -1 : 1)) })); return;
      }
      handleModal(input, key, state.modal, state.settings, setState, runIntent, saveSetting);
      return;
    }
    const selected = rows[selectedIndex];
    if (key.leftArrow || key.tab && key.shift) { setState((current) => ({ ...current, tab: moveTab(current.tab, -1), selected: 0, selectedKey: null, page: 0, agentFilter: null })); return; }
    if (key.rightArrow || key.tab) { setState((current) => ({ ...current, tab: moveTab(current.tab, 1), selected: 0, selectedKey: null, page: 0, agentFilter: null })); return; }
    const numberTab = /^[1-6]$/.test(input) ? TABS[Number(input) - 1] : undefined;
    if (numberTab) { setState((current) => ({ ...current, tab: numberTab, selected: 0, selectedKey: null, page: 0, agentFilter: null })); return; }
    if (input === '?') { setState((current) => ({ ...current, tab: 'Help', selected: 0, selectedKey: null, page: 0, agentFilter: null })); return; }
    if (key.upArrow) { setState((current) => selectionState(current, rows, Math.max(0, selectedIndex - 1), pageSize)); return; }
    if (key.downArrow) { setState((current) => selectionState(current, rows, Math.min(rows.length - 1, selectedIndex + 1), pageSize)); return; }
    if (input === '[' || input === ']') {
      const delta = input === '[' ? -pageSize : pageSize; const next = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta));
      setState((current) => selectionState(current, rows, next, pageSize)); return;
    }
    if (key.return) { handleEnter(selected, state, inventory, archives, openIntent, setState, archiveReason, saveSetting); return; }
    if (state.tab === 'Overview' && input === 'i' && selected?.kind === 'adapter') {
      showAdapterDetails(selected, inventory, setState); return;
    }
    if (state.tab === 'Trust' && input.toLowerCase() === 'f') {
      const choices: readonly (AgentId | null)[] = [null, ...AGENTS];
      const current = choices.indexOf(state.trustFilter);
      setState((value) => ({ ...value, trustFilter: choices[(current + 1) % choices.length] ?? null, selected: 0, selectedKey: null, page: 0 })); return;
    }
    if (state.tab === 'Trust' && (input === '+' || input.toLowerCase() === 'a')) {
      if (!state.trustFilter) setState((value) => ({ ...value, modal: { kind: 'notice', title: 'Choose an agent', message: 'Press f to select a specific agent before adding a trusted directory. Native trust edits remain disabled unless the shared capability gate permits them.' } }));
      else setState((value) => ({ ...value, modal: { kind: 'field', title: `Add ${AGENT_LABELS[state.trustFilter!]} trusted directory`, field: 'trustPath', value: '', agentId: state.trustFilter! } })); return;
    }
    if (state.tab === 'Trust' && input.toLowerCase() === 's' && selected?.kind === 'trust') {
      openIntent({ kind: 'trust-sync', agentId: selected.entry.agentId, path: selected.entry.path }, 'Synchronize trusted directory', `Request per-configuration synchronization for ${selected.entry.path}? Each agent result will be reported independently.`); return;
    }
    if (state.tab === 'Sessions' && input === 'r') {
      setState((current) => ({ ...current, statusMessage: 'Refreshing read-only inventory…' }));
      void props.services.loadInventory().then(setInventory).then(() => setState((current) => ({ ...current, statusMessage: 'Inventory refreshed' })))
        .catch((error: unknown) => setState((current) => ({ ...current, statusMessage: `Inventory refresh failed: ${message(error)}` })));
      return;
    }
    if (state.tab === 'Sessions' && selected?.kind === 'session' && selected.session) {
      const action = ({ a: 'archive', d: 'soft-delete', m: 'temp-move', k: 'terminate' } as const)[input as 'a' | 'd' | 'm' | 'k'];
      if (action) openIntent({ kind: 'session', action, session: selected.session }, actionTitle(action), sessionActionReason(action, selected.session));
    } else if (state.tab === 'Storage' && input === 'r') {
      const selection = exactArchiveSelection(archives);
      if (selection.kind === 'ambiguous') setState((current) => ({ ...current, modal: { kind: 'notice', title: 'Choose an exact archive', message: `Multiple archive instances exist: ${selection.archiveIds.join(', ')}` } }));
      else if (selection.kind === 'selected') openIntent({ kind: 'restore', archive: selection.record }, 'Restore archived session', `Restore exact archive ID ${selection.record.archiveId}? Existing data will never be overwritten.`);
      else setState((current) => ({ ...current, modal: { kind: 'notice', title: 'Archive unavailable', message: archiveReason || 'No registered archive matches the selection' } }));
    } else if (state.tab === 'Storage' && input === 'u' && selected?.kind === 'archive') {
      openIntent({ kind: 'restore', archive: selected.archive }, 'Restore archived session', `Restore exact archive ID ${selected.archive.archiveId}? Existing data will never be overwritten.`);
    } else if (state.tab === 'Trust' && input === 'c' && selected?.kind === 'trust') {
      openIntent({ kind: 'prune', agentId: selected.entry.agentId, path: selected.entry.path }, 'Prune trust entry', `Request removal of ${selected.entry.path}. The trust service must show and confirm its exact diff.`);
    } else if (state.tab === 'Settings') handleSettingsKey(input, selected?.kind === 'setting' ? selected.key : undefined, state, saveSetting, openIntent, setState);
  });

  const tabs = TABS.map((name, index) => {
    const label = name === 'Sessions' && state.agentFilter ? `Sessions:${AGENT_LABELS[state.agentFilter]}` : name;
    return h(Text, { key: name, color: state.tab === name ? 'cyan' : 'gray', bold: state.tab === name }, `${state.tab === name ? '[' : ''}${index + 1}.${label}${state.tab === name ? ']' : ''} `);
  });
  const content = visible.length ? visible.map((row, index) => renderRow(row, start + index === selectedIndex, inventory, viewport.columns))
    : [h(Text, { key: 'empty', color: 'gray' }, emptyMessage(state.tab, inventory, archiveReason))];
  const safeRows = compact ? Math.max(1, viewport.rows - 1) : undefined;
  const compactTab = state.tab === 'Trust' && state.trustFilter ? `Trust:${AGENT_LABELS[state.trustFilter]}` : state.tab;
  const shownTabs = compact ? [h(Text, { key: state.tab, color: 'cyan', bold: true }, `[${TABS.indexOf(state.tab) + 1}.${compactTab}]`)] : tabs;
  return h(Box, { flexDirection: 'column', width: Math.max(20, viewport.columns) },
    h(Box, { flexWrap: 'nowrap', height: 1, overflow: 'hidden' }, ...shownTabs),
    !compact && h(Text, { color: 'gray' }, '─'.repeat(Math.max(10, viewport.columns - 1))),
    h(Box, { flexDirection: 'column', height: safeRows ?? Math.max(1, viewport.rows - 3), overflow: 'hidden' }, ...(state.modal ? [renderModal(state.modal, viewport.columns, safeRows ?? Math.max(1, viewport.rows - 3), state.modalOffset)] : content)),
    !compact && h(Text, { color: 'gray' }, fitLine(`${state.tab}${state.tab === 'Trust' ? ` • ${state.trustFilter ? AGENT_LABELS[state.trustFilter] : 'All'} (f)` : ''} • ${rows.length ? `${Math.floor(selectedIndex / pageSize) + 1}/${pageCount}` : '0 items'} • ${state.statusMessage.replace(/\s+/g, ' ')}`, Math.max(1, viewport.columns - 1))),
  );
}

function handleEnter(row: UiRow | undefined, state: TuiState, inventory: AgentInventory | undefined, archives: readonly ArchiveRecord[], open: (intent: TuiIntent, title: string, detail: string) => void, set: React.Dispatch<React.SetStateAction<TuiState>>, archiveReason: string, save: (value: MaintenanceConfig) => Promise<void>) {
  if (state.tab === 'Sessions' && row?.kind === 'agent') {
    const expanded = new Set(state.expandedAgents);
    if (expanded.has(row.agentId)) expanded.delete(row.agentId); else expanded.add(row.agentId);
    set((current) => ({ ...current, expandedAgents: expanded })); return;
  }
  if (state.tab === 'Sessions' && row?.kind === 'session') {
    set((current) => ({ ...current, modal: { kind: 'notice', title: 'Session ownership', message: `${row.session.ownership}: ${row.session.ownershipExplanation}` } })); return;
  }
  if (state.tab === 'Storage') {
    const selection = exactArchiveSelection(archives, row?.kind === 'archive' ? row.archive.archiveId : undefined);
    if (selection.kind === 'ambiguous') { set((current) => ({ ...current, modal: { kind: 'notice', title: 'Choose an exact archive', message: `Multiple archive instances exist: ${selection.archiveIds.join(', ')}` } })); return; }
    if (selection.kind === 'selected') open({ kind: 'restore', archive: selection.record }, 'Restore archived session', `Restore exact archive ID ${selection.record.archiveId}?`);
    else set((current) => ({ ...current, modal: { kind: 'notice', title: 'Archive listing unavailable', message: archiveReason || 'No registered archive matches the selection' } }));
    return;
  }
  if (state.tab === 'Overview' && row?.kind === 'adapter') {
    set((current) => ({ ...current, tab: 'Sessions', selected: 0, selectedKey: null, page: 0, agentFilter: row.agentId })); return;
  }
  if (state.tab === 'Trust' && row?.kind === 'trust') set((current) => ({ ...current, modal: { kind: 'notice', title: `${AGENT_LABELS[row.entry.agentId]} trust entry`,
    message: `${row.entry.path} • ${row.entry.trustLevel} • ${row.entry.state}: ${row.entry.explanation}` } }));
  if (state.tab === 'Trust' && row?.kind === 'trust-capability') showAdapterDetails({ kind: 'adapter', agentId: row.agentId, version: row.version, reason: row.reason }, inventory, set);
  if (state.tab === 'Settings' && row?.kind === 'setting') handleSettingsKey('', row.key, state, save, open, set);
  if (!inventory && state.tab !== 'Settings') set((current) => ({ ...current, statusMessage: 'Inventory has not loaded' }));
}

function showAdapterDetails(row: Extract<UiRow, { kind: 'adapter' }>, inventory: AgentInventory | undefined, set: React.Dispatch<React.SetStateAction<TuiState>>) {
  const status = inventory?.adapters.find((adapter) => adapter.agentId === row.agentId);
  const details = status ? Object.entries(status.capabilities).map(([name, value]) => `${name}: ${value.enabled ? 'available' : `disabled — ${value.reason}`}`).join('\n') : row.reason;
  set((current) => ({ ...current, modal: { kind: 'notice', title: `${AGENT_LABELS[row.agentId]} capability status`, message: details } }));
}

function handleModal(input: string, key: { readonly return?: boolean; readonly escape?: boolean; readonly backspace?: boolean }, modal: TuiModal, settings: MaintenanceConfig, set: React.Dispatch<React.SetStateAction<TuiState>>, run: (intent: TuiIntent) => Promise<void>, save: (value: MaintenanceConfig) => Promise<void>) {
  if (modal.kind === 'field') {
    if (key.escape) { set((current) => ({ ...current, modal: null, statusMessage: 'Input cancelled' })); return; }
    if (key.return) {
      if (modal.field === 'trustPath') {
        if (!modal.agentId || !path.isAbsolute(modal.value.trim())) {
          set((current) => ({ ...current, modal: { kind: 'notice', title: 'Invalid directory', message: 'Enter an absolute directory path. No trust service was called.' } })); return;
        }
        const agentId = modal.agentId;
        set((current) => ({ ...current, modal: { kind: 'confirm', title: 'Add trusted directory', message: `Request trust for ${modal.value.trim()} in ${AGENT_LABELS[agentId]}? The shared capability gate will decide whether this is available.`, intent: { kind: 'trust-add', agentId, path: modal.value.trim() } } })); return;
      }
      const value = modal.field === 'defaultPort' ? Number(modal.value) : modal.value;
      void save({ ...settings, [modal.field]: value }); return;
    }
    if (key.backspace || input === '\u007f' || input === '\b') set((current) => ({ ...current, modal: { ...modal, value: modal.value.slice(0, -1) } }));
    else if (input.length > 0 && !/[\u0000-\u001f\u007f]/.test(input) && modal.value.length + input.length <= 4096) {
      set((current) => ({ ...current, modal: { ...modal, value: modal.value + input } }));
    }
    return;
  }
  if (modal.kind === 'confirm') {
    if (key.escape || input.toLowerCase() === 'n') { set((current) => ({ ...current, modal: null, statusMessage: 'Action cancelled; no service was called' })); return; }
    if (key.return || input.toLowerCase() === 'y') { void run(modal.intent); return; }
    return;
  }
  if (key.return || key.escape || input === ' ') set((current) => ({ ...current, modal: null }));
}

function handleSettingsKey(input: string, selectedKey: string | undefined, state: TuiState, save: (value: MaintenanceConfig) => Promise<void>, open: (intent: TuiIntent, title: string, detail: string) => void, set: React.Dispatch<React.SetStateAction<TuiState>>) {
  const shortcuts: Record<string, string> = { t: 'tempFolder', p: 'defaultPort', c: 'confirmDelete', w: 'displayWarnings', n: 'showArchiveNotice', h: 'theme', g: 'gui' };
  const key = input ? shortcuts[input] : selectedKey;
  if (key === 'tempFolder') set((current) => ({ ...current, modal: { kind: 'field', title: 'Custom temporary folder', field: 'tempFolder', value: state.settings.tempFolder } }));
  else if (key === 'defaultPort') set((current) => ({ ...current, modal: { kind: 'field', title: 'Default loopback port', field: 'defaultPort', value: String(state.settings.defaultPort) } }));
  else if (key === 'gui') open({ kind: 'launch-gui' }, 'Open desktop interface', 'Request a GUI launch through the shared launcher contract?');
  else {
    const next = key === 'confirmDelete' ? { ...state.settings, confirmDelete: !state.settings.confirmDelete }
      : key === 'displayWarnings' ? { ...state.settings, displayWarnings: !state.settings.displayWarnings }
      : key === 'showArchiveNotice' ? { ...state.settings, showArchiveNotice: !state.settings.showArchiveNotice }
      : key === 'theme' ? { ...state.settings, theme: state.settings.theme === 'default' ? 'dark' : state.settings.theme === 'dark' ? 'light' : 'default' } : undefined;
    if (next) void save(validateConfig(next));
  }
}

function sessionActionReason(action: string, session: InventorySession): string {
  if (action === 'terminate') return `Termination requires verified process ownership. Current ownership: ${session.ownership}.`;
  return `Storage changes require DORMANT ownership and a validated native transaction adapter. Current ownership: ${session.ownership}.`;
}
function actionTitle(action: string): string { return ({ archive: 'Archive session', 'soft-delete': 'Soft-delete session', 'temp-move': 'Move session to temp', terminate: 'Terminate verified session' } as Record<string, string>)[action] ?? 'Session action'; }
function message(error: unknown): string { return error instanceof Error ? error.message : 'Operation failed'; }
function fitLine(value: string, width: number): string { return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`; }
function selectionState(current: TuiState, rows: readonly UiRow[], selected: number, pageSize: number): TuiState {
  const index = rows.length === 0 ? -1 : Math.max(0, Math.min(rows.length - 1, selected));
  return { ...current, selected: index, selectedKey: index < 0 ? null : uiRowKey(rows[index]!), page: Math.floor(Math.max(0, index) / pageSize) };
}
