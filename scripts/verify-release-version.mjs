import { readFile } from 'node:fs/promises';

const requested = process.argv[2] ?? '';
const tag = requested.startsWith('refs/tags/') ? requested.slice('refs/tags/'.length) : requested;
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const sourceVersion = source.match(/CLI_VERSION\s*=\s*'([^']+)'/)?.[1];
if (sourceVersion !== version) {
  process.stderr.write(`CLI version ${sourceVersion ?? '(missing)'} does not match package version ${version}\n`);
  process.exitCode = 1;
} else if (tag && tag !== `v${version}`) {
  process.stderr.write(`Release tag ${tag || '(empty)'} does not match package version v${version}\n`);
  process.exitCode = 1;
} else process.stdout.write(tag ? `Release tag matches package version v${version}\n` : `CLI and package versions match v${version}\n`);
