import { describe, expect, it } from 'vitest'
import { maskComments, maskNonCode } from '../detect/mask'
import { detectInFile } from '../detect/scan'

/**
 * Fix 3B — strip comments and strings before matching.
 *
 * Offsets must survive masking exactly: every rule match is converted back to a
 * line number against the *original* content, so a mask that changed length by
 * even one character would silently misattribute every finding in the file.
 */

const LANGUAGES: [string, string][] = [
  ['a.py', '# comment\nx = 1'],
  ['a.rb', '# comment\nx = 1'],
  ['a.js', '// comment\nlet x = 1'],
  ['a.ts', '/* block\n   comment */\nlet x = 1'],
  ['a.java', '// comment\nint x = 1;'],
  ['a.go', '// comment\nx := 1'],
  ['a.sql', '-- comment\nSELECT 1'],
  ['a.lua', '-- comment\nlocal x = 1'],
  ['a.html', '<!-- comment -->\n<p>x</p>'],
  ['a.cs', '// comment\nvar x = 1;'],
  ['a.php', '// comment\n$x = 1;'],
  ['a.ex', '# comment\nx = 1'],
]

describe('Fix 3B — masking preserves every offset', () => {
  it.each(LANGUAGES)('%s: length and line count are unchanged', (path, src) => {
    const masked = maskNonCode(path, src)
    expect(masked.length).toBe(src.length)
    expect(masked.split('\n').length).toBe(src.split('\n').length)
  })

  it.each(LANGUAGES)('%s: newlines stay exactly where they were', (path, src) => {
    const masked = maskNonCode(path, src)
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n') expect(masked[i]).toBe('\n')
    }
  })

  it('blanks the comment body and leaves the code beside it', () => {
    const masked = maskNonCode('a.py', 'x = 1  # migrate to opensearch')
    expect(masked).toContain('x = 1')
    expect(masked).not.toContain('opensearch')
  })

  it('blanks a string body but keeps the quotes', () => {
    const masked = maskNonCode('a.js', 'const s = "SELECT * FROM t"')
    expect(masked).toContain('"')
    expect(masked).not.toContain('SELECT')
  })

  it('maskComments keeps string bodies — SQL lives in string literals', () => {
    const masked = maskComments('a.js', 'const s = "SELECT * FROM t" // note')
    expect(masked).toContain('SELECT * FROM t')
    expect(masked).not.toContain('note')
  })

  it('handles Python triple-quoted docstrings as strings, not code', () => {
    const src = '"""\nWe should migrate this module to opensearch.\n"""\nx = 1'
    expect(maskNonCode('a.py', src)).not.toContain('opensearch')
  })

  it('leaves an unknown file type untouched rather than guessing', () => {
    const src = '# not necessarily a comment\nvalue'
    expect(maskNonCode('data.unknownext', src)).toBe(src)
  })
})

describe('Fix 3B — regression from R2: prose no longer sets an engine', () => {
  it('a comment mentioning OpenSearch produces no candidate', () => {
    const src = [
      'def search(request, term):',
      '    # TODO: migrate this to opensearch when the cluster is ready',
      '    return {"results": []}',
    ].join('\n')
    expect(detectInFile('tcms/testcases/views.py', src)).toHaveLength(0)
  })

  it('commented-out query code produces no candidate', () => {
    const src = [
      'def handler(request):',
      '    # rows = Product.objects.filter(active=True).values("id")',
      '    return []',
    ].join('\n')
    expect(detectInFile('app/views.py', src)).toHaveLength(0)
  })

  it('a comment mentioning Redshift does not label the file redshift', () => {
    const src = [
      '/* We used to run this on redshift. Now it is MySQL. */',
      'const rows = await db.query("SELECT id FROM orders WHERE tenant_id = ?", [t])',
    ].join('\n')
    const found = detectInFile('src/orders.js', src)
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((c) => c.engine !== 'redshift')).toBe(true)
  })
})

describe('Fix 3C — the four rules that were provably wrong', () => {
  it('Object.keys() is not a Redis SCAN risk', () => {
    const src = 'const fields = Object.keys(payload).filter(Boolean)'
    expect(detectInFile('src/util.ts', src)).toHaveLength(0)
  })

  it('a real redis.keys() still is', () => {
    const found = detectInFile('src/cache.js', 'const all = await redis.keys("session:*")')
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.engine).toBe('redis')
  })

  it('Django .aggregate() is not a MongoDB pipeline', () => {
    const src = [
      'from django.db.models import Sum',
      'def totals(request):',
      '    return Product.objects.aggregate(total=Sum("price"))',
    ].join('\n')
    const found = detectInFile('app/views.py', src)
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((c) => c.engine !== 'mongodb')).toBe(true)
    expect(found.every((c) => c.accessStyle !== 'aggregation-pipeline')).toBe(true)
  })

  it('a real Mongo pipeline still is', () => {
    const src = 'await col.aggregate([{ $lookup: { from: "u" } }, { $match: { a: 1 } }])'
    const found = detectInFile('src/repo.ts', src)
    expect(found.some((c) => c.engine === 'mongodb')).toBe(true)
  })

  it('an identifier ending in q is not SQL string building', () => {
    const src = 'let seq = 0\nseq += 1\nconst faq = base + extra'
    expect(detectInFile('src/counter.ts', src)).toHaveLength(0)
  })

  it('a real sql += still is', () => {
    const src = [
      'let sql = "SELECT id FROM users"',
      'sql += " WHERE tenant_id = $1"',
    ].join('\n')
    expect(detectInFile('src/query.ts', src).length).toBeGreaterThan(0)
  })

  it('the word "opensearch" in a string is not an OpenSearch client', () => {
    const src = 'const label = "opensearch"\nexport default label'
    expect(detectInFile('src/labels.ts', src)).toHaveLength(0)
  })

  it('an actual OpenSearch import still is', () => {
    const src = 'from opensearchpy import OpenSearch\nclient = OpenSearch(hosts=[h])'
    const found = detectInFile('search/client.py', src)
    expect(found.some((c) => c.engine === 'opensearch')).toBe(true)
  })
})
