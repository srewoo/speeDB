import type { Candidate, DbEngine } from '@/core/types'
import { sliceLines } from './scan'

/**
 * Second detection tier: files that are obviously data access, but whose
 * queries are not lexically visible.
 *
 * A regex finds a query only when the query exists as text. In a mature Java
 * or Rails codebase, most of it does not:
 *
 *   - Hibernate/JPA CriteriaBuilder — the query is assembled from method calls
 *   - Django `.objects` chains built conditionally across functions
 *   - ActiveRecord scopes composed at the call site
 *   - Prisma `where` fragments passed between modules
 *   - SQL concatenated from fragments, none of which is a whole statement
 *
 * Span-level rules will keep missing these, and tightening them further only
 * trades one error for the other. So instead of guessing harder, this tier
 * identifies *files* that are unambiguously data access — by imports,
 * annotations, base classes and path — and submits a bounded sample of each
 * for analysis. It converts a recall problem into a bounded token cost.
 */

export interface RelevanceSignal {
  name: string
  pattern: RegExp
  engine: DbEngine
  /** Why this file is data access. Shown to the model as context. */
  reason: string
  extensions?: string[]
}

const JVM = ['java', 'kt', 'kts', 'scala', 'groovy']

export const SIGNALS: RelevanceSignal[] = [
  /* ------------------------------------------------------- JVM / Hibernate -- */
  {
    name: 'jpa-entity',
    pattern: /@Entity\b|@Table\s*\(|@MappedSuperclass\b/,
    engine: 'unknown', extensions: JVM,
    reason: 'A JPA entity — its mapping and fetch strategy determine the SQL Hibernate emits.',
  },
  {
    name: 'jpa-criteria',
    pattern: /CriteriaBuilder|CriteriaQuery|\bRoot<|EntityManager\b|Specification<|JPAQueryFactory/,
    engine: 'unknown', extensions: JVM,
    reason: 'Builds queries programmatically through the Criteria API — there is no SQL string to match.',
  },
  {
    name: 'spring-data-repository',
    pattern: /extends\s+(?:Jpa|Crud|Paging(?:AndSorting)?|Mongo|R2dbc)Repository\b|@Repository\b/,
    engine: 'unknown', extensions: JVM,
    reason: 'A Spring Data repository — derived query methods generate SQL from method names alone.',
  },
  {
    name: 'jpa-fetch-strategy',
    pattern: /@(?:One|Many)To(?:One|Many)\b|FetchType\.(?:LAZY|EAGER)|@BatchSize\b|@EntityGraph\b/,
    engine: 'unknown', extensions: JVM,
    reason: 'Association fetch settings — the usual source of N+1 in Hibernate.',
  },

  /* -------------------------------------------------------------- Python --- */
  {
    name: 'django-model',
    pattern: /class\s+\w+\s*\(\s*(?:models\.Model|Model)\s*\)|from\s+django\.db\s+import|models\.(?:ForeignKey|ManyToManyField|OneToOneField)\s*\(/,
    engine: 'unknown', extensions: ['py'],
    reason: 'A Django model — relations here drive the joins and the N+1 behaviour of every queryset.',
  },
  {
    name: 'django-manager',
    pattern: /class\s+\w*(?:Manager|QuerySet)\s*\(|\.get_queryset\s*\(|Q\s*\(|F\s*\(/,
    engine: 'unknown', extensions: ['py'],
    reason: 'A custom manager or queryset — the query is composed across methods, not written out.',
  },
  {
    name: 'sqlalchemy-model',
    pattern: /declarative_base\s*\(|__tablename__\s*=|relationship\s*\(|Column\s*\(/,
    engine: 'unknown', extensions: ['py'],
    reason: 'A SQLAlchemy model — lazy/eager loading here decides how many queries run.',
  },

  /* ---------------------------------------------------------------- Ruby --- */
  {
    name: 'activerecord-model',
    pattern: /<\s*(?:ApplicationRecord|ActiveRecord::Base)\b|\b(?:has_many|belongs_to|has_one|has_and_belongs_to_many)\b/,
    engine: 'unknown', extensions: ['rb'],
    reason: 'An ActiveRecord model — associations and scopes compose into queries at the call site.',
  },
  {
    name: 'activerecord-scope',
    pattern: /\bscope\s+:\w+\s*,\s*->/,
    engine: 'unknown', extensions: ['rb'],
    reason: 'Named scopes — chained and composed elsewhere, so the final query never appears as text.',
  },

  /* ----------------------------------------------------------- JS / TS ----- */
  {
    name: 'prisma-client',
    pattern: /from\s+['"]@prisma\/client['"]|new\s+PrismaClient\b|Prisma\.\w+WhereInput/,
    engine: 'unknown',
    reason: 'Prisma client usage — `where` and `include` fragments are frequently built in one module and used in another.',
  },
  {
    name: 'typeorm-entity',
    pattern: /@Entity\s*\(|@Column\s*\(|@ManyToOne\s*\(|getRepository\s*\(|DataSource\b/,
    engine: 'unknown',
    reason: 'A TypeORM entity or repository — relations and eager flags decide the emitted SQL.',
  },
  {
    name: 'orm-import',
    pattern: /from\s+['"](?:sequelize|typeorm|drizzle-orm|knex|mongoose|@mikro-orm\/\w+)['"]|require\(['"](?:sequelize|knex|mongoose)['"]\)/,
    engine: 'unknown',
    reason: 'Imports an ORM or query builder, so this file issues queries even if none is written as a string.',
  },

  /* ------------------------------------------------------------- Go / C# --- */
  {
    name: 'gorm-model',
    pattern: /gorm\.Model\b|gorm:"|\bPreload\s*\(/,
    engine: 'unknown', extensions: ['go'],
    reason: 'A GORM model — Preload behaviour is where N+1 appears.',
  },
  {
    name: 'ef-core-context',
    pattern: /:\s*DbContext\b|DbSet<|OnModelCreating\b|\.Include\s*\(/,
    engine: 'unknown', extensions: ['cs'],
    reason: 'An EF Core context — Include and lazy loading determine the generated SQL.',
  },
]

/** Paths that are data access regardless of what the file contains. */
const PATH_HINTS = [
  /(^|\/)(?:repositor(?:y|ies)|daos?|entities|models?|schemas?|persistence|store|stores)\//i,
  /(?:Repository|Dao|DAO|Entity|Mapper)\.(?:java|kt|scala|cs|ts)$/,
]

export interface RelevantFile {
  path: string
  reasons: string[]
  engine: DbEngine
}

export function findRelevantFiles(
  files: { path: string; content: string }[],
  alreadyCovered: Set<string>,
): RelevantFile[] {
  const out: RelevantFile[] = []

  for (const file of files) {
    // A file that already produced a span-level candidate is being analysed.
    if (alreadyCovered.has(file.path)) continue

    const ext = file.path.toLowerCase().split('.').pop() ?? ''
    const reasons: string[] = []
    let engine: DbEngine = 'unknown'

    for (const signal of SIGNALS) {
      if (signal.extensions && !signal.extensions.includes(ext)) continue
      if (!signal.pattern.test(file.content)) continue
      reasons.push(signal.reason)
      if (signal.engine !== 'unknown') engine = signal.engine
    }

    if (reasons.length === 0 && PATH_HINTS.some((r) => r.test(file.path))) {
      reasons.push('Located in a repository/model/entity directory, which is where data access lives.')
    }

    if (reasons.length > 0) out.push({ path: file.path, reasons, engine })
  }

  return out
}

/** Cap per file, so a second tier cannot double the bill. */
const SAMPLE_LINES = 120

/**
 * Turn a relevant file into a candidate.
 *
 * A whole file is too expensive and mostly irrelevant, so this samples the
 * regions that carry query semantics — annotations, associations, chained
 * calls — rather than the first N lines.
 */
export function sampleRelevantFile(file: RelevantFile, content: string): Candidate | null {
  const lines = content.split('\n')

  const INTERESTING =
    /@(?:Entity|Table|Query|OneToMany|ManyToOne|ManyToMany|OneToOne|EntityGraph|BatchSize|Column|Index)\b|FetchType\.|CriteriaBuilder|createQuery|\.objects\.|select_related|prefetch_related|relationship\s*\(|has_many|belongs_to|scope\s+:|\.include\s*\(|Preload\s*\(|DbSet<|prisma\.\w+\.|getRepository|createQueryBuilder/

  const keep: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (INTERESTING.test(lines[i]!)) {
      for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 4); k++) keep.push(k)
    }
  }

  const unique = [...new Set(keep)].sort((a, b) => a - b).slice(0, SAMPLE_LINES)
  if (unique.length === 0) return null

  // Contiguous runs, with an elision marker so the model is not misled into
  // thinking omitted lines were empty.
  const parts: string[] = []
  let runStart = unique[0]!
  let prev = unique[0]!
  for (const n of unique.slice(1)) {
    if (n !== prev + 1) {
      parts.push(sliceLines(content, runStart + 1, prev + 1))
      parts.push(`… (lines ${prev + 2}–${n} omitted)`)
      runStart = n
    }
    prev = n
  }
  parts.push(sliceLines(content, runStart + 1, prev + 1))

  return {
    id: `relevance:${file.path}`,
    file: file.path,
    startLine: unique[0]! + 1,
    endLine: prev + 1,
    excerpt: parts.join('\n'),
    engine: file.engine,
    accessStyle: 'orm',
    detector: `relevance(${file.reasons.length})`,
    // Below the span-level rules: analysed only when budget allows.
    confidence: 0.7,
    // Tier two samples a whole file, so there is no single query site to score
    // and no enclosing scope to read. It sits just under the neutral 0.4 so a
    // ranked cut-off prefers a real span-level candidate, and is pushed further
    // down when the path says the file cannot matter in production.
    priority: coldPath(file.path) ? 0.1 : 0.38,
    priorityReasons: coldPath(file.path)
      ? ['0.10 whole-file sample in migration/test code']
      : ['0.38 whole-file sample: no single query site to score'],
  }
}

const COLD_PATH = /(^|\/)migrations?\/|(^|\/)seeds?\/|(^|\/)fixtures?\/|(^|\/)tests?\/|(^|\/)spec\/|[._-]test\.|[._-]spec\./i

function coldPath(path: string): boolean {
  return COLD_PATH.test(path)
}
