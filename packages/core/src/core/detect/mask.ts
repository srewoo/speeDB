/**
 * Comment and string-literal masking.
 *
 * Detection used to run on raw bytes, which meant a code comment reading
 * `# TODO: migrate this to opensearch` set the engine label for the span it
 * sat in, and commented-out code produced candidates that no longer exist.
 *
 * Masking replaces the *interior* of comments and string literals with spaces
 * of equal length. Every character offset — and therefore every line number —
 * is preserved exactly, so the caller can keep using offsets from the masked
 * text to slice the original.
 *
 * Quote characters themselves are never removed: rules that legitimately
 * anchor on a quote (`sql-in-string-literal`, `sql-fragment-concat`) still
 * need them, and those rules opt into seeing string bodies via
 * `scope: 'code-and-strings'` on the rule.
 */

interface LangSyntax {
  /** Line-comment openers. */
  line: string[]
  /** Block-comment delimiter pairs. */
  block: [string, string][]
  /** Quote delimiters, longest first so `"""` beats `"`. */
  quotes: string[]
  /** True when a backslash escapes the next character inside a string. */
  backslashEscapes: boolean
}

const C_LIKE: LangSyntax = {
  line: ['//'],
  block: [['/*', '*/']],
  quotes: ['`', '"', "'"],
  backslashEscapes: true,
}

const HASH_LIKE: LangSyntax = {
  line: ['#'],
  block: [],
  quotes: ['"""', "'''", '"', "'"],
  backslashEscapes: true,
}

