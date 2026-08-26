import { describe, expect, it } from 'vitest'
import { detectInFile, isBuildScript, isProseFile, pickEngine } from '../detect/scan'
import { analyseScope, classifyTrigger } from '../detect/scope'
import { engineFromPath, inferEngines } from '../detect/engine-profile'
import { applyValueGate } from '../analyze/gate'
import type { Finding } from '../types'
import type { DetectRule } from '../detect/rules'

/**
 * Defects found by running detection over a second real repository —
 * `spring-projects/spring-petclinic` @ 88e37c15, 117 scannable files.
 *
 * The first real repo (Django/MySQL) exercised prose and docstrings. This one is
 * Java/Spring with three parallel DDL trees and a build wrapper, and it broke
 * three different things. Strings below are verbatim from that repository.
 */

describe('build wrappers are machinery, not data access', () => {
  it('recognises the wrappers and Windows shims', () => {
    for (const p of ['mvnw', 'mvnw.cmd', 'gradlew', 'gradlew.bat', 'scripts/run.ps1']) {
      expect(isBuildScript(p), p).toBe(true)
      expect(isProseFile(p), p).toBe(true)
    }
  })

  it('does not sweep up ordinary source or real SQL', () => {
    for (const p of ['src/main/java/App.java', 'db/schema.sql', 'src/api/orders.ts', 'manage.py']) {
      expect(isBuildScript(p), p).toBe(false)
    }
  })

  it("an echo'd sentence in mvnw is not a SQL fragment", () => {
    // `' from ` inside a shell string fired `sql-fragment-concat`.
    const mvnw = [
      '#!/bin/sh',
      '  if [ -z "$distributionSha256Sum" ]; then',
      '    echo "Please disable validation by removing \'distributionSha256Sum\' from your maven-wrapper.properties"',
      '  fi',
    ].join('\n')
    expect(detectInFile('mvnw', mvnw)).toHaveLength(0)
  })

  it('`eval "set -- $("` in gradlew is not a SQL SET clause', () => {
    expect(detectInFile('gradlew', 'eval "set -- $(\n  printf \'%s\\n\' "$@"\n)"')).toHaveLength(0)
  })
})

describe('standalone DDL is install-time code, even with no migrations directory', () => {
  it('classifies schema and seed files as migration-triggered', () => {
    for (const p of [
      'src/main/resources/db/h2/schema.sql',
      'src/main/resources/db/mysql/schema.sql',
      'src/main/resources/db/postgres/data.sql',
      'db/structure.sql',
      'sql/seed.sql',
    ]) {
      expect(classifyTrigger(p, null, ''), p).toBe('migration')
    }
  })

  it('does not classify ordinary app code under db/ as a migration', () => {
    expect(classifyTrigger('app/db/repository.py', 'find_all', '')).toBe('unknown')
    expect(classifyTrigger('src/db/client.ts', 'query', '')).toBe('unknown')
  })

  it('reads the trigger through analyseScope, not just the classifier', () => {
    const ddl = 'CREATE TABLE vets (\n  id INT(4) UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY\n);'
    expect(analyseScope('src/main/resources/db/mysql/schema.sql', ddl.split('\n'), 1).trigger)
      .toBe('migration')
  })
})

