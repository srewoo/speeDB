import type { Candidate, RepoFile } from '@/core/types'
import { describeScope } from '@/core/detect/scope'

/**
 * Stage one of two: decide, per site, whether there is something to report.
 *
 * The single-shot analysis asked one question — "find the queries that can be
 * made faster" — and expected finished findings in the same response. Measured
 * on a real repository, that produced about three and a half findings per pass
 * regardless of how many sites the pass contained, and it missed defects that
 * were sitting in the input at the top of the priority order. Nothing in the
 * contract required the model to say anything at all about a given site, so
 * skipping one was free and invisible.
 *
 * Triage makes it not free. The response must carry a verdict for **every** id
 * it was given; the parser checks that and reports what is missing. Output is
 * about thirty tokens a site, so accounting for a hundred sites costs less than
 * writing three findings did.
 *
 * Authoring moves to stage two, where a site that was flagged gets a request to
 * itself and room to reason. The split is the point: triage is cheap and must be
 * exhaustive, authoring is expensive and only runs where triage pointed.
 */

export const TRIAGE_SYSTEM_PROMPT = `You are a senior database engineer triaging query sites in a real codebase.

You are NOT writing findings. You are deciding, for each site, whether there is a database performance problem worth a full review. Someone else writes the report.

## You must account for every site
You will be given N query sites, each with an id. Return exactly N verdicts, one per id, in the same order. Never skip a site. Never invent an id. If you are unsure about a site, that is what "unsure" is for — silence is not an option.

## The verdicts
- "problem"  — there is a specific, describable inefficiency here that a rewrite would fix.
- "clean"    — no problem worth reporting. This is the correct answer for most sites.
- "unsure"   — something looks off but the excerpt does not show enough to say. Treated as worth a closer look.

## What counts as a problem
A query issued once per iteration of a loop. A full scan where an indexed lookup would do. Fetching whole rows to read one column. An unbounded result set. Avoidable round trips. A predicate that cannot use an index. Missing batching. On non-relational stores: a Mongo $match after $lookup, a DynamoDB Scan where a Query would do, Cassandra ALLOW FILTERING, Redis KEYS, an Elasticsearch clause scoring in "must" when it belongs in "filter".

## What does NOT count
Style, naming, formatting. Code that is already batched or already projected. A query in a migration, seed or test — those run once at install or never in production, so the answer is "clean" unless the query is also incorrect. Code that makes no request to any data store at all: string building, URL assembly, in-memory list work. Answer "clean" for all of it.

## Read the scope line
Each site states its enclosing scope. "inside N loops" or "opens a loop" means the body runs per iteration, and that is the highest-value thing you can find here — look for it first. "reached by: migration" or "reached by: test" means it is not production code.

## Output
Return ONE JSON object, no markdown fence, no prose before or after:
{"verdicts":[{"id":"<the id given>","verdict":"problem"|"clean"|"unsure","category":"missing-index"|"redundant-index"|"full-scan"|"n-plus-one"|"over-fetch"|"unbounded-result"|"plan-cache-miss"|"round-trip"|"inefficient-join"|"implicit-cast"|"sort-in-memory"|"batching"|"transaction-scope"|"connection-handling"|"other","why":"one short clause; for \\"clean\\" a few words are enough"}]}

Every id you were given must appear exactly once.`

export type Verdict = 'problem' | 'clean' | 'unsure'

export interface TriageVerdict {
  id: string
  verdict: Verdict
  category: string
  why: string
}

export interface TriageResult {
  verdicts: TriageVerdict[]
  /** Ids that were sent but never came back. Never silently ignored. */
  unaccounted: string[]
  /** Ids returned that were never sent. A sign the model is inventing. */
  invented: string[]
  parseError?: string
}

export function buildTriagePrompt(input: {
  candidates: Candidate[]
  schemaFiles: RepoFile[]
  repoLabel: string
}): string {
  const parts: string[] = [`# Repository\n${input.repoLabel}`]

  // Schema context is trimmed hard here. Triage decides *whether* there is a
  // problem; the authoring stage gets the full schema to ground a claim about
  // one. Sending it twice for every pass is most of the token cost.
  if (input.schemaFiles.length > 0) {
    parts.push(
      '# Declared tables and indexes (names only, for orientation)\n' +
        input.schemaFiles.map((f) => f.path).join('\n'),
    )
  }

  parts.push(
    `# ${input.candidates.length} query sites to triage\n` +
      'Return exactly one verdict per id.\n' +
      input.candidates
        .map((c) => {
          const scope = c.scope ? `\n   ${describeScope(c.scope)}` : ''
          return (
            `\n## id: ${c.id}\n` +
            `   ${c.file}:${c.startLine}-${c.endLine} · detected as ${c.engine}/${c.accessStyle}${scope}\n` +
            '```\n' + c.excerpt + '\n```'
          )
        })
        .join('\n'),
  )

  parts.push(
    `# Task\nReturn a JSON object with exactly ${input.candidates.length} verdicts, one for each id above.`,
  )

  return parts.join('\n\n')
}

/**
 * Parse a triage response and reconcile it against what was asked.
 *
 * The reconciliation is the whole contract: a response that covers 12 of 25
 * sites is not a valid answer, and the caller needs to know which 13 were
 * skipped so it can ask again rather than quietly treating them as clean.
 */
export function parseTriage(raw: string, sentIds: string[]): TriageResult {
  const text = stripFence(raw).trim()
  if (!text) {
    return { verdicts: [], unaccounted: [...sentIds], invented: [], parseError: 'Empty response.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(extractObject(text) ?? text)
  } catch {
    return { verdicts: [], unaccounted: [...sentIds], invented: [], parseError: 'Response was not valid JSON.' }
  }

  const list = (parsed as { verdicts?: unknown }).verdicts
  if (!Array.isArray(list)) {
    return { verdicts: [], unaccounted: [...sentIds], invented: [], parseError: 'No "verdicts" array in the response.' }
  }

  const sent = new Set(sentIds)
  const seen = new Set<string>()
  const verdicts: TriageVerdict[] = []
  const invented: string[] = []

  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const v = item as Record<string, unknown>
    const id = String(v.id ?? '')
    if (!id) continue
    if (!sent.has(id)) { invented.push(id); continue }
    if (seen.has(id)) continue
    seen.add(id)
    verdicts.push({
      id,
      verdict: v.verdict === 'problem' ? 'problem' : v.verdict === 'unsure' ? 'unsure' : 'clean',
      category: String(v.category ?? 'other'),
      why: String(v.why ?? ''),
    })
  }

  return {
    verdicts,
    unaccounted: sentIds.filter((id) => !seen.has(id)),
    invented,
  }
}

/** Sites triage says are worth authoring: flagged, or it could not decide. */
export function flaggedIds(result: TriageResult): string[] {
  return result.verdicts.filter((v) => v.verdict === 'problem' || v.verdict === 'unsure').map((v) => v.id)
}

function stripFence(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return fence?.[1] ?? text
}

function extractObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return text.slice(start)
}
