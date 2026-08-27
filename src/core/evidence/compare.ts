import { totalsFor } from './parse-pg-explain'
import { checkStaleness, type EvidenceProvenance, type ParsedPlan, type PerformanceVerdict, type QueryLogEvidence } from './types'

/**
 * Two captures in, one verdict out. Deterministic, no model involved.
 *
 * This is the only place in the product that can say a finding was *wrong*.
 * Everything upstream can say "unverified", "not machine-checkable" or
 * "questionable" — all of which are absences. A refutation is a result, and it
 * is the thing that turns the benchmark corpus problem from something that
 * needs a paid audit into something that accumulates from ordinary use.
 *
 * Three rules the comparison holds to:
 *
 * 1. **Never infer a measurement.** An untimed plan cannot produce a timing
 *    verdict, and estimates are not measurements. Missing data yields
 *    `insufficient-evidence` with the missing capture named, never a guess.
 *
 * 2. **A difference is not an improvement.** Every reason cites the metric and
 *    both numbers, so the reader can disagree with the arithmetic rather than
 *    with an adjective.
 *
 * 3. **Noise is not signal.** A 4% change in block reads between two runs of
 *    the same query is ordinary. Thresholds are stated below and applied
 *    consistently rather than being chosen per comparison.
 */

/**
 * Below this relative change, two numbers are the same number.
 *
 * 20% is deliberately blunt. Anything finer would be reporting run-to-run
 * variance as a result — the same variance that dominated the benchmark
 * measurements — and a tool whose entire claim is "we do not overstate" cannot
 * publish a 6% improvement off two single samples.
 */
const MATERIAL_CHANGE = 0.2

/** Below this many blocks, ratios are meaningless. 3 -> 1 is not a 3x win. */
const MIN_BLOCKS = 50

export interface CompareInput {
  original?: { plan?: ParsedPlan; log?: QueryLogEvidence; provenance: EvidenceProvenance }
  proposed?: { plan?: ParsedPlan; log?: QueryLogEvidence; provenance: EvidenceProvenance }
  /** The commit the scan ran against, for the staleness check. */
  scannedCommitSha: string
  now: number
  /** What the finding claimed, so the verdict answers the right question. */
  category?: string
}

export function comparePerformance(input: CompareInput): PerformanceVerdict {
  const basedOn: EvidenceProvenance[] = []
  const missing: string[] = []
  let stale = false
  const staleNotes: string[] = []

  for (const side of ['original', 'proposed'] as const) {
    const capture = input[side]
    if (!capture) {
      missing.push(`A capture for the ${side} version.`)
      continue
    }
    basedOn.push(capture.provenance)
    const check = checkStaleness(capture.provenance, input.scannedCommitSha, input.now)
    if (check.stale) {
      stale = true
      staleNotes.push(`The ${side} capture is not current: ${check.reason}.`)
    }
  }

  if (missing.length > 0) {
    return {
      kind: 'insufficient-evidence',
      because: ['A comparison needs both sides. Only one was supplied.'],
      missing,
      basedOn,
      stale,
    }
  }

  const a = input.original!
  const b = input.proposed!
  const because: string[] = [...staleNotes]

  /* -- round-trip claims: the log is the instrument, not the plan ---------- */
  if (a.log && b.log) {
    return withStale(compareLogs(a.log, b.log, because, basedOn), stale)
  }
  if (isRoundTrip(input.category) && (!a.log || !b.log)) {
    return {
      kind: 'insufficient-evidence',
      because: [
        ...because,
        `This finding claims a change in the number of database calls. A query plan cannot ` +
        'answer that — it describes one statement, and the claim is about how many statements run.',
      ],
      missing: ['A query-count capture for both versions (CaptureQueriesContext, assert_queries, log: [\'query\']).'],
      basedOn,
      stale,
    }
  }

  if (!a.plan || !b.plan) {
    return {
      kind: 'insufficient-evidence',
      because: [...because, 'No plan was supplied for both versions.'],
      missing: ['EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) output for both versions.'],
      basedOn,
      stale,
    }
  }

  return withStale(comparePlans(a.plan, b.plan, because, basedOn), stale)
}

