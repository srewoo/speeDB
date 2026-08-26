/**
 * Repo-level engine inference.
 *
 * `pickEngine()` used to take the highest-confidence rule in a merged span and
 * stop there. `mongodb-pipeline` matched `.aggregate(` at 0.90 and `django-orm`
 * sat at 0.85, so `Product.objects.aggregate(...)` in a Django project became a
 * MongoDB aggregation pipeline. Nothing ever reconciled a local guess against
 * what the repository demonstrably connects to.
 *
 * A repository states its data stores in a handful of well-known files, and
 * those statements are facts rather than guesses. This reads them once per
 * scan and gives detection a prior to fall back on — and, just as importantly,
 * gives the report header something to show, so a wrong inference is visible
 * instead of silent.
 */

import type { DbEngine, RepoFile } from '@/core/types'

export interface EngineDeclaration {
  engine: DbEngine
  /** The file the declaration was read from. Cited in the report header. */
  source: string
  /** The verbatim line that declared it. Never paraphrased. */
  quote: string
  /** Higher wins when picking `primary`. */
  authority: number
}

export interface EngineProfile {
  /** Engines the repository demonstrably connects to, strongest first. */
  declared: EngineDeclaration[]
  /** The single best guess, or 'unknown' when nothing declared one. */
  primary: DbEngine
  /** True when several stores are declared with comparable authority. */
  ambiguous: boolean
}

interface Probe {
  /** Which files this probe reads. */
  file: RegExp
  /** Declaration patterns; the first capture group is unused, the match is quoted. */
  signals: { pattern: RegExp; engine: DbEngine }[]
  /** How much to trust a hit here. Config beats dependencies beats compose. */
  authority: number
}

