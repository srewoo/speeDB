import { z } from 'zod'
import {
  applyValueGate, buildSchemaFacts, checkEquivalence, checkOrmEquivalence,
  checkProposedIndex, detectInFileVerbose, engineSpec, exportReport, explainFor,
  findRedundantIndexes, inferEngines, isScannable, parseRepoUrl,
} from '@speedb/core'
import type { RepoFile, ScanReport } from '@speedb/core'
import { readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { LocalClient } from './local-client.js'
import type { SessionStore } from './session.js'

/**
 * How long `scan_next` waits for the scan to reach its next model call.
 *
 * Long enough that ingest and detection on a large repository finish inside one
 * call, short enough that the agent is never left with a silently dead tool.
 * On timeout the tool returns "still working" with the current phase rather
 * than an error, and the agent calls again.
 */
const NEXT_TIMEOUT_MS = 120_000

const FileInput = z.object({
  path: z.string().min(1),
  content: z.string(),
})

/** Shared by every tool that reads a directory instead of a forge. */
const LocalPath = z.string().min(1).describe('Absolute path to a local checkout.')

export const schemas = {
  detect_queries: {
    path: LocalPath.optional(),
    files: z.array(FileInput).optional()
      .describe('Explicit file contents, instead of reading a directory.'),
    maxFiles: z.number().int().positive().max(5000).optional().default(2000),
  },
  check_equivalence: {
    original: z.string().min(1),
    proposed: z.string().min(1),
    engine: z.string().optional().describe('Engine id, e.g. postgres, mysql, mongodb.'),
    kind: z.enum(['auto', 'sql', 'orm']).optional().default('auto'),
  },
  explain_recipe: {
    engine: z.string().min(1).describe('Engine id, e.g. postgres, mongodb, elasticsearch.'),
  },
  schema_facts: {
    path: LocalPath.optional(),
    files: z.array(FileInput).optional(),
    proposedIndex: z.string().optional()
      .describe('An index proposal to check against the declared schema.'),
  },
  scan_start: {
    path: LocalPath.optional(),
    repoUrl: z.string().optional().describe('GitHub or GitLab repository URL.'),
    ref: z.string().optional(),
    pullRequest: z.number().int().positive().optional(),
    changedOnly: z.boolean().optional().default(false)
      .describe('Local only: restrict candidates to files changed vs the last commit.'),
    maxCandidates: z.number().int().positive().max(2000).optional(),
    minPriority: z.number().min(0).max(1).optional(),
    githubToken: z.string().optional(),
    gitlabToken: z.string().optional(),
  },
  scan_next: { sessionId: z.string().min(1) },
  scan_submit: {
    sessionId: z.string().min(1),
    requestId: z.string().min(1).describe('The id from scan_next. Must match exactly.'),
    response: z.string().min(1).describe('Your answer, as the JSON the prompt asked for.'),
  },
  scan_report: {
    sessionId: z.string().min(1),
    format: z.enum(['markdown', 'json', 'html', 'patch']).optional().default('markdown'),
  },
  scan_cancel: { sessionId: z.string().min(1) },
}

type Files = { path: string; content: string }[]

async function collectFiles(
  path: string | undefined,
  files: Files | undefined,
  maxFiles: number,
): Promise<Files> {
  if (files?.length) return files
  if (!path) throw new Error('Supply either `path` or `files`.')

  const root = resolve(path)
  const client = new LocalClient(root)
  const listed = await client.listFiles()
  const scannable = listed.filter((f: RepoFile) => isScannable(f.path, f.size)).slice(0, maxFiles)

  const out: Files = []
  for (const f of scannable) {
    try {
      out.push({ path: f.path, content: await readFile(resolve(root, f.path), 'utf8') })
    } catch {
      // A file that cannot be read costs that file, never the whole call.
    }
  }
  return out
}

export function makeHandlers(sessions: SessionStore) {
  return {
    async detect_queries(a: { path?: string; files?: Files; maxFiles?: number }) {
      const files = await collectFiles(a.path, a.files, a.maxFiles ?? 2000)
      if (files.length === 0) return text('No readable files. Nothing to detect.')

      const profile = inferEngines(files as unknown as RepoFile[])
      const rows = []
      for (const f of files) {
        const r = detectInFileVerbose(f.path, f.content, { profile })
        for (const c of r.candidates) {
          rows.push({
            id: c.id, file: c.file, line: c.startLine, engine: c.engine,
            confidence: round(c.confidence), priority: round(c.priority),
            trigger: c.scope?.trigger ?? null, loopDepth: c.scope?.loopDepth ?? 0,
            excerpt: c.excerpt.slice(0, 300),
          })
        }
      }
      rows.sort((x, y) => y.priority - x.priority)

      return json({
        filesScanned: files.length,
        candidates: rows.length,
        engineProfile: {
          primary: profile.primary,
          ambiguous: profile.ambiguous,
          declared: profile.declared.map((d) => ({ engine: d.engine, source: d.source, quote: d.quote })),
        },
        note:
          'Deterministic and free — no model was called. `priority` answers "is this likely to matter?"; ' +
          '`confidence` answers "is this a query?". Ranked by priority.',
        sites: rows.slice(0, 200),
        truncated: rows.length > 200 ? `${rows.length - 200} more not shown` : null,
      })
    },

    async check_equivalence(a: {
      original: string; proposed: string; engine?: string; kind?: 'auto' | 'sql' | 'orm'
    }) {
      const engine = a.engine ?? 'postgres'
      const kind = a.kind ?? 'auto'
      const sql = kind !== 'orm' ? checkEquivalence(a.original, a.proposed, engine as never) : null
      const orm = kind !== 'sql' ? checkOrmEquivalence(a.original, a.proposed) : null

      // `auto` prefers whichever reader actually understood the input.
      const chosen = kind === 'sql' ? sql
        : kind === 'orm' ? orm
        : (sql && sql.status !== 'unverifiable' ? sql : orm ?? sql)

      return json({
        status: chosen?.status ?? 'unverifiable',
        summary: chosen?.summary ?? null,
        verified: chosen?.verified ?? [],
        deltas: chosen?.deltas ?? [],
        undecided: chosen?.undecided ?? [],
        note:
          'Decidable properties only — output columns and order, DISTINCT, GROUP BY, set ops, ' +
          'ORDER BY, row limits. Predicate equivalence needs a solver, not a parser, and is ' +
          'reported as undecided rather than as verified.',
      })
    },

    async explain_recipe(a: { engine: string }) {
      const spec = engineSpec(a.engine)
      const r = explainFor(a.engine, spec.family)
      return json({
        engine: spec.id, label: spec.label, family: spec.family,
        plan: r.plan, measure: r.measure ?? null,
        lookFor: r.lookFor, stats: r.stats ?? [],
        equivalenceNotes: spec.equivalenceNotes ?? null,
        note: 'speeDB measures nothing. Run these yourself — this is what to run and what to read.',
      })
    },

    async schema_facts(a: { path?: string; files?: Files; proposedIndex?: string }) {
      const files = await collectFiles(a.path, a.files, 2000)
      const facts = buildSchemaFacts(files)
      const redundant = findRedundantIndexes(facts)
      const advice = a.proposedIndex ? checkProposedIndex(a.proposedIndex, facts) : null

      return json({
        tables: [...facts.tables.keys()],
        indexes: facts.indexes.map((i) => ({ table: i.table, columns: i.columns, source: i.source })),
        redundant: redundant.map((r) => ({
          index: `${r.index.table}(${r.index.columns.join(', ')})`,
          coveredBy: `${r.coveredBy.table}(${r.coveredBy.columns.join(', ')})`,
        })),
        proposedIndexVerdict: advice,
        cannotKnow: [
          'row counts', 'selectivity', 'which indexes exist in production', 'index bloat',
        ],
        note:
          'Parsed from declared DDL and migrations. Migrations record intent, not the live ' +
          'schema, so treat absence as unknown rather than as absence.',
      })
    },

    async scan_start(a: {
      path?: string; repoUrl?: string; ref?: string; pullRequest?: number
      changedOnly?: boolean; maxCandidates?: number; minPriority?: number
      githubToken?: string; gitlabToken?: string
    }) {
      if (!a.path && !a.repoUrl) throw new Error('Supply either `path` or `repoUrl`.')

      let parsed
      let client
      if (a.path) {
        const root = resolve(a.path)
        client = new LocalClient(root)
        parsed = {
          forge: 'github' as const,
          apiOrigin: 'https://api.github.com',
          owner: 'local',
          name: relative(resolve(root, '..'), root).split(sep).join('/') || 'repo',
        }
      } else {
        const p = parseRepoUrl(a.repoUrl!)
        if ('error' in p) throw new Error(p.error)
        parsed = p
      }

      const session = sessions.start(
        parsed as never,
        {
          provider: 'anthropic', model: 'claude-sonnet-5',
          temperature: 0, maxOutputTokens: 8192, tokenBudget: Number.MAX_SAFE_INTEGER,
          analysis: 'two-stage',
          noCache: true,
          ...(a.ref ? { ref: a.ref } : {}),
          ...(a.pullRequest ? { pullRequest: a.pullRequest } : {}),
          ...(a.changedOnly && a.path ? { pullRequest: 1, scopeLabel: 'changed-files' as const } : {}),
          ...(a.maxCandidates ? { maxCandidates: a.maxCandidates } : {}),
          ...(a.minPriority !== undefined ? { minPriority: a.minPriority } : {}),
          ...(a.githubToken ? { githubToken: a.githubToken } : {}),
          ...(a.gitlabToken ? { gitlabToken: a.gitlabToken } : {}),
          // No dollar cost to consent to — the agent's own context pays.
          onEstimate: () => true,
        },
        client,
      )

      return json({
        sessionId: session.id,
        next: 'Call scan_next with this sessionId to get the first prompt.',
        note:
          'You are the model for this scan. speeDB will hand you prompts; answer each as the ' +
          'JSON its schema describes. Every finding you author is still re-checked against the ' +
          'fetched source — invented paths and quotes are rejected, not trusted.',
      })
    },

    async scan_next(a: { sessionId: string }) {
      const session = sessions.get(a.sessionId)
      const pending = await session.provider.nextRequest(NEXT_TIMEOUT_MS)

      if (pending) {
        return json({
          status: 'prompt',
          requestId: pending.id,
          system: pending.request.system,
          user: pending.request.user,
          responseSchema: pending.request.schema?.schema ?? null,
          instruction:
            'Answer as JSON matching responseSchema, then call scan_submit with this exact requestId. ' +
            'Return only the JSON.',
        })
      }

      if (session.error) return json({ status: 'error', error: session.error })
      if (session.report) {
        return json({
          status: 'done',
          summary: summarise(session.report),
          next: 'Call scan_report for the full report.',
        })
      }
      return json({
        status: 'working',
        phase: session.progress?.phase ?? 'starting',
        message: session.progress?.message ?? 'Working…',
        candidatesFound: session.progress?.candidatesFound ?? 0,
        filesFetched: session.progress?.filesFetched ?? 0,
        next: 'Call scan_next again.',
      })
    },

    async scan_submit(a: { sessionId: string; requestId: string; response: string }) {
      const session = sessions.get(a.sessionId)
      const result = session.provider.submit(a.requestId, a.response)
      if (!result.ok) return json({ status: 'rejected', reason: result.reason })
      return json({ status: 'accepted', next: 'Call scan_next for the next prompt or the report.' })
    },

    async scan_report(a: { sessionId: string; format?: 'markdown' | 'json' | 'html' | 'patch' }) {
      const session = sessions.get(a.sessionId)
      if (session.error) return json({ status: 'error', error: session.error })
      if (!session.report) {
        return json({ status: 'not-ready', phase: session.progress?.phase ?? 'starting' })
      }
      const out = exportReport(session.report, a.format ?? 'markdown')
      return text(typeof out === 'string' ? out : out.content)
    },

    async scan_cancel(a: { sessionId: string }) {
      sessions.cancel(a.sessionId)
      return text('Cancelled.')
    },
  }
}

function summarise(r: ScanReport) {
  return {
    findings: r.findings.length,
    suppressed: r.suppressed?.length ?? 0,
    rejected: r.rejected?.length ?? 0,
    sitesAnalysed: r.stats?.sitesAnalysed ?? 0,
    filesFetched: r.stats?.filesFetched ?? 0,
    engines: r.engineProfile?.declared.map((d) => d.engine) ?? [],
    truncatedReason: r.truncatedReason ?? null,
  }
}

const round = (n: number) => Math.round(n * 100) / 100
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

export { applyValueGate }
