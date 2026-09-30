import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { MaintenanceError, type AgentId, type TrustPathObservation } from '../types.ts';

export const CODEX_TRUST_CONFIG_SCHEMA = 'openai/codex rust-v0.159.2 ConfigToml.projects: HashMap<String, ProjectConfig>; ProjectConfig.trust_level';
export const CODEX_TRUST_CONFIG_FINGERPRINT = createHash('sha256').update(CODEX_TRUST_CONFIG_SCHEMA).digest('hex');

function isTomlTable(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Parse only the version-pinned [projects."/absolute/path"] trust schema. */
export function parseCodexProjectTrust(text: string): readonly TrustPathObservation[] {
  let parsed: unknown;
  try { parsed = parse(text); }
  catch { throw new MaintenanceError('ADAPTER_MALFORMED_CONFIG', 'Codex config.toml is not valid TOML'); }
  if (!isTomlTable(parsed)) throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', 'Codex config.toml root must be a TOML table');
  const projects = parsed.projects;
  if (projects === undefined) return Object.freeze([]);
  if (!isTomlTable(projects)) throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', 'Codex projects must be a table keyed by project path');

  const entries: TrustPathObservation[] = [];
  for (const [projectPath, projectConfig] of Object.entries(projects)) {
    if (!isAbsolute(projectPath)) throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', 'Codex project trust keys must be absolute paths');
    if (!isTomlTable(projectConfig)) throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', 'Codex project config must be a TOML table');
    const level = projectConfig.trust_level;
    if (level !== undefined && typeof level !== 'string') throw new MaintenanceError('ADAPTER_SCHEMA_DRIFT', 'Codex trust_level must be a string when present');
    entries.push(Object.freeze({
      agentId: 'codex_cli' as AgentId,
      path: projectPath,
      trustLevel: level === 'trusted' ? 'trusted' : level === 'untrusted' ? 'untrusted' : 'unknown',
    }));
  }
  return Object.freeze(entries);
}

export async function readCodexProjectTrust(codexHome: string): Promise<{ readonly entries: readonly TrustPathObservation[]; readonly inspected: true }> {
  const configPath = join(codexHome, 'config.toml');
  let contents: string;
  try { contents = await readFile(configPath, 'utf8'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return Object.freeze({ entries: Object.freeze([]), inspected: true });
    throw new MaintenanceError('ADAPTER_READ_FAILED', `Cannot read Codex config.toml (${code ?? 'unknown error'})`);
  }
  return Object.freeze({ entries: parseCodexProjectTrust(contents), inspected: true });
}