/* ------------------------------------------------------------------ logs -- */

function compareLogs(
  a: QueryLogEvidence,
  b: QueryLogEvidence,
  because: string[],
  basedOn: EvidenceProvenance[],
): PerformanceVerdict {
  const delta = a.count - b.count

  if (b.count > a.count) {
    return {
      kind: 'regression',
      because: [
        ...because,
        `The rewrite issues ${b.count} queries where the original issues ${a.count} — ${b.count - a.count} more, not fewer.`,
      ],
      basedOn,
      stale: false,
    }
  }
  if (delta === 0) {
    return {
      kind: 'no-difference',
      because: [
        ...because,
        `Both versions issue ${a.count} quer${a.count === 1 ? 'y' : 'ies'}. The claim was a reduction in round trips; there was none.`,
      ],
      basedOn,
      stale: false,
    }
  }
  return {
    kind: 'confirmed',
    because: [
      ...because,
      `The rewrite issues ${b.count} quer${b.count === 1 ? 'y' : 'ies'} where the original issues ${a.count} — ${delta} fewer round trip(s), measured rather than counted from source.`,
      ...(a.totalMs !== undefined && b.totalMs !== undefined
        ? [`Wall clock for the same unit of work: ${a.totalMs}ms -> ${b.totalMs}ms.`]
        : []),
    ],
    basedOn,
    stale: false,
  }
}

/* ----------------------------------------------------------------- plans -- */

