/**
 * Enclosing-scope analysis: is this query inside a loop, and what reaches it?
 *
 * Every detection rule answers "is there a query here". None of them answered
 * "does this run once, or once per row" — which is the difference between a
 * finding worth acting on and a finding worth ignoring. A query at module
 * scope and a query inside a triple-nested loop were handed to the model as
 * the same shape of evidence, with six lines of context, so a `for` nine lines
 * above was invisible.
 *
 * This is a lexical pass, not an AST. A lexical pass is enough: loop nesting
 * and the nearest enclosing definition are both decidable from indentation
 * (Python, Ruby, Elixir) or brace balance (everything else), and getting them
 * approximately right is worth far more than getting them perfectly right at
 * the cost of a parser per language.
 */

import { maskNonCode } from './mask'

export type TriggerKind = 'request-handler' | 'job' | 'migration' | 'test' | 'unknown'

export interface EnclosingScope {
  /** Nesting depth of enclosing loops. 0 = not in a loop. */
  loopDepth: number
  /** The loop header lines, verbatim and trimmed, nearest-first. */
  loopHeaders: string[]
  /** Nearest enclosing function/method, qualified by class where visible. */
  symbol: string | null
  /** Line number of the symbol declaration, for citation. */
  symbolLine: number | null
  /** Best guess at what triggers this code path. */
  trigger: TriggerKind
  /**
   * The cited line itself opens a loop.
   *
   * Distinct from `loopDepth`, which counts what *encloses* the line. When a
   * candidate's span starts at the `for`, nothing encloses it and `loopDepth` is
   * 0 — while the code plainly runs per iteration. Reporting only the enclosing
   * count produced a finding headed "not in a loop" whose counted fact read
   * "moves the query out of the loop". Both were right; together they read as a
   * contradiction.
   */
  opensLoop: boolean
}

const INDENT_EXT = new Set(['py', 'pyi', 'pyx', 'rb', 'ex', 'exs', 'coffee'])

/* ------------------------------------------------------------- patterns -- */

const PY_LOOP = /^\s*(?:for|while)\b/
const PY_DEF = /^\s*(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/
const PY_COMPREHENSION_LOOP = /\bfor\s+\w+\s+in\b[\s\S]*[\]\})]/

