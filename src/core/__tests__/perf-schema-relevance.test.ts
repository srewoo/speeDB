import { describe, expect, it } from 'vitest'
import { checkPerformance } from '../analyze/performance'
import { buildSchemaFacts, checkProposedIndex, findRedundantIndexes } from '../analyze/schema-facts'
import { findRelevantFiles, sampleRelevantFile } from '../detect/relevance'
import { ENGINES } from '@/config/engines'
import { explainFor } from '@/config/explain'

/* ------------------------------------------------------- performance ------ */

describe('checkPerformance — the speed claim is never asserted', () => {
  const base = { engine: 'postgres', category: 'over-fetch', original: 'SELECT * FROM t', proposed: 'SELECT id FROM t' }

  it('always reports that nothing was measured', () => {
    const r = checkPerformance(base)
    expect(r.status).toMatch(/unmeasured|questionable/)
    expect(r.unmeasured.join(' ')).toMatch(/does not execute anything/)
  })

  it('counts what is structurally derivable, and labels it as counted not timed', () => {
    const r = checkPerformance(base)
    expect(r.counted.join(' ')).toMatch(/named columns instead of every column/)
    expect(r.counted.join(' ')).toMatch(/not measured/i)
  })

  it('counts an added row cap', () => {
    const r = checkPerformance({ ...base, original: 'SELECT a FROM t', proposed: 'SELECT a FROM t LIMIT 1' })
    expect(r.counted.join(' ')).toMatch(/Caps the result at 1 row/)
  })

  it('marks a purely data-dependent suggestion as questionable', () => {
    // No structural gain at all: the benefit lives entirely in statistics.
    const r = checkPerformance({
      engine: 'postgres', category: 'missing-index',
      original: 'SELECT a FROM t WHERE b = $1',
      proposed: 'SELECT a FROM t WHERE b = $1',
      requiredMigration: 'CREATE INDEX ix ON t (b)',
    })
    expect(r.status).toBe('questionable')
    expect(r.unmeasured.join(' ')).toMatch(/selectivity/)
    expect(r.unmeasured.join(' ')).toMatch(/already exists in production/)
    expect(r.unmeasured.join(' ')).toMatch(/write cost/)
  })

  it('hands over runnable EXPLAIN for both sides of the change', () => {
    const r = checkPerformance(base)
    const commands = r.verification.map((v) => v.command).join('\n')
    expect(commands).toContain('EXPLAIN (ANALYZE, BUFFERS, VERBOSE)')
    expect(commands).toContain('SELECT * FROM t')
    expect(commands).toContain('SELECT id FROM t')
  })

  it('includes the statistics queries that reveal what source code cannot', () => {
    const r = checkPerformance(base)
    const stats = r.verification.find((v) => v.label.includes('cannot see'))!
    expect(stats.command).toMatch(/pg_stats|pg_class|pg_indexes/)
  })

  it('puts recall first for a vector engine, ahead of latency', () => {
    const r = checkPerformance({
      engine: 'pgvector', category: 'other',
      original: 'SELECT id FROM d ORDER BY e <-> $1 LIMIT 10',
      proposed: 'SELECT id FROM d ORDER BY e <-> $1 LIMIT 10',
    })
    expect(r.unmeasured.join(' ')).toMatch(/Recall/)
    expect(r.lookFor[0]).toMatch(/RECALL FIRST/)
  })

  it('gives a non-SQL engine a usable recipe rather than a SQL one', () => {
    const r = checkPerformance({
      engine: 'mongodb', category: 'over-fetch',
      original: "db.users.find({ a: 1 })", proposed: "db.users.find({ a: 1 }, { _id: 1 })",
    })
    expect(r.verification[0]!.command).toContain("explain('executionStats')")
  })
})

describe('every engine has a verification recipe', () => {
  // Breadth was previously prompt prose. This makes it testable behaviour.
  it.each(ENGINES.map((e) => [e.id, e.family] as const))('%s', (id, family) => {
    const recipe = explainFor(id, family)
    expect(recipe.lookFor.length).toBeGreaterThan(0)
    expect(recipe.plan.length + (recipe.measure?.length ?? 0)).toBeGreaterThan(0)
  })
})

