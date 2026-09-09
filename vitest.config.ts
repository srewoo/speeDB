import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { aliases } from './aliases.mjs'

/**
 * One test run across every package.
 *
 * Vitest gets its own config rather than reusing the extension's build config,
 * which runs the `crx` plugin and expects a manifest and a browser target.
 * This carries only what tests need: the shared alias table, the React
 * transform for component tests, and jsdom for the files that render.
 *
 * `environment: 'node'` stays the default. Only the component tests need a DOM,
 * and giving 700-odd pure-logic tests a jsdom each would cost seconds per run
 * for nothing — they opt in with `@vitest-environment jsdom`.
 */
export default defineConfig({
  // tsup injects this at build time; the tests import the source directly.
  define: { __SPEEDB_VERSION__: JSON.stringify('0.0.0-test') },
  plugins: [react()],
  resolve: {
    alias: [
      // The MCP package consumes core as a published dependency would, by
      // package name. Pointing that at source rather than `dist` keeps one
      // build out of the test loop and makes a stale `dist` impossible.
      { find: /^@speedb\/core$/, replacement: resolve(__dirname, 'packages/core/src/index.ts') },
      ...aliases,
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
  },
})
