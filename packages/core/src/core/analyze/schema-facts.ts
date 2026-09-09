import { stripLiterals } from './sql-shape'

/**
 * A catalog of what the repository *declares* about its schema.
 *
 * This is deliberately not called "the schema". Migration files record intent
 * at a point in time; they do not tell you what exists in production, how many
 * rows a table holds, or how selective a column is. Half of index advice is
 * wrong without those, and none of them are recoverable from source.
 *
 * What the catalog *can* do is kill a specific class of wrong advice: an index
 * that the repository already declares, or one whose leading columns are
 * already covered by an existing index. That is a real check, and it is
 * decidable from DDL alone.
 */

export interface IndexFact {
  name: string
  table: string
  /** Column names in index order. Order is what makes a prefix redundant. */
  columns: string[]
  unique: boolean
  source: { file: string; line: number }
}

export interface TableFact {
  name: string
  columns: Set<string>
  source: { file: string; line: number }
}

export interface SchemaFacts {
  tables: Map<string, TableFact>
  indexes: IndexFact[]
  /** Files that contributed, so the catalog's basis is auditable. */
  sources: string[]
  /**
   * Facts that are NOT in here and cannot be. Rendered in the UI so the limits
   * of the catalog are visible rather than assumed away.
   */
  readonly unknowable: string[]
}

export const UNKNOWABLE = [
  'Row counts — no table size is recoverable from source.',
  'Column selectivity and data distribution.',
  'Which indexes actually exist in production, versus which were declared in a migration that may have been superseded, reverted, or never run.',
  'Index bloat, and whether an existing index is used at all.',
] as const

export function buildSchemaFacts(files: { path: string; content: string }[]): SchemaFacts {
  const tables = new Map<string, TableFact>()
  const indexes: IndexFact[] = []
  const sources: string[] = []

  for (const file of files) {
    const before = tables.size + indexes.length
    readSqlDdl(file.path, file.content, tables, indexes)
    readPrismaSchema(file.path, file.content, tables, indexes)
    readMigrationDsl(file.path, file.content, indexes)
    if (tables.size + indexes.length > before) sources.push(file.path)
  }

  return { tables, indexes, sources, unknowable: [...UNKNOWABLE] }
}

/* --------------------------------------------------------------- SQL DDL -- */