/* ---------------------------------------------------------- schema facts -- */

const DDL = `
CREATE TABLE "policy" (
  "id" int4 NOT NULL,
  "tenant_id" int8 NOT NULL,
  "hierarchy_type" varchar(50),
  "status" varchar(20),
  PRIMARY KEY ("id")
);
CREATE INDEX hierarchy_index ON "policy" USING btree (tenant_id, hierarchy_type, status);
CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id);
CREATE UNIQUE INDEX uk_policy_name ON "policy" (hierarchy_type);
`

describe('schema facts', () => {
  const facts = buildSchemaFacts([{ path: 'db/init.sql', content: DDL }])

  it('reads tables, columns and indexes from DDL', () => {
    expect(facts.tables.get('policy')!.columns.has('tenant_id')).toBe(true)
    expect(facts.indexes.map((i) => i.name)).toContain('hierarchy_index')
    expect(facts.indexes.find((i) => i.name === 'hierarchy_index')!.columns)
      .toEqual(['tenant_id', 'hierarchy_type', 'status'])
  })

  it('states what cannot be known from source at all', () => {
    expect(facts.unknowable.join(' ')).toMatch(/Row counts/)
    expect(facts.unknowable.join(' ')).toMatch(/exist in production/)
  })

  it('finds an index made redundant by a longer one with the same prefix', () => {
    const redundant = findRedundantIndexes(facts)
    expect(redundant.map((r) => r.index.name)).toContain('tenant_id_key')
    expect(redundant.find((r) => r.index.name === 'tenant_id_key')!.coveredBy.name)
      .toBe('hierarchy_index')
  })

  it('never calls a unique index merely redundant — it carries a constraint', () => {
    expect(findRedundantIndexes(facts).map((r) => r.index.name)).not.toContain('uk_policy_name')
  })

  it('reports an exact duplicate of a declared index as a duplicate', () => {
    // tenant_id_key is already exactly this index.
    const advice = checkProposedIndex('CREATE INDEX ix_new ON policy (tenant_id)', facts)!
    expect(advice.duplicateOf?.name).toBe('tenant_id_key')
    expect(advice.notes[0]).toMatch(/already declares an identical index/)
  })

  it('rejects a proposal that an existing index already covers by leading columns', () => {
    // (tenant_id, hierarchy_type) is a prefix of hierarchy_index, so the
    // existing index already serves these lookups. This is the single most
    // common piece of wrong index advice.
    const advice = checkProposedIndex(
      'CREATE INDEX ix_new ON policy (tenant_id, hierarchy_type)', facts,
    )!
    expect(advice.duplicateOf).toBeUndefined()
    expect(advice.coveredBy?.name).toBe('hierarchy_index')
    expect(advice.notes[0]).toMatch(/already leads with these columns/)
  })

  it('spots a proposal that duplicates a declared index exactly', () => {
    const advice = checkProposedIndex('CREATE INDEX whatever ON policy (tenant_id, hierarchy_type, status)', facts)!
    expect(advice.duplicateOf?.name).toBe('hierarchy_index')
  })

  it('allows a genuinely new index', () => {
    const advice = checkProposedIndex('CREATE INDEX ix ON policy (status, tenant_id)', facts)!
    expect(advice.coveredBy).toBeUndefined()
    expect(advice.duplicateOf).toBeUndefined()
  })

  it('flags a column the declared table does not have', () => {
    const advice = checkProposedIndex('CREATE INDEX ix ON policy (does_not_exist)', facts)!
    expect(advice.unknownColumns).toEqual(['does_not_exist'])
  })

  it('reads Prisma models and their index attributes', () => {
    const f = buildSchemaFacts([{ path: 'prisma/schema.prisma', content: `
model User {
  id        Int    @id
  tenantId  Int
  email     String
  @@index([tenantId, email])
}` }])
    expect(f.tables.get('user')!.columns.has('tenantId')).toBe(true)
    expect(f.indexes[0]!.columns).toEqual(['tenantid', 'email'])
  })

  it('reads Rails and Alembic migration DSLs', () => {
    const f = buildSchemaFacts([
      { path: 'db/migrate/001_x.rb', content: 'add_index :users, [:tenant_id, :created_at], unique: true' },
      { path: 'alembic/versions/002.py', content: "op.create_index('ix_o', 'orders', ['customer_id'])" },
    ])
    expect(f.indexes.find((i) => i.table === 'users')!.columns).toEqual(['tenant_id', 'created_at'])
    expect(f.indexes.find((i) => i.table === 'orders')!.columns).toEqual(['customer_id'])
  })
})

