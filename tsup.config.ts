import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // Sourcemaps are intentionally disabled for the published bundle to keep the
  // npm tarball small and to avoid shipping the entire src/ tree under
  // `sourcesContent`. Re-enable locally via `pnpm dev` or a tsup invocation if
  // you need to step through dist/.
  sourcemap: false,
  dts: false,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
});
