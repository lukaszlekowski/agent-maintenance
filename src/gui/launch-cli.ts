import { pathToFileURL } from 'node:url';
import { createDefaultTuiServices } from '../tui/services.ts';

export async function runGui(): Promise<number> {
  const result = await createDefaultTuiServices().guiLauncher.launch();
  if (!result.launched) {
    process.stderr.write(`GUI launch failed safely: ${result.reason ?? 'unknown error'}\n`);
    return 1;
  }
  process.stdout.write('Agent Maintenance GUI started in your browser.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runGui();
