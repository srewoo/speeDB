import type { Candidate, DbEngine } from '@/core/types'
import { RULES, type DetectRule } from './rules'
import { maskComments, maskNonCode } from './mask'
import { analyseScope, type EnclosingScope } from './scope'
import { scorePriority } from './priority'
import { engineFromPath, profileDeclares, type EngineProfile } from './engine-profile'

const CONTEXT_LINES = 6

/**
 * One file can't dominate the token budget with near-duplicate hits.
 *
 * Raised from 25 now that capping happens on priority rather than on line
 * order: the marginal candidate at 40 is genuinely marginal, whereas at 25 the
 * cap was routinely discarding the expensive half of a large `views.py`. The
 * real budget control is `chunkCandidates()` and `opts.tokenBudget`, not this.
 */
export const MAX_CANDIDATES_PER_FILE = 40

/**
 * Candidates below this are discarded, not merely ranked lower.
 *
 * Ordering by confidence only helps when the budget runs out; a weak candidate
 * near the top of a small repo still costs a full analysis slot. Precision is
 * what keeps a scan affordable, so the gate is real.
 */
export const MIN_CONFIDENCE = 0.7

/** A file where the per-file cap bit. Reported, never silent. */
export interface Truncation {
  path: string
  found: number
  analysed: number
}

export interface DetectResult {
  candidates: Candidate[]
  /** Merged spans before any filtering — the honest denominator. */
  matched: number
  /** Dropped below `MIN_CONFIDENCE`. */
  belowConfidence: number
  /** Dropped by the per-file cap, lowest priority first. */
  lowPriority: number
  truncation: Truncation | null
}

export interface DetectOptions {
  /**
   * What the repository declares it connects to. Without it, engine labelling
   * falls back to whichever local rule shouted loudest — which is how a Django
   * project acquired MongoDB, Hive, BigQuery, Redshift and OpenSearch labels.
   */
  profile?: EngineProfile
}

/**
 * Deterministic candidate extraction. Runs entirely locally and costs nothing.
 *
 * Precision matters more than recall here: a false positive burns tokens on the
 * analysis stage, while a false negative is recoverable by the LLM sweep over
 * neighbouring context. The overlap merge below is what keeps a single 40-line
 * query from becoming eight separate candidates.
 *
 * Three things happen in a specific order, and the order is the point:
 * rules match against *masked* source so comments and prose cannot set an
 * engine label; candidates are filtered on confidence, then ranked on priority,
 * then capped — because slicing first spends slots on spans that are about to
 * be thrown away; and every kept span carries its enclosing scope, so the model
 * can see the loop that the six context lines would have hidden.
 */
export function detectInFile(
  path: string,
  content: string,
  opts: DetectOptions = {},
): Candidate[] {
  return detectInFileVerbose(path, content, opts).candidates
}

/**
 * Prose. Not source, and never a query site.
 *
 * A changelog is the worst case: it is long, it quotes SQL, it uses English
 * words that are also SQL keywords, and it has no comment syntax for masking to
 * work with. On a real 953-file repository these files produced 208 of 1,108
 * candidates — 19% of the analysis budget — with `CHANGELOG.rst` and one
 * markdown file the only two files to hit the per-file cap. Every one of those
 * candidates is a query site that does not exist.
 *
 * Config formats (`yml`, `json`, `toml`) are deliberately NOT here: a query in a
 * dbt model, a Liquibase changelog or a Helm values file is a real query.
 */
const PROSE_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'rst', 'txt', 'adoc', 'asciidoc', 'org', 'tex',
  'po', 'pot', 'mo', 'csv', 'tsv', 'log', 'lock', 'svg',
])

/**
 * Stylesheets. Presentation, never data access.
 *
 * 551 of the corpus's candidates were SCSS — the largest single category of
 * false positive left. SCSS module calls look enough like method chains to trip
 * the graph-traversal rule (`breakpoint.until(...)`, `list.repeat(...)`), and a
 * stylesheet has no comment syntax registered for masking, so its whole body is
 * matchable. No stylesheet has ever contained a database query.
 */
