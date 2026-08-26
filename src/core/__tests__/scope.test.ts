import { describe, expect, it } from 'vitest'
import { analyseScope, classifyTrigger } from '../detect/scope'

/**
 * Fix 2 — loop and enclosing-scope awareness.
 *
 * Before this, a query at module scope and a query inside a triple-nested loop
 * were handed to the model as the same shape of evidence, with six lines of
 * context. A `for` nine lines above was invisible, so the `n-plus-one` category
 * was unreachable except by luck.
 */

const at = (src: string, line: number, path = 'app/views.py') =>
  analyseScope(path, src.split('\n'), line)

describe('Fix 2 — indentation languages', () => {
  const python = [
    'class StreamReportView(View):',            // 1
    '    def get(self, request, stream):',      // 2
    '        section_data = []',                // 3
    '        for sec in Section.objects.all():',// 4
    '            sc_total = TestCase.objects.filter(section=sec).count()', // 5
    '            for case in sec.cases.all():', // 6
    '                total = case.runs.count()',// 7
    '        return section_data',              // 8
  ].join('\n')

  it('reads loop depth 0, 1 and 2 in Python', () => {
    expect(at(python, 3).loopDepth).toBe(0)
    expect(at(python, 5).loopDepth).toBe(1)
    expect(at(python, 7).loopDepth).toBe(2)
  })

  it('names the enclosing symbol, class first', () => {
    const scope = at(python, 5)
    expect(scope.symbol).toBe('StreamReportView.get')
    expect(scope.symbolLine).toBe(2)
  })

  it('records the loop header verbatim, nearest first', () => {
    const scope = at(python, 7)
    expect(scope.loopHeaders[0]).toBe('for case in sec.cases.all():')
    expect(scope.loopHeaders[1]).toBe('for sec in Section.objects.all():')
  })

  it('does not treat a `for` inside a string literal as a loop', () => {
    const src = [
      'def build(request):',
      '    sql = "for update of rows"',
      '    return Product.objects.filter(active=True).count()',
    ].join('\n')
    expect(at(src, 3).loopDepth).toBe(0)
  })

  it('does not treat a `for` inside a comment as a loop', () => {
    const src = [
      'def build(request):',
      '    # for sec in sections:  (removed, was too slow)',
      '    return Product.objects.filter(active=True).count()',
    ].join('\n')
    expect(at(src, 3).loopDepth).toBe(0)
  })

  it('reads a Ruby `.each do` block as a loop', () => {
    const src = [
      'class ReportsController < ApplicationController',
      '  def index',
      '    Section.all.each do |sec|',
      '      counts << TestCase.where(section: sec).count',
      '    end',
      '  end',
      'end',
    ].join('\n')
    const scope = at(src, 4, 'app/controllers/reports_controller.rb')
    expect(scope.loopDepth).toBe(1)
    expect(scope.trigger).toBe('request-handler')
  })
})

