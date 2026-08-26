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

describe('the prompt talking back is not data', () => {
  /*
   * On a real scan, 18 of 27 findings returned `requiredMigration: "omit"` —
   * the literal placeholder from the response schema, echoed as a value. Each
   * one showed the user "DDL that must run first: omit", added the "does this
   * index already exist in production" caveat that only applies to a real index,
   * and let a `missing-index` finding claim to concern a schema object, which
   * exempted it from cold-path suppression.
   */
  const withMigration = (v: unknown) => JSON.stringify({
    findings: [{
      title: 'x', original: 'SELECT 1', primaryOccurrence: { file: 'a.sql', startLine: 1 },
      suggestion: { proposed: 'SELECT 1', requiredMigration: v },
    }],
  })

  it.each(['omit', 'none', 'N/A', 'n/a', 'null', '-', '...', 'not applicable', 'None needed', '  omit  '])(
    'drops the placeholder %j', (v) => {
      const { findings } = parseFindings(withMigration(v))
      expect(findings[0]!.suggestion.requiredMigration).toBeUndefined()
    },
  )

  it('drops prose that merely talks about a migration', () => {
    const { findings } = parseFindings(withMigration('A migration would be needed for this.'))
    expect(findings[0]!.suggestion.requiredMigration).toBeUndefined()
  })

  it('keeps real DDL', () => {
    for (const ddl of [
      'CREATE INDEX idx_policy_tenant ON policy (tenant_id);',
      'ALTER TABLE policy ADD COLUMN slug varchar(255);',
      'DROP INDEX IF EXISTS tenant_id_key;',
      'op.create_index("ix_a", "t", ["a"])',
      'add_index :test_cases, :section_id',
    ]) {
      const { findings } = parseFindings(withMigration(ddl))
      expect(findings[0]!.suggestion.requiredMigration, ddl).toBe(ddl)
    }
  })

  it('the response schema no longer invites the echo', async () => {
    const { SYSTEM_PROMPT } = await import('@/core/analyze/prompt')
    expect(SYSTEM_PROMPT).toMatch(/OMIT THIS KEY ENTIRELY/)
    expect(SYSTEM_PROMPT).not.toMatch(/DDL that must run first, or omit/)
  })
})
