import { defineConfig } from 'tsup'
import { createRequire } from 'node:module'

/*
 * The version is injected rather than written in the source.
 *
 * `server.ts` used to carry a literal, which is one more place to remember on
 * every release and the one place nothing would fail if you forgot — the server
 * would simply report a version it no longer was.
 */
const { version } = createRequire(import.meta.url)('./package.json')

export default defineConfig({
  entry: { server: 'src/server.ts' },
  define: { __SPEEDB_VERSION__: JSON.stringify(version) },
  format: ['esm'],
  clean: true,
  sourcemap: true,
  target: 'node20',
  platform: 'node',
  // Left external so a single @speedb/core is installed and deduped, rather
  // than a second copy inlined here that could drift from the published one.
  external: ['@speedb/core', '@modelcontextprotocol/sdk', 'zod'],
  /*
   * No `banner` shebang here — `src/server.ts` already starts with one and tsup
   * preserves it. Adding a second put `#!/usr/bin/env node` on line 2, where it
   * is a syntax error rather than a shebang, so `node dist/server.js` died
   * before printing anything. Nothing caught it: the tests drive `createServer`
   * over an in-memory transport and never execute the built file. The stdio
   * smoke test exists for exactly this.
   */
})
