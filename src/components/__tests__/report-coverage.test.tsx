/**
 * @vitest-environment jsdom
 *
 * Component tests for the two panels that carry the honesty work into the UI.
 *
 * Everything else about Fix 6 was tested at the `toMarkdown()` layer, which
 * proves the exported report is honest and says nothing about the screen most
 * users actually read. These panels are where a silent omission does the most
 * damage: if the coverage note or the suppression list fails to render, the
 * report looks *more* thorough than it is — the exact failure this work exists
 * to remove.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReportScreen } from '../ReportScreen'
import { CostGate } from '../CostGate'
import { useApp } from '@/store/app-store'
import type { Finding, ScanReport } from '@/core/types'

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    kind: 'equivalent',
    title: 'Batch the per-section count',
    summary: 'The count runs once per section inside the loop.',
    severity: 'medium',
    category: 'n-plus-one',
    engine: 'mysql',
    accessStyle: 'orm',
    original: 'TestCase.objects.filter(section=sec).count()',
    primaryOccurrence: {
      file: 'tcms/core/views.py', startLine: 878, endLine: 878,
      excerpt: 'sc_total = TestCase.objects.filter(section=sec).count()',
    },
    otherOccurrences: [],
    suggestion: {
      proposed: 'TestCase.objects.filter(section__in=sections).annotate(n=Count("id"))',
      rationale: '', equivalenceArgument: '', assumptions: [], expectedImpact: '',
    },
    evidence: [],
    grounding: 'verified',
    groundingNotes: [],
    modelConfidence: 0.8,
    ...over,
  }
}

const BASE_STATS: ScanReport['stats'] = {
  filesInTree: 1000, filesFetched: 953, filesSkipped: 0,
  ingest: 'archive', apiCalls: 3,
  candidatesFound: 873,
  sitesMatched: 875, sitesSampled: 0,
  sitesQueued: 873, sitesAnalysed: 873,
  sitesFiltered: { belowConfidence: 0, lowPriority: 2 },
  sitesUnaccounted: 0, truncatedFiles: [{ path: 'tcms/testcases/tests/test_epic_task_sections.py', found: 42, analysed: 40 }],
  chunksAnalysed: 6,
  promptTokens: 100, completionTokens: 50, chunksReused: 0, elapsedMs: 1000,
}

function report(over: Partial<ScanReport> = {}): ScanReport {
  return {
    id: 'r1',
    repo: {
      forge: 'gitlab', apiOrigin: 'https://gitlab.com/api',
      owner: 'mindtickle/qa-automation', name: 'mt-test-studio',
      ref: 'main', commitSha: '36972b38162bab',
    },
    createdAt: new Date().toISOString(),
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    findings: [],
    rejected: [],
    suppressed: [],
    stats: BASE_STATS,
    engineProfile: {
      declared: [
        { engine: 'mysql', source: 'tcms/settings/common.py', quote: '"ENGINE": "django.db.backends.mysql"', authority: 100 },
        { engine: 'mariadb', source: 'docker-compose.yml', quote: 'image: mariadb:10.11', authority: 60 },
      ],
      primary: 'mysql',
      ambiguous: false,
    },
    scope: { kind: 'repository' },
    ...over,
  }
}

/** Drive the real store rather than mocking it — the wiring is the thing. */
const seed = (r: ScanReport) => useApp.setState({ report: r, view: 'report' })

beforeEach(() => useApp.setState({ report: null, pendingEstimate: null }))
afterEach(cleanup)

describe('the coverage headline', () => {
  it('shows matched and analysed as two numbers, never one', () => {
    seed(report())
    render(<ReportScreen onOpenExport={() => {}} />)
    expect(screen.getByText(/875 sites matched/)).toBeTruthy()
    expect(screen.getByText(/873 analysed/)).toBeTruthy()
  })

  it('never claims a bare query-site count', () => {
    seed(report())
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).not.toMatch(/query sites found/)
  })

  it('names the file the per-file cap truncated, and how much it kept', () => {
    seed(report())
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/test_epic_task_sections\.py/)
    expect(container.textContent).toMatch(/42 query sites/)
    expect(container.textContent).toMatch(/40 highest-priority/)
  })

  it('cites the file and line that declared each engine', () => {
    seed(report())
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/tcms\/settings\/common\.py/)
    expect(container.textContent).toMatch(/django\.db\.backends\.mysql/)
    expect(container.textContent).toMatch(/docker-compose\.yml/)
  })

  it('says so plainly when the repository declares no data store', () => {
    seed(report({ engineProfile: { declared: [], primary: 'unknown', ambiguous: false } }))
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/No data store is declared/)
  })

  it('reports what was filtered and why, when anything was', () => {
    seed(report({ stats: { ...BASE_STATS, sitesFiltered: { belowConfidence: 185, lowPriority: 512 } } }))
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/697 matched sites were filtered/)
    expect(container.textContent).toMatch(/185 below the confidence floor/)
    expect(container.textContent).toMatch(/512 below the per-file priority cap/)
  })

  it('renders nothing at all when there is nothing to disclose', () => {
    seed(report({
      stats: { ...BASE_STATS, sitesFiltered: { belowConfidence: 0, lowPriority: 0 }, truncatedFiles: [] },
      engineProfile: undefined,
    }))
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).not.toMatch(/Coverage and engine detection/)
  })
})

