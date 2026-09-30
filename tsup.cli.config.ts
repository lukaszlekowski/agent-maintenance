import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  dts: false,
  clean: false,
  target: 'node22',
  outDir: 'dist',
  external: ['fs-ext', 'smol-toml'],
});
