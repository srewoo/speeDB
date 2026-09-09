import { defineConfig } from 'tsup'
import { resolve } from 'node:path'

/**
 * Bundle rather than plain `tsc`.
 *
 * `tsc` does not rewrite path aliases on emit, so a `tsc`-built `dist` would
 * ship `import ... from '@/core/types'` and fail the moment anyone installed
 * it. Rewriting every alias to a relative path in source would work and would
 * also mean touching ~120 files for the benefit of the build alone.
 *
 * Bundling resolves them at build time and leaves the sources as they are.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  platform: 'neutral',
  esbuildOptions(options) {
    options.alias = {
      '@/core': resolve(import.meta.dirname, 'src/core'),
      '@/config': resolve(import.meta.dirname, 'src/config'),
    }
  },
})
