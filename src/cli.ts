import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCodexInventory } from './adapters/codex.ts';
import { buildInventory, unsupportedAdapter } from './inventory.ts';
import { MaintenanceError, type AdapterInventoryStatus } from './types.ts';

const exec = promisify(execFile);
const TOOL_TIMEOUT_MS = 12_000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;

async function runReadOnlyTool(binary: string, args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const result = await exec(binary, [...args], { cwd, timeout: TOOL_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT, encoding: 'utf8', windowsHide: true });
    return result.stdout.trim();
  } catch { return null; }
}

function parseArgs(args: readonly string[]): { readonly codexHome: string; readonly json: boolean; readonly help: boolean } {
  let codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  let json = false;
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--codex-home') {
      const path = args[++i];
      if (!path) throw new MaintenanceError('CLI_ARGUMENT_INVALID', '--codex-home requires an absolute path');
      codexHome = path;
    } else throw new MaintenanceError('CLI_ARGUMENT_INVALID', `Unknown inventory option: ${arg}`);
  }
  if (!isAbsolute(codexHome)) throw new MaintenanceError('CLI_ARGUMENT_INVALID', 'Codex home must be an absolute path');
  return { codexHome, json, help };
}

function stableError(error: unknown): { readonly code: string; readonly message: string } {
  return error instanceof MaintenanceError
    ? { code: error.code, message: error.message }
    : { code: 'INVENTORY_FAILED', message: 'Inventory failed because an adapter returned invalid or inaccessible data' };
}

export function serializeInventoryJson(value: unknown): string { return JSON.stringify(value); }
export function serializeInventoryError(error: unknown): string { return serializeInventoryJson({ error: stableError(error) }); }

export async function collectInventory(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  if (!isAbsolute(codexHome)) throw new MaintenanceError('CLI_ARGUMENT_INVALID', 'Codex home must be an absolute path');
  const [codexVersion, claudeVersion, openCodeVersion, agyVersion] = await Promise.all([
    runReadOnlyTool('codex', ['--version'], tmpdir()), runReadOnlyTool('claude', ['--version'], tmpdir()),
    runReadOnlyTool('opencode', ['--version'], tmpdir()), runReadOnlyTool('agy', ['--version'], tmpdir()),
  ]);
  const codex = await readCodexInventory(codexHome, codexVersion);
  const adapters: AdapterInventoryStatus[] = [codex.status,
    unsupportedAdapter('claude_code_cli', claudeVersion, 'No stable, versioned session transcript schema or read-only inventory endpoint is validated; parsing remains disabled'),
    unsupportedAdapter('agy_cli', agyVersion, 'Official CLI documents interactive conversation selection, but no stable local session schema or read-only inventory endpoint is validated'),
    unsupportedAdapter('opencode_cli', openCodeVersion, 'OpenCode CLI startup initializes a write-capable database runtime (migrations/WAL/checkpoints); native listing is disabled until a validated read-only storage interface exists')];
  return buildInventory({ sessions: codex.sessions, adapters, trustPaths: codex.trustPaths });
}

export async function runInventory(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args[0] !== 'inventory') {
    process.stderr.write('Usage: agent-maintenance inventory --json [--codex-home ABSOLUTE_PATH]\n');
    return 64;
  }
  let options: ReturnType<typeof parseArgs>;
  try { options = parseArgs(args.slice(1)); }
  catch (error) {
    process.stdout.write(`${serializeInventoryError(error)}\n`);
    return 64;
  }
  if (options.help) {
    process.stdout.write('Read-only inventory. Use --json for stable machine-readable output. --codex-home selects a Codex data root.\n');
    return 0;
  }
  if (!options.json) {
    process.stdout.write(`${serializeInventoryError(new MaintenanceError('CLI_JSON_REQUIRED', 'Inventory output requires --json'))}\n`);
    return 64;
  }
  try {
    const inventory = await collectInventory(options.codexHome);
    process.stdout.write(`${serializeInventoryJson(inventory)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${serializeInventoryError(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runInventory();
}