function comparePlans(
  a: ParsedPlan,
  b: ParsedPlan,
  because: string[],
  basedOn: EvidenceProvenance[],
): PerformanceVerdict {
  const ta = totalsFor(a)
  const tb = totalsFor(b)

  const gains: string[] = []
  const losses: string[] = []

  /* -- scan type: the change a missing-index finding actually predicts ----- */
  if (ta.scanNodes.length > 0 && tb.scanNodes.length === 0) {
    gains.push(
      `The sequential scan on ${ta.scanNodes.join(', ')} is gone; the rewrite uses ${[...tb.nodeTypes].filter((n) => /Index/.test(n)).join(', ') || 'a different access path'}.`,
    )
  }
  if (ta.scanNodes.length === 0 && tb.scanNodes.length > 0) {
    losses.push(`The rewrite introduces a sequential scan on ${tb.scanNodes.join(', ')} where the original had none.`)
  }
  if (ta.scanNodes.length > 0 && tb.scanNodes.length > 0) {
    because.push(
      `Both plans still sequentially scan ${tb.scanNodes.join(', ')} — whatever else changed, the planner did not switch to an index.`,
    )
  }

  /* -- sort spill ---------------------------------------------------------- */
  if (ta.diskSorts.length > 0 && tb.diskSorts.length === 0) {
    gains.push(`The sort no longer spills to disk (was: ${ta.diskSorts.join('; ')}).`)
  }
  if (ta.diskSorts.length === 0 && tb.diskSorts.length > 0) {
    losses.push(`The rewrite introduces a sort that spills to disk: ${tb.diskSorts.join('; ')}.`)
  }

  /* -- blocks read: the comparison metric, when it was captured ------------ */
  if (!ta.hasBuffers || !tb.hasBuffers) {
    because.push(
      'Neither plan reports buffers, so I/O could not be compared. Re-run with EXPLAIN (ANALYZE, BUFFERS) to get the number that matters most.',
    )
  } else {
    const change = relativeChange(ta.blocksRead, tb.blocksRead)
    if (change !== null && Math.abs(change) >= MATERIAL_CHANGE) {
      const line = `Blocks read from disk: ${ta.blocksRead} -> ${tb.blocksRead} (${pct(change)}).`
      if (change < 0) gains.push(line)
      else losses.push(line)
    } else if (change !== null) {
      because.push(`Blocks read from disk: ${ta.blocksRead} -> ${tb.blocksRead}, within noise.`)
    }
  }

  /* -- timings, only when both plans were actually timed ------------------- */
  if (!a.timed || !b.timed) {
    because.push(
      'At least one capture is an untimed EXPLAIN. It shows what the planner intends, not what happened, ' +
      'so it can show an access-path change but cannot demonstrate a speed-up.',
    )
    // Not a hard stop: a Seq Scan becoming an Index Scan is a real, checkable
    // structural change and worth reporting even without timings. What must not
    // happen is calling that a measured improvement in speed.
  } else {
    const ma = a.totalMs ?? a.root.actualTotalMs
    const mb = b.totalMs ?? b.root.actualTotalMs
    const change = relativeChange(ma, mb)
    if (change !== null && Math.abs(change) >= MATERIAL_CHANGE) {
      const line = `Execution time: ${fmtMs(ma)} -> ${fmtMs(mb)} (${pct(change)}). One sample each — repeat it before trusting the magnitude.`
      if (change < 0) gains.push(line)
      else losses.push(line)
    } else if (change !== null) {
      because.push(`Execution time: ${fmtMs(ma)} -> ${fmtMs(mb)}, within noise for a single sample.`)
    }
  }

  /* -- planning time, which is what a plan-cache claim is about ------------ */
  if (a.planningMs !== undefined && b.planningMs !== undefined) {
    const change = relativeChange(a.planningMs, b.planningMs)
    if (change !== null && Math.abs(change) >= MATERIAL_CHANGE) {
      const line = `Planning time: ${fmtMs(a.planningMs)} -> ${fmtMs(b.planningMs)} (${pct(change)}).`
      if (change < 0) gains.push(line)
      else losses.push(line)
    }
  }

  /* -- verdict ------------------------------------------------------------- */
  if (losses.length > 0 && gains.length === 0) {
    return { kind: 'regression', because: [...because, ...losses], basedOn, stale: false }
  }
  if (losses.length > 0 && gains.length > 0) {
    // Both directions moved. That is a real result and it is not an
    // improvement — presenting it as one would be the exact overstatement this
    // product exists to avoid.
    return {
      kind: 'regression',
      because: [
        ...because,
        'The change helps on one metric and hurts on another, so it is not an improvement without a decision about which matters here:',
        ...gains.map((g) => `Better: ${g}`),
        ...losses.map((l) => `Worse: ${l}`),
      ],
      basedOn,
      stale: false,
    }
  }
  if (gains.length > 0) {
    return { kind: 'confirmed', because: [...because, ...gains], basedOn, stale: false }
  }
  return {
    kind: 'no-difference',
    because: [
      ...because,
      'Nothing moved by a margin worth reporting. The rewrite may still be worth making for clarity; it did not measurably change what the database does.',
    ],
    basedOn,
    stale: false,
  }
}

/* ----------------------------------------------------------------- utils -- */

function isRoundTrip(category?: string): boolean {
  return category === 'n-plus-one' || category === 'round-trip' || category === 'batching'
}

function withStale(v: PerformanceVerdict, stale: boolean): PerformanceVerdict {
  return stale ? { ...v, stale: true } : v
}

/**
 * Signed relative change, or null when the comparison would be meaningless.
 *
 * Null on a zero baseline (no percentage exists) and on numbers too small for a
 * ratio to mean anything — 3 blocks becoming 1 is not a 67% improvement in
 * anything a person should act on.
 */
function relativeChange(from?: number, to?: number): number | null {
  if (from === undefined || to === undefined) return null
  if (from === 0) return to === 0 ? 0 : null
  if (from < MIN_BLOCKS && to < MIN_BLOCKS && from < 10 && to < 10) return null
  return (to - from) / from
}

function pct(change: number): string {
  const n = Math.round(Math.abs(change) * 100)
  return change < 0 ? `${n}% fewer` : `${n}% more`
}

function fmtMs(ms?: number): string {
  return ms === undefined ? 'unknown' : `${ms.toFixed(1)}ms`
}
