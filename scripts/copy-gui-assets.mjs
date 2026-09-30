import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'dist/gui/public');
await mkdir(destination, { recursive: true });
await cp(resolve(root, 'src/gui/public'), destination, { recursive: true, force: true });
