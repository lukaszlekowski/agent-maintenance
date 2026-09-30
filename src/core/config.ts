import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import { MaintenanceError } from '../types.ts';

export type Theme = 'default' | 'light' | 'dark';

export interface MaintenanceConfig {
  readonly version: '1.0.0';
  readonly tempFolder: string;
  readonly storageRoot: string;
  readonly defaultPort: number;
  readonly confirmDelete: boolean;
  readonly displayWarnings: boolean;
  readonly showArchiveNotice: boolean;
  readonly theme: Theme;
}

export const CONFIG_DEFAULTS = Object.freeze({
  version: '1.0.0' as const,
  tempFolder: '~/agent-maintenance-temp',
  storageRoot: '~/.agent-maintenance',
  defaultPort: 4567,
  confirmDelete: true,
  displayWarnings: true,
  showArchiveNotice: true,
  theme: 'default' as const,
});

export interface ExpansionContext {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function expandPath(input: string, context: ExpansionContext): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new MaintenanceError('INVALID_PATH', 'Path must be a non-empty string without NUL bytes');
  }
  let expanded = input;
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = context.home + expanded.slice(1);
  } else if (expanded.startsWith('~')) {
    throw new MaintenanceError('UNSUPPORTED_HOME_EXPANSION', 'Only the current-user ~ form is supported');
  }
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced: string | undefined, plain: string | undefined) => {
    const name = braced ?? plain!;
    const value = context.env[name];
    if (value === undefined) throw new MaintenanceError('UNDEFINED_ENVIRONMENT_VARIABLE', `Environment variable ${name} is not defined`);
    return value;
  });
  if (expanded.includes('$')) throw new MaintenanceError('INVALID_PATH_EXPANSION', 'Path contains an unsupported environment expansion');
  if (!isAbsolute(expanded)) throw new MaintenanceError('PATH_NOT_ABSOLUTE', 'Expanded paths must be absolute');
  return normalize(resolve(expanded));
}

export function validateConfig(input: unknown, context: ExpansionContext = { home: homedir(), env: {} }): MaintenanceConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new MaintenanceError('INVALID_CONFIG', 'Configuration must be a JSON object');
  const value = input as Record<string, unknown>;
  const allowed = new Set(Object.keys(CONFIG_DEFAULTS));
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new MaintenanceError('UNKNOWN_CONFIG_KEY', `Unknown configuration key: ${key}`);
  const merged = { ...CONFIG_DEFAULTS, ...value };
  if (merged.version !== '1.0.0') throw new MaintenanceError('UNSUPPORTED_CONFIG_VERSION', 'Only config version 1.0.0 is supported');
  if (!Number.isInteger(merged.defaultPort) || (merged.defaultPort as number) < 1 || (merged.defaultPort as number) > 65535) {
    throw new MaintenanceError('INVALID_CONFIG_PORT', 'defaultPort must be an integer from 1 through 65535');
  }
  for (const key of ['confirmDelete', 'displayWarnings', 'showArchiveNotice'] as const) {
    if (typeof merged[key] !== 'boolean') throw new MaintenanceError('INVALID_CONFIG_BOOLEAN', `${key} must be a boolean`);
  }
  if (merged.theme !== 'default' && merged.theme !== 'light' && merged.theme !== 'dark') throw new MaintenanceError('INVALID_CONFIG_THEME', 'theme must be default, light, or dark');
  return Object.freeze({
    version: '1.0.0', tempFolder: expandPath(merged.tempFolder as string, context),
    storageRoot: expandPath(merged.storageRoot as string, context), defaultPort: merged.defaultPort as number,
    confirmDelete: merged.confirmDelete as boolean, displayWarnings: merged.displayWarnings as boolean,
    showArchiveNotice: merged.showArchiveNotice as boolean, theme: merged.theme,
  });
}
