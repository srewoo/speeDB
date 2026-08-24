import type { Evidence, Finding, QueryOccurrence } from '@/core/types'
import { sliceLines } from '@/core/detect/scan'
import { checkEquivalence } from './equivalence'
import { checkPerformance } from './performance'
import { checkProposedIndex, type SchemaFacts } from './schema-facts'

/**
 * The grounding pass. Nothing reaches the UI without going through here.
 *
 * The model is asked to cite file paths, line ranges and verbatim quotes. This
 * re-checks every one of those against the bytes we actually fetched. A model
 * that invents a path, an index name or a column gets caught here rather than
 * in the user's production database.
 *
 * Three outcomes:
 *   verified            - every citation checks out
 *   needs-verification  - the finding is real-looking but a citation is soft
 *   rejected            - a citation is fabricated; the finding is pulled
 */
export interface GroundingInput {
  /** Every file we fetched, by path. The only source of truth. */
  files: Map<string, string>
  /** What the repository declares about its schema, for index checks. */
  schema?: SchemaFacts
}

export function groundFindings(findings: Finding[], input: GroundingInput): {
  kept: Finding[]
  rejected: Finding[]
} {
  const kept: Finding[] = []
  const rejected: Finding[] = []

  for (const finding of findings) {
    const notes: string[] = []
    let fatal = false

    // 1. The primary occurrence must point at a file we actually read.
    const occResult = checkOccurrence(finding.primaryOccurrence, input.files)
    notes.push(...occResult.notes)
    if (occResult.fatal) fatal = true

    // 2. The original query text should appear in that file. Whitespace and
    //    string-concatenation differences are tolerated; a wholly absent query
    //    is not.
    if (!fatal && finding.original.trim()) {
      const source = input.files.get(finding.primaryOccurrence.file)
      if (source && !containsLoosely(source, finding.original)) {
        notes.push('The quoted original query was not found verbatim in the cited file.')
      }
    }

    // 3. Every evidence citation gets the same treatment.
    const verifiedEvidence: Evidence[] = []
    for (const ev of finding.evidence) {
      const res = checkEvidence(ev, input.files)
      if (res.ok) {
        verifiedEvidence.push(ev)
      } else {
        notes.push(res.note)
        // A fabricated file path in evidence is disqualifying — it means the
        // model invented the schema it reasoned from.
        if (res.fabricatedPath) fatal = true
      }
    }

    // 4. Machine-check the same-output claim against the queries themselves.
    //
    //    This replaces what used to be a length threshold on the model's prose.
    //    A long argument is not a correct one; the only honest options are to
    //    check a property or to say it was not checked.
    let kind = finding.kind
    const equivalence = checkEquivalence(finding.original, finding.suggestion.proposed)

    if (finding.kind === 'equivalent') {
      const hard = equivalence.deltas.filter((d) => d.severity === 'hard')
      const soft = equivalence.deltas.filter((d) => d.severity === 'soft')

      if (hard.length > 0) {
        // Demonstrably different output. This is not a judgement call, so the
        // finding is moved out of the same-output section entirely.
        kind = 'behavioural'
        notes.push(
          `Reclassified as behaviour-changing: ${hard.map((d) => d.detail).join(' ')}`,
        )
      } else if (soft.length > 0) {
        notes.push(...soft.map((d) => `Same-output claim needs review — ${d.detail}`))
      }

      if (equivalence.undecided.length > 0) {
        notes.push(
          `Not machine-checkable: ${equivalence.undecided.join(' ')} The argument below is the model's, shown in full for you to judge.`,
        )
      }

      // Completeness heuristic, honestly labelled: does the argument even
      // mention the dimensions that "same output" has to cover?
      const missing = missingDimensions(finding.suggestion.equivalenceArgument)
      if (missing.length > 0) {
        notes.push(`The equivalence argument does not address: ${missing.join(', ')}.`)
      }
    }

    // 5. A suggestion that names an index must have index evidence behind it.
    const namesIndex = /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|USING\s+btree|@@index)\b/i.test(
      finding.suggestion.proposed + finding.suggestion.rationale,
    )
    const hasIndexEvidence = verifiedEvidence.some(
      (e) => e.kind === 'index-definition' || e.kind === 'schema' || e.kind === 'migration',
    )
    if (namesIndex && !hasIndexEvidence && !finding.suggestion.requiredMigration) {
      notes.push('References an index but cites no schema or migration evidence for it.')
    }

    // 6. The speed claim, held to the same standard as the equivalence claim.
    const performance = checkPerformance({
      engine: finding.engine,
      category: finding.category,
      original: finding.original,
      proposed: finding.suggestion.proposed,
      requiredMigration: finding.suggestion.requiredMigration,
    })

    // 7. An index proposal is checked against what the repository declares.
    //    This kills the most common wrong recommendation: an index that an
    //    existing one already covers by leading columns.
    let indexAdvice
    if (input.schema) {
      const proposal = finding.suggestion.requiredMigration ?? finding.suggestion.proposed
      indexAdvice = checkProposedIndex(proposal, input.schema) ?? undefined
      if (indexAdvice?.duplicateOf) {
        notes.push(`Redundant recommendation — ${indexAdvice.notes[0]}`)
      } else if (indexAdvice?.coveredBy) {
        notes.push(`Likely unnecessary — ${indexAdvice.notes[0]}`)
      }
      if (indexAdvice?.unknownColumns.length) {
        notes.push(indexAdvice.notes.find((n) => n.includes('not found')) ?? '')
      }
    }

    const grounded: Finding = {
      ...finding,
      kind,
      equivalence,
      performance,
      indexAdvice,
      evidence: verifiedEvidence,
      groundingNotes: notes,
      grounding: fatal ? 'rejected' : notes.length === 0 ? 'verified' : 'needs-verification',
    }

    if (fatal) rejected.push(grounded)
    else kept.push(grounded)
  }

  return { kept, rejected }
}

