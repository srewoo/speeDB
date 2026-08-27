import { describe, expect, it } from 'vitest'
import { applyValueGate, judgeSemanticNoOp, severityCeiling, summariseGate } from '../analyze/gate'
import { groundFindings } from '../analyze/ground'
import { checkPerformance } from '../analyze/performance'
import type { Finding, Severity } from '../types'
import type { EnclosingScope } from '../detect/scope'
import replay from '../../../bench/fixtures/mt-test-studio-2026-08-26.json'

/**
 * Fix 5 — a value gate before publication.
 *
 * Nothing between parseFindings() and the report rejected a worthless finding.
 * Thirteen shipped: 3 no-ops, 1 that issued more queries than the original, 2 on
 * code that touches no data store, 5 in install-time migrations, and 1 resting
 * on an assumption the file itself contradicts.
 */

let seq = 0

function finding(over: Partial<Finding> & {
  file?: string
  startLine?: number
  endLine?: number
  original?: string
  proposed?: string
  assumptions?: string[]
}): Finding {
  const file = over.file ?? 'app/views.py'
  return {
    id: `t${++seq}`,
    kind: over.kind ?? 'equivalent',
    title: over.title ?? 'A finding',
    summary: over.summary ?? 'A problem.',
    severity: over.severity ?? 'medium',
    category: over.category ?? 'round-trip',
    engine: 'mysql',
    accessStyle: 'orm',
    original: over.original ?? 'Product.objects.filter(pk=pk).first()',
    primaryOccurrence: {
      file,
      startLine: over.startLine ?? 1,
      endLine: over.endLine ?? 1,
      excerpt: over.original ?? '',
    },
    otherOccurrences: [],
    suggestion: {
      proposed: over.proposed ?? 'Product.objects.filter(pk__in=pks).first()',
      rationale: '',
      equivalenceArgument: '',
      assumptions: over.assumptions ?? [],
      expectedImpact: '',
    },
    evidence: [],
    scope: over.scope,
    grounding: over.grounding ?? 'verified',
    groundingNotes: [],
    modelConfidence: 0.8,
    performance: over.performance,
    triageSupport: over.triageSupport,
  }
}

/** A PerformanceCheck shaped for the severity and speculation rules. */
function perf(counted: string[], status: 'unmeasured' | 'questionable' = 'unmeasured') {
  return {
    status, counted, unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
  } as Finding['performance']
}

const files = (content: string, path = 'app/views.py') => new Map([[path, content]])

const handlerScope: EnclosingScope = {
  loopDepth: 1, loopHeaders: ['for sec in sections:'],
  symbol: 'ReportView.get', symbolLine: 1, opensLoop: false, trigger: 'request-handler',
}
const migrationScope: EnclosingScope = {
  loopDepth: 1, loopHeaders: ['for row in rows:'],
  symbol: 'forwards', symbolLine: 1, opensLoop: false, trigger: 'migration',
}

