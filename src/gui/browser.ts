import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { platform } from 'node:os';
import { spawn } from 'node:child_process';

export interface BrowserProcessRunner {
  spawn(command: string, args: readonly string[]): Promise<void>;
}
export type BrowserResult = 'chromium-app' | 'system-browser';

export async function launchBrowser(url: string, runner: BrowserProcessRunner = detachedRunner): Promise<BrowserResult> {
  const chromium = await findChromium();
  if (chromium) {
    try { await runner.spawn(chromium, [`--app=${url}`]); return 'chromium-app'; }
    catch { /* Continue to the documented system-browser fallback. */ }
  }
  const os = platform();
  if (os === 'darwin') await runner.spawn('open', [url]);
  else if (os === 'linux') await runner.spawn('xdg-open', [url]);
  else if (os === 'win32') await runner.spawn('cmd', ['/c', 'start', '', url]);
  else throw new Error(`No browser launcher is validated for ${os}`);
  return 'system-browser';
}

export async function findChromium(pathValue = process.env.PATH ?? ''): Promise<string | undefined> {
  const names = platform() === 'win32' ? ['google-chrome.exe', 'chromium.exe', 'brave.exe', 'msedge.exe'] : ['google-chrome', 'chromium', 'brave', 'msedge'];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* not an executable candidate */ }
    }
  }
  return undefined;
}

const detachedRunner: BrowserProcessRunner = Object.freeze({ spawn: spawnDetached });

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
