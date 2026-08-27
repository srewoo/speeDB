/**
 * Structural reader for ORM and query-builder code.
 *
 * `checkEquivalence()` and `checkPerformance()` both opened with
 * `readSqlShape()`, and everything that is not parseable SQL text fell into a
 * dead branch: `kind: 'other'` → "Not a statement this checker can read". That
 * dead branch is where Django, Rails, Hibernate, Prisma, SQLAlchemy, GORM,
 * EF Core, Sequelize and TypeORM all land — the overwhelming majority of real
 * application data access. The product's two best machine checks were switched
 * off exactly where most users need them, and the `EXPLAIN ANALYZE` fallback
 * ended up pointed at JavaScript string concatenation.
 *
 * This reader is lexical and deliberately conservative. It does not try to
 * understand the query. It counts round trips and compares projections, and
 * both of those are decidable from text — which is enough to turn "not
 * machine-checkable" into "401 database calls become 1, counted from the code".
 */

import type { EnclosingScope } from '@/core/detect/scope'

export type OrmDialect =
  | 'django' | 'activerecord' | 'sqlalchemy' | 'prisma' | 'sequelize'
  | 'typeorm' | 'gorm' | 'hibernate' | 'efcore' | 'mongoose'

export interface OrmShape {
  dialect: OrmDialect
  /**
   * Round trips this snippet issues, counted lexically.
   *
   * Only evaluating constructs count. A lazy queryset assignment is zero, which
   * is what it actually costs.
   */
  queryCount: number
  /** Data-access constructs of any kind, lazy ones included. */
  builderCount: number
  /** True when at least one query sits inside a loop. */
  perIteration: boolean
  /** Terminal operations found, e.g. 'count', 'exists', 'first', 'all'. */
  terminals: string[]
  /** Eager-loading directives present. */
  eagerLoads: string[]
  /** Named fields in a projection (values/values_list/select/pluck/only). */
  projection: string[] | null
  /** Slice or limit, if any. */
  limit: number | null
  /** Filter expressions as normalised text, for comparison. */
  predicates: string[]
  /** True when a predicate uses set membership (`__in`, `IN (…)`, `whereIn`). */
  batched: boolean
  /** True when the code writes (create/update/delete/save). */
  writes: boolean
  /** `.distinct()` present. */
  distinct: boolean
  /** Ordering directives, normalised. */
  orderBy: string[]
  /** Aggregate functions applied, e.g. Max, Count, Sum. */
  aggregates: string[]
  /** The result is materialised once — `list(qs)`, `.to_a`, `Array.from`. */
  materialised: boolean
  /**
   * The association fetch mode this snippet declares, for ORMs where it is a
   * declaration rather than a call — JPA/Hibernate `FetchType`, principally.
   *
   * Kept apart from `eagerLoads` because it is not the same claim. An
   * `@EntityGraph` or a `JOIN FETCH` is a *per-query* instruction; a
   * `FetchType` is a property of the mapping and applies to every read of that
   * entity, everywhere. Changing it is a wider change than changing a query,
   * and the trade-off runs in both directions — which is why
   * `performance.ts` reports it as a counted structural fact with the round-trip
   * risk named beside it, rather than as a win.
   */
  fetchMode: 'eager' | 'lazy' | null
}

interface DialectSpec {
  dialect: OrmDialect
  /** Identifies the dialect. Must be specific enough not to fire on another. */
  detect: RegExp
  /** Any data-access construct. Decides whether this is ORM code at all. */
  calls: RegExp
  /**
   * Constructs that actually cost a round trip.
   *
   * This is not the same set as `calls`, and conflating them produced a false
   * `counted` fact on the first real scan: `Product.objects.filter(pk=x)` is a
   * *lazy* queryset in Django — it builds an object and issues no SQL — yet a
   * finding shipped claiming "issues 2 database calls where the original issues
   * 4" about four such assignments. Zero of them touch the database.
   *
   * A `counted` fact is the one thing in this product that is supposed to be a
   * fact, so it has to distinguish the builders from the evaluators. Lazy
   * dialects (Django, ActiveRecord, SQLAlchemy, EF Core, TypeORM's builder)
   * evaluate on a terminal, an iteration or a write; eager ones (Prisma,
   * Sequelize, Mongoose, GORM) issue the call on the spot.
   */
  evaluators: RegExp
  terminals: RegExp
  eager: RegExp
  projection: RegExp
  limit: RegExp
  predicate: RegExp
  batched: RegExp
  writes: RegExp
  distinct: RegExp
  order: RegExp
}