const SYNTAX: Record<string, LangSyntax> = {
  // C family and everything that borrowed its comments.
  js: C_LIKE, jsx: C_LIKE, ts: C_LIKE, tsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE,
  mts: C_LIKE, cts: C_LIKE, svelte: C_LIKE, vue: C_LIKE,
  java: C_LIKE, kt: C_LIKE, kts: C_LIKE, scala: C_LIKE, groovy: C_LIKE,
  go: C_LIKE, rs: C_LIKE, swift: C_LIKE, dart: C_LIKE, zig: C_LIKE,
  c: C_LIKE, cc: C_LIKE, cpp: C_LIKE, h: C_LIKE, hpp: C_LIKE, m: C_LIKE, mm: C_LIKE,
  cs: C_LIKE, fs: C_LIKE, php: C_LIKE, json5: C_LIKE, prisma: C_LIKE,

  // Hash-comment family.
  py: HASH_LIKE, pyi: HASH_LIKE, pyx: HASH_LIKE,
  rb: HASH_LIKE, pl: HASH_LIKE, r: HASH_LIKE, jl: HASH_LIKE,
  ex: HASH_LIKE, exs: HASH_LIKE, sh: HASH_LIKE, bash: HASH_LIKE, zsh: HASH_LIKE,
  yaml: HASH_LIKE, yml: HASH_LIKE, toml: HASH_LIKE, cfg: HASH_LIKE, ini: HASH_LIKE,

  // SQL and its dialect files.
  sql: { line: ['--'], block: [['/*', '*/']], quotes: ['"', "'", '`'], backslashEscapes: false },
  ddl: { line: ['--'], block: [['/*', '*/']], quotes: ['"', "'", '`'], backslashEscapes: false },
  psql: { line: ['--'], block: [['/*', '*/']], quotes: ['"', "'", '`'], backslashEscapes: false },
  hql: { line: ['--'], block: [['/*', '*/']], quotes: ['"', "'", '`'], backslashEscapes: false },
  q: { line: ['--'], block: [['/*', '*/']], quotes: ['"', "'", '`'], backslashEscapes: false },
  cql: { line: ['--'], block: [['/*', '*/']], quotes: ['"', "'"], backslashEscapes: false },
  cypher: { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], backslashEscapes: true },
  cyp: { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"], backslashEscapes: true },
  lua: { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"], backslashEscapes: true },
  erl: { line: ['%'], block: [], quotes: ['"'], backslashEscapes: true },
  clj: { line: [';'], block: [], quotes: ['"'], backslashEscapes: true },
  cljs: { line: [';'], block: [], quotes: ['"'], backslashEscapes: true },
  vb: { line: ["'"], block: [], quotes: ['"'], backslashEscapes: false },
  html: { line: [], block: [['<!--', '-->']], quotes: ['"', "'"], backslashEscapes: false },
  xml: { line: [], block: [['<!--', '-->']], quotes: ['"', "'"], backslashEscapes: false },
}

/** Files with no comment syntax we know: masked as plain text (unchanged). */
const PLAIN: LangSyntax = { line: [], block: [], quotes: [], backslashEscapes: false }

export interface MaskOptions {
  /**
   * Blank string-literal bodies too. Default true.
   *
   * Rules declaring `scope: 'code-and-strings'` need the bodies — a SQL
   * statement lives inside a string literal by definition — so they run
   * against `maskComments()` instead.
   */
  strings?: boolean
}

/**
 * Replace comment (and optionally string-literal) bodies with spaces of equal
 * length. Newlines are always preserved, so line numbers never shift.
 */
export function maskNonCode(path: string, content: string, opts: MaskOptions = {}): string {
  const maskStrings = opts.strings !== false
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const syn = SYNTAX[ext] ?? PLAIN
  if (syn === PLAIN) return content

  const out = content.split('')
  const n = content.length
  let i = 0

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  while (i < n) {
    // Line comment.
    const lineOpener = syn.line.find((o) => content.startsWith(o, i))
    if (lineOpener) {
      const nl = content.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      blank(i, end)
      i = end
      continue
    }

    // Block comment.
    const blockPair = syn.block.find(([open]) => content.startsWith(open, i))
    if (blockPair) {
      const [open, close] = blockPair
      const closeAt = content.indexOf(close, i + open.length)
      const end = closeAt === -1 ? n : closeAt + close.length
      blank(i, end)
      i = end
      continue
    }

    // String literal. Quotes are kept; the body is blanked when asked.
    const quote = syn.quotes.find((q) => content.startsWith(q, i))
    if (quote) {
      const bodyStart = i + quote.length
      let j = bodyStart
      while (j < n) {
        if (syn.backslashEscapes && content[j] === '\\') { j += 2; continue }
        if (content.startsWith(quote, j)) break
        j++
      }
      const bodyEnd = Math.min(j, n)
      // A docstring is documentation, and documentation is never a query — so
      // it is masked even when string bodies are being kept. Without this the
      // dialect rules match English: "a *returning* browser" fires
      // `RETURNING \w+`, "probes *connect by* IP" fires Oracle's `CONNECT BY`,
      // and `Bug<->Tag` fires the pgvector distance operator. Found by running
      // detection over a real 953-file repository, where every stray engine
      // label surviving the engine profile came from prose in a docstring.
      //
      // The test is positional, and that is what keeps it safe: a docstring
      // opens its own statement. `QUERY = """SELECT …"""` and
      // `cursor.execute("""SELECT …""")` both have something before the quote on
      // that line, so SQL held in a triple-quoted string stays visible to the
      // rules that need it.
      if (maskStrings || isDocstring(content, i, quote)) blank(bodyStart, bodyEnd)
      i = bodyEnd + (bodyEnd < n ? quote.length : 0)
      continue
    }

    i++
  }

  return out.join('')
}

/**
 * Is the string starting at `at` documentation rather than a value?
 *
 * True when its opening quote is the first non-whitespace character on its
 * line — exactly the shape of a docstring, and not the shape of an assignment
 * or a call argument.
 */
function isDocstring(content: string, at: number, quote: string): boolean {
  // Only the triple-quote forms are ever docstrings; a short quoted string at
  // the start of a line is far more likely to be data.
  if (quote.length < 3) return false
  const lineStart = content.lastIndexOf('\n', at - 1) + 1
  return content.slice(lineStart, at).trim() === ''
}

/** Comments blanked, string bodies intact. For `scope: 'code-and-strings'`. */
export function maskComments(path: string, content: string): string {
  return maskNonCode(path, content, { strings: false })
}