describe('Fix 5 — one fixture per suppression reason', () => {
  it('no-op: a proposal identical to the original after collapsing whitespace', () => {
    const gate = applyValueGate([finding({
      original: 'Product.objects.filter(pk=pk).first()',
      proposed: 'Product.objects.filter(pk=pk).first()   ',
    })], { files: files('x') })

    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('no-op')
    expect(gate.suppressed[0]!.suppression!.detail).toMatch(/nothing to apply/)
  })

  it('wrong-direction: the proposal issues no fewer queries', () => {
    const gate = applyValueGate([finding({
      category: 'round-trip',
      original: 'product = Product.objects.filter(pk=stream).first()',
      proposed: "pid = Product.objects.filter(pk=stream).values_list('id').first()\nproduct = Product.objects.filter(pk=pid).first()",
    })], { files: files('x') })

    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('wrong-direction')
    expect(gate.suppressed[0]!.suppression!.detail).toMatch(/Counted from the code, not measured/)
  })

  it('not-data-access: neither side is a query or ORM code', () => {
    const gate = applyValueGate([finding({
      original: "if (sectionId) { url += sep + 'section=' + sectionId; sep = '&'; }",
      proposed: "const parts = []\nif (sectionId) parts.push(`section=${sectionId}`)",
      file: 'static/js/casePicker.js',
    })], { files: files('x', 'static/js/casePicker.js') })

    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('not-data-access')
  })

  it('cold-path: a performance claim in a migration', () => {
    const gate = applyValueGate([finding({
      scope: migrationScope,
      severity: 'high',
      category: 'full-scan',
      file: 'app/migrations/0001_squashed.py',
      original: "TestCase.objects.filter(summary__contains='legacy')",
      proposed: "TestCase.objects.filter(summary__startswith='legacy')",
    })], { files: files('x', 'app/migrations/0001_squashed.py') })

    expect(gate.published).toHaveLength(0)
    const held = gate.suppressed[0]!
    expect(held.suppression!.reason).toBe('cold-path')
    // Downgraded to a note, not dropped: the change may still be a tidy-up.
    expect(held.severity).toBe('info')
  })

  it('unsupported-assumption: the file contradicts the stated assumption', () => {
    const source = [
      'def get(self, request, stream):',                  // 1
      '    product = Product.objects.filter(pk=stream).first()', // 2
      '    rows = []',                                    // 3
      '    return _export_filename(rows, product)',       // 4
    ].join('\n')

    const gate = applyValueGate([finding({
      startLine: 2, endLine: 2,
      assumptions: ['product is not used later in the view'],
      original: 'product = Product.objects.filter(pk=stream).first()',
      proposed: 'product = Product.objects.filter(pk=stream).values("id").first()',
      category: 'over-fetch',
    })], { files: files(source) })

    expect(gate.published).toHaveLength(0)
    const held = gate.suppressed[0]!
    expect(held.suppression!.reason).toBe('unsupported-assumption')
    // The contradiction is cited, not merely asserted.
    expect(held.suppression!.detail).toMatch(/app\/views\.py:4/)
    expect(held.suppression!.detail).toMatch(/_export_filename/)
  })

  it('publishes a finding that passes every rule', () => {
    const gate = applyValueGate([finding({
      scope: handlerScope,
      category: 'n-plus-one',
      original: 'for sec in sections:\n    TestCase.objects.filter(section=sec).count()',
      proposed: 'TestCase.objects.filter(section__in=sections).values("section").annotate(n=Count("id"))',
      performance: { status: 'unmeasured', counted: ['Issues 1 database call where the original issues 2.'], unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '' },
    })], { files: files('x') })

    expect(gate.suppressed).toHaveLength(0)
    expect(gate.published).toHaveLength(1)
  })

  it('does not suppress a correctness fix in a migration', () => {
    // Cold-path only applies to a pure performance claim. A behavioural finding
    // in a migration is a bug in code that will run once — still worth knowing.
    const gate = applyValueGate([finding({
      kind: 'behavioural',
      scope: migrationScope,
      category: 'implicit-cast',
      file: 'app/migrations/0002_fix.py',
      original: "TestCase.objects.filter(summary__contains='legacy')",
      proposed: "TestCase.objects.filter(summary__iexact='legacy')",
    })], { files: files('x', 'app/migrations/0002_fix.py') })

    expect(gate.published).toHaveLength(1)
  })
})

describe('Fix 5 — severity derived from evidence, in both directions', () => {
  const withCounted = (counted: string[]): Finding['performance'] => ({
    status: 'unmeasured', counted, unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
  })

  it('caps a migration finding at info, whatever the model said', () => {
    const f = finding({ severity: 'critical', category: 'full-scan', performance: withCounted(['x']) })
    expect(severityCeiling(f, migrationScope)).toBe('info')
  })

  it('caps a test finding at info', () => {
    const f = finding({ severity: 'high', performance: withCounted(['x']) })
    expect(severityCeiling(f, { ...migrationScope, trigger: 'test' })).toBe('info')
  })

  it('allows high for an N+1 that really is in a loop', () => {
    const f = finding({ category: 'n-plus-one', performance: withCounted(['x']) })
    expect(severityCeiling(f, handlerScope)).toBe('high')
  })

  it('caps an N+1 that is not in a loop at low', () => {
    const f = finding({ category: 'n-plus-one', performance: withCounted(['x']) })
    expect(severityCeiling(f, { ...handlerScope, loopDepth: 0, loopHeaders: [] })).toBe('low')
  })

  it('rates a per-iteration query on a request path at least medium', () => {
    // With no counted fact this used to be `low`. A query inside a loop on a
    // request path is not `low` just because the structural reader had nothing
    // to say about the rewrite — the loop is the finding.
    const f = finding({ category: 'over-fetch', performance: withCounted([]) })
    expect(severityCeiling(f, handlerScope)).toBe('medium')
  })

  it('caps at low when nothing was counted AND there is no loop', () => {
    const flat = { ...handlerScope, loopDepth: 0, loopHeaders: [] }
    const f = finding({ category: 'over-fetch', performance: withCounted([]) })
    expect(severityCeiling(f, flat)).toBe('low')
  })

  it('overrides an inflated model severity and says why', () => {
    const gate = applyValueGate([finding({
      severity: 'critical',
      category: 'over-fetch',
      scope: { ...handlerScope, loopDepth: 0, loopHeaders: [] },
      original: 'Product.objects.filter(active=True).all()',
      proposed: 'Product.objects.filter(active=True).values("id")',
      performance: withCounted([]),
    })], { files: files('x') })

    expect(gate.published[0]!.severity).toBe('low')
    expect(gate.published[0]!.modelSeverity).toBe('critical')
    expect(gate.published[0]!.groundingNotes.join(' ')).toMatch(/Severity is low, not the critical the model proposed/)
  })

  it('RAISES a severity the model set too low — the inversion this fixes', () => {
    /*
     * The old contract was "the model may rate lower than the ceiling, never
     * higher", and it produced the measured failure: across 27 findings in three
     * real runs, none came out above `low`, because the model rated almost
     * everything `low` and a ceiling can only agree. The evidence here is
     * stronger than the guess — two loops deep, request path, counted facts —
     * and the evidence now wins.
     */
    const gate = applyValueGate([finding({
      severity: 'info',
      category: 'n-plus-one',
      scope: { ...handlerScope, loopDepth: 2 },
      original: 'for sec in sections:\n    TestCase.objects.filter(section=sec).count()',
      proposed: 'TestCase.objects.filter(section__in=sections).annotate(n=Count("id"))',
      performance: withCounted(['x', 'y']),
    })], { files: files('x') })

    expect(gate.published[0]!.severity).toBe('high')
    // The guess is kept beside the answer, not overwritten silently.
    expect(gate.published[0]!.modelSeverity).toBe('info')
    expect(gate.published[0]!.groundingNotes.join(' ')).toMatch(/not the info the model proposed/)
  })

  it('caps an unverified citation at low and marks the summary', () => {
    const gate = applyValueGate([finding({
      severity: 'high',
      category: 'n-plus-one',
      grounding: 'needs-verification',
      scope: handlerScope,
      original: 'for sec in sections:\n    TestCase.objects.filter(section=sec).count()',
      proposed: 'TestCase.objects.filter(section__in=sections).annotate(n=Count("id"))',
      performance: withCounted(['x']),
    })], { files: files('x') })

    expect(gate.published[0]!.severity).toBe('low')
    expect(gate.published[0]!.summary).toMatch(/^\[Unverified citation\]/)
  })
})

