import { describe, expect, it } from 'vitest'
import { detectInFile, detectInFileVerbose, MAX_CANDIDATES_PER_FILE } from '../detect/scan'
import { scorePriority } from '../detect/priority'
import { analyseScope } from '../detect/scope'

/**
 * Fix 1 — rank before you cap.
 *
 * The reproduction: `merged` was sorted by character offset and then sliced, so
 * the cap kept the first N query sites by line number. In a Django `views.py`
 * whose cheap queries sit at the top and whose expensive report view sits at
 * the bottom, that discarded exactly the half worth analysing.
 */

/** A file shaped like the reproduction: trivia first, the real N+1 at the end. */
function bigViewsFile(fillerCount: number): string {
  const lines: string[] = ['from .models import Section, TestCase, Product', '']
  lines.push('def trivial(request, pk):')
  lines.push('    return TestCase.objects.get(pk=pk)')
  lines.push('')

  for (let i = 0; i < fillerCount; i++) {
    lines.push(`def filler_${i}(request):`)
    lines.push(`    return Product.objects.filter(id=${i}).values("id")`)
    // Padding wide enough that the span merger cannot fold neighbouring
    // queries into one candidate — otherwise this fixture never reaches the cap
    // and would pass for the wrong reason.
    lines.push('    # ' + 'pad '.repeat(40))
    lines.push('    # ' + 'pad '.repeat(40))
    lines.push('')
  }

  lines.push('class StreamReportView(View):')
  lines.push('    def get(self, request, stream):')
  lines.push('        section_data = []')
  lines.push('        for sec in Section.objects.filter(product=stream).order_by("name"):')
  lines.push('            sc_total = TestCase.objects.filter(section=sec).count()')
  lines.push('            if not sc_total:')
  lines.push('                continue')
  return lines.join('\n')
}

describe('Fix 1 — priority ranking survives the per-file cap', () => {
  it('keeps the loop query at the bottom of a file that overflows the cap', () => {
    // Enough filler to push the cap well past the interesting site.
    const src = bigViewsFile(MAX_CANDIDATES_PER_FILE + 15)
    const total = src.split('\n').length

    const result = detectInFileVerbose('tcms/core/views.py', src)

    // The cap bit, and said so.
    expect(result.truncation).not.toBeNull()
    expect(result.truncation!.analysed).toBe(MAX_CANDIDATES_PER_FILE)
    expect(result.truncation!.found).toBeGreaterThan(MAX_CANDIDATES_PER_FILE)

    // The `.count()` inside the `for` is near the end of the file and survives.
    const loopSite = result.candidates.find((c) => c.startLine > total - 6)
    expect(loopSite).toBeDefined()
    expect(loopSite!.scope?.loopDepth).toBe(1)

    // And it ranks above the trivial `objects.get(pk=…)` at the top.
    expect(result.candidates[0]!.priority).toBeGreaterThanOrEqual(loopSite!.priority)
    const trivial = result.candidates.find((c) => c.startLine <= 4)
    if (trivial) expect(loopSite!.priority).toBeGreaterThan(trivial.priority)
  })

  it('ranks a migration site below an otherwise identical view site', () => {
    const code = [
      'from .models import Product',
      '',
      'def handler(request):',
      '    return Product.objects.filter(active=True).count()',
    ].join('\n')

    const view = detectInFile('app/views.py', code)[0]
    const migration = detectInFile('app/migrations/0001_initial.py', code)[0]

    expect(view).toBeDefined()
    expect(migration).toBeDefined()
    expect(migration!.priority).toBeLessThan(view!.priority)
    expect(migration!.priorityReasons.join(' ')).toMatch(/install time/)
  })

  it('ranks a test-file site below a production site', () => {
    const code = [
      'from .models import Product',
      '',
      'def check():',
      '    return Product.objects.filter(active=True).all()',
    ].join('\n')

    const prod = detectInFile('app/services.py', code)[0]!
    const test = detectInFile('app/tests/test_products.py', code)[0]!
    expect(test.priority).toBeLessThan(prod.priority)
  })

  it('filters on confidence BEFORE the cap, so no slot is spent on a reject', () => {
    // The old order sliced, mapped, then filtered: a below-floor span consumed
    // one of the slots and was then thrown away, wasting it entirely.
    const result = detectInFileVerbose('app/views.py', bigViewsFile(60))
    for (const c of result.candidates) expect(c.confidence).toBeGreaterThanOrEqual(0.7)
    expect(result.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_FILE)
  })

  it('scores a loop in a request handler above everything else', () => {
    const inLoop = scorePriority({
      path: 'app/views.py',
      excerpt: 'TestCase.objects.filter(section=sec).count()',
      enclosing: { loopDepth: 1, loopHeaders: ['for sec in sections:'], symbol: 'StreamReportView.get', symbolLine: 10, opensLoop: false, trigger: 'request-handler' },
      accessStyle: 'orm',
    })
    const atModuleScope = scorePriority({
      path: 'app/views.py',
      excerpt: 'TestCase.objects.filter(section=sec).count()',
      enclosing: { loopDepth: 0, loopHeaders: [], symbol: null, symbolLine: null, opensLoop: false, trigger: 'unknown' },
      accessStyle: 'orm',
    })
    expect(inLoop.score).toBeGreaterThan(atModuleScope.score)
    expect(inLoop.reasons.join(' ')).toMatch(/N\+1 signal/)
  })

  it('does not reward a query that already batches', () => {
    const scope = analyseScope('app/views.py', ['x = 1'], 1)
    const naive = scorePriority({
      path: 'app/views.py', enclosing: scope, accessStyle: 'orm',
      excerpt: 'Product.objects.filter(pk=pk).all()',
    })
    const batched = scorePriority({
      path: 'app/views.py', enclosing: scope, accessStyle: 'orm',
      excerpt: 'Product.objects.select_related("owner").filter(pk__in=pks).all()',
    })
    expect(batched.score).toBeLessThan(naive.score)
  })
})
