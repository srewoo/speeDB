import type { Finding } from '@/core/types'

/**
 * Extract the JSON object from a model response.
 *
 * Every provider misbehaves differently: fenced blocks, a leading "Here is",
 * a trailing explanation, or a truncated tail when max_tokens is hit. All of
 * that is handled here so the adapters stay dumb.
 */
export function parseFindings(raw: string): { findings: Finding[]; parseError?: string } {
  const text = stripFence(raw).trim()
  if (!text) return { findings: [], parseError: 'Model returned an empty response.' }

  const candidate = extractObject(text)
  if (!candidate) return { findings: [], parseError: 'No JSON object found in the response.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    // One repair attempt: a response truncated mid-array is the common case.
    const repaired = repairTruncated(candidate)
    if (!repaired) return { findings: [], parseError: 'Response was not valid JSON.' }
    try {
      parsed = JSON.parse(repaired)
    } catch {
      return { findings: [], parseError: 'Response was not valid JSON, and could not be repaired.' }
    }
  }

  const list = (parsed as { findings?: unknown }).findings
  if (!Array.isArray(list)) {
    return { findings: [], parseError: 'Response JSON had no "findings" array.' }
  }

  const findings = list.filter(isPlausibleFinding).map(normalise)
  return { findings }
}

function stripFence(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return fence?.[1] ?? text
}

/** Brace-matching scan — regex can't balance nested objects reliably. */
function extractObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  // Unbalanced — return the tail so repairTruncated gets a shot.
  return text.slice(start)
}

/**
 * Repair a response that was cut off mid-array (max_tokens hit).
 *
 * A naive `lastIndexOf('},')` picks a brace nested inside the *incomplete*
 * element and produces invalid JSON. Instead, walk the text tracking bracket
 * depth and string state, remember the last offset at which a complete element
 * of the findings array closed, cut there, and close the still-open brackets.
 */
function repairTruncated(text: string): string | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  let lastElementEnd = -1
  let closersAtCut = ''

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue

    if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      stack.pop()
      // Depth 2 means: inside the root object, inside the findings array —
      // so the value that just closed is a complete finding.
      if (stack.length === 2) {
        lastElementEnd = i + 1
        closersAtCut = stack
          .slice()
          .reverse()
          .map((b) => (b === '{' ? '}' : ']'))
          .join('')
      }
    }
  }

  if (lastElementEnd === -1) return null
  return text.slice(0, lastElementEnd) + closersAtCut
}

function isPlausibleFinding(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null) return false
  const f = x as Record<string, unknown>
  return typeof f.title === 'string' && typeof f.original === 'string' && !!f.primaryOccurrence
}

let seq = 0

/** Fill defaults so downstream code never guards on missing optional fields. */
function normalise(raw: Record<string, unknown>): Finding {
  const occ = (raw.primaryOccurrence ?? {}) as Record<string, unknown>
  const sug = (raw.suggestion ?? {}) as Record<string, unknown>

  return {
    id: `f${++seq}-${Date.now().toString(36)}`,
    kind: raw.kind === 'behavioural' ? 'behavioural' : 'equivalent',
    title: String(raw.title ?? 'Untitled finding'),
    summary: String(raw.summary ?? ''),
    severity: pick(raw.severity, ['critical', 'high', 'medium', 'low', 'info'], 'medium'),
    category: String(raw.category ?? 'other') as Finding['category'],
    engine: String(raw.engine ?? 'unknown') as Finding['engine'],
    accessStyle: String(raw.accessStyle ?? 'raw-sql') as Finding['accessStyle'],
    original: String(raw.original ?? ''),
    primaryOccurrence: {
      file: String(occ.file ?? ''),
      startLine: num(occ.startLine, 0),
      endLine: num(occ.endLine, num(occ.startLine, 0)),
      enclosingSymbol: occ.enclosingSymbol ? String(occ.enclosingSymbol) : undefined,
      triggeredBy: occ.triggeredBy ? String(occ.triggeredBy) : undefined,
      excerpt: String(occ.excerpt ?? ''),
    },
    otherOccurrences: Array.isArray(raw.otherOccurrences)
      ? (raw.otherOccurrences as Finding['otherOccurrences'])
      : [],
    suggestion: {
      proposed: String(sug.proposed ?? ''),
      rationale: String(sug.rationale ?? ''),
      equivalenceArgument: String(sug.equivalenceArgument ?? ''),
      assumptions: Array.isArray(sug.assumptions) ? sug.assumptions.map(String) : [],
      expectedImpact: String(sug.expectedImpact ?? ''),
      requiredMigration: sug.requiredMigration ? String(sug.requiredMigration) : undefined,
    },
    evidence: Array.isArray(raw.evidence) ? (raw.evidence as Finding['evidence']) : [],
    grounding: 'needs-verification',
    groundingNotes: [],
    modelConfidence: num(raw.modelConfidence, 0.5),
  }
}

function pick<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
