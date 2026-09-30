import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/gui/server-entry.ts'],
  format: ['esm'],
  dts: false,
  clean: false,
  target: 'node22',
  outDir: 'dist/gui',
  external: ['fs-ext', 'smol-toml'],
});