describe('Fix 2 — brace languages', () => {
  it('reads loop depth in TypeScript', () => {
    const src = [
      'export async function loadOrders(req: Request) {',   // 1
      '  const orders = await prisma.order.findMany({})',   // 2
      '  for (const o of orders) {',                        // 3
      '    const user = await prisma.user.findUnique({ where: { id: o.userId } })', // 4
      '  }',                                               // 5
      '}',                                                 // 6
    ].join('\n')
    expect(at(src, 2, 'src/api/orders.ts').loopDepth).toBe(0)
    expect(at(src, 4, 'src/api/orders.ts').loopDepth).toBe(1)
  })

  it('reads a Java for loop and its enclosing method', () => {
    const src = [
      'public class OrderService {',                       // 1
      '  public List<Dto> load(List<Long> ids) {',         // 2
      '    for (Long id : ids) {',                         // 3
      '      Order o = repository.findById(id);',          // 4
      '    }',                                             // 5
      '  }',                                               // 6
      '}',                                                 // 7
    ].join('\n')
    const scope = at(src, 4, 'src/main/java/OrderService.java')
    expect(scope.loopDepth).toBe(1)
    expect(scope.symbol).toContain('load')
  })

  it('reads a Go range loop', () => {
    const src = [
      'func (s *Service) Load(ids []int64) error {',
      '\tfor _, id := range ids {',
      '\t\tvar o Order',
      '\t\tdb.Where("id = ?", id).First(&o)',
      '\t}',
      '\treturn nil',
      '}',
    ].join('\n')
    expect(at(src, 4, 'internal/service.go').loopDepth).toBe(1)
  })

  it('reads a .forEach callback as a loop', () => {
    const src = [
      'function sync(sections) {',
      '  sections.forEach((sec) => {',
      '    db.query("SELECT count(*) FROM cases WHERE section = $1", [sec.id])',
      '  })',
      '}',
    ].join('\n')
    expect(at(src, 3, 'src/sync.js').loopDepth).toBe(1)
  })
})

describe('Fix 2 — trigger classification', () => {
  it('calls a migration a migration, whatever the symbol says', () => {
    expect(classifyTrigger('tcms/core/migrations/0001_squashed.py', 'forwards', '')).toBe('migration')
    expect(classifyTrigger('db/migrate/20240101_add_index.rb', 'up', '')).toBe('migration')
    expect(classifyTrigger('app/seeds/products.py', 'run', '')).toBe('migration')
  })

  it('calls a test a test', () => {
    expect(classifyTrigger('tests/test_views.py', 'test_get', '')).toBe('test')
    expect(classifyTrigger('src/api/orders.spec.ts', 'it', '')).toBe('test')
    expect(classifyTrigger('src/main/java/OrderServiceTest.java', 'load', '')).toBe('test')
  })

  it('recognises a request handler by symbol or decorator', () => {
    expect(classifyTrigger('app/views.py', 'StreamReportView.get', '')).toBe('request-handler')
    expect(classifyTrigger('app/api.py', 'list_products', '@app.route("/products")')).toBe('request-handler')
    expect(classifyTrigger('Controller.java', 'load', '@GetMapping("/x")')).toBe('request-handler')
  })

  it('recognises a background job by path', () => {
    expect(classifyTrigger('app/tasks/nightly.py', 'run', '')).toBe('job')
    expect(classifyTrigger('app/consumers/events.py', 'handle', '')).toBe('job')
  })

  it('says unknown rather than guessing', () => {
    expect(classifyTrigger('app/utils.py', 'helper', '')).toBe('unknown')
  })

  it('a migration path outranks a handler-shaped symbol', () => {
    // Path is a fact; a symbol suffix is a naming convention.
    expect(classifyTrigger('app/migrations/0002_x.py', 'ProductView', '')).toBe('migration')
  })
})

describe('Fix 2 — regression fixtures from the reproduction', () => {
  // R1/R3: tcms/core/views.py:878 — `.count()` inside `for sec in …`, in a view.
  const viewsPy = [
    ...Array.from({ length: 869 }, (_, i) => `# line ${i + 1}`),
    'class StreamReportView(View):',                                   // 870
    '    def get(self, request, stream):',                             // 871
    '        section_data = []',                                       // 872
    '        product = Product.objects.get(pk=stream)',                // 873
    '        # ...',                                                   // 874
    '        # ...',                                                   // 875
    '        # ...',                                                   // 876
    '        for sec in Section.objects.filter(product=stream):',      // 877
    '            sc_total = TestCase.objects.filter(section=sec).count()', // 878
    '            if not sc_total:',                                    // 879
    '                continue',                                        // 880
  ].join('\n')

  it('views.py:878 is inside one loop, in a request handler', () => {
    const scope = at(viewsPy, 878, 'tcms/core/views.py')
    expect(scope.loopDepth).toBe(1)
    expect(scope.symbol).toBe('StreamReportView.get')
    expect(scope.trigger).toBe('request-handler')
  })

  it('a loop in a migration is still labelled a migration', () => {
    const src = [
      'def forwards(apps, schema_editor):',
      '    Section = apps.get_model("core", "Section")',
      '    for sec in Section.objects.all():',
      '        sec.slug = slugify(sec.name)',
      '        sec.save()',
    ].join('\n')
    const scope = at(src, 5, 'tcms/core/migrations/0001_squashed.py')
    expect(scope.loopDepth).toBe(1)
    expect(scope.trigger).toBe('migration')
  })
})

