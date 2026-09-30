import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rename, lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig, CONFIG_DEFAULTS, type MaintenanceConfig } from '../core/config.ts';
import { syncDirectory } from '../storage/durable-fs.ts';

export interface SettingsStore {
  load(): Promise<MaintenanceConfig>;
  save(value: MaintenanceConfig): Promise<void>;
}

export class FileSettingsStore implements SettingsStore {
  readonly path: string;
  constructor(path = join(homedir(), '.agent-maintenance', 'settings.json')) { this.path = path; }

  async load(): Promise<MaintenanceConfig> {
    let handle;
    try { handle = await open(this.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateConfig(CONFIG_DEFAULTS);
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Settings file must be a regular file');
      return validateConfig(JSON.parse(await handle.readFile('utf8')));
    } finally { await handle.close(); }
  }

  async save(value: MaintenanceConfig): Promise<void> {
    const valid = validateConfig(value); const directory = dirname(this.path);
    let info;
    try { info = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(directory, { recursive: true, mode: 0o700 }); info = await lstat(directory); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Settings directory must be a real directory');
    const temp = join(directory, `.settings-${randomUUID()}.tmp`);
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(valid, null, 2)}\n`); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temp).catch(() => undefined); throw error; }
    await handle.close();
    try { await rename(temp, this.path); await syncDirectory(directory, undefined, 'tui-settings'); }
    catch (error) { await unlink(temp).catch(() => undefined); throw error; }
  }
}

export class MemorySettingsStore implements SettingsStore {
  private value: MaintenanceConfig;
  constructor(value = validateConfig(CONFIG_DEFAULTS)) { this.value = value; }
  async load(): Promise<MaintenanceConfig> { return this.value; }
  async save(value: MaintenanceConfig): Promise<void> { this.value = validateConfig(value); }
}
