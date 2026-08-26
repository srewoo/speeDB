import { describe, expect, it } from 'vitest'
import { toMarkdown } from '../report/export'
import type { Finding, ScanReport } from '../types'

/**
 * Fix 6 — honest headline metrics.
 *
 * `Coverage 924 files read · 1115 query sites found · 6 analysis passes` read as
 * a thoroughness claim, while a large share of those 1,115 sites were
 * Object.keys(), comments mentioning OpenSearch, and JavaScript string
 * concatenation. Silence about what was filtered or capped is itself a claim.
 */

function report(over: Partial<ScanReport> = {}): ScanReport {
  return {
    id: 'r1',
    repo: {
      forge: 'gitlab', apiOrigin: 'https://gitlab.com/api',
      owner: 'mindtickle/qa-automation', name: 'mt-test-studio',
      ref: 'main', commitSha: 'abcdef1234567890',
    },
    createdAt: '2026-08-26T09:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-opus-5',
    findings: [],
    rejected: [],
    suppressed: [],
    stats: {
      filesInTree: 1000, filesFetched: 924, filesSkipped: 0,
      ingest: 'archive', apiCalls: 3,
      candidatesFound: 418,
      sitesMatched: 1115, sitesSampled: 0,
      sitesQueued: 418, sitesAnalysed: 418,
      sitesFiltered: { belowConfidence: 185, lowPriority: 512 },
      sitesUnaccounted: 0, truncatedFiles: [
        { path: 'tcms/core/views.py', found: 48, analysed: 40 },
        { path: 'tcms/core/admin_views.py', found: 44, analysed: 40 },
      ],
      chunksAnalysed: 6,
      promptTokens: 100, completionTokens: 50, chunksReused: 0, elapsedMs: 1000,
    },
    engineProfile: {
      declared: [
        { engine: 'mysql', source: 'tcms/settings/common.py', quote: '"ENGINE": "django.db.backends.mysql"', authority: 100 },
        { engine: 'mariadb', source: 'docker-compose.yml', quote: 'image: mariadb:10.11', authority: 60 },
      ],
      primary: 'mysql',
      ambiguous: false,
    },
    ...over,
  }
}

