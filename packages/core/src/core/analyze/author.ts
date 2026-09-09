import { equivalenceNotesFor } from '@/config/engines'
import type { Candidate, RepoFile } from '@/core/types'
import { describeScope } from '@/core/detect/scope'
import type { TriageVerdict } from './triage'

/**
 * Stage two of two: write the finding for a site triage flagged.
 *
 * Everything that made the old single prompt long is still here — the
 * equivalence rule, the speed rule, the grounding rule, the response schema —
 * because those are what make a finding trustworthy. What changed is how much
 * work one response has to carry: a handful of sites instead of hundreds, with
 * the reason triage flagged each one already stated, so the model spends its
 * output budget on argument rather than on triage it has already done.
 */

export const AUTHOR_SYSTEM_PROMPT = `You are a senior database engineer writing up database performance findings for a real codebase.

Each site below was already triaged as a probable problem, and the triage reason is given. Your job is to write the finding, or to say the triage was wrong.

## You must account for every site
Every site below has an id. Each one gets either a finding, or an entry in "declined" saying why not. Never leave a site out of both. Silently omitting a site is the one thing you must not do.

## Disagreeing is a valid answer
If a site does not actually have the problem triage claimed — or has none at all — decline it and say why in one clause. Declining is a good outcome and costs you nothing. A short, correct report beats a complete-looking one. What is not acceptable is passing over a site without saying anything about it.

## The equivalence rule — this is absolute
A suggestion may only be classified "equivalent" if the rewrite provably returns:
- the same rows, for every possible database state
- the same columns, in the same order
- the same row ordering (an unordered query has no ordering guarantee; do not add or remove ORDER BY and call it equivalent)
- the same NULL handling and the same duplicate handling
- the same error behaviour on the same inputs

If a change is an improvement but alters output in ANY of those ways — including "it fixes a bug" — classify it "behavioural" instead.

## The speed rule — you cannot measure, so do not claim to
You have no database connection, no query plan, no table sizes, no column selectivity and no timings.
- NEVER state or imply a speed multiple, a percentage, or a millisecond figure.
- State the MECHANISM: what the database will do differently. "One round trip instead of one per row." "Reads the index instead of the whole table."
- If the benefit depends on data you cannot see, say so in "assumptions".
- An index is not free: its benefit depends on selectivity and it adds write cost.

## The grounding rule — this is also absolute
- Cite file paths and line numbers only from the context below. Never guess a path.
- Every quote in an evidence item must appear VERBATIM in the context.
- Never reference an index, column, table or constraint you have not seen defined. If you suspect one exists but cannot see it, say so in "assumptions".

## The proposal must be different, and must go the right way
- Never return a "proposed" block that is the same code as "original".
- If your rewrite issues the same number of database calls as the original, or more, it is not a round-trip finding.
- Note that in Django, ActiveRecord, SQLAlchemy and EF Core, building a queryset issues NO query. Only a terminal, an iteration or a write does.

## Output
Return ONE JSON object, no markdown fence, no prose before or after:
{"findings":[ ... ], "declined":[{"siteId":"...","why":"one clause"}]}

Each finding:
{
  "siteId": "the id of the site this is about",
  "kind": "equivalent" | "behavioural",
  "title": "short imperative phrase",
  "summary": "one sentence stating the problem",
  "severity": "critical" | "high" | "medium" | "low" | "info",
  "category": "missing-index" | "redundant-index" | "full-scan" | "n-plus-one" | "over-fetch" | "unbounded-result" | "plan-cache-miss" | "round-trip" | "inefficient-join" | "implicit-cast" | "sort-in-memory" | "batching" | "transaction-scope" | "connection-handling" | "other",
  "engine": "the engine given for the site",
  "accessStyle": "raw-sql"|"query-builder"|"orm"|"stored-procedure"|"aggregation-pipeline"|"search-dsl"|"kv-command"|"ddl-migration",
  "original": "the query exactly as it appears in the source",
  "primaryOccurrence": {"file":"...","startLine":N,"endLine":N,"enclosingSymbol":"...","triggeredBy":"route/event/job that reaches this, if visible","excerpt":"verbatim lines from the context"},
  "otherOccurrences": [],
  "suggestion": {
    "proposed": "the rewritten query or code, ready to paste",
    "rationale": "plain English: why this is faster",
    "equivalenceArgument": "address rows, columns, ordering, NULLs, duplicates explicitly",
    "assumptions": ["anything that must be true for this to be safe"],
    "expectedImpact": "concrete, e.g. '1 round trip instead of N'",
    "requiredMigration": "the CREATE INDEX or ALTER TABLE statement that must run first. OMIT THIS KEY ENTIRELY if there is none — do not write \\"omit\\", \\"none\\" or \\"N/A\\" as its value"
  },
  "evidence": [{"kind":"schema"|"migration"|"index-definition"|"model-definition"|"call-site"|"config","file":"...","startLine":N,"endLine":N,"quote":"verbatim","relevance":"one sentence"}],
  "modelConfidence": 0.0-1.0
}

Returning fewer findings than sites is expected and correct — but every site you do not write up must appear in "declined". If none of them hold up, return {"findings":[], "declined":[ ...every site, with a reason... ]}.`

