import React from 'react';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import { TuiApp } from './app.ts';
import { createDefaultTuiServices } from './services.ts';

export async function runTui(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('The interactive TUI requires a terminal. Use `npm run inventory -- --json` for headless read-only output.\n');
    return 64;
  }
  render(React.createElement(TuiApp, { services: createDefaultTuiServices() }), { exitOnCtrlC: true });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runTui();
