import { describe, expect, it } from 'vitest'
import { ormVerificationRecipe, readOrmShape } from '../analyze/orm-shape'
import { checkEquivalence } from '../analyze/equivalence'
import { checkPerformance } from '../analyze/performance'
import type { EnclosingScope } from '../detect/scope'

/**
 * Fix 4 — an ORM shape reader for equivalence and counted facts.
 *
 * R3: all thirteen findings printed "Not machine-checkable", and the
 * performance block offered `EXPLAIN ANALYZE` against JavaScript string
 * concatenation. Django, Rails, Hibernate, Prisma, SQLAlchemy, GORM, EF Core,
 * Sequelize and TypeORM all landed in the dead branch — the majority of real
 * application data access.
 */

const inLoop: EnclosingScope = {
  loopDepth: 1, loopHeaders: ['for sec in sections:'],
  symbol: 'StreamReportView.get', symbolLine: 870, opensLoop: false, trigger: 'request-handler',
}
const notInLoop: EnclosingScope = {
  loopDepth: 0, loopHeaders: [], symbol: 'StreamReportView.get', symbolLine: 870, opensLoop: false, trigger: 'request-handler',
}

describe('Fix 4A — readOrmShape per dialect', () => {
  it('django: counts calls, terminals and a projection', () => {
    const shape = readOrmShape('TestCase.objects.filter(section=sec).values("id", "name").count()')
    expect(shape).not.toBeNull()
    expect(shape!.dialect).toBe('django')
    expect(shape!.queryCount).toBeGreaterThanOrEqual(1)
    expect(shape!.terminals).toContain('count')
    expect(shape!.projection).toEqual(['id', 'name'])
  })

  it('django: reads a slice as a limit', () => {
    expect(readOrmShape('Product.objects.filter(active=True)[:10]')!.limit).toBe(10)
  })

  it('django: recognises __in as a batched predicate', () => {
    expect(readOrmShape('TestCase.objects.filter(section__in=secs).count()')!.batched).toBe(true)
    expect(readOrmShape('TestCase.objects.filter(section=sec).count()')!.batched).toBe(false)
  })

  it('django: reads eager loading', () => {
    const shape = readOrmShape('Product.objects.select_related("owner").prefetch_related("tags").all()')!
    expect(shape.eagerLoads).toContain('select_related')
    expect(shape.eagerLoads).toContain('prefetch_related')
  })

  it('activerecord', () => {
    const shape = readOrmShape('TestCase.where(section: sec).count')!
    expect(shape.dialect).toBe('activerecord')
    expect(shape.terminals).toContain('count')
  })

  it('sqlalchemy', () => {
    const shape = readOrmShape('session.query(Product).filter(Product.id == pid).first()')!
    expect(shape.dialect).toBe('sqlalchemy')
    expect(shape.terminals).toContain('first')
  })

  it('prisma', () => {
    const shape = readOrmShape('await prisma.user.findUnique({ where: { id: o.userId }, take: 5 })')!
    expect(shape.dialect).toBe('prisma')
    expect(shape.limit).toBe(5)
  })

  it('sequelize', () => {
    const shape = readOrmShape('await Order.findAll({ where: { userId: u.id }, limit: 20 })')!
    expect(shape.dialect).toBe('sequelize')
    expect(shape.limit).toBe(20)
  })

  it('typeorm', () => {
    const shape = readOrmShape('await repo.createQueryBuilder("o").where("o.id = :id").getMany()')!
    expect(shape.dialect).toBe('typeorm')
    expect(shape.terminals).toContain('getMany')
  })

  it('gorm', () => {
    const shape = readOrmShape('db.Where("id = ?", id).First(&o)')!
    expect(shape.dialect).toBe('gorm')
    expect(shape.terminals).toContain('First')
  })

  it('hibernate', () => {
    const shape = readOrmShape('em.createQuery("SELECT o FROM Order o WHERE o.id = :id").getResultList()')!
    expect(shape.dialect).toBe('hibernate')
    expect(shape.terminals).toContain('getResultList')
  })

  it('efcore', () => {
    const shape = readOrmShape('await ctx.Orders.Include(o => o.User).Where(o => o.Id == id).ToListAsync()')!
    expect(shape.dialect).toBe('efcore')
    expect(shape.eagerLoads.length).toBeGreaterThan(0)
  })

  it('returns null for code that is not data access at all', () => {
    // The `casePicker.js` case: URL string assembly, reported as a DB finding.
    const js = "if (sectionId) { url += sep + 'section=' + sectionId; sep = '&'; }"
    expect(readOrmShape(js)).toBeNull()
    expect(readOrmShape('const total = items.reduce((a, b) => a + b, 0)')).toBeNull()
    expect(readOrmShape('')).toBeNull()
  })

  it('marks a query inside a loop as per-iteration', () => {
    expect(readOrmShape('TestCase.objects.filter(section=sec).count()', inLoop)!.perIteration).toBe(true)
    expect(readOrmShape('TestCase.objects.filter(section=sec).count()', notInLoop)!.perIteration).toBe(false)
  })
})