describe('Fix 5 — the empty report is a good outcome', () => {
  it('says so in words', () => {
    const text = summariseGate({ published: [], suppressed: [], counts: {
      'no-op': 0, 'wrong-direction': 0, 'not-data-access': 0, 'cold-path': 0,
      'unsupported-assumption': 0, 'immaterial': 0, 'invented-symbol': 0,
      'unsupported-speculation': 0,
    } }, 1115, 924)
    expect(text).toMatch(/No findings/)
    expect(text).toMatch(/1,115/)
    expect(text).toMatch(/good outcome, not an empty one/)
  })

  it('names what it suppressed rather than hiding the count', () => {
    const gate = applyValueGate([
      finding({ original: 'a', proposed: 'a' }),
      finding({ original: 'b', proposed: 'b' }),
    ], { files: files('x') })
    const text = summariseGate(gate, 10, 5)
    expect(text).toMatch(/0 finding\(s\) published, 2 suppressed/)
    expect(text).toMatch(/2 no-op \(proposal identical to the original\)/)
  })
})

/**
 * The regression test for the entire document.
 *
 * The 13 findings as published on 2026-08-26, replayed through grounding and
 * the gate. Exactly one — the tag-sync batching finding — should survive.
 */
describe('Fix 5 — replay of the 2026-08-26 mt-test-studio report', () => {
  const sources = new Map<string, string>(
    Object.entries(replay.files as Record<string, string[]>).map(([p, lines]) => [p, lines.join('\n')]),
  )

  const raw: Finding[] = (replay.findings as Record<string, unknown>[]).map((r) => ({
    id: String(r.title),
    kind: r.kind as Finding['kind'],
    title: String(r.title),
    summary: String(r.summary),
    severity: r.severity as Severity,
    category: r.category as Finding['category'],
    engine: 'mysql',
    accessStyle: 'orm',
    original: String(r.original),
    primaryOccurrence: {
      file: String(r.file),
      startLine: Number(r.startLine),
      endLine: Number(r.endLine),
      excerpt: String(r.original),
    },
    otherOccurrences: [],
    suggestion: {
      proposed: String(r.proposed),
      rationale: '',
      equivalenceArgument: 'Same rows, same columns, same ordering, same NULL and duplicate handling.',
      assumptions: (r.assumptions as string[]) ?? [],
      expectedImpact: '',
    },
    evidence: [],
    grounding: 'needs-verification',
    groundingNotes: [],
    modelConfidence: 0.7,
  }))

  const { kept } = groundFindings(raw, { files: sources })
  const gate = applyValueGate(kept, { files: sources })

  it('publishes exactly one finding', () => {
    expect(gate.published).toHaveLength(1)
    expect(gate.published[0]!.title).toMatch(/Batch the tag lookups/)
  })

  it('suppresses the other twelve, each for the reason the audit gave', () => {
    expect(gate.suppressed).toHaveLength(12)
    const byTitle = new Map(gate.suppressed.map((f) => [f.title, f.suppression!.reason]))
    for (const r of replay.findings as Record<string, unknown>[]) {
      if (r._expect === 'published') continue
      expect(byTitle.get(String(r.title))).toBe(r._expect)
    }
  })

  it('matches the audit tally: 3 no-ops, 2 not data access, 5 cold-path, 1 wrong direction, 1 contradicted assumption', () => {
    expect(gate.counts).toEqual({
      'no-op': 3,
      'wrong-direction': 1,
      'not-data-access': 2,
      'cold-path': 5,
      'unsupported-assumption': 1,
      // Zero, and that is the assertion. This corpus predates sampled triage,
      // so none of its findings carry `triageSupport` — and the speculation
      // rule requires it. A gate rule that fired on findings it has no
      // agreement data for would be guessing, which is the thing it exists to
      // suppress.
      'unsupported-speculation': 0,
      // The materiality rule adds nothing here: the one published finding is a
      // batching fix, not a column narrowing.
      'immaterial': 0,
      // And the vocabulary check abstains: this fixture carries four files, far
      // too few to tell an invented name from a merely absent one.
      'invented-symbol': 0,
    })
  })

  it('rates the one real finding on its evidence, not on the model\'s guess', () => {
    // The original report claimed 0 critical and 0 high across 13 findings —
    // which was itself the problem: the one actionable finding was a per-request
    // N+1 and it shipped as `medium`. Evidence rates it, and the model's guess is
    // preserved for comparison.
    const [f] = gate.published
    expect(f!.severity).toBe('high')
    expect(f!.modelSeverity).toBe('medium')
    expect(f!.groundingNotes.join(' ')).toMatch(/runs once per iteration of an enclosing loop, on a request path/)
  })

  it('holds nothing back silently — every suppression carries its reason', () => {
    for (const f of gate.suppressed) {
      expect(f.suppression?.reason).toBeTruthy()
      expect(f.suppression?.detail.length).toBeGreaterThan(20)
    }
  })
})