/* ------------------------------------------------------------- relevance -- */

describe('relevance tier — code a regex will never match', () => {
  const CASES: [string, string, string][] = [
    ['JPA criteria', 'src/UserRepo.java',
      'CriteriaBuilder cb = em.getCriteriaBuilder();\nCriteriaQuery<User> q = cb.createQuery(User.class);\nRoot<User> root = q.from(User.class);'],
    ['JPA entity with fetch strategy', 'src/User.java',
      '@Entity\npublic class User {\n  @OneToMany(fetch = FetchType.EAGER)\n  private List<Order> orders;\n}'],
    ['Spring Data repository', 'src/OrderRepo.java',
      'public interface OrderRepo extends JpaRepository<Order, Long> { List<Order> findByTenantId(Long id); }'],
    ['Django model', 'app/models.py',
      'from django.db import models\nclass Order(models.Model):\n    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)'],
    ['Django manager', 'app/managers.py',
      'class OrderQuerySet(models.QuerySet):\n    def active(self):\n        return self.filter(Q(state="open"))'],
    ['ActiveRecord scopes', 'app/models/order.rb',
      'class Order < ApplicationRecord\n  belongs_to :customer\n  scope :recent, -> { order(created_at: :desc) }\nend'],
    ['TypeORM entity', 'src/order.entity.ts',
      '@Entity()\nexport class Order {\n  @ManyToOne(() => Customer)\n  customer: Customer\n}'],
    ['Prisma across modules', 'src/queries.ts',
      "import { PrismaClient } from '@prisma/client'\nexport const activeWhere: Prisma.OrderWhereInput = { state: 'open' }"],
    ['GORM preload', 'internal/store.go',
      'type Order struct { gorm.Model }\nfunc load(db *gorm.DB) { db.Preload("Items").Find(&orders) }'],
    ['EF Core context', 'Data/AppContext.cs',
      'public class AppContext : DbContext { public DbSet<Order> Orders { get; set; } }'],
  ]

  it.each(CASES)('flags %s', (_name, path, content) => {
    const found = findRelevantFiles([{ path, content }], new Set())
    expect(found).toHaveLength(1)
    expect(found[0]!.reasons.length).toBeGreaterThan(0)
  })

  it('skips files that already produced a span-level candidate', () => {
    const [, path, content] = CASES[0]!
    expect(findRelevantFiles([{ path, content }], new Set([path]))).toHaveLength(0)
  })

  it('ignores ordinary code with no data-access signal', () => {
    expect(findRelevantFiles([
      { path: 'src/math.ts', content: 'export const add = (a: number, b: number) => a + b' },
      { path: 'src/Button.tsx', content: 'export const Button = () => <button />' },
    ], new Set())).toHaveLength(0)
  })

  it('samples the query-bearing regions rather than the first N lines', () => {
    const content = [
      ...Array.from({ length: 60 }, (_, i) => `// filler ${i}`),
      '@OneToMany(fetch = FetchType.EAGER)',
      'private List<Order> orders;',
      ...Array.from({ length: 60 }, (_, i) => `// more filler ${i}`),
    ].join('\n')

    const file = findRelevantFiles([{ path: 'src/User.java', content: `@Entity\n${content}` }], new Set())[0]!
    const sample = sampleRelevantFile(file, `@Entity\n${content}`)!

    expect(sample.excerpt).toContain('FetchType.EAGER')
    expect(sample.excerpt).toContain('omitted')       // elision is marked, not silent
    expect(sample.excerpt).not.toContain('filler 30')
    expect(sample.detector).toMatch(/^relevance/)
  })
})
