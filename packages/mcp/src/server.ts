#!/usr/bin/env node
/** Replaced at build time by tsup with the version from package.json. */
declare const __SPEEDB_VERSION__: string

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { setStorageBackend, memoryBackend } from '@speedb/core'
import { SessionStore } from './session.js'
import { makeHandlers, schemas } from './tools.js'

/**
 * Storage is pinned to memory rather than left to detection.
 *
 * Core would fall back to memory here anyway, since there is no `chrome`. Being
 * explicit costs one line and makes the guarantee a property of this server
 * rather than an accident of its environment: nothing this process learns about
 * a private repository is written to disk.
 */
setStorageBackend(memoryBackend())

export function createServer(): McpServer {
  const server = new McpServer({ name: 'speedb', version: __SPEEDB_VERSION__ })
  const sessions = new SessionStore()
  const h = makeHandlers(sessions)

  server.tool(
    'detect_queries',
    'Find every database query site in a repository. Deterministic, free, and calls no model — ' +
    'rules over masked source, ranked by how likely each site is to matter. Use this first: if a ' +
    'query never becomes a candidate here, no amount of analysis will find it.',
    schemas.detect_queries,
    h.detect_queries,
  )

  server.tool(
    'check_equivalence',
    'Check whether a proposed rewrite returns the same rows as the original. Answers ' +
    'machine-verified / partly-verified / contradicted / not-machine-checkable, and names each ' +
    'difference. Works on SQL and on ORM chains (Django, ActiveRecord, Prisma, Sequelize, ' +
    'Hibernate). Free, no model.',
    schemas.check_equivalence,
    h.check_equivalence,
  )

  server.tool(
    'explain_recipe',
    'The exact EXPLAIN (or .explain(), or profile API) to run for a given engine, and which line ' +
    'of its output actually answers "did this get faster?". Covers 60+ engines across relational, ' +
    'document, wide-column, graph, search, vector and time-series families. Free, no model.',
    schemas.explain_recipe,
    h.explain_recipe,
  )

  server.tool(
    'schema_facts',
    'Parse declared DDL and migrations into tables and indexes, list indexes made redundant by a ' +
    'leading-prefix match, and check whether a proposed index already exists. Kills the most ' +
    'common wrong recommendation. Free, no model.',
    schemas.schema_facts,
    h.schema_facts,
  )

  server.tool(
    'scan_start',
    'Start a full grounded scan of a local checkout or a GitHub/GitLab repo. YOU are the model: ' +
    'the scan hands you prompts through scan_next and you answer with scan_submit. Every finding ' +
    'you author is re-checked against the fetched source before it reaches the report — cited ' +
    'files must exist, quotes must appear verbatim, and worthless findings are held back with a ' +
    'stated reason. No API key is used.',
    schemas.scan_start,
    h.scan_start,
  )

  server.tool(
    'scan_next',
    'Get the next prompt awaiting your answer, or the finished report. Returns status "prompt" ' +
    '(answer it and call scan_submit), "working" (call again), "done", or "error".',
    schemas.scan_next,
    h.scan_next,
  )

  server.tool(
    'scan_submit',
    'Submit your answer to the prompt scan_next gave you. requestId must match exactly — a ' +
    'mismatched id is rejected rather than applied to whichever prompt is currently waiting.',
    schemas.scan_submit,
    h.scan_submit,
  )

  server.tool(
    'scan_report',
    'The finished report as markdown, json, html, or a git-applicable .patch. Behaviour-changing ' +
    'findings are excluded from the patch and the count of what was withheld is stated.',
    schemas.scan_report,
    h.scan_report,
  )

  server.tool(
    'scan_cancel',
    'Abort a scan and free the repository it is holding in memory.',
    schemas.scan_cancel,
    h.scan_cancel,
  )

  return server
}

/**
 * Only start a transport when run as a program.
 *
 * The tests import `createServer` and drive it over an in-memory transport, and
 * a module that grabs stdio on import cannot be tested that way.
 *
 * Both paths are resolved through `realpath` before comparing, which is not
 * defensive padding — it is the whole check. `npm install` puts a *symlink* at
 * `node_modules/.bin/speedb-mcp`, so `process.argv[1]` is the symlink while
 * `import.meta.url` is the file it points at. A naive string comparison is
 * therefore false for every installed copy, and the server started fine from a
 * source checkout and exited silently for every real user. On macOS `/tmp` and
 * `/private/tmp` add a second way for the same comparison to be wrong.
 */
function runningAsProgram(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

if (runningAsProgram()) {
  const server = createServer()
  await server.connect(new StdioServerTransport())
}
