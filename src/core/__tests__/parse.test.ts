import { describe, expect, it } from 'vitest'
import { parseFindings } from '../analyze/parse'

const ONE = {
  findings: [
    {
      kind: 'equivalent',
      title: 'Add LIMIT 1',
      original: 'SELECT * FROM t',
      primaryOccurrence: { file: 'a.py', startLine: 3, endLine: 3, excerpt: 'x' },
      suggestion: { proposed: 'SELECT * FROM t LIMIT 1' },
    },
  ],
}

describe('parseFindings', () => {
  it('parses a bare JSON object', () => {
    expect(parseFindings(JSON.stringify(ONE)).findings).toHaveLength(1)
  })

  it('unwraps a ```json fence', () => {
    const raw = '```json\n' + JSON.stringify(ONE) + '\n```'
    expect(parseFindings(raw).findings).toHaveLength(1)
  })

  it('ignores prose before and after the object', () => {
    const raw = `Sure! Here is the analysis:\n${JSON.stringify(ONE)}\nLet me know if you need more.`
    expect(parseFindings(raw).findings).toHaveLength(1)
  })

  it('handles nested braces inside string values', () => {
    const raw = JSON.stringify({
      findings: [{ ...ONE.findings[0], summary: 'uses ${tenant} and { braces }' }],
    })
    expect(parseFindings(raw).findings).toHaveLength(1)
  })

  it('recovers the complete findings from a truncated response', () => {
    const full = JSON.stringify({ findings: [ONE.findings[0], ONE.findings[0]] })
    const truncated = full.slice(0, full.length - 40)
    expect(parseFindings(truncated).findings.length).toBeGreaterThanOrEqual(1)
  })

  it('returns an error rather than throwing on garbage', () => {
    expect(parseFindings('I cannot help with that.').parseError).toBeTruthy()
    expect(parseFindings('').parseError).toBeTruthy()
  })

  it('treats an explicit empty result as a valid answer', () => {
    const r = parseFindings('{"findings":[]}')
    expect(r.parseError).toBeUndefined()
    expect(r.findings).toHaveLength(0)
  })

  it('drops malformed entries but keeps good ones', () => {
    const raw = JSON.stringify({ findings: [{ nope: true }, ONE.findings[0]] })
    expect(parseFindings(raw).findings).toHaveLength(1)
  })

  it('defaults missing fields instead of producing undefined holes', () => {
    const f = parseFindings(JSON.stringify(ONE)).findings[0]!
    expect(f.severity).toBe('medium')
    expect(f.evidence).toEqual([])
    expect(f.suggestion.assumptions).toEqual([])
    expect(f.grounding).toBe('needs-verification')
  })
})
