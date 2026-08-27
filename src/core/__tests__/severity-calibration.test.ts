import { describe, expect, it } from 'vitest'
import { severityFromEvidence } from '../analyze/gate'
import type { Finding, Severity } from '../types'
import fixture from '../../../bench/fixtures/severity-calibration.json'

/**
 * Phase 1b, measured against every finding a real model actually published.
 *
 * The failure this fixes: across three scans of mt-test-studio, gpt-5.4-mini
 * published 27 findings and **not one came out above `low`**. Severity was a
 * ceiling — the model proposed a value and evidence could only lower it — and
 * the model rated almost everything `low`, so a ceiling could only agree. The
 * report gave the reader no way to tell a per-request N+1 from a suggestion to
 * drop a column.
 *
 * `matchesRealDefect` comes from the human-verified truth file, not from the
 * tool, so this measures whether the derived severity actually sorts real
 * defects above noise rather than merely spreading the distribution.
 */

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

type Row = (typeof fixture.findings)[number]

/** Rebuild the shape `severityFromEvidence` reads. */
function asFinding(r: Row): Finding {
  return {
    id: r.title, kind: r.kind as Finding['kind'], title: r.title, summary: '',
    severity: r.publishedSeverity as Severity,
    category: r.category as Finding['category'],
    engine: 'mysql', accessStyle: 'orm',
    original: r.original,
    primaryOccurrence: { file: r.file, startLine: r.startLine, endLine: r.startLine, excerpt: '' },
    otherOccurrences: [],
    suggestion: {
      proposed: r.proposed, rationale: '', equivalenceArgument: '', assumptions: [],
      expectedImpact: '', requiredMigration: r.requiredMigration ?? undefined,
    },
    evidence: [],
    scope: (r.scope ?? undefined) as Finding['scope'],
    performance: {
      status: 'unmeasured',
      counted: Array.from({ length: r.countedFacts }, (_, i) => `fact ${i}`),
      unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
    },
    grounding: 'verified', groundingNotes: [], modelConfidence: 0.5,
  }
}

const rows = fixture.findings.map((r) => ({
  row: r,
  derived: severityFromEvidence(asFinding(r), (r.scope ?? null) as never).severity,
}))
const real = rows.filter((x) => x.row.matchesRealDefect)
const noise = rows.filter((x) => !x.row.matchesRealDefect)
const mean = (xs: typeof rows) => xs.reduce((a, x) => a + RANK[x.derived], 0) / xs.length

describe('the published severities were uniformly low', () => {
  it('every one of the 27 was low or info as published', () => {
    for (const { row } of rows) expect(['low', 'info']).toContain(row.publishedSeverity)
  })
})

describe('derived severity spreads, and spreads usefully', () => {
  it('produces a real distribution instead of one band', () => {
    const bands = new Set(rows.map((x) => x.derived))
    expect(bands.size).toBeGreaterThanOrEqual(3)
    expect([...bands]).toContain('high')
  })

  it('lifts every finding that matches a human-verified defect out of low', () => {
    // This is the point. Five findings across three runs land on a real defect;
    // all five shipped as `low`.
    expect(real).toHaveLength(5)
    for (const { row, derived } of real) {
      expect(['high', 'medium'], `${row.title} -> ${derived}`).toContain(derived)
    }
  })

  it('ranks real defects above noise by a clear margin', () => {
    // Spreading the distribution is not the same as sorting it. Lower rank is
    // more severe, so the real mean must sit below the noise mean.
    expect(mean(real)).toBeLessThan(mean(noise) - 0.5)
  })

  it('concentrates real defects in the top band', () => {
    const highs = rows.filter((x) => x.derived === 'high' || x.derived === 'critical')
    const hitRate = highs.filter((x) => x.row.matchesRealDefect).length / highs.length
    const baseRate = real.length / rows.length
    // Reading only the top band must beat reading everything.
    expect(hitRate).toBeGreaterThan(baseRate * 1.5)
  })

  it('never rates a cold-path finding above info', () => {
    for (const { row, derived } of rows) {
      const cold = row.scope?.trigger === 'migration' || row.scope?.trigger === 'test'
      const indexy = /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|add_index|@@index)\b/i
        .test(`${row.original} ${row.proposed} ${row.requiredMigration ?? ''}`)
      if (cold && !indexy) expect(derived, row.title).toBe('info')
    }
  })

  it('never rates an N+1 high when the source shows no loop', () => {
    for (const { row, derived } of rows) {
      const perIteration = (row.scope?.loopDepth ?? 0) > 0 || row.scope?.opensLoop === true
      if (row.category === 'n-plus-one' && !perIteration) expect(derived, row.title).toBe('low')
    }
  })
})
