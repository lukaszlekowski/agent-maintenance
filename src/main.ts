import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { AGENT_IDS, MaintenanceError, archiveId, sessionId } from './types.ts';
import type { AgentId } from './types.ts';
import { runInventory } from './cli.ts';
import { runTui } from './tui/cli.ts';
import { runGui } from './gui/launch-cli.ts';
import { createDefaultTuiServices } from './tui/services.ts';

export const CLI_VERSION = '0.1.0';
const HELP = `agent-maintenance ${CLI_VERSION}
Usage: agent-maintenance [--tui | --gui] [command]

Commands:
  inventory --json [--codex-home ABSOLUTE_PATH]  Read-only session/trust inventory
  archived [--json]                              List managed archives
  deleted [--json]                               List managed soft-deletes
  restore AGENT/SESSION [--archive-id ID]        Restore one exact archive instance
  trust [--json]                                 Inspect validated trust entries
  trust add AGENT PATH                           Request a trusted-path addition
  trust prune AGENT PATH                          Request removal of an obsolete trust path
  trust sync AGENT PATH                           Request cross-agent trust synchronization
  --version                                      Print version
  --help                                         Print this help

Without a command, an interactive terminal opens the TUI; redirected output emits JSON inventory.
Archive, restore, and trust writes report disabled native capabilities until their safety gates are validated.`;

export interface Invocation { readonly mode: 'tui' | 'gui' | 'command'; readonly args: readonly string[] }

export function resolveInvocation(args: readonly string[], interactive: boolean): Invocation {
  const modeFlags = args.filter((item) => item === '--tui' || item === '--gui');
  if (modeFlags.length > 1) throw new MaintenanceError('CLI_MODE_CONFLICT', '--tui and --gui cannot be combined');
  const commandArgs = args.filter((item) => item !== '--tui' && item !== '--gui');
  if (commandArgs.length && modeFlags.length) throw new MaintenanceError('CLI_MODE_CONFLICT', 'Explicit interface flags cannot be combined with a subcommand');
  if (modeFlags[0] === '--gui') return { mode: 'gui', args: [] };
  if (modeFlags[0] === '--tui') return { mode: 'tui', args: [] };
  if (commandArgs.length) return { mode: 'command', args: commandArgs };
  return { mode: interactive ? 'tui' : 'command', args: interactive ? [] : ['inventory', '--json'] };
}