function readSqlDdl(
  file: string, content: string,
  tables: Map<string, TableFact>, indexes: IndexFact[],
): void {
  const text = stripLiterals(content)

  // CREATE TABLE "x" ( ... )
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[\]\w.]+)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = tableRe.exec(text)) !== null) {
    const name = unquote(m[1]!)
    const body = balancedBody(text, m.index + m[0].length - 1)
    if (body === null) continue
    tables.set(name.toLowerCase(), {
      name,
      columns: new Set(readColumnNames(body)),
      source: { file, line: lineAt(content, m.index) },
    })

    // Inline UNIQUE / PRIMARY KEY constraints are indexes too.
    const inlineRe = /(UNIQUE|PRIMARY)\s+KEY\s*\(([^)]*)\)/gi
    let c: RegExpExecArray | null
    while ((c = inlineRe.exec(body)) !== null) {
      indexes.push({
        name: `${name}_${c[1]!.toLowerCase()}`,
        table: name,
        columns: splitColumns(c[2]!),
        unique: true,
        source: { file, line: lineAt(content, m.index) },
      })
    }
  }

  // CREATE [UNIQUE] INDEX name ON table [USING method] (cols)
  const indexRe =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.]+)\s+ON\s+(?:ONLY\s+)?([`"\[\]\w.]+)(?:\s+USING\s+\w+)?\s*\(([^)]*)\)/gi
  while ((m = indexRe.exec(text)) !== null) {
    indexes.push({
      name: unquote(m[2]!),
      table: unquote(m[3]!),
      columns: splitColumns(m[4]!),
      unique: Boolean(m[1]),
      source: { file, line: lineAt(content, m.index) },
    })
  }
}

/* ------------------------------------------------------------- Prisma ----- */

function readPrismaSchema(
  file: string, content: string,
  tables: Map<string, TableFact>, indexes: IndexFact[],
): void {
  if (!file.endsWith('.prisma')) return

  const modelRe = /model\s+(\w+)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = modelRe.exec(content)) !== null) {
    const name = m[1]!
    const body = balancedBody(content, m.index + m[0].length - 1, '{', '}')
    if (body === null) continue

    const columns = new Set<string>()
    for (const line of body.split('\n')) {
      const field = /^\s*(\w+)\s+\w+/.exec(line)
      if (field && !line.trim().startsWith('@@')) columns.add(field[1]!)
    }
    tables.set(name.toLowerCase(), { name, columns, source: { file, line: lineAt(content, m.index) } })

    const attrRe = /@@(index|unique)\s*\(\s*\[([^\]]*)\]/g
    let a: RegExpExecArray | null
    while ((a = attrRe.exec(body)) !== null) {
      indexes.push({
        name: `${name}_${a[2]!.replace(/\W+/g, '_')}`,
        table: name,
        columns: splitColumns(a[2]!),
        unique: a[1] === 'unique',
        source: { file, line: lineAt(content, m.index) },
      })
    }
  }
}

/* ------------------------------------------------- framework migration DSL -- */

function readMigrationDsl(file: string, content: string, indexes: IndexFact[]): void {
  // Rails: add_index :users, [:tenant_id, :created_at], unique: true
  // Alembic: op.create_index('ix', 'users', ['tenant_id'])
  // Knex: table.index(['tenant_id'])
  const rails = /add_index\s+:?["']?(\w+)["']?\s*,\s*(\[[^\]]*\]|:\w+|["']\w+["'])(.*)$/gim
  let m: RegExpExecArray | null
  while ((m = rails.exec(content)) !== null) {
    indexes.push({
      name: `${m[1]!}_idx`,
      table: m[1]!,
      columns: splitColumns(m[2]!),
      unique: /unique:\s*true/.test(m[3] ?? ''),
      source: { file, line: lineAt(content, m.index) },
    })
  }

  const alembic = /op\.create_index\s*\(\s*(?:["']([\w]+)["']\s*,\s*)?["'](\w+)["']\s*,\s*\[([^\]]*)\](.*)$/gim
  while ((m = alembic.exec(content)) !== null) {
    indexes.push({
      name: m[1] ?? `${m[2]!}_idx`,
      table: m[2]!,
      columns: splitColumns(m[3]!),
      unique: /unique\s*=\s*True/i.test(m[4] ?? ''),
      source: { file, line: lineAt(content, m.index) },
    })
  }
}

/* -------------------------------------------------------------- the checks -- */

export interface IndexAdvice {
  /** An existing index that already serves the proposed one. */
  coveredBy?: IndexFact
  /** A declared index that the proposal duplicates exactly. */
  duplicateOf?: IndexFact
  /** Columns named in the proposal that no known table declares. */
  unknownColumns: string[]
  notes: string[]
}

/**
 * Check a proposed CREATE INDEX against what the repository already declares.
 *
 * A btree index on (a, b, c) already serves any query that an index on (a) or
 * (a, b) would — leading-column containment is decidable, and it kills the
 * single most common piece of wrong index advice.
 */
export function checkProposedIndex(proposal: string, facts: SchemaFacts): IndexAdvice | null {
  const m = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.]+)?\s*ON\s+([`"\[\]\w.]+)(?:\s+USING\s+\w+)?\s*\(([^)]*)\)/i
    .exec(stripLiterals(proposal))
  if (!m) return null

  const table = unquote(m[3]!)
  const columns = splitColumns(m[4]!)
  const advice: IndexAdvice = { unknownColumns: [], notes: [] }

  const onTable = facts.indexes.filter((i) => i.table.toLowerCase() === table.toLowerCase())

  advice.duplicateOf = onTable.find(
    (i) => i.columns.length === columns.length && i.columns.every((c, k) => c === columns[k]),
  )

  if (!advice.duplicateOf) {
    // Leading-column containment: (a,b,c) serves (a) and (a,b).
    advice.coveredBy = onTable.find(
      (i) => i.columns.length >= columns.length && columns.every((c, k) => i.columns[k] === c),
    )
  }

  const known = facts.tables.get(table.toLowerCase())
  if (known) {
    advice.unknownColumns = columns.filter(
      (c) => ![...known.columns].some((k) => k.toLowerCase() === c.toLowerCase()),
    )
  }

  if (advice.duplicateOf) {
    advice.notes.push(
      `The repository already declares an identical index (${advice.duplicateOf.name}) at ${advice.duplicateOf.source.file}:${advice.duplicateOf.source.line}.`,
    )
  } else if (advice.coveredBy) {
    advice.notes.push(
      `An existing index ${advice.coveredBy.name} on (${advice.coveredBy.columns.join(', ')}) already leads with these columns, so it serves the same lookups. Declared at ${advice.coveredBy.source.file}:${advice.coveredBy.source.line}.`,
    )
  }
  if (advice.unknownColumns.length) {
    advice.notes.push(
      `Column(s) not found in the declared definition of ${table}: ${advice.unknownColumns.join(', ')}.`,
    )
  }
  if (!known) {
    advice.notes.push(`No CREATE TABLE for ${table} was found in the scanned files, so its columns could not be checked.`)
  }

  return advice
}

/** Indexes the repository declares that another declared index already covers. */
export function findRedundantIndexes(facts: SchemaFacts): { index: IndexFact; coveredBy: IndexFact }[] {
  const out: { index: IndexFact; coveredBy: IndexFact }[] = []
  for (const candidate of facts.indexes) {
    const cover = facts.indexes.find(
      (other) =>
        other !== candidate &&
        other.table.toLowerCase() === candidate.table.toLowerCase() &&
        other.columns.length > candidate.columns.length &&
        candidate.columns.every((c, k) => other.columns[k] === c) &&
        // A unique index carries a constraint, so it is never merely redundant.
        !candidate.unique,
    )
    if (cover) out.push({ index: candidate, coveredBy: cover })
  }
  return out
}

/* ------------------------------------------------------------------ utils -- */

function unquote(s: string): string {
  return s.replace(/[`"\[\]]/g, '').split('.').pop() ?? s
}

function splitColumns(raw: string): string[] {
  return raw
    .replace(/[\[\]]/g, '')
    .split(',')
    .map((c) => c.trim().replace(/^[:'"`]+|['"`]+$/g, '').split(/\s+/)[0] ?? '')
    .map((c) => c.toLowerCase())
    .filter(Boolean)
}

function readColumnNames(body: string): string[] {
  return splitTopLevelCommas(body)
    .map((part) => part.trim())
    .filter((part) => !/^(?:PRIMARY|UNIQUE|FOREIGN|CONSTRAINT|CHECK|INDEX|KEY)\b/i.test(part))
    .map((part) => unquote(part.split(/\s+/)[0] ?? ''))
    .filter(Boolean)
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts
}

/** Read a bracketed body starting at `open`, respecting nesting. */
function balancedBody(text: string, open: number, o = '(', c = ')'): string | null {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++
    else if (text[i] === c) {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return null
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}