export function buildAuthorPrompt(input: {
  sites: { candidate: Candidate; verdict: TriageVerdict }[]
  schemaFiles: RepoFile[]
  repoLabel: string
}): string {
  const parts: string[] = [`# Repository\n${input.repoLabel}`]

  const notes = equivalenceNotesFor(input.sites.map((s) => s.candidate.engine))
  if (notes) {
    parts.push(
      '# Equivalence semantics for the engines here\n' +
        'These override any general intuition. If a change touches one of these behaviours, ' +
        'it is behaviour-changing, not equivalent.\n' + notes,
    )
  }

  if (input.schemaFiles.length > 0) {
    parts.push(
      '# Schema and migration context\n' +
        'Use these to ground any claim about tables, columns, indexes or constraints.\n' +
        input.schemaFiles
          .map((f) => `\n## FILE: ${f.path}\n\`\`\`\n${withLineNumbers(f.content ?? '', 1)}\n\`\`\``)
          .join('\n'),
    )
  }

  parts.push(
    '# Sites to write up\n' +
      'Line numbers are the real line numbers in each file. Cite them exactly.\n' +
      input.sites
        .map(({ candidate: c, verdict }) => {
          const scope = c.scope ? `\n   ${describeScope(c.scope)}` : ''
          return (
            `\n## id: ${c.id}\n` +
            `   ${c.file}  (lines ${c.startLine}-${c.endLine}, detected as ${c.engine}/${c.accessStyle})${scope}\n` +
            `   triaged as ${verdict.category}: ${verdict.why}\n` +
            '```\n' + withLineNumbers(c.excerpt, Math.max(1, c.startLine - 6)) + '\n```'
          )
        })
        .join('\n'),
  )

  parts.push(
    '# Task\nWrite up the sites that hold up. Set "siteId" on each finding. Return the JSON object described in your instructions.',
  )

  return parts.join('\n\n')
}

function withLineNumbers(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(5, ' ')}| ${line}`)
    .join('\n')
}


export interface AuthorAccounting {
  /** Site ids the response wrote a finding for. */
  authored: string[]
  /** Sites explicitly declined, with the stated reason. */
  declined: { siteId: string; why: string }[]
  /** Sites in the batch that appear in neither. The failure this exists to catch. */
  unaccounted: string[]
}

/**
 * Reconcile an authoring response against the batch it was asked about.
 *
 * The accounting contract was applied to triage and not to authoring, and the
 * gap showed: on a real run triage flagged all ten lines of the three known
 * defects, with accurate reasons, and the authoring stage wrote up 30 of 72
 * flagged sites — 42% — dropping every one of those ten without a word. That is
 * the same silent-skip failure the two-stage split was built to remove, moved
 * one stage later.
 */
export function reconcileAuthoring(
  raw: string,
  batchIds: string[],
  /**
   * The sites, for matching a finding that omitted its `siteId`.
   *
   * Depending on the model echoing an id back is a weak contract — it is asked
   * to, and it often does, but a finding already identifies its site by the file
   * and line it cites. Falling back to that is strictly more forgiving and no
   * less correct.
   */
  sites?: { id: string; file: string; startLine: number }[],
): AuthorAccounting {
  let parsed: unknown
  try {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
    parsed = JSON.parse(fenced?.[1] ?? raw)
  } catch {
    return { authored: [], declined: [], unaccounted: [...batchIds] }
  }

  const obj = (parsed ?? {}) as { findings?: unknown; declined?: unknown }
  const findings = Array.isArray(obj.findings) ? obj.findings : []
  const authored = findings
    .map((f) => {
      const o = (f ?? {}) as {
        siteId?: unknown
        primaryOccurrence?: { file?: unknown; startLine?: unknown }
      }
      const declared = String(o.siteId ?? '')
      if (batchIds.includes(declared)) return declared
      // No usable id: identify the site by what the finding cites.
      const file = String(o.primaryOccurrence?.file ?? '')
      const line = Number(o.primaryOccurrence?.startLine ?? NaN)
      const match = (sites ?? []).find(
        (sm) => sm.file === file && Math.abs(sm.startLine - line) <= 6,
      )
      return match?.id ?? ''
    })
    .filter((id) => batchIds.includes(id))

  const declined = Array.isArray(obj.declined)
    ? obj.declined
        .map((d) => {
          const o = (d ?? {}) as { siteId?: unknown; why?: unknown }
          return { siteId: String(o.siteId ?? ''), why: String(o.why ?? '') }
        })
        .filter((d) => batchIds.includes(d.siteId))
    : []

  const seen = new Set([...authored, ...declined.map((d) => d.siteId)])
  return { authored, declined, unaccounted: batchIds.filter((id) => !seen.has(id)) }
}