const STYLE_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss'])

/**
 * Files with no extension at all.
 *
 * Init scripts, service units, gitignore templates, wrapper executables. They
 * match engine *vocabulary* — Gitea's `options/gitignore/Node` mentions
 * dynamodb, a Gentoo service script mentions memcached — and they are never
 * where an application's queries live. `Rakefile` is the one real exception:
 * it is Ruby, and Ruby in a Rakefile can genuinely touch ActiveRecord.
 */
const EXTENSIONLESS_ALLOWED = new Set(['rakefile', 'gemfile'])

function isExtensionless(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (!name || name.includes('.')) return false
  return !EXTENSIONLESS_ALLOWED.has(name)
}

/**
 * Build wrappers and shell scripts. Machinery, not application data access.
 *
 * `spring-petclinic` gave up 5 of its 29 candidates — 17% — to `mvnw`,
 * `gradlew` and their `.bat`/`.cmd` twins. `sql-fragment-concat` was matching
 * English inside shell strings: `echo "Please disable validation by removing
 * 'distributionSha256Sum' from your …"` fires on `' from `, and
 * `eval "set -- $("` fires on `" set `. No build wrapper has ever contained a
 * query, so the cheapest correct answer is not to read them.
 */
const BUILD_SCRIPTS = new Set(['mvnw', 'gradlew', 'gradle', 'configure', 'bootstrap'])
const SCRIPT_EXTENSIONS = new Set(['bat', 'cmd', 'ps1', 'sh', 'bash', 'zsh', 'fish', 'nu'])

export function isBuildScript(path: string): boolean {
  const name = path.toLowerCase().split('/').pop() ?? ''
  if (BUILD_SCRIPTS.has(name)) return true
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  // `mvnw.cmd`, `gradlew.bat` — the wrapper with a Windows extension.
  if (SCRIPT_EXTENSIONS.has(ext) && BUILD_SCRIPTS.has(name.slice(0, name.lastIndexOf('.')))) return true
  return SCRIPT_EXTENSIONS.has(ext) && (ext === 'bat' || ext === 'cmd' || ext === 'ps1')
}

/**
 * Translation catalogues. Prose, whatever they are serialised as.
 *
 * Extension alone cannot decide this: `.yml` and `.json` are excluded from
 * PROSE_EXTENSIONS on purpose, because a dbt model or a Liquibase changelog is
 * a real query. A path is what distinguishes them. At scale these were among
 * the worst files in the corpus — `config/locales/client.en.yml` produced 51
 * candidate sites in Discourse and `options/locale/locale_en-US.json` produced
 * 43 in Gitea, both hitting the per-file cap with sentences.
 */
const LOCALE_PATH = /(^|\/)(?:locales?|i18n|intl|translations?|lang|messages)\/|(^|\/)LC_MESSAGES\//i

export function isLocaleFile(path: string): boolean {
  return LOCALE_PATH.test(path)
}

/**
 * Not source that can hold a query.
 *
 * Kept as one predicate because the callers all want the same answer: prose,
 * stylesheets, build machinery, translation catalogues and extensionless
 * scripts are all files where a query site cannot exist, and the cheapest
 * correct handling of every one of them is not to read it.
 */
export function isProseFile(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return (
    PROSE_EXTENSIONS.has(ext) ||
    STYLE_EXTENSIONS.has(ext) ||
    isBuildScript(path) ||
    isLocaleFile(path) ||
    isExtensionless(path)
  )
}

