import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Boot the built file as a real subprocess.
 *
 * Everything else in this package is driven over an in-memory transport, which
 * is fast and tests the tools but shares this process — so it never runs
 * `dist/server.js`, never sees the shebang, and never resolves `@speedb/core`
 * the way an installed copy would.
 *
 * That gap was not theoretical. `tsup` was configured with a `banner` shebang
 * while `src/server.ts` already had one, so the build emitted
 * `#!/usr/bin/env node` on line 2 — a syntax error, not a shebang. Every
 * in-memory test passed; `node dist/server.js` died before printing a byte.
 * This is the test that would have caught it, and it is the same argument
 * `real-path.test.ts` makes in core.
 */
const DIST = resolve(import.meta.dirname, '../../dist/server.js')

describe.skipIf(!existsSync(DIST))('the built server, over real stdio', () => {
  it('boots as a subprocess and serves its tools', async () => {
    const client = new Client({ name: 'stdio-smoke', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: 'node', args: [DIST] }))

    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain('scan_start')
      expect(tools).toHaveLength(9)

      // One real call, so this covers more than process startup.
      const result = await client.callTool({
        name: 'check_equivalence',
        arguments: { original: 'SELECT a FROM t', proposed: 'SELECT a FROM t LIMIT 10' },
      })
      const out = JSON.parse((result as { content: { text: string }[] }).content[0]!.text)
      expect(out.status).toBe('partially-verified')
    } finally {
      await client.close()
    }
  }, 30_000)

  /**
   * Launch through a symlink, the way an install does.
   *
   * `npm install` writes `node_modules/.bin/speedb-mcp` as a symlink, so
   * `process.argv[1]` is the link and `import.meta.url` is its target. The
   * entrypoint guard compared those two as strings, which is false for every
   * installed copy — the server started from a checkout and exited silently,
   * printing nothing, for anyone who installed it. Running the file directly
   * cannot catch that; only going through a link can.
   */
  it('starts when launched through a symlink, as an installed bin is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'speedb-bin-'))
    const link = join(dir, 'speedb-mcp')
    await symlink(DIST, link)

    const client = new Client({ name: 'symlink-smoke', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: 'node', args: [link] }))
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(9)
    } finally {
      await client.close()
    }
  }, 30_000)
})