function checkOccurrence(
  occ: QueryOccurrence,
  files: Map<string, string>,
): { fatal: boolean; notes: string[] } {
  const notes: string[] = []
  if (!occ.file) return { fatal: true, notes: ['Finding cited no file path.'] }

  const source = files.get(occ.file)
  if (source === undefined) {
    return { fatal: true, notes: [`Cited file does not exist in the scanned tree: ${occ.file}`] }
  }

  const totalLines = source.split('\n').length
  if (occ.startLine < 1 || occ.startLine > totalLines) {
    notes.push(`Cited line ${occ.startLine} is outside ${occ.file} (${totalLines} lines).`)
  } else if (occ.excerpt.trim()) {
    // Allow drift of a few lines — models routinely off-by-one on line numbers,
    // and that alone shouldn't sink an otherwise good finding.
    const window = sliceLines(source, Math.max(1, occ.startLine - 5), occ.endLine + 5)
    if (!containsLoosely(window, firstSignificantLine(occ.excerpt))) {
      notes.push(`Excerpt does not match ${occ.file} around line ${occ.startLine}.`)
    }
  }

  return { fatal: false, notes }
}

function checkEvidence(
  ev: Evidence,
  files: Map<string, string>,
): { ok: true } | { ok: false; note: string; fabricatedPath: boolean } {
  const source = files.get(ev.file)
  if (source === undefined) {
    return {
      ok: false,
      note: `Evidence cites a file that was never read: ${ev.file}`,
      fabricatedPath: true,
    }
  }
  if (ev.quote?.trim() && !containsLoosely(source, ev.quote)) {
    return {
      ok: false,
      note: `Evidence quote was not found in ${ev.file}.`,
      fabricatedPath: false,
    }
  }
  return { ok: true }
}

/**
 * Whitespace-insensitive, case-insensitive containment.
 *
 * Deliberately loose: SQL is often assembled across concatenated string
 * literals, so an exact match would reject correct findings. It still catches
 * the failure that matters — a quote the model made up entirely.
 */
function containsLoosely(haystack: string, needle: string): boolean {
  if (!needle.trim()) return true
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/['"`]/g, '').toLowerCase().trim()
  const h = norm(haystack)
  const n = norm(needle)
  if (n.length < 12) return h.includes(n)
  if (h.includes(n)) return true

  // Long quotes may span a concatenation the model collapsed. Require a
  // strong majority of consecutive 24-char windows to be present.
  const windows: string[] = []
  for (let i = 0; i + 24 <= n.length; i += 24) windows.push(n.slice(i, i + 24))
  if (windows.length === 0) return false
  const found = windows.filter((w) => h.includes(w)).length
  return found / windows.length >= 0.7
}

function firstSignificantLine(excerpt: string): string {
  const lines = excerpt.split('\n').map((l) => l.replace(/^\s*\d+\s*\|\s?/, '').trim())
  return lines.find((l) => l.length > 8) ?? excerpt.slice(0, 40)
}

/**
 * Does the argument mention the dimensions "same output" must cover?
 *
 * A completeness heuristic, not a proof — and named as one. It catches an
 * argument that silently ignores ordering or NULL handling; it cannot tell a
 * correct argument from a confident wrong one. That is what checkEquivalence
 * is for.
 */
function missingDimensions(argument: string): string[] {
  const text = argument.toLowerCase()
  const dimensions: [string, RegExp][] = [
    ['the rows returned', /\brows?\b|\bresult set\b|\bmatches\b/],
    ['the column list', /\bcolumns?\b|\bprojection\b|\bfields?\b|\bselect list\b/],
    ['ordering', /\border\b|\bordering\b|\bsort/],
    ['NULL or duplicate handling', /\bnull\b|\bduplicat/],
  ]
  return dimensions.filter(([, re]) => !re.test(text)).map(([label]) => label)
}