describe('Ruby blocks that have already closed do not enclose anything', () => {
  // Found on Discourse: `lib/topic_view.rb` put an already-batched
  // `Group.where(id: ids).pluck(...)` at loop depth 1 — and therefore at the top
  // of the priority list — because the `@posts.each do … end` above it had
  // ended four lines earlier and the Ruby fallback never counted the `end`.
  const topicView = [
    '  def group_names',                                                          // 1
    '    primary_group_ids = Set.new',                                            // 2
    '    @posts.each do |p|',                                                     // 3
    '      primary_group_ids << p.user.primary_group_id if p.user.try(:primary_group_id)', // 4
    '    end',                                                                    // 5
    '',                                                                           // 6
    '    result = {}',                                                            // 7
    '    unless primary_group_ids.empty?',                                        // 8
    '      Group.where(id: primary_group_ids.to_a).pluck(:id, :name)',            // 9
    '    end',                                                                    // 10
    '  end',                                                                      // 11
  ].join('\n')

  it('the query after the block is not in a loop', () => {
    expect(at(topicView, 9, 'lib/topic_view.rb').loopDepth).toBe(0)
  })

  it('the query inside the block still is', () => {
    expect(at(topicView, 4, 'lib/topic_view.rb').loopDepth).toBe(1)
  })

  it('a genuine per-item query in a controller is still found', () => {
    // Verbatim shape from discourse app/controllers/groups_controller.rb.
    const controller = [
      '  def set_notifications',
      '    tags.each do |tag_id, data|',
      '      tag_users = []',
      '      existing_users = TagUser.where(tag_id:, user_id: user_ids)',
      '      skip_user_ids = existing_users.pluck(:user_id)',
      '    end',
      '  end',
    ].join('\n')
    const scope = at(controller, 4, 'app/controllers/groups_controller.rb')
    expect(scope.loopDepth).toBe(1)
    expect(scope.trigger).toBe('request-handler')
  })
})

describe('opening a loop is not the same as being inside one', () => {
  // A finding whose cited span starts at the `for` has nothing enclosing it, so
  // loopDepth is 0 — while the code plainly runs per iteration. Reporting only
  // the enclosing count produced a finding headed "not in a loop" whose counted
  // fact read "moves the query out of the loop". Both true; together, confusing.
  const src = [
    'def build(request, runs):',
    '    for run in runs:',
    '        plan = TestPlan.objects.get(pk=run.plan_id)',
  ].join('\n')

  it('the `for` line itself reports opensLoop, not loopDepth', () => {
    const atFor = at(src, 2)
    expect(atFor.loopDepth).toBe(0)
    expect(atFor.opensLoop).toBe(true)
  })

  it('the line inside reports loopDepth, not opensLoop', () => {
    const inside = at(src, 3)
    expect(inside.loopDepth).toBe(1)
    expect(inside.opensLoop).toBe(false)
  })

  it('describeScope says which, so the two never read as contradictory', async () => {
    const { describeScope } = await import('@/core/detect/scope')
    expect(describeScope(at(src, 2))).toMatch(/opens a loop, so its body runs per iteration/)
    expect(describeScope(at(src, 3))).toMatch(/inside 1 loop/)
    expect(describeScope(at(src, 1))).toMatch(/not in a loop/)
  })
})