const PROBES: Probe[] = [
  /* ---- explicit application configuration: the strongest signal ---- */
  {
    file: /(^|\/)settings(?:\/[\w.]+|_\w+)?\.py$|(^|\/)settings\.py$|(^|\/)config\/settings/i,
    authority: 100,
    signals: [
      { pattern: /django\.db\.backends\.postgresql(?:_psycopg2)?/i, engine: 'postgres' },
      { pattern: /django\.db\.backends\.mysql/i, engine: 'mysql' },
      { pattern: /django\.db\.backends\.sqlite3/i, engine: 'sqlite' },
      { pattern: /django\.db\.backends\.oracle/i, engine: 'oracle' },
      { pattern: /mssql|sql_server\.pyodbc/i, engine: 'mssql' },
    ],
  },
  {
    file: /(^|\/)config\/database\.ya?ml$/i,
    authority: 100,
    signals: [
      { pattern: /adapter:\s*postgresql/i, engine: 'postgres' },
      { pattern: /adapter:\s*mysql2?/i, engine: 'mysql' },
      { pattern: /adapter:\s*sqlite3?/i, engine: 'sqlite' },
      { pattern: /adapter:\s*trilogy/i, engine: 'mysql' },
    ],
  },
  {
    file: /(^|\/)application(?:-\w+)?\.(?:properties|ya?ml)$/i,
    authority: 100,
    signals: [
      { pattern: /jdbc:postgresql:/i, engine: 'postgres' },
      { pattern: /jdbc:mysql:/i, engine: 'mysql' },
      { pattern: /jdbc:mariadb:/i, engine: 'mariadb' },
      { pattern: /jdbc:sqlserver:/i, engine: 'mssql' },
      { pattern: /jdbc:oracle:/i, engine: 'oracle' },
      { pattern: /jdbc:h2:/i, engine: 'sqlite' },
      { pattern: /jdbc:clickhouse:/i, engine: 'clickhouse' },
      { pattern: /spring\.data\.mongodb/i, engine: 'mongodb' },
      { pattern: /spring\.(?:redis|data\.redis)/i, engine: 'redis' },
      { pattern: /spring\.elasticsearch|elasticsearch\.uris/i, engine: 'elasticsearch' },
    ],
  },
  {
    file: /(^|\/)schema\.prisma$/i,
    authority: 100,
    signals: [
      { pattern: /provider\s*=\s*"postgresql"/i, engine: 'postgres' },
      { pattern: /provider\s*=\s*"mysql"/i, engine: 'mysql' },
      { pattern: /provider\s*=\s*"sqlite"/i, engine: 'sqlite' },
      { pattern: /provider\s*=\s*"sqlserver"/i, engine: 'mssql' },
      { pattern: /provider\s*=\s*"mongodb"/i, engine: 'mongodb' },
      { pattern: /provider\s*=\s*"cockroachdb"/i, engine: 'cockroachdb' },
    ],
  },
  {
    file: /(^|\/)(?:alembic\.ini|knexfile\.\w+|ormconfig\.\w+|sequelize\w*\.\w+|\.env\.example|drizzle\.config\.\w+)$/i,
    authority: 90,
    signals: [
      { pattern: /postgres(?:ql)?:\/\//i, engine: 'postgres' },
      { pattern: /mysql:\/\//i, engine: 'mysql' },
      { pattern: /mariadb:\/\//i, engine: 'mariadb' },
      { pattern: /sqlite:\/{2,}/i, engine: 'sqlite' },
      { pattern: /mongodb(?:\+srv)?:\/\//i, engine: 'mongodb' },
      { pattern: /redis:\/\//i, engine: 'redis' },
      { pattern: /clickhouse:\/\//i, engine: 'clickhouse' },
    ],
  },

  /* ---- declared dependencies: a driver in the manifest is a real claim ---- */
  {
    file: /(^|\/)(?:requirements[\w.-]*\.txt|Pipfile|pyproject\.toml|setup\.py|constraints\.txt)$/i,
    authority: 70,
    signals: [
      { pattern: /^\s*["']?(?:psycopg2(?:-binary)?|asyncpg|psycopg)\b/im, engine: 'postgres' },
      { pattern: /^\s*["']?(?:mysqlclient|PyMySQL|mysql-connector-python|aiomysql)\b/im, engine: 'mysql' },
      { pattern: /^\s*["']?mariadb\b/im, engine: 'mariadb' },
      { pattern: /^\s*["']?pymongo\b|^\s*["']?motor\b/im, engine: 'mongodb' },
      { pattern: /^\s*["']?(?:redis|aioredis)\b/im, engine: 'redis' },
      { pattern: /^\s*["']?elasticsearch\b/im, engine: 'elasticsearch' },
      { pattern: /^\s*["']?opensearch-py\b/im, engine: 'opensearch' },
      { pattern: /^\s*["']?snowflake-connector-python\b/im, engine: 'snowflake' },
      { pattern: /^\s*["']?google-cloud-bigquery\b/im, engine: 'bigquery' },
      { pattern: /^\s*["']?cassandra-driver\b/im, engine: 'cassandra' },
      { pattern: /^\s*["']?pgvector\b/im, engine: 'pgvector' },
      { pattern: /^\s*["']?clickhouse-(?:driver|connect)\b/im, engine: 'clickhouse' },
      { pattern: /^\s*["']?duckdb\b/im, engine: 'duckdb' },
      { pattern: /^\s*["']?influxdb\b/im, engine: 'influxdb' },
      { pattern: /^\s*["']?neo4j\b/im, engine: 'neo4j' },
      { pattern: /^\s*["']?(?:pinecone-client|pinecone)\b/im, engine: 'pinecone' },
      { pattern: /^\s*["']?qdrant-client\b/im, engine: 'qdrant' },
      { pattern: /^\s*["']?(?:weaviate-client)\b/im, engine: 'weaviate' },
      { pattern: /^\s*["']?(?:pymilvus)\b/im, engine: 'milvus' },
      { pattern: /^\s*["']?chromadb\b/im, engine: 'chroma' },
    ],
  },
  {
    file: /(^|\/)package\.json$/i,
    authority: 70,
    signals: [
      { pattern: /"(?:pg|postgres|pg-promise|@vercel\/postgres)"\s*:/i, engine: 'postgres' },
      { pattern: /"(?:mysql|mysql2)"\s*:/i, engine: 'mysql' },
      { pattern: /"mariadb"\s*:/i, engine: 'mariadb' },
      { pattern: /"(?:mongodb|mongoose)"\s*:/i, engine: 'mongodb' },
      { pattern: /"(?:redis|ioredis)"\s*:/i, engine: 'redis' },
      { pattern: /"(?:@elastic\/elasticsearch)"\s*:/i, engine: 'elasticsearch' },
      { pattern: /"(?:@opensearch-project\/opensearch)"\s*:/i, engine: 'opensearch' },
      { pattern: /"(?:better-sqlite3|sqlite3)"\s*:/i, engine: 'sqlite' },
      { pattern: /"(?:mssql|tedious)"\s*:/i, engine: 'mssql' },
      { pattern: /"snowflake-sdk"\s*:/i, engine: 'snowflake' },
      { pattern: /"@google-cloud\/bigquery"\s*:/i, engine: 'bigquery' },
      { pattern: /"@aws-sdk\/(?:client-dynamodb|lib-dynamodb)"\s*:/i, engine: 'dynamodb' },
      { pattern: /"(?:cassandra-driver)"\s*:/i, engine: 'cassandra' },
      { pattern: /"(?:neo4j-driver)"\s*:/i, engine: 'neo4j' },
      { pattern: /"@pinecone-database\/pinecone"\s*:/i, engine: 'pinecone' },
      { pattern: /"(?:@qdrant\/js-client-rest)"\s*:/i, engine: 'qdrant' },
      { pattern: /"(?:weaviate-ts-client|weaviate-client)"\s*:/i, engine: 'weaviate' },
      { pattern: /"(?:chromadb)"\s*:/i, engine: 'chroma' },
      { pattern: /"(?:clickhouse|@clickhouse\/client)"\s*:/i, engine: 'clickhouse' },
    ],
  },
  {
    file: /(^|\/)(?:go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|Cargo\.toml|[\w.-]+\.csproj)$/i,
    authority: 70,
    signals: [
      { pattern: /lib\/pq|jackc\/pgx|postgresql-\d|org\.postgresql|tokio-postgres|\bpg\b\s*[,)]|Npgsql/i, engine: 'postgres' },
      { pattern: /go-sql-driver\/mysql|mysql-connector-j|com\.mysql|mysql2?\s*[,(]|MySqlConnector/i, engine: 'mysql' },
      { pattern: /mariadb-java-client|mariadb\b/i, engine: 'mariadb' },
      { pattern: /mattn\/go-sqlite3|sqlite-jdbc|rusqlite|sqlite3\b/i, engine: 'sqlite' },
      { pattern: /mongo-driver|mongodb-driver|mongoid/i, engine: 'mongodb' },
      { pattern: /go-redis|redigo|jedis|lettuce-core|StackExchange\.Redis|redis-rb/i, engine: 'redis' },
      { pattern: /elasticsearch-(?:java|rest|rails)|olivere\/elastic/i, engine: 'elasticsearch' },
      { pattern: /opensearch-java|opensearch-ruby/i, engine: 'opensearch' },
      { pattern: /mssql-jdbc|denisenkom\/go-mssqldb|System\.Data\.SqlClient|Microsoft\.Data\.SqlClient/i, engine: 'mssql' },
      { pattern: /ojdbc|oracle\.jdbc|ruby-oci8/i, engine: 'oracle' },
      { pattern: /snowflake-jdbc|gosnowflake/i, engine: 'snowflake' },
      { pattern: /google-cloud-bigquery|bigquery/i, engine: 'bigquery' },
      { pattern: /cassandra-driver-core|gocql/i, engine: 'cassandra' },
      { pattern: /neo4j-java-driver|neo4j-driver/i, engine: 'neo4j' },
      { pattern: /clickhouse-jdbc|clickhouse-go/i, engine: 'clickhouse' },
      { pattern: /aws-sdk-go.*dynamodb|dynamodb-enhanced|AWSSDK\.DynamoDBv2/i, engine: 'dynamodb' },
    ],
  },

  /* ---- container topology: what actually gets run beside the app ---- */
  {
    file: /(^|\/)(?:docker-compose[\w.-]*\.ya?ml|compose[\w.-]*\.ya?ml)$/i,
    authority: 60,
    signals: [
      { pattern: /image:\s*["']?(?:postgres|postgis|bitnami\/postgresql)/i, engine: 'postgres' },
      { pattern: /image:\s*["']?(?:mysql|bitnami\/mysql|percona)/i, engine: 'mysql' },
      { pattern: /image:\s*["']?mariadb/i, engine: 'mariadb' },
      { pattern: /image:\s*["']?mongo/i, engine: 'mongodb' },
      { pattern: /image:\s*["']?redis/i, engine: 'redis' },
      { pattern: /image:\s*["']?(?:elasticsearch|docker\.elastic\.co)/i, engine: 'elasticsearch' },
      { pattern: /image:\s*["']?opensearchproject/i, engine: 'opensearch' },
      { pattern: /image:\s*["']?(?:clickhouse|yandex\/clickhouse)/i, engine: 'clickhouse' },
      { pattern: /image:\s*["']?cassandra/i, engine: 'cassandra' },
      { pattern: /image:\s*["']?neo4j/i, engine: 'neo4j' },
      { pattern: /image:\s*["']?(?:timescale|timescaledb)/i, engine: 'timescaledb' },
      { pattern: /image:\s*["']?(?:mcr\.microsoft\.com\/mssql|mssql)/i, engine: 'mssql' },
      { pattern: /image:\s*["']?(?:qdrant|weaviate|milvus|chromadb)/i, engine: 'unknown' },
    ],
  },
]

/** Only these files are read. Everything else is skipped without a regex run. */
const MAX_PROBE_BYTES = 400_000

export function inferEngines(files: RepoFile[]): EngineProfile {
  const found = new Map<string, EngineDeclaration>()

  for (const file of files) {
    const content = file.content
    if (!content || content.length > MAX_PROBE_BYTES) continue

    for (const probe of PROBES) {
      if (!probe.file.test(file.path)) continue
      for (const signal of probe.signals) {
        if (signal.engine === 'unknown') continue
        const m = signal.pattern.exec(content)
        if (!m) continue
        const decl: EngineDeclaration = {
          engine: signal.engine,
          source: file.path,
          quote: quoteFor(content, m.index, m[0]),
          authority: probe.authority,
        }
        const existing = found.get(signal.engine)
        if (!existing || existing.authority < decl.authority) found.set(signal.engine, decl)
      }
    }
  }

  const declared = [...found.values()].sort((a, b) => b.authority - a.authority)
  if (declared.length === 0) {
    return { declared: [], primary: 'unknown', ambiguous: false }
  }

  const top = declared[0]!
  // A relational store is the primary even when a cache or search index is
  // declared with the same authority — those are auxiliary by nature, and
  // labelling every query `redis` because a Redis container exists is exactly
  // the failure this pass was written to stop.
  const AUXILIARY = new Set(['redis', 'memcached', 'elasticsearch', 'opensearch', 'solr', 'etcd'])
  const primaryDecl = declared.find((d) => d.authority === top.authority && !AUXILIARY.has(d.engine)) ?? top

  const peers = declared.filter((d) => d.authority === primaryDecl.authority && !AUXILIARY.has(d.engine))

  return {
    declared,
    primary: primaryDecl.engine,
    // MySQL in production and MariaDB in development is not real ambiguity —
    // they are the same dialect for every purpose this tool has.
    ambiguous: peers.filter((p) => !sameDialect(p.engine, primaryDecl.engine)).length > 0,
  }
}

const DIALECT_ALIASES: DbEngine[][] = [
  ['mysql', 'mariadb'],
  ['postgres', 'pgvector', 'timescaledb', 'cockroachdb'],
]

export function sameDialect(a: DbEngine, b: DbEngine): boolean {
  if (a === b) return true
  return DIALECT_ALIASES.some((group) => group.includes(a) && group.includes(b))
}

/** True when the repository declares this engine, allowing for dialect aliases. */
export function profileDeclares(profile: EngineProfile, engine: DbEngine): boolean {
  return profile.declared.some((d) => sameDialect(d.engine, engine))
}

function quoteFor(content: string, index: number, match: string): string {
  const lineStart = content.lastIndexOf('\n', index) + 1
  const lineEnd = content.indexOf('\n', index)
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim()
  return (line || match).slice(0, 160)
}

/**
 * The engine a file's own path names, if any.
 *
 * `spring-petclinic` ships `db/h2/schema.sql`, `db/mysql/schema.sql` and
 * `db/postgres/schema.sql` side by side. The profile declares postgres and
 * mysql with equal authority, so `primary` picked postgres and labelled all
 * three postgres — including a file whose first three lines are
 * `INT(4) UNSIGNED NOT NULL AUTO_INCREMENT`. A directory named after an engine
 * is the strongest possible local evidence about that file, and it beats any
 * repository-wide guess.
 */
const PATH_ENGINE: [RegExp, DbEngine][] = [
  [/(?:^|\/)(?:db|database|sql|ddl|migrations?)\/(?:[^/]*\/)?postgres(?:ql)?(?:\/|[-_.])/i, 'postgres'],
  [/(?:^|\/)(?:db|database|sql|ddl|migrations?)\/(?:[^/]*\/)?mysql(?:\/|[-_.])/i, 'mysql'],
  [/(?:^|\/)(?:db|database|sql|ddl|migrations?)\/(?:[^/]*\/)?mariadb(?:\/|[-_.])/i, 'mariadb'],
  [/(?:^|\/)(?:db|database|sql|ddl|migrations?)\/(?:[^/]*\/)?sqlite(?:\/|[-_.])/i, 'sqlite'],
  [/(?:^|\/)(?:db|database|sql|ddl|migrations?)\/(?:[^/]*\/)?(?:mssql|sqlserver)(?:\/|[-_.])/i, 'mssql'],
  [/(?:^|\/)(?:db|database|sql|ddl|migrations?)\/(?:[^/]*\/)?oracle(?:\/|[-_.])/i, 'oracle'],
  [/(?:^|\/)(?:db|database|sql|ddl|migrations?)\/(?:[^/]*\/)?clickhouse(?:\/|[-_.])/i, 'clickhouse'],
  [/application-postgres(?:ql)?\.(?:properties|ya?ml)$/i, 'postgres'],
  [/application-mysql\.(?:properties|ya?ml)$/i, 'mysql'],
]

export function engineFromPath(path: string): DbEngine | null {
  for (const [re, engine] of PATH_ENGINE) if (re.test(path)) return engine
  return null
}

/** One-line description for the report header. Cited, never paraphrased. */
export function describeEngineProfile(profile: EngineProfile): string {
  if (profile.declared.length === 0) {
    return 'No data store is declared in any configuration file, dependency manifest or compose file in this repository.'
  }
  return profile.declared
    .slice(0, 6)
    .map((d) => `${d.engine} (\`${d.source}\` — \`${d.quote}\`)`)
    .join(', ')
}