describe('Phase 4 — materiality', () => {
  /*
   * Precision against a truth file of major defects sat at 17%. The unmatched
   * findings were mostly true and tiny: "fetch two columns instead of the whole
   * row" on a query that runs once. Nineteen of those bury the two that matter.
   */
  type Over = Partial<Finding> & { original?: string; proposed?: string }
  const narrowing = (over: Over = {}) => finding({
    category: 'over-fetch',
    original: 'products = Product.objects.filter(active=True).all()',
    proposed: 'products = Product.objects.filter(active=True).values("id", "name")',
    performance: {
      status: 'unmeasured',
      counted: ['Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)'],
      unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
    },
    scope: { loopDepth: 0, loopHeaders: [], symbol: 'f', symbolLine: 1, opensLoop: false, trigger: 'request-handler' },
    ...over,
  })

  it('holds back a column narrowing on a query that runs once', () => {
    const gate = applyValueGate([narrowing()], { files: files('x') })
    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('immaterial')
    // Held back as a note, not deleted.
    expect(gate.suppressed[0]!.severity).toBe('info')
    expect(gate.suppressed[0]!.suppression!.detail).toMatch(/real saving and a small one/)
  })

  it('publishes the same narrowing when it happens per iteration', () => {
    // Per row, a narrower column list is not a rounding error.
    const gate = applyValueGate([narrowing({
      scope: { loopDepth: 1, loopHeaders: ['for p in ps:'], symbol: 'f', symbolLine: 1, opensLoop: false, trigger: 'request-handler' },
    })], { files: files('x') })
    expect(gate.published).toHaveLength(1)
  })

  it('publishes anything with substantive evidence behind it', () => {
    for (const fact of [
      'Moves the query out of the loop: one call for the whole set instead of one per iteration.',
      'Issues 1 database call(s) where the original issues 4.',
      'Caps the result at 50 row(s), where the original was unbounded.',
      'Adds eager loading (select_related), so related rows arrive with the parent query.',
    ]) {
      const gate = applyValueGate([narrowing({
        performance: {
          status: 'unmeasured', counted: [fact],
          unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
        },
      })], { files: files('x') })
      expect(gate.published, fact).toHaveLength(1)
    }
  })

  it('publishes an index finding regardless — the cost is paid on every write', () => {
    const gate = applyValueGate([narrowing({
      category: 'redundant-index',
      original: 'CREATE INDEX tenant_id_key ON policy (tenant_id)',
      proposed: 'DROP INDEX IF EXISTS tenant_id_key',
    })], { files: files('x') })
    expect(gate.published).toHaveLength(1)
  })

  it('leaves a finding with nothing counted to the other rules', () => {
    // No counted facts means materiality has no evidence to weigh; that case
    // belongs to the severity derivation, not here.
    const gate = applyValueGate([narrowing({
      performance: { status: 'unmeasured', counted: [], unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '' },
    })], { files: files('x') })
    expect(gate.suppressed.filter((f) => f.suppression?.reason === 'immaterial')).toHaveLength(0)
  })

  it('mechanical failures still take precedence over materiality', () => {
    // A no-op that is also immaterial is reported as a no-op: the more specific
    // and more damning reason wins.
    const gate = applyValueGate([narrowing({
      original: 'x = Product.objects.values("id")',
      proposed: 'x = Product.objects.values("id")',
    })], { files: files('x') })
    expect(gate.suppressed[0]!.suppression!.reason).toBe('no-op')
  })
})