export function detectInFileVerbose(
  path: string,
  content: string,
  opts: DetectOptions = {},
): DetectResult {
  const empty: DetectResult = {
    candidates: [], matched: 0, belowConfidence: 0, lowPriority: 0, truncation: null,
  }
  if (isProseFile(path)) return empty
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const lineOffsets = buildLineOffsets(content)

  // Two masked views of the same bytes, both length-preserving so every offset
  // still indexes the original: code only, and code plus string bodies.
  const codeOnly = maskNonCode(path, content)
  const withStrings = maskComments(path, content)

  const hits: { rule: DetectRule; start: number; end: number }[] = []

  for (const rule of RULES) {
    if (rule.extensions && !rule.extensions.includes(ext)) continue
    // Comments are masked for every rule; string bodies are masked only for the
    // rules that opted out of seeing them.
    const haystack = rule.scope === 'code' ? codeOnly : withStrings
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m: RegExpExecArray | null
    let guard = 0
    while ((m = re.exec(haystack)) !== null) {
      hits.push({ rule, start: m.index, end: m.index + m[0].length })
      // Zero-length match protection.
      if (m.index === re.lastIndex) re.lastIndex++
      if (++guard > 500) break
    }
  }

  if (hits.length === 0) return empty

  hits.sort((a, b) => a.start - b.start)

  // Merge hits whose context windows overlap, keeping the highest-confidence
  // rule's classification for the merged span.
  const merged: { rules: DetectRule[]; start: number; end: number }[] = []
  for (const hit of hits) {
    const last = merged[merged.length - 1]
    // Concatenated SQL arrives as several small literals on consecutive lines,
    // so fragment hits get a wider merge window than ordinary ones. Without
    // it each fragment becomes its own useless candidate.
    const isFragment = hit.rule.name.startsWith('sql-fragment') ||
      last?.rules.some((r) => r.name.startsWith('sql-fragment'))
    const window = isFragment ? 400 : 120

    if (last && hit.start <= last.end + window) {
      last.end = Math.max(last.end, hit.end)
      last.rules.push(hit.rule)
    } else {
      merged.push({ rules: [hit.rule], start: hit.start, end: hit.end })
    }
  }

  const lines = content.split('\n')

  const scored = merged.map((span, i) => {
    const best = span.rules.reduce((a, b) => (b.confidence > a.confidence ? b : a))
    const startLine = lineOf(lineOffsets, span.start)
    const endLine = lineOf(lineOffsets, span.end)
    const scope = analyseScope(path, lines, startLine)
    const excerpt = buildExcerpt(content, lines, startLine, endLine, scope)
    const accessStyle = best.accessStyle
    const priority = scorePriority({ path, excerpt, enclosing: scope, accessStyle })

    return {
      id: `${path}:${startLine}:${i}`,
      file: path,
      startLine,
      endLine,
      excerpt,
      engine: pickEngine(span.rules, opts.profile, path),
      accessStyle,
      detector: [...new Set(span.rules.map((r) => r.name))].join('+'),
      confidence: Math.min(0.99, best.confidence + 0.05 * (span.rules.length - 1)),
      priority: priority.score,
      priorityReasons: priority.reasons,
      scope,
    } satisfies Candidate
  })

  // Filter, then sort, then slice. The old order sliced first, mapped, then
  // filtered — so a low-confidence span consumed one of the slots and was then
  // thrown away, wasting it entirely.
  const confident = scored.filter((c) => c.confidence >= MIN_CONFIDENCE)
  const ranked = [...confident].sort((a, b) =>
    b.priority - a.priority || b.confidence - a.confidence || a.startLine - b.startLine)
  const kept = ranked.slice(0, MAX_CANDIDATES_PER_FILE)

  return {
    candidates: kept,
    matched: merged.length,
    belowConfidence: scored.length - confident.length,
    lowPriority: confident.length - kept.length,
    truncation: confident.length > MAX_CANDIDATES_PER_FILE
      ? { path, found: confident.length, analysed: kept.length }
      : null,
  }
}

/**
 * The excerpt the model actually sees.
 *
 * Widening `CONTEXT_LINES` globally would multiply token cost across every
 * candidate to fix a problem that only affects candidates inside a loop. So the
 * loop headers are prepended as an elided prefix instead: the model sees the
 * `for` nine lines up without paying for the eight lines in between.
 */
