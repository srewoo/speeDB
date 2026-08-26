import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Vitest gets its own config rather than reusing `vite.config.ts`.
 *
 * The build config runs the `crx` plugin, which expects an extension manifest
 * and a browser target; loading it under a test runner is asking for trouble.
 * This carries only what tests need: the `@` alias, the React transform for
 * component tests, and jsdom for the files that render.
 *
 * `environment: 'node'` stays the default. Only the component tests need a DOM,
 * and giving 500 pure-logic tests a jsdom each would cost seconds per run for
 * nothing — they opt in with `@vitest-environment jsdom`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