describe('a finding that proposes nothing', () => {
  it('is suppressed, not published', () => {
    // The no-op rule compared `original` to `proposed` only when `proposed` was
    // non-empty, so an empty suggestion skipped the rule entirely. One did on a
    // real scan: a `missing-index` finding whose whole suggestion was "".
    const gate = applyValueGate([finding({
      category: 'missing-index',
      original: 'if TestPlan.objects.filter(global_id=gid).exists():',
      proposed: '',
    })], { files: files('x') })

    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('no-op')
    expect(gate.suppressed[0]!.suppression!.detail).toMatch(/proposes no change at all/)
  })

  it('whitespace is not a proposal either', () => {
    const gate = applyValueGate([finding({ proposed: '   \n\t  ' })], { files: files('x') })
    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('no-op')
  })
})

describe('a proposal that cannot run', () => {
  /*
   * From an independent audit of a real run. Two published findings would have
   * raised AttributeError: one accessed `new_run.execution_model`, an attribute
   * that appears nowhere in the repository. The gate had six rules and none of
   * them looked at whether the code was viable.
   *
   * The repository is its own vocabulary, and that is what makes the check safe:
   * every ORM method and model field a real rewrite needs already appears in the
   * surrounding source, because the existing code uses it.
   */
  const repo = (extra: Record<string, string> = {}) => {
    const files = new Map<string, string>()
    // A vocabulary large enough for the check to engage — below its threshold it
    // abstains, because on a handful of files everything looks invented.
    for (let i = 0; i < 40; i++) {
      // Padded past the vocabulary threshold — below it the check abstains, and
      // an abstaining check would make this test pass for the wrong reason.
      files.set(`app/mod${i}.py`, `def helper${i}(x):\n    return TestCase.objects.filter(pk=x).first()\n${'# padding padding padding padding padding\n'.repeat(30)}`)
    }
    for (const [k, v] of Object.entries(extra)) files.set(k, v)
    return files
  }

  it('suppresses a proposal that invents an attribute', () => {
    const gate = applyValueGate([finding({
      category: 'n-plus-one',
      original: 'for exe in executions:\n    new_run.create_execution(case=exe.case)',
      proposed: 'objs = [type(new_run.execution_model)(run=new_run, case=exe.case) for exe in executions]',
    })], { files: repo() })

    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('invented-symbol')
    expect(gate.suppressed[0]!.suppression!.detail).toMatch(/execution_model/)
    expect(gate.suppressed[0]!.suppression!.detail).toMatch(/would fail at runtime/)
  })

  it('publishes a proposal whose names the repository does contain', () => {
    const gate = applyValueGate([finding({
      category: 'n-plus-one',
      original: 'for pk in pks:\n    TestCase.objects.filter(pk=pk).first()',
      proposed: 'rows = TestCase.objects.filter(pk__in=pks)\nfor row in rows:\n    use(row)',
      scope: { loopDepth: 1, loopHeaders: ['for pk in pks:'], symbol: 'f', symbolLine: 1, opensLoop: false, trigger: 'request-handler' },
      performance: {
        status: 'unmeasured',
        counted: ['Moves the query out of the loop: one call for the whole set instead of one per iteration.'],
        unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
      },
    })], { files: repo() })

    expect(gate.published).toHaveLength(1)
  })

  it('does not flag framework methods the existing code happens not to use', () => {
    // A rewrite may reach for a standard ORM method the repository never called.
    const gate = applyValueGate([finding({
      category: 'over-fetch',
      original: 'rows = TestCase.objects.filter(a=1)',
      proposed: 'rows = TestCase.objects.filter(a=1).only("id").iterator()',
      scope: { loopDepth: 1, loopHeaders: ['for x in y:'], symbol: 'f', symbolLine: 1, opensLoop: false, trigger: 'request-handler' },
      performance: {
        status: 'unmeasured',
        counted: ['Moves the query out of the loop: one call for the whole set instead of one per iteration.'],
        unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
      },
    })], { files: repo() })
    expect(gate.published).toHaveLength(1)
  })

  it('abstains when the fetched tree is too small to be a vocabulary', () => {
    // Against a few files almost every legitimate name looks invented. Guessing
    // there would reject good rewrites on small repositories.
    const gate = applyValueGate([finding({
      category: 'n-plus-one',
      original: 'for x in xs:\n    Thing.objects.filter(pk=x).first()',
      proposed: 'rows = Thing.objects.filter(pk__in=xs).some_invented_helper()',
      scope: { loopDepth: 1, loopHeaders: ['for x in xs:'], symbol: 'f', symbolLine: 1, opensLoop: false, trigger: 'request-handler' },
      performance: {
        status: 'unmeasured',
        counted: ['Moves the query out of the loop: one call for the whole set instead of one per iteration.'],
        unmeasured: [], verification: [], lookFor: [], confirms: [], refutes: [], summary: '',
      },
    })], { files: files('x') })
    expect(gate.suppressed.filter((f) => f.suppression?.reason === 'invented-symbol')).toHaveLength(0)
  })
})


