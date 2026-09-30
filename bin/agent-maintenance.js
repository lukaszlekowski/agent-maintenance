#!/usr/bin/env node
import('../dist/main.js').then(({ runCli }) => runCli()).then((status) => {
  process.exitCode = status;
}).catch((error) => {
  process.stderr.write(`agent-maintenance failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