const RB_LOOP = /^\s*(?:for|while|until)\b|\.\s*(?:each|each_with_index|each_slice|map|collect|find_each|in_batches|times|upto|downto)\b\s*(?:\{|do\b)/
const RB_DEF = /^\s*(?:def|class|module)\s+([A-Za-z_][\w.:]*)/

const EX_LOOP = /\bEnum\.(?:each|map|reduce|flat_map)\b|\bfor\b\s+\w+\s+<-/
const EX_DEF = /^\s*(?:defp?|defmodule)\s+([A-Za-z_][\w.]*)/

const BRACE_LOOP =
  /^\s*(?:for|while|do)\b|\bfor\s*\(|\bwhile\s*\(|\.\s*(?:forEach|map|flatMap|filter|reduce)\s*\(|\bforeach\s*\(|\brange\s+/
const BRACE_DEF =
  /(?:function\s+([A-Za-z_$]\w*)|(?:async\s+)?([A-Za-z_$]\w*)\s*\([^)]*\)\s*(?::\s*[\w<>,\[\]\s|]+)?\s*\{|(?:class|interface|struct|enum)\s+([A-Za-z_$]\w*)|func\s+(?:\([^)]*\)\s*)?([A-Za-z_$]\w*)|(?:public|private|protected|internal|static|final|override|virtual|async|\s)+[\w<>,\[\]\.]+\s+([A-Za-z_$]\w*)\s*\()/

/* --------------------------------------------------------------- trigger -- */

/**
 * Directories that are unambiguously a migration tool's own.
 *
 * A bare `migrations/` is NOT on this list, and that is the fix: it used to be,
 * and it marked Gitea's `services/migrations/` — the feature that imports a
 * repository from another forge, i.e. ordinary request-time production code —
 * as install-time. Anything relying on the word alone has to pass the
 * versioned-file test below as well.
 */
const MIGRATION_PATH = /(^|\/)alembic\/|(^|\/)db\/migrate\/|(^|\/)liquibase\/|(^|\/)flyway\/|(^|\/)goose\//i

/**
 * Standalone DDL: the schema and the seed data, applied once at install.
 *
 * `spring-petclinic` keeps its DDL in `db/h2/schema.sql`, `db/mysql/schema.sql`
 * and `db/postgres/data.sql` — no `migrations/` directory anywhere. 20 of its 29
 * candidates are those files, and every one came back `trigger: unknown`, so
 * neither the severity ceiling nor the cold-path rule would have touched a
 * performance finding on install-time DDL. That is the same failure as the five
 * migration findings in the original report, wearing a different path.
 */
/**
 * A versioned file inside a migration-ish directory.
 *
 * The literal-directory rule above misses real layouts: Gitea keeps its schema
 * migrations in `modelmigration/v1_13/v143.go`, which contains no `migrations/`
 * segment, so ~2,000 files came back `trigger: unknown` and its highest-priority
 * in-loop candidates were all install-time migrations.
 *
 * Widening to "any directory whose name contains migrat" would be wrong in the
 * other direction: Gitea also has `services/migrations/`, which is the feature
 * that imports a repository from another forge — ordinary production code.
 *
 * The pair of conditions is what separates them. A schema migration is a
 * *versioned* file: `v143.go`, `0001_initial.py`, `20240101120000_x.rb`.
 * `services/migrations/github.go` is not.
 */
const MIGRATION_DIRISH = /(^|\/)[\w.-]*migrat(?:e|ion)[\w.-]*\//i
/**
 * A *top-level* directory named for migrations owns its whole subtree.
 *
 * `modelmigration/base/db.go` is Gitea's migration framework — install-time by
 * definition, but its filename carries no version so the versioned-file test
 * misses it. Anchoring at the repository root is what keeps this from
 * swallowing `services/migrations/`, which lives under a `services/` root and
 * is request-time production code.
 */
const MIGRATION_ROOT = /^[\w.-]*migrat(?:e|ion)[\w.-]*\//i
const VERSIONED_FILE = /(^|\/)(?:v?\d[\w.-]*)\.(?:go|rb|py|sql|ts|js|mjs|php|cs|java|kt|ex)$/i

const DDL_FILE = /(^|\/)(?:schema|structure|data|seed|seeds|fixtures|initial|init)[\w.-]*\.(?:sql|ddl|psql|hql|cql)$/i
/**
 * Schema declaration files that are not `.sql`.
 *
 * `packages/prisma/schema.prisma` produced 119 candidate sites on cal.com — the
 * most of any file in the repository — and came back `trigger: unknown`, so a
 * performance finding on a model declaration would have published as though it
 * were on a hot path. A schema is applied at migrate time whatever syntax it is
 * written in.
 */
const SCHEMA_DECL_FILE = /\.prisma$|(^|\/)(?:schema|structure)\.(?:rb|py|ts|js|json|graphql|graphqls|hcl)$/i
const DDL_DIR = /(^|\/)(?:db|database|sql|ddl)\/(?:[^/]+\/)?[\w.-]+\.(?:sql|ddl|psql)$/i
const SEED_PATH = /(^|\/)seeds?\/|(^|\/)fixtures?\/|(^|\/)factories\//i
const TEST_PATH = /(^|\/)tests?\/|(^|\/)spec\/|[._-]test\.|[._-]spec\.|_tests?\.py$|Test\.(?:java|kt|cs|scala)$|Tests\.(?:java|kt|cs)$/i
const JOB_PATH = /(^|\/)(?:tasks|jobs|workers|commands|consumers|crons?|schedulers?)\//i

/**
 * Request-scoped by location.
 *
 * The symbol chain is only as good as the window it was read in: a query inside
 * a private method 200 lines below its `class GroupsController` declaration
 * comes back with the method name and nothing else. The directory is a fact
 * that does not depend on how far up the class happens to be, and every
 * mainstream framework puts its handlers in one.
 */
const HANDLER_PATH = /(^|\/)(?:controllers?|handlers?|resolvers?|endpoints?|routes?|views?|api)\//i

const HANDLER_SYMBOL = /(?:View|Controller|Handler|Resource|Resolver|Endpoint|Route|Api|Serializer)$/
const HANDLER_DECORATOR =
  /@(?:app|blueprint|bp|router|api)\.(?:route|get|post|put|patch|delete)\b|@(?:Get|Post|Put|Patch|Delete|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping)\s*\(|@rpc_method\b|@api_view\b|@require_(?:GET|POST|http_methods)\b|@HttpGet\b|\[HttpGet\]|\[HttpPost\]/

/**
 * Classify what reaches this code. Deliberately crude: path first, because a
 * path is a fact, then the enclosing symbol, then decorators above it.
 */
export function classifyTrigger(
  path: string,
  symbol: string | null,
  decoratorContext: string,
): TriggerKind {
  if (MIGRATION_PATH.test(path) || SEED_PATH.test(path)) return 'migration'
  if (DDL_FILE.test(path) || DDL_DIR.test(path) || SCHEMA_DECL_FILE.test(path)) return 'migration'
  if (MIGRATION_ROOT.test(path)) return 'migration'
  if (MIGRATION_DIRISH.test(path) && VERSIONED_FILE.test(path)) return 'migration'
  if (TEST_PATH.test(path)) return 'test'
  if (HANDLER_DECORATOR.test(decoratorContext)) return 'request-handler'
  if (symbol && HANDLER_SYMBOL.test(symbol.split('.')[0] ?? '')) return 'request-handler'
  if (symbol && HANDLER_SYMBOL.test(symbol)) return 'request-handler'
  if (HANDLER_PATH.test(path) || /(^|\/)views\.py$/i.test(path)) return 'request-handler'
  if (JOB_PATH.test(path)) return 'job'
  if (symbol && /Command$|Job$|Task$|Worker$|Consumer$/.test(symbol.split('.')[0] ?? '')) return 'job'
  return 'unknown'
}

/**
 * Analyse the scope enclosing `queryLine` (1-based).
 *
 * `lines` must be the *original* source split on newlines — masking is applied
 * internally so a `for` inside a string literal or a comment never registers
 * as a loop.
 */
export function analyseScope(path: string, lines: string[], queryLine: number): EnclosingScope {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const masked = maskNonCode(path, lines.join('\n')).split('\n')
  const idx = Math.max(0, Math.min(masked.length - 1, queryLine - 1))

  const result = INDENT_EXT.has(ext)
    ? walkIndentation(ext, masked, idx)
    : walkBraces(masked, idx)

  // A one-line comprehension loop on the query line itself is still a loop, and
  // the upward walks cannot see it because it opens and closes on one line.
  const own = masked[idx] ?? ''
  if (result.loopDepth === 0 && PY_COMPREHENSION_LOOP.test(own) && INDENT_EXT.has(ext)) {
    result.loopDepth = 1
    result.loopHeaders = [own.trim()]
  }

  const decoratorContext = result.symbolLine
    ? (lines.slice(Math.max(0, result.symbolLine - 6), result.symbolLine).join('\n'))
    : lines.slice(Math.max(0, idx - 6), idx).join('\n')

  const ext2 = ext
  const ownLoopRe = INDENT_EXT.has(ext2)
    ? (ext2 === 'rb' ? RB_LOOP : ext2 === 'ex' || ext2 === 'exs' ? EX_LOOP : PY_LOOP)
    : BRACE_LOOP

  return {
    ...result,
    opensLoop: ownLoopRe.test(own),
    trigger: classifyTrigger(path, result.symbol, decoratorContext),
  }
}

type ScopeCore = Omit<EnclosingScope, 'trigger' | 'opensLoop'>

/**
 * Indentation languages: walk upward tracking the minimum indentation seen.
 * A line indented strictly less than everything below it, back to the query,
 * is an enclosing construct — that is exactly what indentation means here.
 */
function walkIndentation(ext: string, lines: string[], idx: number): ScopeCore {
  const loopRe = ext === 'rb' ? RB_LOOP : ext === 'ex' || ext === 'exs' ? EX_LOOP : PY_LOOP
  const defRe = ext === 'rb' ? RB_DEF : ext === 'ex' || ext === 'exs' ? EX_DEF : PY_DEF

  let minIndent = indentOf(lines[idx] ?? '')
  const loopHeaders: string[] = []
  const symbols: string[] = []
  let symbolLine: number | null = null

  for (let i = idx - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.trim()) continue
    const indent = indentOf(line)
    if (indent >= minIndent) continue

    // Ruby's `.each do` blocks do not always dedent the way `for` does, so the
    // loop test runs before the indentation gate narrows.
    if (loopRe.test(line)) {
      loopHeaders.push(line.trim())
      minIndent = indent
      continue
    }
    const def = defRe.exec(line)
    if (def) {
      const name = def[1]
      if (name) {
        symbols.push(name)
        if (symbolLine === null) symbolLine = i + 1
      }
      minIndent = indent
      continue
    }
    minIndent = indent
  }

  // Ruby blocks that do not dedent the way `for` does: `collection.each do |x|`
  // keeps its body at the same indentation as the header in plenty of real
  // code, so the indentation walk above misses it.
  //
  // Counting `end` on the way up is what makes this sound. Without it, a block
  // that *closed* above the query still registered as enclosing it — on
  // Discourse this put `Group.where(id: ids).pluck(...)` at loop depth 1 when
  // the `@posts.each do … end` around it had ended four lines earlier, and a
  // batched query got reported as the highest-priority N+1 in the file.
  if (ext === 'rb' && loopHeaders.length === 0) {
    const own = indentOf(lines[idx] ?? '')
    let closed = 0
    for (let i = idx - 1; i >= 0 && i >= idx - 40; i--) {
      const line = lines[i]!
      if (!line.trim()) continue
      if (RB_DEF.test(line)) break
      if (indentOf(line) > own) continue

      // A block terminator at or above our own indentation closes something
      // that cannot contain us.
      if (/^\s*(?:end\b|\})/.test(line)) { closed++; continue }

      if (RB_LOOP.test(line)) {
        if (closed > 0) { closed--; continue }
        loopHeaders.push(line.trim())
        break
      }
    }
  }

  return {
    loopDepth: loopHeaders.length,
    loopHeaders,
    symbol: symbols.length ? symbols.slice().reverse().join('.') : null,
    symbolLine,
  }
}

/**
 * Brace languages: walk upward counting unbalanced `}` against `{`. Each time
 * the balance goes positive, the line that opened that block encloses the
 * query — classify it by its header text.
 */
function walkBraces(lines: string[], idx: number): ScopeCore {
  let balance = 0
  const loopHeaders: string[] = []
  const symbols: string[] = []
  let symbolLine: number | null = null

  // Start above the query line: a brace on the query's own line neither opens
  // nor closes a block that contains it.
  for (let i = idx - 1; i >= 0; i--) {
    const line = lines[i]!

    // Scanning upward, a `}` closes a block that does not contain us; its
    // matching `{` further up must therefore be skipped too. Tracking the
    // running balance is what does that skipping.
    balance += count(line, '}') - count(line, '{')

    if (balance < 0) {
      // This line opened a block that encloses the query.
      balance = 0
      const header = headerFor(lines, i)
      if (BRACE_LOOP.test(header)) {
        loopHeaders.push(header.trim())
      } else {
        const name = braceSymbol(header)
        if (name) {
          symbols.push(name)
          if (symbolLine === null) symbolLine = i + 1
        }
      }
    }
  }

  // Go/Rust/Java single-statement loops without braces, and chained
  // `.forEach(x => …)` callbacks whose brace opened on a previous line, are
  // both caught by the balance walk above. What it misses is a loop header
  // whose `{` sits on the *next* line — rare, but cheap to cover.
  return {
    loopDepth: loopHeaders.length,
    loopHeaders,
    symbol: symbols.length ? symbols.slice().reverse().join('.') : null,
    symbolLine,
  }
}

/**
 * A block's header is not always the line carrying the `{` — Java and C# often
 * put the brace on its own line. Look back a little for the real header.
 */
function headerFor(lines: string[], i: number): string {
  const line = lines[i]!
  if (line.trim() !== '{') return line
  for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
    if (lines[k]!.trim()) return lines[k]!
  }
  return line
}

function braceSymbol(header: string): string | null {
  const m = BRACE_DEF.exec(header)
  if (!m) return null
  return m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? null
}

function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n++
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

function count(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n++
  return n
}

/** One-line description for the prompt header and the report. */
export function describeScope(scope: EnclosingScope): string {
  const parts: string[] = []
  if (scope.symbol) parts.push(`enclosing: ${scope.symbol}`)
  parts.push(
    scope.loopDepth > 0
      ? `inside ${scope.loopDepth} loop${scope.loopDepth > 1 ? 's' : ''}`
      : scope.opensLoop
        // Says the thing that matters — this runs per iteration — without
        // claiming something encloses it, which nothing does.
        ? 'opens a loop, so its body runs per iteration'
        : 'not in a loop',
  )
  parts.push(`reached by: ${scope.trigger}`)
  return parts.join('  ·  ')
}