describe('triage agreement is carried onto the finding and used', () => {
  /*
   * Sampled triage authors the *union* of what any sample flagged, which is
   * what keeps recall up — a site only has to be caught once. The cost is that
   * a site one sample flagged, and the other two read and called clean, reaches
   * authoring on identical footing to one every sample flagged. The model,
   * handed a site as a problem, will generally write it up.
   *
   * The count was already computed and was being thrown away. These tests pin
   * where it is allowed to matter, and — more importantly — where it is not.
   */

  it('does not rate down a weakly-supported site that counted a structural fact', () => {
    // The load-bearing case. Agreement is evidence about the *site*; a counted
    // fact is evidence about the *rewrite*, and the second is stronger. This is
    // exactly the finding two samples missed and one caught — the variance
    // sampling exists to cover. Demoting it would undo the recall the union
    // just bought, which would make sampling pointless.
    const gate = applyValueGate([finding({
      scope: handlerScope,
      triageSupport: { flagged: 1, samples: 3 },
      performance: perf(['Issues 1 database call where the original issues 400.']),
    })], { files: files('x') })

    expect(gate.published).toHaveLength(1)
    expect(gate.published[0]!.severity).toBe('high')
    expect(gate.published[0]!.groundingNotes.join(' ')).not.toMatch(/Rated down/)
  })

  it('rates down a weakly-supported site with nothing counted', () => {
    const gate = applyValueGate([finding({
      scope: handlerScope,
      triageSupport: { flagged: 1, samples: 3 },
      performance: perf([]),
    })], { files: files('x') })

    expect(gate.published).toHaveLength(1)
    // medium (per-iteration, request path, nothing counted) -> low.
    expect(gate.published[0]!.severity).toBe('low')
    expect(gate.published[0]!.groundingNotes.join(' ')).toMatch(/1 of 3 triage samples/)
  })

  it('leaves a well-supported site alone', () => {
    const gate = applyValueGate([finding({
      scope: handlerScope,
      triageSupport: { flagged: 3, samples: 3 },
      performance: perf([]),
    })], { files: files('x') })
    expect(gate.published[0]!.severity).toBe('medium')
  })

  it('does nothing at all when sampling is off', () => {
    // Fast mode runs one sample, so every site is 1-of-1 and the ratio is
    // meaningless. Firing here would silently demote every finding of every
    // scan run in Fast mode — the ratio needs at least three samples before
    // 1-of-N says anything.
    for (const support of [{ flagged: 1, samples: 1 }, { flagged: 1, samples: 2 }]) {
      const gate = applyValueGate([finding({
        scope: handlerScope, triageSupport: support, performance: perf([]),
      })], { files: files('x') })
      expect(gate.published[0]!.severity).toBe('medium')
    }
  })

  it('suppresses the case where all three signals are empty', () => {
    // Data-dependent category, nothing counted, and the other samples read the
    // same code and called it clean. Nothing here is checkable from source.
    const gate = applyValueGate([finding({
      category: 'missing-index',
      scope: handlerScope,
      triageSupport: { flagged: 1, samples: 3 },
      performance: perf([], 'questionable'),
    })], { files: files('x') })

    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed).toHaveLength(1)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('unsupported-speculation')
    // Held back with its reason, not dropped — a gate that silently eats a true
    // positive is worse than the padding it removes.
    expect(gate.suppressed[0]!.suppression!.detail).toMatch(/1 of 3 triage samples/)
  })

  it('publishes when any one of the three signals is present', () => {
    const base = {
      category: 'missing-index' as const,
      scope: handlerScope,
      triageSupport: { flagged: 1, samples: 3 },
      performance: perf([], 'questionable' as const),
    }
    // Each of these alone is an ordinary finding. Only all three at once is a
    // guess, which is why the rule requires the conjunction.
    const variants = [
      { ...base, triageSupport: { flagged: 3, samples: 3 } },      // agreed on
      { ...base, performance: perf(['Transfers 3 fewer columns.'], 'questionable') },
      { ...base, performance: perf([]) },                           // not data-dependent
    ]
    for (const v of variants) {
      const gate = applyValueGate([finding(v)], { files: files('x') })
      expect(gate.published).toHaveLength(1)
    }
  })
})


