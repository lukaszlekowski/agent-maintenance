import { isAbsolute } from 'node:path';
import { restorePolicy, sessionActionPolicy, trustEditPolicy, trustSyncPolicy } from '../core/action-policy.ts';
import { validateConfig } from '../core/config.ts';
import type { AgentId, AgentInventory } from '../types.ts';
import type { TuiServices } from '../tui/contracts.ts';
import type { GuiApi, GuiCommand, GuiCommandResult, GuiSnapshot } from './contracts.ts';

const AGENTS: readonly AgentId[] = ['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli'];
const ACTIONS = ['archive', 'soft-delete', 'temp-move', 'terminate'] as const;

export function createGuiApi(services: TuiServices): GuiApi {
  return Object.freeze({
    async snapshot(): Promise<GuiSnapshot> {
      const inventory = await services.loadInventory();
      try {
        const listing = await services.listArchives();
        return Object.freeze({ inventory, archives: listing.records, archiveAvailable: listing.available,
          ...(listing.reason === undefined ? {} : { archiveReason: listing.reason }) });
      } catch (error) {
        return Object.freeze({ inventory, archives: Object.freeze([]), archiveAvailable: false, archiveReason: errorMessage(error) });
      }
    },
    dispatch: async (command: GuiCommand) => dispatch(services, command),
    loadSettings: () => services.settings.load(),
  });
}

export function parseGuiCommand(input: unknown): GuiCommand | null {
  if (!isRecord(input) || typeof input.kind !== 'string') return null;
  if (input.kind === 'session' && isAgent(input.agentId) && typeof input.sessionId === 'string' && input.sessionId.length > 0 && input.sessionId.length <= 256
    && ACTIONS.includes(input.action as typeof ACTIONS[number])) {
    return Object.freeze({ kind: 'session', action: input.action as typeof ACTIONS[number], agentId: input.agentId, sessionId: input.sessionId });
  }
  if (input.kind === 'restore' && typeof input.archiveId === 'string' && input.archiveId.length > 0 && input.archiveId.length <= 256) return Object.freeze({ kind: 'restore', archiveId: input.archiveId });
  if ((input.kind === 'trust-add' || input.kind === 'trust-prune') && isAgent(input.agentId) && typeof input.path === 'string' && input.path.length > 0 && input.path.length <= 4096) {
    return Object.freeze({ kind: input.kind, agentId: input.agentId, path: input.path });
  }
  if (input.kind === 'trust-sync' && isAgent(input.agentId) && typeof input.path === 'string' && input.path.length > 0 && input.path.length <= 4096) {
    return Object.freeze({ kind: 'trust-sync', agentId: input.agentId, path: input.path });
  }
  if (input.kind === 'settings-save' && Object.hasOwn(input, 'settings')) return Object.freeze({ kind: 'settings-save', settings: input.settings });
  return null;
}

async function dispatch(services: TuiServices, command: GuiCommand): Promise<GuiCommandResult> {
  try {
    if (command.kind === 'settings-save') {
      const settings = validateConfig(command.settings); await services.settings.save(settings);
      return { ok: true, message: 'Preferences saved' };
    }
    const inventory = await services.loadInventory();
    if (command.kind === 'session') return sessionAction(services, inventory, command);
    if (command.kind === 'restore') return restore(services, inventory, command.archiveId);
    if (command.kind === 'trust-add') return trustAdd(services, inventory, command.agentId, command.path);
    if (command.kind === 'trust-prune') return trustPrune(services, inventory, command.agentId, command.path);
    return trustSync(services, inventory, command.agentId, command.path);
  } catch (error) { return { ok: false, message: errorMessage(error) }; }
}

async function sessionAction(services: TuiServices, inventory: AgentInventory, command: Extract<GuiCommand, { kind: 'session' }>): Promise<GuiCommandResult> {
  const matches = [...inventory.sessions, ...inventory.verifiedSubagents].filter((row) => row.agentId === command.agentId && row.id === command.sessionId);
  if (matches.length !== 1) return { ok: false, message: matches.length ? 'Session identity is ambiguous' : 'Session is no longer in the current inventory' };
  const session = matches[0]!; const gate = sessionActionPolicy(inventory, command.action, session);
  return gate.allowed ? services.performSessionAction(command.action, session) : { ok: false, message: gate.reason };
}

async function restore(services: TuiServices, inventory: AgentInventory, archiveId: string): Promise<GuiCommandResult> {
  const listing = await services.listArchives();
  const matches = listing.records.filter((archive) => archive.archiveId === archiveId);
  if (matches.length !== 1) return { ok: false, message: matches.length ? 'Archive ID is ambiguous' : listing.reason ?? 'Exact archive ID is unavailable' };
  const archive = matches[0]!; const gate = restorePolicy(inventory, archive.agentId, archive.archiveId);
  return gate.allowed ? services.restoreArchive(archive.agentId, archive.sessionId, archive.archiveId) : { ok: false, message: gate.reason };
}

async function trustAdd(services: TuiServices, inventory: AgentInventory, agentId: AgentId, path: string): Promise<GuiCommandResult> {
  if (!isAbsolute(path)) return { ok: false, message: 'Trust directory must be an absolute path' };
  const gate = trustEditPolicy(inventory, agentId);
  return gate.allowed ? services.addTrustedPath(agentId, path) : { ok: false, message: gate.reason };
}

async function trustPrune(services: TuiServices, inventory: AgentInventory, agentId: AgentId, path: string): Promise<GuiCommandResult> {
  const gate = trustEditPolicy(inventory, agentId);
  return gate.allowed ? services.pruneTrust(agentId, path) : { ok: false, message: gate.reason };
}

async function trustSync(services: TuiServices, inventory: AgentInventory, agentId: AgentId, path: string): Promise<GuiCommandResult> {
  const gate = trustSyncPolicy(inventory, agentId);
  if (!gate.allowed) return { ok: false, message: gate.reason, outcomes: [{ agentId, ok: false, message: gate.reason }] };
  const outcomes = await services.syncTrust(agentId, path);
  return { ok: outcomes.length > 0 && outcomes.every((outcome) => outcome.ok), outcomes,
    message: outcomes.map((outcome) => `${outcome.agentId}: ${outcome.ok ? 'synced' : `blocked — ${outcome.message}`}`).join('\n') };
}

function isAgent(value: unknown): value is AgentId { return typeof value === 'string' && AGENTS.includes(value as AgentId); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'GUI request failed'; }
