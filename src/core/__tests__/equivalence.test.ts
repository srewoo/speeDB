import { describe, expect, it } from 'vitest'
import { checkEquivalence } from '../analyze/equivalence'
import { readSqlShape } from '../analyze/sql-shape'

describe('readSqlShape', () => {
  it('extracts the clauses that matter', () => {
    const s = readSqlShape(`
      SELECT DISTINCT a.id, a.name AS label
      FROM users a JOIN orgs o ON o.id = a.org_id
      WHERE a.tenant = $1
      GROUP BY a.id, a.name
      HAVING count(*) > 1
      ORDER BY a.name DESC
      LIMIT 10 OFFSET 20
    `)!
    expect(s.kind).toBe('select')
    expect(s.distinct).toBe(true)
    expect(s.projection).toEqual(['a.id', 'a.name as label'])
    expect(s.groupBy).toEqual(['a.id', 'a.name'])
    expect(s.orderBy).toEqual(['a.name desc'])
    expect(s.limit).toBe('10')
    expect(s.offset).toBe('20')
    expect(s.joins).toBe(1)
  })

  it('is not fooled by clause keywords inside strings or comments', () => {
    const s = readSqlShape(`SELECT id -- ORDER BY nope
      FROM t WHERE name = 'GROUP BY xyz'`)!
    expect(s.orderBy).toEqual([])
    expect(s.groupBy).toEqual([])
    expect(s.projection).toEqual(['id'])
  })

  it('ignores clause keywords nested inside a subquery', () => {
    const s = readSqlShape(
      `SELECT id FROM (SELECT id FROM t ORDER BY x LIMIT 5) sub WHERE id > 0`,
    )!
    expect(s.orderBy).toEqual([])
    expect(s.limit).toBe('')
  })

  it('reads T-SQL TOP as a row limit', () => {
    expect(readSqlShape('SELECT TOP 10 id FROM t')!.limit).toBe('10')
  })

  it('treats index DDL as its own kind', () => {
    expect(readSqlShape('DROP INDEX IF EXISTS tenant_id_key')!.kind).toBe('ddl-index')
    expect(readSqlShape('CREATE UNIQUE INDEX x ON t (a, b)')!.kind).toBe('ddl-index')
  })
})

describe('checkEquivalence — the same-output claim', () => {
  it('verifies a formatting-only rewrite', () => {
    const r = checkEquivalence(
      'SELECT id, name FROM users WHERE tenant = $1',
      `SELECT id,
              name
         FROM users
        WHERE tenant = $1`,
    )
    expect(r.status).toBe('machine-verified')
    expect(r.deltas).toHaveLength(0)
  })

  it('verifies that an index change cannot alter a result set', () => {
    const r = checkEquivalence(
      'CREATE INDEX tenant_id_key ON policy USING btree (tenant_id)',
      'DROP INDEX IF EXISTS tenant_id_key',
    )
    expect(r.status).toBe('machine-verified')
    expect(r.summary).toMatch(/cannot alter any result set/)
  })

  it('contradicts a claim when the output columns change', () => {
    const r = checkEquivalence(
      'SELECT id, name, email FROM users',
      'SELECT id FROM users',
    )
    expect(r.status).toBe('contradicted')
    expect(r.deltas[0]!.property).toBe('projection')
    expect(r.deltas[0]!.severity).toBe('hard')
  })

  it('contradicts SELECT * being replaced by a column list', () => {
    const r = checkEquivalence('SELECT * FROM t', 'SELECT id, name FROM t')
    expect(r.status).toBe('contradicted')
    expect(r.deltas[0]!.detail).toMatch(/SELECT \* is replaced/)
  })

  it('contradicts a DISTINCT being added', () => {
    const r = checkEquivalence('SELECT a FROM t', 'SELECT DISTINCT a FROM t')
    expect(r.status).toBe('contradicted')
    expect(r.deltas[0]!.property).toBe('distinct')
  })

  it('contradicts a GROUP BY change', () => {
    const r = checkEquivalence(
      'SELECT a, count(*) FROM t GROUP BY a',
      'SELECT a, count(*) FROM t GROUP BY a, b',
    )
    expect(r.status).toBe('contradicted')
    expect(r.deltas.some((d) => d.property === 'group-by')).toBe(true)
  })

  it('flags an added LIMIT as soft — it changes rows, but the caller may make it safe', () => {
    // This is the exact shape of the "fetch one row instead of all" finding.
    // It must NOT be reported as fully verified.
    const r = checkEquivalence(
      'SELECT id FROM policy WHERE tenant_id = $1',
      'SELECT id FROM policy WHERE tenant_id = $1 LIMIT 1',
    )
    expect(r.status).toBe('partially-verified')
    const delta = r.deltas.find((d) => d.property === 'row-limit')!
    expect(delta.severity).toBe('soft')
    expect(delta.detail).toMatch(/only safe if the caller/)
  })

  it('flags an added ORDER BY as soft and says why', () => {
    const r = checkEquivalence('SELECT a FROM t', 'SELECT a FROM t ORDER BY a')
    expect(r.status).toBe('partially-verified')
    expect(r.deltas[0]!.detail).toMatch(/no ordering guarantee/)
  })

  it('will not claim a changed predicate is equivalent', () => {
    // The flagship finding: an OR-chain becomes ANY(). Everything decidable
    // matches, but predicate equivalence is undecidable — say so.
    const r = checkEquivalence(
      `SELECT hierarchy_type, permission FROM policy WHERE tenant_id=$1 AND (permission='3' OR permission='2')`,
      `SELECT hierarchy_type, permission FROM policy WHERE tenant_id=$1 AND permission = ANY($4::policy_permission_enum[])`,
    )
    expect(r.status).toBe('partially-verified')
    expect(r.verified.join(' ')).toMatch(/Output columns are identical/)
    expect(r.undecided.join(' ')).toMatch(/needs a solver/)
  })

  it('reports non-SQL as unverifiable rather than guessing', () => {
    const r = checkEquivalence(
      'db.users.find({ tenantId })',
      'db.users.find({ tenantId }).limit(1)',
    )
    expect(r.status).toBe('unverifiable')
    expect(r.summary).toMatch(/Not machine-checkable/)
  })

  it('contradicts a change of statement type', () => {
    const r = checkEquivalence('SELECT id FROM t', 'DELETE FROM t')
    expect(r.status).toBe('contradicted')
  })
})
