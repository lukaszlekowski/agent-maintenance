import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageTransactionEngine } from '../../../src/storage/engine.ts';
import type { ControlledStorageAdapter } from './controlled-adapter.ts';

type Fixture = {
  payload: string;
  storage: string;
  data: string;
  sid: string;
  adapter: ControlledStorageAdapter;
  engine: StorageTransactionEngine;
};

export async function captureStorageState(x: Fixture) {
  let source: string | null = null;
  try { source = await readFile(x.payload, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let registry: unknown = null;
  try { registry = JSON.parse(await readFile(join(x.storage, 'registry.json'), 'utf8')) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {
    source,
    index: await x.adapter.readIndexState(x.sid),
    registry,
    archives: await x.engine.listArchives('codex_cli', x.sid),
    durable: await captureTree(x.storage),
    sourceTree: await captureTree(x.data),
  };
}

async function captureTree(root: string): Promise<readonly unknown[]> {
  const rows: unknown[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      rows.push({ path: relative, type: 'directory', dev: info.dev, ino: info.ino, mode: info.mode });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? `${relative}/${name}` : name);
      return;
    }
    if (info.isFile()) {
      const bytes = await readFile(path);
      const journalFile = relative.startsWith('transactions/') && relative.endsWith('.json');
      let content: string;
      if (journalFile) {
        const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        delete parsed.updatedAt;
        content = JSON.stringify(parsed);
      } else content = bytes.toString('base64');
      rows.push({ path: relative, type: 'file', dev: info.dev, ...(journalFile ? {} : { ino: info.ino }), mode: info.mode, size: content.length, content });
      return;
    }
    rows.push({ path: relative, type: 'other', dev: info.dev, ino: info.ino, mode: info.mode });
  }
  await visit(root, '');
  return rows;
}
