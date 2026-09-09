import { describe, expect, it } from 'vitest'
import { inferEngines, profileDeclares, sameDialect } from '../detect/engine-profile'
import { detectInFile } from '../detect/scan'
import type { RepoFile } from '../types'

/**
 * Fix 3A — repo-level engine inference.
 *
 * Every engine guess used to be local, and the loudest regex won. R2: a Django
 * + MySQL codebase produced mongodb, bigquery, opensearch, redshift, redis and
 * hive labels for a repository that has never had a connection to any of them.
 */

const f = (path: string, content: string): RepoFile => ({ path, size: content.length, content })

describe('Fix 3A — inferEngines reads what the repository declares', () => {
  it('Django + MySQL', () => {
    const profile = inferEngines([
      f('tcms/settings/common.py', 'DATABASES = {"default": {"ENGINE": "django.db.backends.mysql"}}'),
      f('requirements/base.txt', 'Django==4.2\nmysqlclient==2.2.0\n'),
      f('docker-compose.yml', 'services:\n  db:\n    image: mariadb:10.11\n'),
    ])
    expect(profile.primary).toBe('mysql')
    expect(profile.declared[0]!.source).toBe('tcms/settings/common.py')
    expect(profile.declared[0]!.quote).toContain('django.db.backends.mysql')
    // MySQL in prod and MariaDB in dev is one dialect, not an ambiguity.
    expect(profile.ambiguous).toBe(false)
  })

  it('Rails + Postgres', () => {
    const profile = inferEngines([
      f('config/database.yml', 'default: &default\n  adapter: postgresql\n  pool: 5\n'),
      f('Gemfile', "gem 'rails'\ngem 'pg', '~> 1.5'\n"),
    ])
    expect(profile.primary).toBe('postgres')
  })

  it('Spring + MySQL', () => {
    const profile = inferEngines([
      f('src/main/resources/application.properties', 'spring.datasource.url=jdbc:mysql://localhost:3306/app\n'),
      f('pom.xml', '<artifactId>mysql-connector-j</artifactId>'),
    ])
    expect(profile.primary).toBe('mysql')
  })

  it('Prisma + Postgres', () => {
    const profile = inferEngines([
      f('prisma/schema.prisma', 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}'),
      f('package.json', '{ "dependencies": { "@prisma/client": "^5.0.0", "pg": "^8.11.0" } }'),
    ])
    expect(profile.primary).toBe('postgres')
  })

  it('Go + SQLite', () => {
    const profile = inferEngines([
      f('go.mod', 'module app\n\nrequire github.com/mattn/go-sqlite3 v1.14.22\n'),
    ])
    expect(profile.primary).toBe('sqlite')
  })

  it('a cache container does not become the primary store', () => {
    const profile = inferEngines([
      f('config/database.yml', 'adapter: postgresql\n'),
      f('docker-compose.yml', 'services:\n  redis:\n    image: redis:7\n'),
    ])
    expect(profile.primary).toBe('postgres')
    expect(profile.declared.map((d) => d.engine)).toContain('redis')
  })

  it('a genuinely multi-engine repository says so rather than picking one', () => {
    // Gitea supports MySQL, Postgres and SQLite by design.
    const profile = inferEngines([
      f('go.mod', [
        'require (',
        '  github.com/go-sql-driver/mysql v1.8.1',
        '  github.com/lib/pq v1.10.9',
        '  github.com/mattn/go-sqlite3 v1.14.22',
        ')',
      ].join('\n')),
    ])
    expect(profile.declared.length).toBeGreaterThanOrEqual(3)
    expect(profile.ambiguous).toBe(true)
  })

  it('declares nothing when the repository declares nothing', () => {
    const profile = inferEngines([f('src/index.ts', 'export const x = 1')])
    expect(profile.primary).toBe('unknown')
    expect(profile.declared).toHaveLength(0)
    expect(profile.ambiguous).toBe(false)
  })

  it('quotes the declaring line verbatim rather than paraphrasing it', () => {
    const profile = inferEngines([
      f('config/database.yml', '# production\nproduction:\n  adapter: postgresql\n'),
    ])
    expect(profile.declared[0]!.quote).toBe('adapter: postgresql')
  })
})

describe('Fix 3A — dialect aliases', () => {
  it('treats MySQL and MariaDB as one dialect', () => {
    expect(sameDialect('mysql', 'mariadb')).toBe(true)
  })
  it('treats pgvector and TimescaleDB as Postgres', () => {
    expect(sameDialect('postgres', 'pgvector')).toBe(true)
    expect(sameDialect('postgres', 'timescaledb')).toBe(true)
  })
  it('does not treat MySQL and Postgres as one dialect', () => {
    expect(sameDialect('mysql', 'postgres')).toBe(false)
  })
})

describe('Fix 3A — regression from R2, on the labels themselves', () => {
  const django = inferEngines([
    f('tcms/settings/common.py', 'DATABASES = {"default": {"ENGINE": "django.db.backends.mysql"}}'),
    f('requirements/base.txt', 'Django==4.2\nmysqlclient==2.2.0\n'),
  ])

  it('the profile corroborates MySQL and nothing else', () => {
    expect(profileDeclares(django, 'mysql')).toBe(true)
    for (const wrong of ['mongodb', 'redshift', 'bigquery', 'opensearch', 'hive', 'redis']) {
      expect(profileDeclares(django, wrong)).toBe(false)
    }
  })

  it('a Django aggregate is labelled mysql, not mongodb', () => {
    const src = [
      'from django.db.models import Count',
      'def report(request):',
      '    return Product.objects.aggregate(n=Count("id"))',
    ].join('\n')
    const found = detectInFile('tcms/core/views.py', src, { profile: django })
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.engine).toBe('mysql')
  })

  it('an uncorroborated warehouse word does not override the declared engine', () => {
    const src = [
      'def export(request):',
      '    rows = Product.objects.filter(active=True).values("id", "name")',
      '    return build_athena_style_csv(rows)',
    ].join('\n')
    const found = detectInFile('tcms/core/views.py', src, { profile: django })
    expect(found.length).toBeGreaterThan(0)
    for (const c of found) {
      expect(['mysql', 'mariadb']).toContain(c.engine)
    }
  })

  it('a genuine dialect marker still wins over the repo profile', () => {
    // `ON CONFLICT` is evidence about this statement, not vocabulary.
    const src = 'cursor.execute("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING")'
    const found = detectInFile('app/dao.py', src, { profile: django })
    expect(found.some((c) => c.engine === 'postgres')).toBe(true)
  })

  it('falls back to the declared primary when no rule names an engine', () => {
    const src = 'cursor.execute("SELECT id FROM policy WHERE tenant_id = %s", [t])'
    const found = detectInFile('app/dao.py', src, { profile: django })
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.engine).toBe('mysql')
  })
})