describe('invented-symbol and framework constants', () => {
  /*
   * Regression, found by running the benchmark against spring-petclinic rather
   * than by reasoning about the rule. All three findings that repository exists
   * to test — `FetchType.EAGER` -> `FetchType.LAZY` on Owner, Pet and Vet —
   * were suppressed as invented symbols. `FetchType` is imported in all three
   * entity files; `LAZY` appears in none, because it is an enum constant in
   * `jakarta.persistence`, a jar this tool never reads.
   *
   * The strings below are verbatim from that run.
   */
  const javaVocabulary = new Map(
    Array.from({ length: 30 }, (_, i) => [
      `src/main/java/Entity${i}.java`,
      'import jakarta.persistence.FetchType;\n'.repeat(20) +
      '@OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)\n'.repeat(40) +
      'private final List<Pet> pets = new ArrayList<>();\n'.repeat(40),
    ]),
  )

  it('does not call a constant on a known type invented', () => {
    const gate = applyValueGate([finding({
      file: 'src/main/java/Entity0.java',
      original: '@OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)',
      proposed: '@OneToMany(cascade = CascadeType.ALL, fetch = FetchType.LAZY)',
      performance: perf(['Fetches related rows only when accessed.']),
    })], { files: javaVocabulary })

    // Scoped to this rule. A bare JPA annotation is separately judged
    // `not-data-access`, which is a different question and has its own tests.
    expect(gate.suppressed.map((f) => f.suppression?.reason)).not.toContain('invented-symbol')
  })

  it('still catches a lowercase attribute that does not exist', () => {
    // The narrowness is the point. A lowercase member on a known receiver is an
    // attribute this tool *can* see in the source, so its absence still means
    // the rewrite would fail at runtime.
    const gate = applyValueGate([finding({
      file: 'src/main/java/Entity0.java',
      original: 'owner.getPets()',
      proposed: 'owner.getVaccinationSchedule()',
    })], { files: javaVocabulary })

    expect(gate.suppressed[0]?.suppression?.reason).toBe('invented-symbol')
  })

  it('still catches a constant on a receiver the repository does not know', () => {
    // An unknown receiver means the whole expression is invented, not just the
    // member — abstaining there would defeat the rule entirely.
    const gate = applyValueGate([finding({
      file: 'src/main/java/Entity0.java',
      original: 'FetchType.EAGER',
      proposed: 'MadeUpEnum.SOME_MODE',
    })], { files: javaVocabulary })

    expect(gate.suppressed[0]?.suppression?.reason).toBe('invented-symbol')
  })
})


describe('JPA fetch mode is data access', () => {
  /*
   * Second regression from the same spring-petclinic run. With the
   * invented-symbol false positive fixed, all three findings fell straight
   * through to `not-data-access` — because `readOrmShape` did not recognise a
   * JPA mapping annotation as data access at all.
   *
   * An association's fetch mode is not near the data access; it is the
   * declaration that decides whether reading a list of parents costs one query
   * or one per parent. Between them these two rules are why this repository
   * published zero findings in every run ever recorded for it, while the
   * corpus notes list `FetchType.LAZY` N+1 as the thing it exists to test.
   */
  const files = new Map(
    Array.from({ length: 30 }, (_, i) => [
      `src/main/java/E${i}.java`,
      'import jakarta.persistence.FetchType;\n'.repeat(20) +
      '@OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)\n'.repeat(40) +
      'private final List<Pet> pets = new ArrayList<>();\n'.repeat(40),
    ]),
  )

  const verbatim = {
    file: 'src/main/java/E0.java',
    original: '@OneToMany(cascade = CascadeType.ALL, fetch = FetchType.EAGER)\n\t@JoinColumn(name = "owner_id")',
    proposed: '@OneToMany(cascade = CascadeType.ALL, fetch = FetchType.LAZY)\n\t@JoinColumn(name = "owner_id")',
  }

  it('does not read 0-vs-0 calls as evidence of the wrong direction', () => {
    /*
     * Third layer of the same spring-petclinic failure, and the subtlest. With
     * the first two fixed, `wrong-direction` suppressed all three with
     * "issues 0 database calls where the original issues 0" — a sentence that
     * reads as a measurement and is an absence of one. A mapping declaration
     * contains no call by construction, so the comparison is guaranteed to fire
     * and can never be informative. The round-trip effect lives at the call
     * sites, not in the declaration.
     */
    const gate = applyValueGate(
      [finding({ ...verbatim, category: 'n-plus-one' })],
      { files },
    )
    expect(gate.suppressed.map((f) => f.suppression?.reason)).not.toContain('wrong-direction')
  })

  it('still catches a genuine wrong-direction claim', () => {
    // The narrowing must not disarm the rule where it has a real count.
    const pyFiles = new Map(
      Array.from({ length: 30 }, (_, i) => [
        `app/m${i}.py`,
        'Product.objects.filter(pk=pk).first()\n'.repeat(40) +
        'Review.objects.filter(product=pk).first()\n'.repeat(40),
      ]),
    )
    const gate = applyValueGate([finding({
      file: 'app/m0.py',
      category: 'n-plus-one',
      original: 'Product.objects.filter(pk=pk).first()',
      proposed: 'Product.objects.filter(pk=pk).first()\nReview.objects.filter(product=pk).first()',
    })], { files: pyFiles })
    expect(gate.suppressed[0]?.suppression?.reason).toBe('wrong-direction')
  })

  it('publishes a fetch-mode change instead of calling it not-data-access', () => {
    const gate = applyValueGate([finding({ ...verbatim, category: 'over-fetch' })], { files })
    expect(gate.suppressed.map((f) => f.suppression?.reason)).not.toContain('not-data-access')
    expect(gate.published).toHaveLength(1)
  })

  it('counts the change and names the round-trip risk it creates', () => {
    // The honest half. Eager -> lazy is the one rewrite here whose round-trip
    // effect can run the wrong way: if a caller iterates parents and touches
    // the collection, lazy turns one eager load into one query per parent —
    // the N+1 this tool exists to find, introduced by its own suggestion.
    const check = checkPerformance({
      engine: 'mysql',
      category: 'over-fetch',
      original: verbatim.original,
      proposed: verbatim.proposed,
    })
    expect(check.counted.join(' ')).toMatch(/no longer loaded with the parent/)
    expect(check.unmeasured.join(' ')).toMatch(/one query per parent/)
  })
})