describe('an index outlives the statement that created it', () => {
  const base = (over: Partial<Finding> = {}): Finding => ({
    id: 'i1', kind: 'equivalent',
    title: 'Drop the redundant index',
    summary: 'It duplicates the leading column of another index.',
    severity: 'medium', category: 'redundant-index',
    engine: 'postgres', accessStyle: 'ddl-migration',
    original: 'CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id)',
    primaryOccurrence: { file: 'db/schema.sql', startLine: 2, endLine: 2, excerpt: '' },
    otherOccurrences: [],
    suggestion: {
      proposed: 'DROP INDEX IF EXISTS tenant_id_key',
      rationale: '', equivalenceArgument: '', assumptions: [], expectedImpact: '',
    },
    evidence: [],
    scope: { loopDepth: 0, loopHeaders: [], symbol: null, symbolLine: null, opensLoop: false, trigger: 'migration' },
    grounding: 'verified', groundingNotes: [], modelConfidence: 0.9,
    ...over,
  })

  const files = new Map([['db/schema.sql', 'CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id);']])

  it('publishes an index finding declared in a schema file', () => {
    // The DDL runs once; the index it leaves behind is paid for on every write.
    const gate = applyValueGate([base()], { files })
    expect(gate.published).toHaveLength(1)
    expect(gate.suppressed).toHaveLength(0)
  })

  it('still suppresses a query rewrite in the same schema file', () => {
    const gate = applyValueGate([base({
      category: 'full-scan',
      original: "TestCase.objects.filter(summary__contains='legacy')",
      suggestion: {
        proposed: "TestCase.objects.filter(summary__startswith='legacy')",
        rationale: '', equivalenceArgument: '', assumptions: [], expectedImpact: '',
      },
    })], { files })
    expect(gate.suppressed[0]!.suppression!.reason).toBe('cold-path')
  })

  it('does not take the category on trust — an index finding must show an index', () => {
    // Verbatim from the 2026-08-26 report: filed `missing-index`, proposes no
    // index. Believing the label would have published it.
    const gate = applyValueGate([base({
      category: 'missing-index',
      original: "TestCase.objects.filter(summary__contains='legacy')",
      suggestion: {
        proposed: "TestCase.objects.filter(summary__startswith='legacy').only('id', 'summary')",
        rationale: '', equivalenceArgument: '', assumptions: [], expectedImpact: '',
      },
    })], { files })
    expect(gate.suppressed[0]!.suppression!.reason).toBe('cold-path')
  })

  it('accepts a requiredMigration as proof of a schema object', () => {
    const gate = applyValueGate([base({
      category: 'missing-index',
      original: 'SELECT id FROM policy WHERE tenant_id = 1',
      suggestion: {
        proposed: 'SELECT id FROM policy WHERE tenant_id = 1',
        requiredMigration: 'CREATE INDEX idx_policy_tenant ON policy (tenant_id);',
        rationale: '', equivalenceArgument: '', assumptions: [], expectedImpact: '',
      },
    })], { files })
    // Not cold-path — it is a no-op, which is a different and correct verdict.
    expect(gate.suppressed[0]?.suppression?.reason).not.toBe('cold-path')
  })
})

describe('a directory named after an engine is evidence about that file', () => {
  it('reads the engine from the path', () => {
    expect(engineFromPath('src/main/resources/db/mysql/schema.sql')).toBe('mysql')
    expect(engineFromPath('src/main/resources/db/postgres/data.sql')).toBe('postgres')
    expect(engineFromPath('db/sqlite/schema.sql')).toBe('sqlite')
    expect(engineFromPath('src/main/resources/application-mysql.properties')).toBe('mysql')
    expect(engineFromPath('src/main/java/App.java')).toBeNull()
  })

  it('labels db/mysql/schema.sql mysql even when the profile leads with postgres', () => {
    // The bug: petclinic declares postgres and mysql with equal authority, so
    // `primary` picked postgres and labelled all three DDL trees postgres —
    // including a file whose first lines are `INT(4) UNSIGNED AUTO_INCREMENT`.
    const profile = inferEngines([
      { path: 'src/main/resources/application-postgres.properties', size: 60, content: 'spring.datasource.url=jdbc:postgresql://localhost/petclinic' },
      { path: 'src/main/resources/application-mysql.properties', size: 60, content: 'spring.datasource.url=jdbc:mysql://localhost/petclinic' },
    ])
    expect(profile.ambiguous).toBe(true)

    const mysqlDdl = 'CREATE TABLE IF NOT EXISTS vets (\n  id INT(4) UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  first_name VARCHAR(30)\n);'
    const found = detectInFile('src/main/resources/db/mysql/schema.sql', mysqlDdl, { profile })
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((c) => c.engine === 'mysql')).toBe(true)
  })

  it('says unknown rather than picking one when the repo is genuinely multi-engine', () => {
    // Gitea supports MySQL, Postgres and SQLite by design; asserting one is a
    // guess dressed as a fact, and it makes the prompt inject the wrong
    // dialect's equivalence semantics.
    const profile = inferEngines([{
      path: 'go.mod', size: 200,
      content: 'require (\n  github.com/go-sql-driver/mysql v1.8.1\n  github.com/lib/pq v1.10.9\n  github.com/mattn/go-sqlite3 v1.14.22\n)',
    }])
    expect(profile.ambiguous).toBe(true)

    const generic: DetectRule[] = [
      { name: 'go-database-sql', pattern: /x/, engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.8 },
    ]
    expect(pickEngine(generic, profile, 'models/issue.go')).toBe('unknown')
  })

  it('an unambiguous profile is still asserted', () => {
    const profile = inferEngines([{
      path: 'tcms/settings/common.py', size: 80,
      content: 'DATABASES = {"default": {"ENGINE": "django.db.backends.mysql"}}',
    }])
    expect(profile.ambiguous).toBe(false)
    const generic: DetectRule[] = [
      { name: 'python-dbapi', pattern: /x/, engine: 'unknown', accessStyle: 'raw-sql', confidence: 0.8 },
    ]
    expect(pickEngine(generic, profile, 'app/dao.py')).toBe('mysql')
  })
})