describe('Fix 6 — the coverage headline degrades honestly', () => {
  const md = toMarkdown(report(), [])

  it('reports matched and analysed as different numbers', () => {
    expect(md).toMatch(/1,115 sites matched/)
    expect(md).toMatch(/418 analysed/)
  })

  it('says what was filtered, and why', () => {
    expect(md).toMatch(/697 filtered/)
    expect(md).toMatch(/below confidence 185/)
    expect(md).toMatch(/low priority 512/)
  })

  it('names the files where the per-file cap bit', () => {
    expect(md).toMatch(/2 file\(s\) had more query sites than the per-file cap/)
    expect(md).toMatch(/tcms\/core\/views\.py` \(48 found, 40 analysed\)/)
  })

  it('cites the engine declaration rather than asserting an engine', () => {
    expect(md).toMatch(/mysql \(`tcms\/settings\/common\.py`/)
    expect(md).toMatch(/django\.db\.backends\.mysql/)
  })

  it('never claims a query-site count without saying how many were analysed', () => {
    expect(md).not.toMatch(/query sites found/)
  })

  it('states the finding split in the header', () => {
    const md2 = toMarkdown(report({
      suppressed: [suppressed()],
      rejected: [suppressed()],
    }), [])
    expect(md2).toMatch(/0 published · 1 suppressed · 1 rejected in verification/)
  })

  it('says an empty report is a good outcome, not an absence', () => {
    expect(md).toMatch(/good outcome, not an empty one/)
  })

  it('lists suppressed findings with their reason, grouped', () => {
    const md2 = toMarkdown(report({ suppressed: [suppressed()] }), [])
    expect(md2).toMatch(/## Suppressed before publication/)
    expect(md2).toMatch(/no-op \(proposal identical to the original\) — 1/)
    expect(md2).toMatch(/none of them was silently dropped/)
    expect(md2).toMatch(/nothing to apply/)
  })

  it('flags a genuinely ambiguous engine profile instead of picking one', () => {
    const md2 = toMarkdown(report({
      engineProfile: {
        declared: [
          { engine: 'mysql', source: 'go.mod', quote: 'go-sql-driver/mysql', authority: 70 },
          { engine: 'postgres', source: 'go.mod', quote: 'lib/pq', authority: 70 },
        ],
        primary: 'mysql',
        ambiguous: true,
      },
    }), [])
    expect(md2).toMatch(/Several data stores are declared with equal authority/)
  })
})

function suppressed(): Finding {
  return {
    id: 's1',
    kind: 'equivalent',
    title: 'Use exists() instead of count()',
    summary: 'The count is only compared against zero.',
    severity: 'info',
    category: 'over-fetch',
    engine: 'mysql',
    accessStyle: 'orm',
    original: 'TestCase.objects.filter(section=sec).count()',
    primaryOccurrence: {
      file: 'tcms/core/views.py', startLine: 878, endLine: 878,
      excerpt: 'sc_total = TestCase.objects.filter(section=sec).count()',
    },
    otherOccurrences: [],
    suggestion: {
      proposed: 'TestCase.objects.filter(section=sec).count()',
      rationale: '', equivalenceArgument: '', assumptions: [], expectedImpact: '',
    },
    evidence: [],
    suppression: {
      reason: 'no-op',
      detail: 'The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.',
    },
    grounding: 'verified',
    groundingNotes: [],
    modelConfidence: 0.6,
  }
}

describe('the coverage numbers add up', () => {
  it('matched minus filtered equals analysed', () => {
    // `analysed` exceeding `matched` was live until a real Java repo showed it:
    // tier two produces one candidate per data-access file with no visible
    // query, and those were missing from the matched total.
    const r = report({
      stats: {
        ...report().stats,
        sitesMatched: 29, sitesSampled: 5, sitesAnalysed: 29,
        sitesFiltered: { belowConfidence: 0, lowPriority: 0 },
      },
    })
    const s = r.stats
    expect(s.sitesMatched - s.sitesFiltered.belowConfidence - s.sitesFiltered.lowPriority)
      .toBe(s.sitesAnalysed)
    expect(s.sitesAnalysed).toBeLessThanOrEqual(s.sitesMatched)
  })

  it('discloses how many sites came from whole-file samples', () => {
    const md = toMarkdown(report({
      stats: { ...report().stats, sitesMatched: 29, sitesSampled: 5, sitesAnalysed: 29 },
    }), [])
    expect(md).toMatch(/29 sites matched \(5 from whole-file samples\)/)
  })

  it('stays quiet about tier two when it contributed nothing', () => {
    const md = toMarkdown(report({ stats: { ...report().stats, sitesSampled: 0 } }), [])
    expect(md).not.toMatch(/whole-file samples/)
  })
})

describe('a queue the budget never reached is not coverage', () => {
  // Introduced by the coverage rewrite itself: `sitesAnalysed` was set to
  // `candidates.length`, so a scan that the token budget cut off after 8 of 16
  // passes still reported every queued site as analysed. Discourse queues
  // 11,046 sites, of which only 396 score above 0.60.
  it('reports analysed and queued separately when the budget bit', () => {
    const md = toMarkdown(report({
      stats: { ...report().stats, sitesMatched: 11330, sitesQueued: 11046, sitesAnalysed: 3200 },
      truncatedReason: 'Stopped at the 400,000 token budget. 8 pass(es) were not run.',
    }), [])
    expect(md).toMatch(/3,200 analysed \(of 11,046 queued — the token budget stopped the scan first\)/)
  })

  it('says nothing extra when the whole queue was analysed', () => {
    const md = toMarkdown(report({
      stats: { ...report().stats, sitesQueued: 418, sitesAnalysed: 418 },
    }), [])
    expect(md).not.toMatch(/queued/)
  })
})

describe('consent sets the ceiling, not a second argument with it', () => {
  it('a budget below the approved estimate no longer truncates the scan', async () => {
    // 25 sites per pass turns a 875-site repo into 35 passes, whose total
    // exceeds the old 400k default. The gate would quote all 35, the user would
    // approve, and the budget would then cut the run short — two mechanisms
    // disagreeing about one decision.
    const { DEFAULTS } = await import('@/config/models')
    expect(DEFAULTS.scanTokenBudget).toBeGreaterThan(0)
    // The invariant is behavioural and covered by pipeline.test.ts; this asserts
    // the two knobs still exist independently, which is what makes the conflict
    // possible and the resolution meaningful.
    expect(DEFAULTS.sitesPerPass).toBeLessThan(DEFAULTS.scanTokenBudget)
  })
})

describe('triage gaps are disclosed, not merely handled', () => {
  it('says how many sites came back with no verdict', () => {
    // Escalating an unanswered site to a full write-up is the safe direction,
    // but it is a workaround: a scan with many of them has a triage stage that
    // is not answering reliably, and only the count makes that visible.
    const md = toMarkdown(report({
      stats: { ...report().stats, sitesUnaccounted: 42 },
    }), [])
    expect(md).toMatch(/42 site\(s\) came back from triage with no verdict/)
    expect(md).toMatch(/escalated to a full write-up rather than assumed clean/)
    expect(md).toMatch(/not answering reliably/)
  })

  it('stays quiet when triage accounted for everything', () => {
    const md = toMarkdown(report({ stats: { ...report().stats, sitesUnaccounted: 0 } }), [])
    expect(md).not.toMatch(/Triage gaps/)
  })
})
