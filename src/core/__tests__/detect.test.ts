import { describe, expect, it } from 'vitest'
import { detectInFile } from '../detect/scan'

describe('detectInFile', () => {
  it('finds parameterised Postgres SQL in Python and tags the engine', () => {
    const src = [
      'async def get_all(self):',
      '    rows = await Database.fetch(',
      '        conn,',
      '        "SELECT id, policy_uname, status FROM policy WHERE tenant_id=$1",',
      '        self._tenant_id,',
      '    )',
    ].join('\n')

    const found = detectInFile('src/policy_handler.py', src)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.engine).toBe('postgres')
    expect(found[0]!.startLine).toBe(4)
  })

  it('reports real 1-based line numbers', () => {
    const src = `${'\n'.repeat(40)}const q = "SELECT * FROM users WHERE id = 1"`
    const found = detectInFile('a.ts', src)
    expect(found[0]!.startLine).toBe(41)
  })

  it('merges adjacent hits into one candidate instead of eight', () => {
    const src = `
      const a = "SELECT x FROM t WHERE a = 1"
      const b = "SELECT y FROM t WHERE b = 2"
      const c = "SELECT z FROM t WHERE c = 3"
    `
    expect(detectInFile('a.ts', src).length).toBe(1)
  })

  it('does not fire on prose that merely contains SQL keywords', () => {
    const src = '// The user can select from a list and update their profile settings.'
    expect(detectInFile('a.ts', src)).toHaveLength(0)
  })

  it('respects the extension filter on language-specific rules', () => {
    const django = 'qs = Meeting.objects.filter(tenant_id=1).select_related("owner")'
    expect(detectInFile('views.py', django).length).toBeGreaterThan(0)
    // Same text in a .go file must not match the Django rule.
    const goHits = detectInFile('main.go', django)
    expect(goHits.every((h) => !h.detector.includes('django'))).toBe(true)
  })

  it('treats .sql files as DDL with high confidence', () => {
    const found = detectInFile('db/init.sql', 'CREATE INDEX idx ON policy USING btree (tenant_id);')
    expect(found[0]!.accessStyle).toBe('ddl-migration')
    expect(found[0]!.confidence).toBeGreaterThan(0.9)
  })

  it('includes context lines around the match', () => {
    const src = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
      .replace('line 15', 'db.query("SELECT a FROM b WHERE c = 1")')
    const found = detectInFile('a.ts', src)
    expect(found[0]!.excerpt).toContain('line 10')
  })
})