function buildExcerpt(
  content: string,
  lines: string[],
  startLine: number,
  endLine: number,
  scope: EnclosingScope,
): string {
  const from = Math.max(1, startLine - CONTEXT_LINES)
  const to = endLine + CONTEXT_LINES
  const body = sliceLines(content, from, to)

  if (scope.loopHeaders.length === 0) return body

  // Nearest-first from the walk; render outermost-first, the way the file reads.
  const headers: string[] = []
  for (const header of [...scope.loopHeaders].reverse()) {
    const at = lines.findIndex((l) => l.trim() === header)
    if (at === -1 || at + 1 >= from) continue
    headers.push(`${String(at + 1).padStart(5, ' ')}| ${lines[at]}`)
  }
  if (headers.length === 0) return body

  return [...headers, `      … (lines above ${from} omitted)`, body].join('\n')
}

/**
 * Reconcile a local rule hit against what the repository declares.
 *
 * A genuine dialect marker — `ON CONFLICT`, `ROWNUM`, `PREWHERE` — is evidence
 * about this statement and wins outright. Engine *vocabulary* is not: matching
 * the word `redshift` or a bare `.aggregate(` says something about the token,
 * not about the data store, and when the repository never declared that store
 * the local guess is simply wrong.
 */
const DIALECT_RULES = new Set([
  'postgres-dialect', 'postgres-placeholder', 'mysql-dialect', 'mssql-dialect',
  'oracle-dialect', 'sqlite-dialect', 'clickhouse', 'pgvector', 'cassandra-cql',
  'cql-file', 'hive-file', 'cypher', 'cypher-file', 'promql',
])

export function pickEngine(
  rules: DetectRule[],
  profile?: EngineProfile,
  path?: string,
): DbEngine {
  // Highest-confidence dialect marker, not the first one in rule order: a span
  // carrying both `$1` (postgres-placeholder, 0.85) and `<->` (pgvector, 0.92)
  // is pgvector, and rule declaration order has nothing to say about that.
  const dialects = rules.filter((r) => DIALECT_RULES.has(r.name) && r.engine !== 'unknown')
  if (dialects.length > 0) {
    return dialects.reduce((a, b) => (b.confidence > a.confidence ? b : a)).engine
  }

  const named = rules.filter((r) => r.engine !== 'unknown')

  // A directory named after an engine outranks any repository-wide guess: it is
  // evidence about *this file*. `db/mysql/schema.sql` is MySQL even in a repo
  // whose profile leads with Postgres.
  const fromPath = path ? engineFromPath(path) : null
  if (fromPath) return fromPath

  if (profile && profile.declared.length > 0) {
    // A local hit the repository corroborates is trustworthy.
    const corroborated = named
      .filter((r) => profileDeclares(profile, r.engine))
      .sort((a, b) => b.confidence - a.confidence)[0]
    if (corroborated) return corroborated.engine
    // Otherwise the repo profile is better evidence than the loudest regex —
    // but only when the profile actually points somewhere. A repository that
    // supports three engines equally (Gitea, and petclinic's H2/MySQL/Postgres
    // profiles) has no single answer, and asserting the first one alphabetically
    // is how `db/mysql/schema.sql` came back labelled postgres. Saying
    // `unknown` is the honest result, and the engine notes in the prompt then
    // stay silent rather than applying the wrong dialect's semantics.
    if (!profile.ambiguous && profile.primary !== 'unknown') return profile.primary
    if (profile.ambiguous) return 'unknown'
  }

  if (named.length === 0) return profile?.primary ?? 'unknown'
  return named.reduce((a, b) => (b.confidence > a.confidence ? b : a)).engine
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1)
  }
  return offsets
}

/** Binary search: char offset -> 1-based line number. */
function lineOf(offsets: number[], pos: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid]! <= pos) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 1-based, inclusive. Used for both excerpts and grounding re-verification. */
export function sliceLines(text: string, from: number, to: number): string {
  return text.split('\n').slice(Math.max(0, from - 1), to).join('\n')
}