describe('a schema is install-time whatever syntax it is written in', () => {
  it('classifies schema.prisma as migration-triggered', () => {
    // 119 candidate sites on cal.com — the most of any file there — all coming
    // back `trigger: unknown`, so a finding on a model declaration would have
    // published as though it sat on a hot path.
    expect(classifyTrigger('packages/prisma/schema.prisma', null, '')).toBe('migration')
    expect(classifyTrigger('prisma/schema.prisma', null, '')).toBe('migration')
  })

  it('classifies a Rails schema.rb and a Django-style structure file too', () => {
    expect(classifyTrigger('db/schema.rb', null, '')).toBe('migration')
    expect(classifyTrigger('db/structure.sql', null, '')).toBe('migration')
  })

  it('does not classify ordinary Prisma client code as a migration', () => {
    expect(classifyTrigger('src/server/bookings.ts', 'listBookings', '')).toBe('unknown')
  })
})

describe('migration directories are not all called "migrations"', () => {
  it('classifies a versioned file in a migration-ish directory', () => {
    // Gitea: ~2,000 files, none matching a literal `migrations/` segment, and
    // its highest-priority in-loop candidates were all install-time migrations.
    expect(classifyTrigger('modelmigration/v1_13/v143.go', null, '')).toBe('migration')
    expect(classifyTrigger('modelmigration/v1_22/v286.go', null, '')).toBe('migration')
    expect(classifyTrigger('app/migrations/0001_initial.py', null, '')).toBe('migration')
    expect(classifyTrigger('db/migrate/20240101120000_create_users.rb', null, '')).toBe('migration')
  })

  it('does NOT classify a repo-import feature as a migration', () => {
    // Gitea's `services/migrations/` migrates repositories between forges. It
    // is production code that runs on request, and the naive widening would
    // have marked all of it cold-path.
    expect(classifyTrigger('services/migrations/github.go', 'GetIssues', '')).not.toBe('migration')
    expect(classifyTrigger('services/migrations/gitlab.go', 'GetComments', '')).not.toBe('migration')
    expect(classifyTrigger('modules/migration/downloader.go', 'Download', '')).not.toBe('migration')
  })

  it('a top-level migration directory owns its whole subtree', () => {
    // Gitea's migration framework: install-time by definition, but the filename
    // carries no version. Anchoring at the repository root is what keeps this
    // from swallowing `services/migrations/`.
    expect(classifyTrigger('modelmigration/base/db.go', null, '')).toBe('migration')
    expect(classifyTrigger('migrations/helpers/util.py', null, '')).toBe('migration')
    expect(classifyTrigger('services/migrations/github.go', 'GetIssues', '')).not.toBe('migration')
  })

  it('still needs both conditions, not either', () => {
    // A versioned filename outside a migration directory is just a file.
    expect(classifyTrigger('internal/v2/handler.go', 'serve', '')).not.toBe('migration')
  })
})