describe('Fix 4B — counted[] works without SQL', () => {
  it('counts the loop query becoming one batched query', () => {
    const check = checkPerformance({
      engine: 'mysql',
      category: 'n-plus-one',
      original: 'for sec in sections:\n    sc_total = TestCase.objects.filter(section=sec).count()',
      proposed: 'counts = TestCase.objects.filter(section__in=sections).values("section").annotate(n=Count("id"))',
      scope: inLoop,
    })
    expect(check.counted.length).toBeGreaterThan(0)
    expect(check.counted.join(' ')).toMatch(/out of the loop|database call/)
    // The honesty framing survives intact: still a count, never a timing.
    expect(check.counted.join(' ')).toMatch(/Counted from the code, not measured|Counted, not measured/)
    expect(check.counted.join(' ')).not.toMatch(/\d+x|faster|ms\b|%/)
  })

  it('names the loop trip count as unmeasured — it is the whole multiplier', () => {
    const check = checkPerformance({
      engine: 'mysql', category: 'n-plus-one',
      original: 'TestCase.objects.filter(section=sec).count()',
      proposed: 'TestCase.objects.filter(section__in=secs).count()',
      scope: inLoop,
    })
    expect(check.unmeasured.join(' ')).toMatch(/how many iterations/i)
  })

  it('counts a projection narrowing on ORM code', () => {
    const check = checkPerformance({
      engine: 'mysql', category: 'over-fetch',
      original: 'products = Product.objects.filter(active=True).all()',
      proposed: 'products = Product.objects.filter(active=True).values("id", "name")',
    })
    expect(check.counted.join(' ')).toMatch(/named column/)
  })

  it('counts eager loading being added', () => {
    const check = checkPerformance({
      engine: 'postgres', category: 'n-plus-one',
      original: 'orders = Order.objects.filter(user=u).all()',
      proposed: 'orders = Order.objects.select_related("user").filter(user=u).all()',
    })
    expect(check.counted.join(' ')).toMatch(/eager loading/)
  })
})