describe('no-op with different text', () => {
  /*
   * From adjudicating mt-test-studio run-1: three of the four false positives
   * emitted byte-identical SQL, and the whitespace-collapse rule saw three
   * different strings. One of them was published at `high` with grounding
   * `verified`. Strings below are verbatim from that run.
   */

  it('knows .only() is inert before .exists()', () => {
    /*
     * `.only()` controls which columns are SELECTed when a model instance is
     * materialised. `.exists()` materialises nothing — it compiles to
     * `SELECT (1) AS a1 ... LIMIT 1` and never reads the deferred-field set.
     * The two statements are the same statement.
     */
    const v = judgeSemanticNoOp(
      'if (\n  old_run_gid\n  and TestRun.objects.filter(global_id=old_run_gid).exists()\n):',
      'if old_run_gid and TestRun.objects.filter(global_id=old_run_gid).only("pk").exists():',
    )
    expect(v?.reason).toBe('no-op')
  })

  it('sees through redundant parentheses, including nested ones', () => {
    // `get((Q(a) | Q(b)))` -> `get(Q(a) | Q(b))`. The inner group contains
    // parentheses of its own, which is why this needs a balanced scan and not
    // a character class.
    const v = judgeSemanticNoOp(
      'return User.objects.get((Q(email=value) | Q(username=value)))',
      'return User.objects.get(Q(email=value) | Q(username=value))',
    )
    expect(v?.reason).toBe('no-op')
  })

  it('does not fire on .only() before a call that DOES materialise', () => {
    // The boundary that keeps this honest. `.first()` returns an instance, so
    // the deferred-field set decides which columns are fetched — dropping
    // `.only()` there is a real change.
    expect(judgeSemanticNoOp('qs.only("pk").first()', 'qs.first()')).toBeNull()
  })

  it('does not fire on .values(), which changes what the queryset yields', () => {
    expect(judgeSemanticNoOp('qs.values("pk").exists()', 'qs.exists()')).toBeNull()
  })

  it('does not fire when the parentheses are grouping, not redundancy', () => {
    expect(judgeSemanticNoOp('if (a and b):', 'if (a or b):')).toBeNull()
    expect(judgeSemanticNoOp('User.objects.get(Q(a=1) | Q(b=2))', 'User.objects.get(Q(a=1), Q(b=2))')).toBeNull()
  })

  it('does not fire on a real rewrite', () => {
    expect(judgeSemanticNoOp(
      'Tag.objects.filter(name=n).first()',
      'Tag.objects.filter(name__in=names)',
    )).toBeNull()
  })

  it('suppresses through the full gate, not just the helper', () => {
    const files = new Map(
      Array.from({ length: 30 }, (_, i) => [
        `app/m${i}.py`,
        'TestRun.objects.filter(global_id=old_run_gid).exists()\n'.repeat(40) +
        'old_run_gid = request.POST.get("gid")\n'.repeat(40),
      ]),
    )
    const gate = applyValueGate([finding({
      file: 'app/m0.py',
      severity: 'high',
      category: 'missing-index',
      original: 'if (old_run_gid and TestRun.objects.filter(global_id=old_run_gid).exists()):',
      proposed: 'if old_run_gid and TestRun.objects.filter(global_id=old_run_gid).only("pk").exists():',
    })], { files })

    expect(gate.published).toHaveLength(0)
    expect(gate.suppressed[0]!.suppression!.reason).toBe('no-op')
  })
})