export async function runCli(args: readonly string[] = process.argv.slice(2), interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)): Promise<number> {
  if (args.includes('--version') || args.includes('-v')) { process.stdout.write(`${CLI_VERSION}\n`); return 0; }
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${HELP}\n`); return 0; }
  let invocation: Invocation;
  try { invocation = resolveInvocation(args, interactive); }
  catch (error) { return emitError(error, 64, args.includes('--json')); }
  if (invocation.mode === 'tui') return runTui();
  if (invocation.mode === 'gui') return runGui();
  return runCommand(invocation.args);
}

async function runCommand(args: readonly string[]): Promise<number> {
  const json = args.includes('--json');
  try {
    const command = args[0];
    if (command === 'inventory') return runInventory(args);
    if (command === 'archived' || command === 'deleted') {
      if (args.slice(1).some((arg) => arg !== '--json')) throw new MaintenanceError('CLI_ARGUMENT_INVALID', `Unknown ${command} option`);
      const listing = await createDefaultTuiServices().listArchives();
      if (!listing.available) return emitError(new MaintenanceError('CAPABILITY_DISABLED', listing.reason ?? 'Managed storage listing is unavailable'), 3, json);
      const category = command === 'archived' ? 'archived' : 'deleted';
      const records = listing.records.filter((record) => record.category === category);
      return emitValue({ records }, json);
    }
    if (command === 'restore') return await restoreCommand(args.slice(1), json);
    if (command === 'trust') return await trustCommand(args.slice(1), json);
    throw new MaintenanceError('CLI_COMMAND_UNKNOWN', `Unknown command: ${command ?? '(none)'}`);
  } catch (error) {
    const errorCode = error instanceof MaintenanceError ? error.code : '';
    const status = errorCode === 'CAPABILITY_DISABLED' ? 3 : errorCode.startsWith('CLI_') || errorCode === 'INVALID_ID' ? 64 : 2;
    return emitError(error, status, json);
  }
}

async function restoreCommand(args: readonly string[], json: boolean): Promise<number> {
  const positionals: string[] = []; let chosenArchive: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]!;
    if (value === '--json') continue;
    if (value === '--archive-id') {
      if (chosenArchive !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new MaintenanceError('CLI_ARGUMENT_INVALID', 'Usage: restore AGENT/SESSION [--archive-id ID]');
      chosenArchive = args[++i]!; continue;
    }
    if (value.startsWith('--')) throw new MaintenanceError('CLI_ARGUMENT_INVALID', `Unknown restore option: ${value}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw new MaintenanceError('CLI_ARGUMENT_INVALID', 'Usage: restore AGENT/SESSION [--archive-id ID]');
  const selected = positionals[0]!.split('/');
  if (selected.length !== 2 || !AGENT_IDS.includes(selected[0] as AgentId) || !selected[1]) {
    throw new MaintenanceError('CLI_SELECTOR_INVALID', 'Restore selector must be AGENT/SESSION using a supported agent ID');
  }
  const selectedSession = sessionId(selected[1]!);
  const exactArchive = chosenArchive !== undefined ? archiveId(chosenArchive) : undefined;
  const result = await createDefaultTuiServices().restoreArchive(selected[0] as AgentId, selectedSession, exactArchive);
  return result.ok ? emitValue(result, json) : emitError(new MaintenanceError('CAPABILITY_DISABLED', result.message), 3, json);
}

async function trustCommand(args: readonly string[], json: boolean): Promise<number> {
  const input = args.filter((arg) => arg !== '--json');
  if (input.length === 0) {
    const inventory = await (await import('./cli.ts')).collectInventory();
    return emitValue({ entries: inventory.trustEntries, adapters: inventory.adapters.map(({ agentId, capabilities, explanation }) => ({ agentId, enabled: capabilities.trustRead.enabled, reason: explanation })) }, json);
  }
  const operation = input[0]; const agent = input[1] as AgentId; const path = input[2];
  if (input.length !== 3 || !['add', 'prune', 'sync'].includes(operation!) || !AGENT_IDS.includes(agent) || !path || path.includes('\0')) {
    throw new MaintenanceError('CLI_ARGUMENT_INVALID', 'Usage: trust [--json] | trust add|prune|sync AGENT ABSOLUTE_PATH');
  }
  if (!isAbsolute(path)) throw new MaintenanceError('CLI_ARGUMENT_INVALID', 'Trust path must be absolute');
  const services = createDefaultTuiServices();
  if (operation === 'sync') {
    const outcomes = await services.syncTrust(agent, path);
    const failed = outcomes.some((outcome) => !outcome.ok);
    return failed ? emitError(new MaintenanceError('CAPABILITY_DISABLED', 'Trust synchronization is unavailable for one or more agents', { outcomes }), 3, json) : emitValue({ outcomes }, json);
  }
  const result = operation === 'add' ? await services.addTrustedPath(agent, path) : await services.pruneTrust(agent, path);
  return result.ok ? emitValue(result, json) : emitError(new MaintenanceError('CAPABILITY_DISABLED', result.message), 3, json);
}

function emitValue(value: unknown, json: boolean): number {
  if (json || !process.stdout.isTTY) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function emitError(error: unknown, code: number, json: boolean): number {
  const structured = error instanceof MaintenanceError ? error.toJSON() : { code: 'CLI_FAILED', message: error instanceof Error ? error.message : 'Command failed' };
  if (json || !process.stdout.isTTY) process.stdout.write(`${JSON.stringify({ error: structured })}\n`);
  else process.stderr.write(`${structured.code}: ${structured.message}\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli();