const DIALECTS: DialectSpec[] = [
  {
    dialect: 'django',
    evaluators: /\.\s*(?:count|exists|first|last|get|latest|earliest|aggregate|in_bulk)\s*\(|\.\s*(?:save|delete|create|update|bulk_create|bulk_update|get_or_create|update_or_create)\s*\(|\bfor\s+\w+(?:\s*,\s*\w+)*\s+in\s+[\w.]*(?:\.objects\.|_set\.)|\b(?:list|len|any|all|sum)\s*\(\s*[\w.]*\.objects\./g,
    detect: /\.\s*objects\s*\.|\bQuerySet\b|\bF\s*\(|\bQ\s*\(|\bannotate\s*\(/,
    calls: /\.\s*objects\s*\.\s*\w+|\.\s*(?:count|exists|first|last|get|latest|earliest|aggregate|bulk_create|bulk_update|update|delete|create|save|in_bulk)\s*\(/g,
    terminals: /\.\s*(count|exists|first|last|get|all|aggregate|latest|earliest|values_list|values|in_bulk)\s*\(/g,
    eager: /\b(select_related|prefetch_related|only|defer)\s*\(/g,
    projection: /\.\s*(?:values|values_list|only)\s*\(([^)]*)\)/g,
    limit: /\[\s*:\s*(\d+)\s*\]|\.\s*first\s*\(\s*\)/,
    predicate: /\.\s*(?:filter|exclude|get)\s*\(([^)]*)\)/g,
    // A queryset-level `update()`/`delete()`, a grouped `annotate()` and a
    // set-membership predicate are all one statement for the whole set — which
    // is what "batched" has to mean here, because it is what decides whether a
    // rewrite escaped the enclosing loop. Instance-level `save()` is not in
    // this list on purpose: that is the per-row call being replaced.
    batched: /__in\s*=|\bin_bulk\s*\(|\bbulk_(?:create|update)\s*\(|\.\s*(?:update|delete)\s*\(|\bannotate\s*\(/,
    writes: /\.\s*(?:save|delete|create|update|bulk_create|bulk_update|get_or_create|update_or_create)\s*\(/,
    distinct: /\.\s*distinct\s*\(/,
    order: /\.\s*order_by\s*\(([^)]*)\)/g,
  },
  {
    dialect: 'activerecord',
    evaluators: /\.\s*(?:count|exists\?|first|last|pluck|sum|average|to_a|find_each|find_in_batches|find_by|find)\b|\.\s*(?:save!?|destroy!?|update!?|create!?|update_all|delete_all|insert_all)\b|\.\s*each\b/g,
    detect: /\b[A-Z]\w*\s*\.\s*(?:where|find_by|find_each|pluck|includes|joins)\b|\bActiveRecord\b|\.\s*find_each\b/,
    calls: /\b[A-Z]\w*\s*\.\s*(?:where|find_by|find|all|first|last|count|exists\?|pluck|sum|average)\b|\.\s*(?:count|exists\?|first|last|pluck|sum|to_a|find_each|update|destroy|save)\b/g,
    terminals: /\.\s*(count|exists\?|first|last|pluck|to_a|sum|average|find_each)\b/g,
    eager: /\.\s*(includes|preload|eager_load|left_outer_joins)\s*\(/g,
    projection: /\.\s*(?:pluck|select)\s*\(([^)]*)\)/g,
    limit: /\.\s*limit\s*\(\s*(\d+)\s*\)|\.\s*first\b/,
    predicate: /\.\s*(?:where|find_by)\s*[\(!]?([^)]*)\)?/g,
    batched: /\bwhere\s*\(\s*\w+\s*:\s*\[|\bin_batches\b|\bfind_each\b|\bwhere\s*\(.*\bIN\b/i,
    writes: /\.\s*(?:save!?|destroy!?|update!?|create!?|update_all|delete_all|insert_all)\b/,
    distinct: /\.\s*(?:distinct|uniq)\b/,
    order: /\.\s*order\s*\(([^)]*)\)/g,
  },
  {
    dialect: 'sqlalchemy',
    evaluators: /\.\s*(?:all|one|one_or_none|first|count|scalar)\s*\(|\bsession\s*\.\s*(?:execute|scalars|scalar|get|commit|flush|add|add_all|delete|merge)\s*\(/g,
    detect: /\bsession\s*\.\s*(?:query|execute|scalars|scalar|get)\b|\bselect\s*\(\s*\w+\s*\)|\bjoinedload\b|\bselectinload\b/,
    calls: /\bsession\s*\.\s*(?:query|execute|scalars|scalar|get|add|delete|commit)\s*\(|\.\s*(?:all|one|one_or_none|first|count|scalar)\s*\(/g,
    terminals: /\.\s*(all|one|one_or_none|first|count|scalar)\s*\(/g,
    eager: /\b(joinedload|selectinload|subqueryload|contains_eager)\s*\(/g,
    projection: /\bwith_entities\s*\(([^)]*)\)|\bselect\s*\(([^)]*)\)/g,
    limit: /\.\s*limit\s*\(\s*(\d+)\s*\)|\.\s*first\s*\(\s*\)/,
    predicate: /\.\s*(?:filter|filter_by|where)\s*\(([^)]*)\)/g,
    batched: /\.\s*in_\s*\(|\bbulk_(?:save_objects|insert_mappings)\b/,
    writes: /\bsession\s*\.\s*(?:add|add_all|delete|merge)\s*\(|\.\s*update\s*\(/,
    distinct: /\.\s*distinct\s*\(/,
    order: /\.\s*order_by\s*\(([^)]*)\)/g,
  },
  {
    dialect: 'prisma',
    evaluators: /\bprisma\s*\.\s*\w+\s*\.\s*(?:findMany|findFirst|findUnique|findUniqueOrThrow|count|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$queryRaw|\$executeRaw/g,
    detect: /\bprisma\s*\.\s*\w+\s*\.\s*\w+|\$queryRaw|\$transaction/,
    calls: /\bprisma\s*\.\s*\w+\s*\.\s*(?:findMany|findFirst|findUnique|findUniqueOrThrow|count|aggregate|groupBy|create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$queryRaw|\$executeRaw/g,
    terminals: /\.\s*(findMany|findFirst|findUnique|count|aggregate|groupBy)\s*\(/g,
    eager: /\b(include|select)\s*:/g,
    projection: /\bselect\s*:\s*\{([^}]*)\}/g,
    limit: /\btake\s*:\s*(\d+)/,
    predicate: /\bwhere\s*:\s*\{([^}]*)\}/g,
    batched: /\bin\s*:\s*\[|\bcreateMany\b|\bupdateMany\b|\$transaction\b/,
    writes: /\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    distinct: /\bdistinct\s*:/,
    order: /\borderBy\s*:\s*(\{[^}]*\}|\[[^\]]*\])/g,
  },
  {
    dialect: 'sequelize',
    evaluators: /\.\s*(?:findAll|findOne|findByPk|findAndCountAll|count|create|bulkCreate|update|destroy|increment|save)\s*\(/g,
    detect: /\.\s*(?:findAll|findAndCountAll|findByPk)\s*\(|\bSequelize\b|\bDataTypes\b/,
    calls: /\.\s*(?:findAll|findOne|findByPk|findAndCountAll|count|create|bulkCreate|update|destroy|increment)\s*\(/g,
    terminals: /\.\s*(findAll|findOne|findByPk|findAndCountAll|count)\s*\(/g,
    eager: /\binclude\s*:/g,
    projection: /\battributes\s*:\s*\[([^\]]*)\]/g,
    limit: /\blimit\s*:\s*(\d+)/,
    predicate: /\bwhere\s*:\s*\{([^}]*)\}/g,
    batched: /\[\s*Op\.in\s*\]|\bbulkCreate\b/,
    writes: /\.\s*(?:create|bulkCreate|update|destroy|save|increment)\s*\(/,
    distinct: /\bdistinct\s*:\s*true/,
    order: /\border\s*:\s*(\[[^\]]*\])/g,
  },
  {
    dialect: 'typeorm',
    evaluators: /\.\s*(?:getMany|getOne|getRawMany|getRawOne|getCount|find|findOne|findOneBy|findAndCount|save|insert|update|delete|remove|softDelete)\s*\(/g,
    detect: /\bcreateQueryBuilder\s*\(|\bgetRepository\s*\(|\bleftJoinAndSelect\b|@Entity\b/,
    calls: /\.\s*(?:getMany|getOne|getRawMany|getRawOne|getCount|find|findOne|findOneBy|findAndCount|save|insert|update|delete|remove)\s*\(/g,
    terminals: /\.\s*(getMany|getOne|getRawMany|getCount|find|findOne|findAndCount)\s*\(/g,
    eager: /\.\s*(leftJoinAndSelect|innerJoinAndSelect)\s*\(|\brelations\s*:/g,
    projection: /\.\s*select\s*\(\s*\[?([^)\]]*)\]?\s*\)/g,
    limit: /\.\s*(?:take|limit)\s*\(\s*(\d+)\s*\)/,
    predicate: /\.\s*(?:where|andWhere)\s*\(([^)]*)\)/g,
    batched: /\bIn\s*\(|\bwhereInIds\b/,
    writes: /\.\s*(?:save|insert|update|delete|remove|softDelete)\s*\(/,
    distinct: /\.\s*distinct\s*\(/,
    order: /\.\s*(?:orderBy|addOrderBy)\s*\(([^)]*)\)/g,
  },
  {
    dialect: 'gorm',
    evaluators: /\.\s*(?:Find|First|Last|Take|Count|Pluck|Scan|Create|Save|Updates?|Delete|FindInBatches|CreateInBatches)\s*\(/g,
    detect: /\b(?:db|tx)\s*\.\s*(?:Where|Preload|Model|Find|First|Joins)\s*\(/,
    calls: /\b(?:db|tx)\s*\.\s*(?:Find|First|Last|Take|Count|Pluck|Scan|Create|Save|Updates?|Delete|FindInBatches)\s*\(|\.\s*(?:Find|First|Count|Scan|Pluck)\s*\(/g,
    terminals: /\.\s*(Find|First|Last|Take|Count|Pluck|Scan)\s*\(/g,
    eager: /\.\s*Preload\s*\(|\.\s*Joins\s*\(/g,
    projection: /\.\s*Select\s*\(([^)]*)\)/g,
    limit: /\.\s*Limit\s*\(\s*(\d+)\s*\)/,
    predicate: /\.\s*Where\s*\(([^)]*)\)/g,
    batched: /\bIN\s*\?|\bCreateInBatches\b|\bFindInBatches\b|\bIN\s*\(/i,
    writes: /\.\s*(?:Create|Save|Updates?|Delete|CreateInBatches)\s*\(/,
    distinct: /\.\s*Distinct\s*\(/,
    order: /\.\s*Order\s*\(([^)]*)\)/g,
  },
  {
    dialect: 'hibernate',
    evaluators: /\.\s*(?:getResultList|getSingleResult|getResultStream|find|persist|merge|remove|save|saveAll|saveAndFlush|delete|deleteAll|findAll|findById|count|flush)\s*\(/g,
    /*
     * JPA *mapping* annotations are data access, and leaving them out was a
     * false negative with real consequences.
     *
     * Found by running the benchmark: on spring-petclinic all three findings
     * the repository exists to test propose `fetch = FetchType.EAGER` ->
     * `FetchType.LAZY`, and every one was suppressed as `not-data-access`
     * because neither side parsed as a query. An association's fetch mode is
     * not merely near the data access — it *is* the declaration that decides
     * whether reading a list of parents costs one query or one per parent.
     * That is the single most valuable thing this tool looks for, and the
     * shape reader could not see it.
     */
    detect: /\bEntityManager\b|\bcreateQuery\s*\(|\bCriteriaBuilder\b|@(?:Query|NamedQuery|EntityGraph)\b|\bgetResultList\b|@(?:OneToMany|ManyToMany|ManyToOne|OneToOne|ElementCollection)\b|\bFetchType\s*\.\s*(?:EAGER|LAZY)\b/,
    calls: /\.\s*(?:getResultList|getSingleResult|createQuery|createNativeQuery|find|persist|merge|remove|saveAll|save|findAll|findById|count)\s*\(/g,
    terminals: /\.\s*(getResultList|getSingleResult|findAll|findById|count)\s*\(/g,
    eager: /@EntityGraph\b|\bJOIN\s+FETCH\b|@BatchSize\b|\bFetchType\s*\.\s*EAGER\b/g,
    projection: /\bSELECT\s+(?:new\s+\S+\s*\()?([\w.,\s]+?)\s+FROM\b/gi,
    limit: /\.\s*setMaxResults\s*\(\s*(\d+)\s*\)/,
    predicate: /\bWHERE\s+([^)]*?)(?:\bORDER\b|\bGROUP\b|$)/gi,
    batched: /\bIN\s*[(:]|\bsaveAll\b|@BatchSize\b/i,
    writes: /\.\s*(?:persist|merge|remove|save|saveAll|delete|deleteAll)\s*\(/,
    distinct: /\bDISTINCT\b/i,
    order: /\bORDER\s+BY\s+([\w.,\s]+)/gi,
  },
  {
    dialect: 'efcore',
    evaluators: /\.\s*(?:ToListA?s?y?n?c?|ToArrayA?s?y?n?c?|FirstA?s?y?n?c?|FirstOrDefaultA?s?y?n?c?|SingleA?s?y?n?c?|SingleOrDefaultA?s?y?n?c?|CountA?s?y?n?c?|AnyA?s?y?n?c?|SumA?s?y?n?c?|SaveChangesA?s?y?n?c?|ExecuteUpdateA?s?y?n?c?|ExecuteDeleteA?s?y?n?c?)\s*\(/g,
    detect: /\bDbSet<|\.\s*Include\s*\(|\bAsNoTracking\s*\(|\bFromSqlRaw\b/,
    calls: /\.\s*(?:ToList|ToListAsync|First|FirstAsync|FirstOrDefault|FirstOrDefaultAsync|Single|SingleOrDefault|Count|CountAsync|Any|AnyAsync|Add|AddRange|Update|Remove|SaveChanges|SaveChangesAsync)\s*\(/g,
    terminals: /\.\s*(ToListA?s?y?n?c?|FirstOrDefaultA?s?y?n?c?|FirstA?s?y?n?c?|CountA?s?y?n?c?|AnyA?s?y?n?c?)\s*\(/g,
    eager: /\.\s*(Include|ThenInclude)\s*\(/g,
    projection: /\.\s*Select\s*\(([^)]*)\)/g,
    limit: /\.\s*Take\s*\(\s*(\d+)\s*\)/,
    predicate: /\.\s*Where\s*\(([^)]*)\)/g,
    batched: /\.\s*Contains\s*\(|\bAddRange\b|\bUpdateRange\b/,
    writes: /\.\s*(?:Add|AddRange|Update|Remove|RemoveRange|SaveChanges|SaveChangesAsync)\s*\(/,
    distinct: /\.\s*Distinct\s*\(/,
    order: /\.\s*(?:OrderBy|OrderByDescending|ThenBy)\s*\(([^)]*)\)/g,
  },
  {
    dialect: 'mongoose',
    evaluators: /\.\s*(?:find|findOne|findById|countDocuments|estimatedDocumentCount|aggregate|updateOne|updateMany|insertMany|deleteOne|deleteMany|save|bulkWrite|create|exec|lean)\s*\(/g,
    detect: /\bmongoose\b|\.\s*populate\s*\(|\.\s*lean\s*\(/,
    calls: /\.\s*(?:find|findOne|findById|countDocuments|estimatedDocumentCount|aggregate|updateOne|updateMany|insertMany|deleteOne|deleteMany|save|bulkWrite)\s*\(/g,
    terminals: /\.\s*(find|findOne|findById|countDocuments|aggregate)\s*\(/g,
    eager: /\.\s*populate\s*\(/g,
    projection: /\.\s*select\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g,
    limit: /\.\s*limit\s*\(\s*(\d+)\s*\)/,
    predicate: /\.\s*find(?:One)?\s*\(\s*(\{[^}]*\})/g,
    batched: /\$in\s*:|\binsertMany\b|\bbulkWrite\b/,
    writes: /\.\s*(?:save|updateOne|updateMany|insertMany|deleteOne|deleteMany|bulkWrite|create)\s*\(/,
    distinct: /\.\s*distinct\s*\(/,
    order: /\.\s*sort\s*\(([^)]*)\)/g,
  },
]

/**
 * Read the ORM shape of a code snippet, or return null when nothing in it
 * looks like ORM data access at all.
 *
 * Returning null is a real answer, and the value gate depends on it: a snippet
 * where neither this nor `readSqlShape()` finds anything is not data access,
 * and a performance finding on it should never have been published.
 */
export function readOrmShape(code: string, scope?: EnclosingScope | null): OrmShape | null {
  if (!code || !code.trim()) return null

  const spec = DIALECTS.find((d) => d.detect.test(code))
  if (!spec) return null

  // `calls` answers "is this ORM code?"; `evaluators` answers "how many round
  // trips?". They are different questions and were the same regex.
  const calls = matchCount(code, spec.calls)

  /*
   * A mapping *declaration* is data access with zero calls in it.
   *
   * `calls === 0 -> null` is right for ordinary code — it is what stops a
   * string-building helper being read as a query. It is wrong for a JPA
   * association mapping, which contains no call by construction and yet
   * determines the round-trip cost of every read of that entity. Requiring a
   * call meant `@OneToMany(fetch = FetchType.EAGER)` parsed as "not data
   * access", and the value gate then suppressed every finding about it.
   */
  const fetchMode: OrmShape['fetchMode'] = /\bFetchType\s*\.\s*EAGER\b/.test(code)
    ? 'eager'
    : /\bFetchType\s*\.\s*LAZY\b/.test(code)
      ? 'lazy'
      : null

  if (calls === 0 && fetchMode === null) return null
  const roundTrips = matchCount(code, spec.evaluators)

  const terminals = [...new Set(captureAll(code, spec.terminals).map((s) => s.trim()))]
  const eagerLoads = [...new Set(captureAll(code, spec.eager).map((s) => s.trim()).filter(Boolean))]
  const projectionRaw = captureAll(code, spec.projection)
  const predicates = captureAll(code, spec.predicate).map(normalise).filter(Boolean)
  const orderBy = captureAll(code, spec.order).map(normalise).filter(Boolean)

  const limitMatch = spec.limit.exec(code)

  const batched = spec.batched.test(code)

  return {
    dialect: spec.dialect,
    queryCount: roundTrips,
    builderCount: calls,
    // A query inside a loop issues one call per iteration, so its real cost is
    // the loop's trip count — which source cannot know, and which is exactly
    // why this is reported as "per iteration" rather than as a number.
    //
    // `scope` describes the *site*, so both sides of a rewrite share it. A
    // proposal that replaces the per-row predicate with a set-membership one is
    // by construction a single call for the whole set, whatever loop it is
    // written next to — so a batched snippet is never per-iteration. Without
    // this, the two shapes were identical on the field that the whole N+1
    // check turns on, and no batch rewrite could ever be recognised.
    perIteration: !batched && ((scope?.loopDepth ?? 0) > 0 || hasOwnLoop(code)),
    terminals,
    eagerLoads,
    projection: projectionRaw.length ? splitFields(projectionRaw.join(',')) : null,
    limit: limitMatch ? (limitMatch[1] ? Number(limitMatch[1]) : 1) : null,
    predicates,
    batched,
    writes: spec.writes.test(code),
    distinct: spec.distinct.test(code),
    orderBy,
    aggregates: [...new Set(
      [...code.matchAll(/\b(Max|Min|Count|Sum|Avg|Coalesce)\s*\(/g)].map((m) => m[1]!),
    )],
    // A queryset assigned once and read twice issues two queries; the same one
    // materialised issues one. Both sides have the same call count, so the
    // difference is invisible to `queryCount` and has to be read directly.
    materialised: /\blist\s*\(|\.\s*to_a\b|\bArray\.from\s*\(|\btolist\s*\(/i.test(code),
    fetchMode,
  }
}

/**
 * The instrument that actually settles the question for this stack.
 *
 * `EXPLAIN ANALYZE` against Django ORM code is not a verification step, it is a
 * category error — the user cannot run it, and offering it is how the report
 * ended up pointing `EXPLAIN ANALYZE` at JavaScript string concatenation. Every
 * one of these counts the queries issued, which is the claim being made.
 */
export function ormVerificationRecipe(dialect: OrmDialect | undefined): string {
  switch (dialect) {
    case 'django':
      return [
        '# Count the queries this code path issues, before and after.',
        'from django.test.utils import CaptureQueriesContext',
        'from django.db import connection',
        '',
        'with CaptureQueriesContext(connection) as ctx:',
        '    <call the view or function>',
        'print(len(ctx.captured_queries))   # this is the number that must drop',
        '',
        '# In a browser, django-debug-toolbar shows the same count per request.',
      ].join('\n')
    case 'activerecord':
      return [
        '# Count the queries this code path issues, before and after.',
        'ActiveRecord::Base.logger = Logger.new($stdout)',
        '',
        '# Or assert it in a test, which is the version that stays honest:',
        'assert_queries(1) { <call the action> }',
      ].join('\n')
    case 'sqlalchemy':
      return [
        '# Echo every statement the session emits, before and after.',
        'engine = create_engine(URL, echo=True)',
        '',
        '# Or count them, which is the claim being made:',
        'from sqlalchemy import event',
        'count = 0',
        '@event.listens_for(engine, "before_cursor_execute")',
        'def _count(*args, **kwargs):',
        '    global count; count += 1',
      ].join('\n')
    case 'prisma':
      return [
        '// Log every query the client issues, before and after.',
        "const prisma = new PrismaClient({ log: ['query'] })",
        '',
        '// The count in the log is the number that must drop.',
      ].join('\n')
    case 'sequelize':
      return [
        '// Log every statement, before and after.',
        'const sequelize = new Sequelize(URL, { logging: console.log })',
      ].join('\n')
    case 'typeorm':
      return [
        '// Log every statement, before and after.',
        "const ds = new DataSource({ ...opts, logging: ['query'] })",
      ].join('\n')
    case 'hibernate':
      return [
        '# Show every statement Hibernate issues, before and after.',
        'spring.jpa.show-sql=true',
        'spring.jpa.properties.hibernate.generate_statistics=true',
        '',
        '// Or read the count directly, which is the claim being made:',
        'sessionFactory.getStatistics().getQueryExecutionCount()',
      ].join('\n')
    case 'gorm':
      return [
        '// Log every statement, before and after.',
        'db.Debug().<the same call>',
      ].join('\n')
    case 'efcore':
      return [
        '// Log every command, before and after.',
        'optionsBuilder.LogTo(Console.WriteLine, LogLevel.Information)',
      ].join('\n')
    case 'mongoose':
      return [
        '// Log every operation the driver issues, before and after.',
        'mongoose.set("debug", true)',
      ].join('\n')
    default:
      return [
        '# speeDB could not identify the data-access library here, so it will not',
        '# guess at a command. Count the queries this code path issues before and',
        '# after the change, using whatever query log your stack already has.',
      ].join('\n')
  }
}

/**
 * A loop header inside the snippet itself.
 *
 * The `original` field of a finding often carries its own `for` line, which is
 * the only loop evidence available when no scope was passed.
 */
const OWN_LOOP = /^\s*(?:for|while)\b|\bfor\s*\(|\.\s*(?:forEach|each|map|find_each)\s*[({]|\bEnum\.each\b|\.\s*each\s+do\b/m

function hasOwnLoop(code: string): boolean {
  return OWN_LOOP.test(code)
}

function matchCount(text: string, re: RegExp): number {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let n = 0
  let guard = 0
  while (rx.exec(text) !== null) {
    n++
    if (++guard > 500) break
  }
  return n
}

function captureAll(text: string, re: RegExp): string[] {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = rx.exec(text)) !== null) {
    const captured = m.slice(1).find((g) => g !== undefined)
    if (captured !== undefined) out.push(captured)
    if (m.index === rx.lastIndex) rx.lastIndex++
    if (++guard > 200) break
  }
  return out
}

function splitFields(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((f) => f.replace(/['"`\[\]{}():]/g, '').trim())
    .filter((f) => f.length > 0 && f !== 'true' && f !== 'false')
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