describe('Fix 4D — no EXPLAIN pointed at things that are not SQL', () => {
  it('offers a query counter for Django, not EXPLAIN ANALYZE', () => {
    const check = checkPerformance({
      engine: 'mysql', category: 'n-plus-one',
      original: 'TestCase.objects.filter(section=sec).count()',
      proposed: 'TestCase.objects.filter(section__in=secs).count()',
      scope: inLoop,
    })
    const commands = check.verification.map((v) => v.command).join('\n')
    expect(commands).not.toMatch(/EXPLAIN/i)
    expect(commands).toMatch(/CaptureQueriesContext|django-debug-toolbar/)
  })

  it('offers the right instrument for each stack', () => {
    expect(ormVerificationRecipe('activerecord')).toMatch(/assert_queries|ActiveRecord::Base\.logger/)
    expect(ormVerificationRecipe('prisma')).toMatch(/log: \['query'\]/)
    expect(ormVerificationRecipe('hibernate')).toMatch(/show-sql|getQueryExecutionCount/)
    expect(ormVerificationRecipe('gorm')).toMatch(/db\.Debug\(\)/)
    expect(ormVerificationRecipe('efcore')).toMatch(/LogTo/)
    expect(ormVerificationRecipe('sqlalchemy')).toMatch(/echo=True|before_cursor_execute/)
  })

  it('refuses to guess a command when it cannot identify the stack', () => {
    expect(ormVerificationRecipe(undefined)).toMatch(/will not\n# guess|will not guess/)
  })

  it('still uses EXPLAIN for real SQL', () => {
    const check = checkPerformance({
      engine: 'postgres', category: 'full-scan',
      original: 'SELECT * FROM users WHERE email = $1',
      proposed: 'SELECT id, email FROM users WHERE email = $1',
    })
    expect(check.verification.map((v) => v.command).join('\n')).toMatch(/EXPLAIN/i)
  })
})

describe('Fix 4C — equivalence decides what it can on ORM code', () => {
  it('no longer says "not machine-checkable" for a Django rewrite', () => {
    const check = checkEquivalence(
      'Product.objects.filter(active=True).values("id", "name")',
      'Product.objects.filter(active=True).values("id", "name").order_by("name")',
    )
    expect(check.status).not.toBe('unverifiable')
    expect(check.verified.length).toBeGreaterThan(0)
  })

  it('contradicts a changed field list', () => {
    const check = checkEquivalence(
      'Product.objects.filter(active=True).values("id", "name")',
      'Product.objects.filter(active=True).values("id")',
    )
    expect(check.status).toBe('contradicted')
    expect(check.deltas[0]!.severity).toBe('hard')
  })

  it('contradicts a changed terminal operation', () => {
    const check = checkEquivalence(
      'Product.objects.filter(active=True).count()',
      'Product.objects.filter(active=True).exists()',
    )
    expect(check.status).toBe('contradicted')
  })

  it('flags an added ordering as needing judgement, not as verified', () => {
    const check = checkEquivalence(
      'Product.objects.filter(active=True).all()',
      'Product.objects.filter(active=True).order_by("name").all()',
    )
    expect(check.status).toBe('partially-verified')
    expect(check.deltas.some((d) => d.property === 'order-by')).toBe(true)
  })

  it('confirms duplicate handling when distinct is unchanged', () => {
    const check = checkEquivalence(
      'Product.objects.filter(a=1).values("id")',
      'Product.objects.filter(a=1).values("id")',
    )
    expect(check.verified.join(' ')).toMatch(/duplicate handling is unchanged/i)
  })

  it('never claims a predicate change is verified', () => {
    const check = checkEquivalence(
      'Product.objects.filter(active=True).values("id")',
      'Product.objects.filter(active=True, deleted=False).values("id")',
    )
    expect(check.status).not.toBe('machine-verified')
    expect(check.undecided.join(' ')).toMatch(/solver, not a parser/)
  })

  it('the N+1 → batch rewrite is partially verified, with the guard named', () => {
    const check = checkEquivalence(
      'TestCase.objects.filter(section=sec).count()',
      'TestCase.objects.filter(section__in=sections).values("section").annotate(n=Count("id"))',
      inLoop,
    )
    expect(check.status).toBe('partially-verified')
    expect(check.verified.join(' ')).toMatch(/union of the per-row results/)
    expect(check.undecided.join(' ')).toMatch(/guard condition/)
  })

  it('still says "not machine-checkable" when it genuinely is not', () => {
    const check = checkEquivalence(
      "url += sep + 'section=' + sectionId",
      "url += sep + 'section=' + encodeURIComponent(sectionId)",
    )
    expect(check.status).toBe('unverifiable')
  })
})

describe('a lazy queryset is not a database call', () => {
  /*
   * From the first scan with a real model. It published one finding, and that
   * finding's `counted` fact was false:
   *
   *   "Issues 2 database call(s) where the original issues 4."
   *
   * The four constructs were `Product.objects.filter(pk=x)` assignments to form
   * fields. In Django those are lazy — they build a queryset object and issue no
   * SQL. The true figure on both sides is zero. A `counted` fact is the one
   * thing in this product that is supposed to be a fact.
   */
  const original = [
    'form.fields["product"].queryset = Product.objects.filter(pk=stream_id)',
    'if auto_build_id:',
    '    form.fields["build"].queryset = Build.objects.filter(pk=auto_build_id)',
    '    form.fields["product"].queryset = Product.objects.filter(pk=stream_id)',
    '    form.fields["build"].queryset = Build.objects.filter(pk=auto_build_id)',
  ].join('\n')

  it('counts zero round trips for four lazy assignments', () => {
    const shape = readOrmShape(original)!
    expect(shape.queryCount).toBe(0)
    expect(shape.builderCount).toBeGreaterThan(0)
  })

  it('produces no counted fact for deduplicating lazy querysets', () => {
    const proposed = [
      'product_qs = Product.objects.filter(pk=stream_id)',
      'build_qs = Build.objects.filter(pk=auto_build_id)',
      'form.fields["product"].queryset = product_qs',
      'form.fields["build"].queryset = build_qs',
    ].join('\n')
    const check = checkPerformance({
      engine: 'mysql', category: 'round-trip', original, proposed,
    })
    expect(check.counted.join(' ')).not.toMatch(/database call/)
  })

  it('still counts a terminal as a round trip', () => {
    expect(readOrmShape('TestCase.objects.filter(section=sec).count()')!.queryCount).toBe(1)
    expect(readOrmShape('Product.objects.filter(pk=1).exists()')!.queryCount).toBe(1)
    expect(readOrmShape('Product.objects.get(pk=1)')!.queryCount).toBe(1)
  })

  it('counts iterating a queryset as a round trip', () => {
    expect(readOrmShape('for sec in Section.objects.filter(product=p):')!.queryCount).toBe(1)
    expect(readOrmShape('rows = list(Product.objects.filter(active=True))')!.queryCount).toBe(1)
  })

  it('counts a write as a round trip', () => {
    expect(readOrmShape('Product.objects.filter(pk=1).update(name="x")')!.queryCount).toBe(1)
    // A bare `case.save()` names no dialect, so the reader declines to guess —
    // which is the right answer, not a miss. It needs one identifying construct.
    expect(readOrmShape('case.save()')).toBeNull()
    expect(readOrmShape('case = TestCase.objects.get(pk=1)\ncase.save()')!.queryCount).toBe(2)
  })

  it('still sees the loop N+1 it is meant to see', () => {
    const loopScope = { loopDepth: 1, loopHeaders: ['for sec in sections:'], symbol: 'V.get', symbolLine: 1, opensLoop: false, trigger: 'request-handler' as const }
    const a = readOrmShape('for sec in sections:\n    TestCase.objects.filter(section=sec).count()', loopScope)!
    const b = readOrmShape('TestCase.objects.filter(section__in=sections).values("section").annotate(n=Count("id"))', loopScope)!
    expect(a.queryCount).toBeGreaterThan(b.queryCount)
    expect(a.perIteration).toBe(true)
    expect(b.perIteration).toBe(false)
  })

  it('an eager dialect still counts its call on the spot', () => {
    // Prisma is not lazy: findMany() issues the query.
    expect(readOrmShape('const u = await prisma.user.findMany({ where: { id } })')!.queryCount).toBe(1)
    expect(readOrmShape('const o = await Order.findAll({ where: { userId } })')!.queryCount).toBe(1)
  })
})

describe('shapes the round-trip count cannot see', () => {
  /*
   * On a real two-stage scan, 10 of 31 findings carried no counted fact, and
   * three rewrite shapes accounted for most of them. Each is structural and
   * decidable from the two versions — the standard a counted fact has to meet —
   * and leaving them uncounted pushed genuine findings down to `low`, because
   * the severity derivation rests on having counted something.
   *
   * All three originals are verbatim from that scan.
   */
  it('counts count() becoming exists()', () => {
    const check = checkPerformance({
      engine: 'mysql', category: 'unbounded-result',
      original: 'get_user_model().objects.filter(is_superuser=True).count()',
      proposed: 'get_user_model().objects.filter(is_superuser=True).exists()',
    })
    expect(check.counted.join(' ')).toMatch(/Stops at the first matching row/)
  })

  it('counts an ordered fetch becoming an aggregate', () => {
    const check = checkPerformance({
      engine: 'mysql', category: 'full-scan',
      original: 'TestExecution.objects.filter(run__plan__product=stream).order_by("-stop_date").values("stop_date").first()',
      proposed: 'TestExecution.objects.filter(run__plan__product=stream).aggregate(last_stop=Max("stop_date"))',
    })
    expect(check.counted.join(' ')).toMatch(/single Max aggregate/)
    expect(check.counted.join(' ')).toMatch(/no longer has to order the rows/)
  })

  it('counts a queryset materialised once instead of re-evaluated', () => {
    const check = checkPerformance({
      engine: 'mysql', category: 'over-fetch',
      original: 'for field in TestCaseFieldConfig.objects.filter(is_active=True).order_by("order"):\n    use(field)',
      proposed: 'field_configs = list(TestCaseFieldConfig.objects.filter(is_active=True).order_by("order"))',
    })
    expect(check.counted.join(' ')).toMatch(/Evaluates the queryset once and reuses the result/)
  })

  it('does not invent a fact when the rewrite adds a redundant predicate', () => {
    // Also verbatim: `pk__isnull=False` on a primary key changes nothing, and
    // nothing structural should be claimed for it.
    const check = checkPerformance({
      engine: 'mysql', category: 'full-scan',
      original: 'candidates = user_model.objects.filter(first_name="", last_name="").order_by("pk")',
      proposed: 'candidates = user_model.objects.filter(first_name="", last_name="", pk__isnull=False).order_by("pk")',
    })
    expect(check.counted).toHaveLength(0)
  })

  it('reads aggregates and materialisation off the shape', () => {
    const shape = readOrmShape('TestExecution.objects.filter(a=1).aggregate(last=Max("stop_date"))')!
    expect(shape.aggregates).toContain('Max')
    expect(readOrmShape('rows = list(Product.objects.filter(a=1))')!.materialised).toBe(true)
    expect(readOrmShape('rows = Product.objects.filter(a=1)')!.materialised).toBe(false)
  })
})
