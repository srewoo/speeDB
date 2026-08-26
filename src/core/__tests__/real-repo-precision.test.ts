import { describe, expect, it } from 'vitest'
import { detectInFile, detectInFileVerbose, isProseFile } from '../detect/scan'
import { maskComments } from '../detect/mask'
import { inferEngines } from '../detect/engine-profile'

/**
 * Precision defects found by running detection over a real 953-file repository
 * (mindtickle/qa-automation/mt-test-studio @ 36972b38), not over a fixture.
 *
 * The engine profile had already removed every *undeclared-store* label. What
 * was left was subtler and would have been invisible without a real corpus:
 *
 *   - 208 of 1,108 candidates (19%) sat in prose files. `CHANGELOG.rst` and one
 *     markdown file were the only two files in the repository to hit the
 *     per-file cap, so the two most truncated files were both documentation.
 *   - Every stray engine label that survived the profile came from **English
 *     prose inside a docstring**, because a docstring is a string literal
 *     rather than a comment and string bodies are deliberately kept visible.
 *
 * The strings below are verbatim from that repository.
 */

describe('prose files are not query sites', () => {
  it('recognises the prose extensions', () => {
    for (const p of ['CHANGELOG.rst', 'NOTES.md', 'a/b.txt', 'django.po', 'data.csv', 'x.adoc']) {
      expect(isProseFile(p)).toBe(true)
    }
  })

  it('does NOT treat config formats as prose — a query in a config is real', () => {
    for (const p of ['dbt_project.yml', 'values.yaml', 'changelog.json', 'schema.sql', 'q.hql']) {
      expect(isProseFile(p)).toBe(false)
    }
  })

  it('a changelog quoting SQL produces no candidates', () => {
    const changelog = [
      'Changelog',
      '=========',
      '',
      '* Allow filtering by TestRun ID in Test Case Search page',
      '* You can manually update your existing databases by using the following instructions::',
      '',
      '    ALTER TABLE tcms_testcases ADD COLUMN summary varchar(255);',
      '    SELECT id, summary FROM tcms_testcases WHERE summary LIKE \'%legacy%\';',
      '',
      '* Fixed a bug where a returning browser kept its cached copy',
    ].join('\n')

    expect(detectInFile('CHANGELOG.rst', changelog)).toHaveLength(0)
    expect(detectInFile('MT_QA_HUB_CHANGE_HISTORY.md', changelog)).toHaveLength(0)
  })

  it('a translation catalogue produces no candidates', () => {
    const po = [
      'msgid "Select a test plan"',
      'msgstr "Válasszon teszttervet"',
      '',
      'msgid "Update the selected runs"',
      'msgstr "A kijelölt futtatások frissítése"',
    ].join('\n')
    expect(detectInFile('tcms/locale/hu_HU/LC_MESSAGES/django.po', po)).toHaveLength(0)
  })

  it('reports a prose file as zero matched, not as zero after filtering', () => {
    // The distinction matters for the coverage numbers: a file that was never
    // examined must not inflate `sitesMatched`.
    const result = detectInFileVerbose('CHANGELOG.rst', 'SELECT id FROM t WHERE a = 1')
    expect(result.matched).toBe(0)
    expect(result.belowConfidence).toBe(0)
    expect(result.lowPriority).toBe(0)
    expect(result.truncation).toBeNull()
  })
})

describe('a docstring is documentation, so it is masked like a comment', () => {
  it('blanks a docstring body even when string bodies are kept', () => {
    const src = [
      'def serialize_cases_by_id(case_ids):',
      '    """Rows for ``case_ids``, keyed by case id.',
      '',
      '    to the Trash, and returning nothing for such a row would read as data loss',
      '    """',
      '    return []',
    ].join('\n')
    const masked = maskComments('tcms/testcases/serializers.py', src)
    expect(masked).not.toContain('returning nothing')
    expect(masked.length).toBe(src.length)
    expect(masked.split('\n').length).toBe(src.split('\n').length)
  })

  it('keeps SQL held in a triple-quoted string, because that is not a docstring', () => {
    // The positional test is what makes the docstring rule safe: an assignment
    // or a call argument has something before the quote on its line.
    const assigned = 'QUERY = """\n    SELECT id, summary FROM tcms_testcases WHERE plan_id = %s\n"""'
    expect(maskComments('a.py', assigned)).toContain('SELECT id, summary FROM')

    const called = 'cursor.execute("""\n    SELECT id FROM tcms_testcases WHERE plan_id = %s\n""", [pid])'
    expect(maskComments('a.py', called)).toContain('SELECT id FROM')
  })

  it('still detects SQL assigned to a variable in a docstring-shaped file', () => {
    const src = [
      'def rows(pid):',
      '    """Fetch the rows."""',
      '    sql = """',
      '        SELECT id, summary FROM tcms_testcases WHERE plan_id = %s',
      '    """',
      '    return cursor.execute(sql, [pid])',
    ].join('\n')
    expect(detectInFile('tcms/testcases/queries.py', src).length).toBeGreaterThan(0)
  })
})