describe('the suppressed-findings panel', () => {
  const suppression = {
    reason: 'no-op' as const,
    detail: 'The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.',
  }
  const held = finding({ title: 'Use exists() instead of count()', severity: 'info', suppression })

  it('shows the count, the title, the location and the reason', () => {
    seed(report({ suppressed: [held] }))
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/1 finding held/)
    expect(container.textContent).toMatch(/Use exists\(\) instead of count\(\)/)
    expect(container.textContent).toMatch(/tcms\/core\/views\.py/)
    expect(container.textContent).toMatch(/nothing to apply/)
  })

  it('pluralises honestly', () => {
    seed(report({ suppressed: [held, { ...held, id: 's2' }] }))
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/2 findings held/)
  })

  it('is absent when the gate suppressed nothing', () => {
    seed(report())
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).not.toMatch(/held/)
  })

  it('shows a Suppressed tile alongside the published findings', () => {
    seed(report({ findings: [finding()], suppressed: [held] }))
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/Suppressed/)
    expect(container.textContent).toMatch(/Batch the per-section count/)
  })

  it('states an empty report as a good outcome, not an absence', () => {
    seed(report())
    const { container } = render(<ReportScreen onOpenExport={() => {}} />)
    expect(container.textContent).toMatch(/good outcome, not an empty one/)
  })
})

describe('the cost gate', () => {
  const pending = (usd: number | null) => ({
    candidates: 339,
    passes: 2,
    cachedPasses: 0,
    // The store attaches the resolver that the buttons call.
    resolve: () => {},
    cost: {
      promptTokens: 95_000, completionTokens: 5_734, totalTokens: 100_734,
      usd, free: false, pricesVerifiedOn: '2026-05-01',
    },
  })

  it('names the model it has no price for, so the message is actionable', () => {
    useApp.setState({
      pendingEstimate: pending(null),
      settings: { ...useApp.getState().settings, model: 'claude-sonnet-4-5-20250929' },
    })
    const { container } = render(<CostGate />)
    expect(container.textContent).toMatch(/no list price for/)
    expect(container.textContent).toMatch(/claude-sonnet-4-5-20250929/)
    expect(container.textContent).toMatch(/worse than none/)
  })

  it('never shows a figure without saying how old the price is', () => {
    useApp.setState({ pendingEstimate: pending(0.37) })
    const { container } = render(<CostGate />)
    expect(container.textContent).toMatch(/\$0\.37/)
    expect(container.textContent).toMatch(/last checked on 2026-05-01/)
  })

  it('describes the real shape of the work, not a chunk count', () => {
    // When the two-stage analysis landed, the gate still quoted a chunk count
    // the two-stage path never uses — "35 passes" for a scan that ran 15 triage
    // passes and a number of write-ups nobody could know in advance.
    useApp.setState({
      pendingEstimate: {
        ...pending(0.42),
        stages: {
          triage: { passes: 15, samples: 2, calls: 30 },
          author: { projectedRequests: 30, assumption: 'assumes about 10% of sites are flagged, 3 per request — the real number is not knowable until triage runs' },
        },
      } as never,
    })
    const { container } = render(<CostGate />)
    expect(container.textContent).toMatch(/30 triage calls across 15 passes × 2 samples/)
    expect(container.textContent).toMatch(/about 30 write-ups/)
    expect(container.textContent).toMatch(/not knowable until triage runs/)
  })

  it('labels the output side as a projection', () => {
    useApp.setState({ pendingEstimate: pending(0.37) })
    const { container } = render(<CostGate />)
    expect(container.textContent).toMatch(/output is projected/)
  })
})
