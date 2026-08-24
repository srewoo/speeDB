import type { Candidate, DbEngine } from '@/core/types'
import { RULES, type DetectRule } from './rules'

const CONTEXT_LINES = 6
/** One file can't dominate the token budget with near-duplicate hits. */
const MAX_CANDIDATES_PER_FILE = 25

/**
 * Candidates below this are discarded, not merely ranked lower.
 *
 * Ordering by confidence only helps when the budget runs out; a weak candidate
 * near the top of a small repo still costs a full analysis slot. Precision is
 * what keeps a scan affordable, so the gate is real.
 */
export const MIN_CONFIDENCE = 0.7

/**
 * Deterministic candidate extraction. Runs entirely locally and costs nothing.
 *
 * Precision matters more than recall here: a false positive burns tokens on the
 * analysis stage, while a false negative is recoverable by the LLM sweep over
 * neighbouring context. The overlap merge below is what keeps a single 40-line
 * query from becoming eight separate candidates.
 */
export function detectInFile(path: string, content: string): Candidate[] {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const lineOffsets = buildLineOffsets(content)
  const hits: { rule: DetectRule; start: number; end: number }[] = []

  for (const rule of RULES) {
    if (rule.extensions && !rule.extensions.includes(ext)) continue
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    let m: RegExpExecArray | null
    let guard = 0
    while ((m = re.exec(content)) !== null) {
      hits.push({ rule, start: m.index, end: m.index + m[0].length })
      // Zero-length match protection.
      if (m.index === re.lastIndex) re.lastIndex++
      if (++guard > 500) break
    }
  }

  if (hits.length === 0) return []

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

  const candidates = merged.slice(0, MAX_CANDIDATES_PER_FILE).map((span, i) => {
    const best = span.rules.reduce((a, b) => (b.confidence > a.confidence ? b : a))
    const startLine = lineOf(lineOffsets, span.start)
    const endLine = lineOf(lineOffsets, span.end)
    const from = Math.max(1, startLine - CONTEXT_LINES)
    const to = endLine + CONTEXT_LINES

    return {
      id: `${path}:${startLine}:${i}`,
      file: path,
      startLine,
      endLine,
      excerpt: sliceLines(content, from, to),
      engine: pickEngine(span.rules),
      accessStyle: best.accessStyle,
      detector: [...new Set(span.rules.map((r) => r.name))].join('+'),
      confidence: Math.min(0.99, best.confidence + 0.05 * (span.rules.length - 1)),
    }
  })

  return candidates.filter((c) => c.confidence >= MIN_CONFIDENCE)
}

/** Prefer a rule that actually identified an engine over the `unknown` default. */
function pickEngine(rules: DetectRule[]): DbEngine {
  const known = rules.filter((r) => r.engine !== 'unknown')
  if (known.length === 0) return 'unknown'
  return known.reduce((a, b) => (b.confidence > a.confidence ? b : a)).engine
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