describe('English is not a SQL dialect', () => {
  const django = inferEngines([{
    path: 'tcms/settings/common.py',
    size: 80,
    content: 'DATABASES = {"default": {"ENGINE": "django.db.backends.mysql"}}',
  }])

  /** Verbatim prose from the repository, each of which used to set an engine. */
  const PROSE: [string, string, string][] = [
    ['postgres', 'tcms/testcases/serializers.py',
      'def f():\n    """\n    to the Trash, and returning nothing for such a row would read as data loss\n    """\n    return TestCase.objects.filter(pk=1).first()'],
    ['oracle', 'tcms/kiwi_auth/sso.py',
      'def f():\n    """\n    always exempt — k8s probes and the container HEALTHCHECK connect by IP\n    """\n    return User.objects.filter(pk=1).first()'],
    ['pgvector', 'tcms/bugs/management.py',
      'def f():\n    """\n    Create the missing permissions for the Bug<->Tag m2m model, see\n    """\n    return Bug.objects.filter(pk=1).first()'],
    ['postgres', 'tcms/templates/base.html',
      '<!-- in here; without a bump a returning browser keeps its cached copy -->\n<p>x</p>'],
  ]

  it.each(PROSE)('does not label prose as %s (%s)', (engine, path, src) => {
    const found = detectInFile(path, src, { profile: django })
    expect(found.every((c) => c.engine !== engine)).toBe(true)
  })

  it('still labels a real upper-case dialect marker', () => {
    const found = detectInFile('app/dao.py',
      'cursor.execute("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING")',
      { profile: django })
    expect(found.some((c) => c.engine === 'postgres')).toBe(true)
  })

  it('still labels a real RETURNING clause', () => {
    const found = detectInFile('app/dao.py',
      'cursor.execute("INSERT INTO t (a) VALUES (1) RETURNING id")', { profile: django })
    expect(found.some((c) => c.engine === 'postgres')).toBe(true)
  })

  it('still labels a real ALLOW FILTERING', () => {
    const found = detectInFile('app/dao.py',
      'session.execute("SELECT * FROM events WHERE x = 1 ALLOW FILTERING")')
    expect(found.some((c) => c.engine === 'cassandra')).toBe(true)
  })

  it('still labels a spaced pgvector distance operator', () => {
    const found = detectInFile('search.sql', 'SELECT id FROM docs ORDER BY embedding <-> $1 LIMIT 10')
    expect(found.some((c) => c.engine === 'pgvector')).toBe(true)
  })

  it('a lower-case query falls back to the declared engine rather than guessing', () => {
    // Losing the dialect label on lower-case SQL is the deliberate trade: the
    // statement is still detected, and the repository profile is better evidence
    // about the engine than a keyword that is also an English word.
    const found = detectInFile('app/dao.py',
      'cursor.execute("insert into t (a) values (1) on conflict (a) do nothing")',
      { profile: django })
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.engine).toBe('mysql')
  })
})

describe('non-source files are not read for queries', () => {
  it('stylesheets are excluded', () => {
    // 551 of the corpus's candidates were SCSS — the largest remaining category
    // of false positive. SCSS module calls (`breakpoint.until(...)`,
    // `list.repeat(...)`) tripped the graph-traversal rule, and a stylesheet has
    // no comment syntax registered so its whole body was matchable.
    for (const p of ['app/assets/stylesheets/common/base/search.scss', 'web_src/css/modules/svg.css', 'a/b.less', 'c.styl']) {
      expect(isProseFile(p), p).toBe(true)
    }
    expect(detectInFile('themes/horizon/scss/mobile-stuff.scss',
      '@include breakpoint.until(md) {\n  .topic-list { display: none; }\n}')).toHaveLength(0)
  })

  it('extensionless scripts and templates are excluded', () => {
    // Gitea's `options/gitignore/Node` mentions dynamodb; a Gentoo service
    // script mentions memcached. Vocabulary, not queries.
    for (const p of ['options/gitignore/Node', 'contrib/service/gentoo/gitea', 'script/mwrap_sidekiq', 'bin/bundle']) {
      expect(isProseFile(p), p).toBe(true)
    }
  })

  it('but a Rakefile is Ruby and can genuinely touch ActiveRecord', () => {
    expect(isProseFile('Rakefile')).toBe(false)
    expect(isProseFile('Gemfile')).toBe(false)
  })

  it('a real Gremlin traversal is still detected', () => {
    const found = detectInFile('src/graph.js', 'const r = await g.V().hasLabel("user").outE("follows").toList()')
    expect(found.some((c) => c.engine === 'neptune')).toBe(true)
  })

  it('binaries, archives and fonts never reach detection at all', async () => {
    // The first filter is at ingest: `isScannable` refuses them before a byte
    // is read, which is why they never appear in any candidate list.
    const { isScannable } = await import('@/core/repo/client')
    for (const p of ['docs/logo.png', 'a.pdf', 'b.zip', 'f.woff2', 'x.class', 'y.wasm', 'package-lock.json']) {
      expect(isScannable(p, 1000), p).toBe(false)
    }
    for (const p of ['src/app.py', 'db/schema.sql', 'main.go', 'lib.rs', 'App.java']) {
      expect(isScannable(p, 1000), p).toBe(true)
    }
  })
})
