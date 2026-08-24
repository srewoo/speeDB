import type { ScanReport } from '@/core/types'

/**
 * Preview fixture. The findings are the real ones from the analysis of
 * gitlab.com/mindtickle/migrated-call-ai/access-control, so the layout is
 * exercised with genuine content lengths rather than lorem ipsum.
 */
export const MOCK_REPORT: ScanReport = {
  id: 'a88c0961-preview',
  createdAt: new Date().toISOString(),
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  repo: {
    forge: 'gitlab',
    apiOrigin: 'https://gitlab.com/api',
    owner: 'mindtickle/migrated-call-ai',
    name: 'access-control',
    ref: 'main',
    commitSha: 'a88c0961f2be4c1d90a7',
  },
  stats: {
    filesInTree: 412, filesFetched: 268, filesSkipped: 0, ingest: 'archive', apiCalls: 3, candidatesFound: 47,
    chunksAnalysed: 6, chunksReused: 0, promptTokens: 162_840, completionTokens: 21_480, elapsedMs: 96_400,
  },
  schema: {
    tables: 3,
    indexes: 5,
    sources: ['db/init-db.sh'],
    unknowable: [
      'Row counts — no table size is recoverable from source.',
      'Column selectivity and data distribution.',
      'Which indexes actually exist in production, versus which were declared in a migration that may have been superseded, reverted, or never run.',
      'Index bloat, and whether an existing index is used at all.',
    ],
  },
  rejected: [
    {
      id: 'r1', kind: 'equivalent', title: 'Add covering index on share_v1.meeting_id',
      summary: 'Suggested an index on a table definition that was never read.',
      severity: 'medium', category: 'missing-index', engine: 'postgres', accessStyle: 'raw-sql',
      original: '', primaryOccurrence: { file: 'db/share_schema.sql', startLine: 12, endLine: 14, excerpt: '' },
      otherOccurrences: [],
      suggestion: { proposed: '', rationale: '', equivalenceArgument: '', assumptions: [], expectedImpact: '' },
      evidence: [], grounding: 'rejected',
      groundingNotes: ['Cited file does not exist in the scanned tree: db/share_schema.sql'],
      modelConfidence: 0.62,
    },
  ],
  findings: [
    {
      id: 'f1', kind: 'equivalent',
      title: 'Replace concatenated permission clause with a single parameterised ANY()',
      summary:
        'The permission filter is assembled from up to four if-branches, producing four distinct query texts that each need their own cached plan.',
      severity: 'high', category: 'plan-cache-miss', engine: 'postgres', accessStyle: 'raw-sql',
      original:
        'SELECT hierarchy_type, hierarchy_level, hierarchy_sub_type, permission\n' +
        "FROM policy where tenant_id=$1 and status=$2 and hierarchy_type!='' and\n" +
        "hierarchy_type!=$3 and (permission='3' or permission='2' or permission='0')",
      primaryOccurrence: {
        file: 'src/services/policy_service/policy_handler.py',
        startLine: 113, endLine: 118,
        enclosingSymbol: 'PolicyHandler.get_hierarchical_policies',
        triggeredBy: 'UserPolicyHandler.get_hierarchical_users, reached from POST /filter-meetings',
        excerpt:
          '        async with self._db.connection() as conn:\n' +
          '            policies = await Database.fetch(\n' +
          '                conn,\n' +
          '                "SELECT hierarchy_type, hierarchy_level, hierarchy_sub_type, permission "\n' +
          '                "FROM policy where tenant_id=$1 and status=$2 and hierarchy_type!=\'\' and "\n' +
          '                "hierarchy_type!=$3 and {}".format(permission_query),',
      },
      otherOccurrences: [],
      suggestion: {
        proposed:
          'SELECT hierarchy_type, hierarchy_level, hierarchy_sub_type, permission\n' +
          "FROM policy where tenant_id=$1 and status=$2 and hierarchy_type!='' and\n" +
          'hierarchy_type!=$3 and permission = ANY($4::policy_permission_enum[])',
        rationale:
          'asyncpg caches a prepared statement per distinct query text, per connection. Because the permission clause is concatenated in Python, the same logical query arrives as up to four different strings and none of them accumulates cache hits. Passing the tiers as an array parameter makes the text constant, so one plan is prepared once and reused.',
        equivalenceArgument:
          "ANY() over the same tier list matches exactly the rows the OR-chain matched: set membership and equality on an enum are identical operations. The column list is unchanged, no ORDER BY exists in either version so neither guarantees an order, and NULL permissions are excluded by both (NULL = ANY(...) and NULL = '3' are both NULL, never true). Duplicate handling is unaffected — neither form dedupes.",
        assumptions: [
          'The tier list is built in Python from the same permission cascade currently in the if-branches.',
        ],
        expectedImpact: 'One cached plan instead of four, on every connection in the pool.',
      },
      evidence: [
        {
          kind: 'schema', file: 'db/init-db.sh', startLine: 16, endLine: 16,
          quote: 'CREATE TYPE "policy_permission_enum" AS ENUM (\'3\', \'2\', \'1\', \'0\');',
          relevance: 'Confirms permission is an enum, so the array cast is well-typed.',
        },
        {
          kind: 'call-site', file: 'src/services/policy_service/user_policy_handler.py',
          startLine: 79, endLine: 79,
          quote: 'policies = await self._policy_handler.get_hierarchical_policies(permission)',
          relevance: 'The only caller; it consumes the rows without relying on ordering.',
        },
      ],
      grounding: 'verified', groundingNotes: [], modelConfidence: 0.94,
      performance: {
        status: 'unmeasured',
        counted: [],
        unmeasured: [
          'Whether this is actually faster. speeDB does not execute anything — it has no connection, no timings and no query plan.',
        ],
        verification: [
          {
            label: 'Measure the current query',
            command: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE)\nSELECT hierarchy_type, permission FROM policy\n WHERE tenant_id=$1 AND (permission=\'3\' OR permission=\'2\');',
          },
          {
            label: 'The data facts speeDB cannot see',
            command: "SELECT reltuples::bigint AS estimated_rows FROM pg_class WHERE relname = 'policy';\nSELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'policy';",
          },
        ],
        lookFor: [
          'Scan type — Seq Scan becoming Index Scan is the change you are looking for.',
          'Buffers: shared read versus hit — read means it went to disk.',
        ],
        summary: 'Not measured. speeDB does not execute queries — run the plan below to confirm the direction of the change.',
      },
      equivalence: {
        status: 'partially-verified',
        verified: [
          'Output columns are identical (hierarchy_type, hierarchy_level, hierarchy_sub_type, permission).',
          'Duplicate handling is unchanged (DISTINCT off).',
          'Neither version has an ORDER BY, so neither guarantees an order.',
        ],
        deltas: [],
        undecided: [
          'Whether the changed WHERE clause matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.',
        ],
        summary: 'Partly verified: predicate equivalence is not machine-decidable.',
      },
    },
    {
      id: 'f2', kind: 'equivalent',
      title: 'Drop the redundant tenant_id_key index',
      summary:
        'hierarchy_index already leads with tenant_id, so tenant_id_key serves no read it cannot.',
      severity: 'medium', category: 'redundant-index', engine: 'postgres', accessStyle: 'ddl-migration',
      original: 'CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id);',
      primaryOccurrence: {
        file: 'db/init-db.sh', startLine: 38, endLine: 38,
        enclosingSymbol: 'init-db.sh',
        excerpt: '    CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id);',
      },
      otherOccurrences: [],
      suggestion: {
        proposed: 'DROP INDEX IF EXISTS tenant_id_key;',
        rationale:
          'A btree index on (tenant_id, hierarchy_type, permission, status) can satisfy every lookup that a btree on (tenant_id) alone can, because tenant_id is the leading column. Keeping both means every INSERT and UPDATE on policy maintains two structures where one would do.',
        equivalenceArgument:
          'Dropping a redundant index cannot change any result set — indexes affect the plan, never the rows. Every query currently able to use tenant_id_key can use hierarchy_index with the same access pattern on the same leading column.',
        assumptions: ['No query uses an index hint naming tenant_id_key explicitly.'],
        expectedImpact: 'One less index to maintain on every write to policy.',
        requiredMigration: 'DROP INDEX IF EXISTS tenant_id_key;',
      },
      evidence: [
        {
          kind: 'index-definition', file: 'db/init-db.sh', startLine: 37, endLine: 38,
          quote:
            'CREATE INDEX hierarchy_index ON "policy" USING btree (tenant_id, hierarchy_type, permission, status);\n' +
            '    CREATE INDEX tenant_id_key ON "policy" USING btree (tenant_id);',
          relevance: 'Both indexes are declared adjacently; the prefix overlap is visible here.',
        },
      ],
      grounding: 'verified', groundingNotes: [], modelConfidence: 0.91,
    },
    {
      id: 'f3', kind: 'equivalent',
      title: 'Fetch one row instead of every row to read [0]',
      summary: 'Two policy lookups materialise the full result set and then index the first row.',
      severity: 'medium', category: 'over-fetch', engine: 'postgres', accessStyle: 'raw-sql',
      original:
        'SELECT hierarchy_type, permission, status FROM policy where tenant_id=$1 and\n' +
        'hierarchy_type=$2 and status=$3 and (permission<=$4 or permission=$5)',
      primaryOccurrence: {
        file: 'src/services/policy_service/policy_handler.py',
        startLine: 66, endLine: 72,
        enclosingSymbol: 'PolicyHandler.get_all_access_permission_policies',
        triggeredBy: 'is_all_policy_activated, called on every /filter-meetings request',
        excerpt:
          '            policy = await Database.fetch(\n' +
          '                conn,\n' +
          '                "SELECT hierarchy_type, permission, status FROM policy where tenant_id=$1 and "\n' +
          '                "hierarchy_type=$2 and status=$3 and (permission<=$4 or permission=$5) ",',
      },
      otherOccurrences: [
        {
          file: 'src/services/policy_service/policy_handler.py',
          startLine: 157, endLine: 162, enclosingSymbol: 'PolicyHandler.get', excerpt: '',
        },
      ],
      suggestion: {
        proposed:
          'SELECT hierarchy_type, permission, status FROM policy where tenant_id=$1 and\n' +
          'hierarchy_type=$2 and status=$3 and (permission<=$4 or permission=$5)\n' +
          'LIMIT 1',
        rationale:
          'The result is used as policy[0] and nothing else. LIMIT 1 lets Postgres stop as soon as it has a row and transfers one row instead of the whole match set.',
        equivalenceArgument:
          'The caller reads only index 0, so the returned value is identical. Neither version has an ORDER BY, so neither guarantees which row is first — LIMIT 1 preserves exactly the same arbitrary choice the existing [0] makes. The empty case still yields zero rows and the same -1 sentinel.',
        assumptions: ['Callers continue to read only the first row.'],
        expectedImpact: 'One row transferred instead of every matching policy.',
      },
      evidence: [
        {
          kind: 'call-site', file: 'src/services/policy_service/policy_handler.py',
          startLine: 76, endLine: 78,
          quote: 'if len(policy) == 0:\n            return -1\n\n        return int(policy[0]["permission"])',
          relevance: 'Shows only row 0 is ever read.',
        },
      ],
      grounding: 'verified', groundingNotes: [], modelConfidence: 0.88,
    },
    {
      id: 'f4', kind: 'equivalent',
      title: 'Provision tenant policies in one transaction instead of N',
      summary:
        'Each default policy takes its own pooled connection and its own transaction to insert one row.',
      severity: 'high', category: 'round-trip', engine: 'postgres', accessStyle: 'raw-sql',
      original:
        'for f in os.listdir(templates_path):\n' +
        '    ...\n' +
        '    await self.policy_handler.add(data)   # acquires a connection + opens a transaction',
      primaryOccurrence: {
        file: 'src/services/object_handlers/tenant_policy_handler.py',
        startLine: 20, endLine: 25,
        enclosingSymbol: 'TenantPolicyHandler.add_policies',
        triggeredBy: 'tenant.create event from RabbitMQ',
        excerpt:
          '        for f in os.listdir(templates_path):\n' +
          '            file_path = os.path.join(templates_path, f)\n' +
          '            if os.path.isfile(file_path):\n' +
          '                with open(file_path) as fp:\n' +
          '                    data = json.load(fp)\n' +
          '                await self.policy_handler.add(data)',
      },
      otherOccurrences: [],
      suggestion: {
        proposed:
          'async with self._db.connection() as conn:\n' +
          '    async with Database.transaction(conn):\n' +
          '        await conn.executemany(\n' +
          '            "INSERT INTO policy (id, tenant_id, hierarchy_type, hierarchy_level, "\n' +
          '            "hierarchy_sub_type, meeting_filter, user_meeting_filter, status, "\n' +
          '            "permission, policy_uname) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",\n' +
          '            rows,\n' +
          '        )',
        rationale:
          'PolicyHandler.add acquires a pooled connection and opens a transaction for a single INSERT, so provisioning a tenant with k templates costs k acquire/release cycles and k BEGIN/COMMIT pairs. Doing the whole set on one connection in one transaction collapses that to a single round trip.',
        equivalenceArgument:
          'The same rows are inserted with the same values in the same order. The only observable difference is atomicity, which strengthens rather than changes the result: today a mid-loop failure leaves a partially provisioned tenant, which is not a state any caller expects.',
        assumptions: [
          'Primary keys are still generated per row before the batch is sent.',
        ],
        expectedImpact: 'One connection and one transaction instead of one per policy template.',
      },
      evidence: [
        {
          kind: 'call-site', file: 'src/services/policy_service/policy_handler.py',
          startLine: 31, endLine: 33,
          quote: 'async with self._db.connection() as conn:\n            async with Database.transaction(conn) as tr:',
          relevance: 'Confirms add() opens its own connection and transaction per call.',
        },
      ],
      grounding: 'verified', groundingNotes: [], modelConfidence: 0.9,
    },
    {
      id: 'f5', kind: 'equivalent',
      title: 'Page the recent-search trim query instead of fetching every row',
      summary:
        'After creating a search, the handler fetches all of a user’s recent-search ids just to delete the tail.',
      severity: 'medium', category: 'over-fetch', engine: 'unknown', accessStyle: 'orm',
      original:
        'urss = await UserRecentSearch.get_many(\n' +
        '    tenant_id=self.tenant_id,\n' +
        '    select=[ColumnExpression(UserRecentSearch.id)],\n' +
        '    where=And(Equate(UserRecentSearch.user_id, LiteralExpression.as_id(self.user_id))),\n' +
        '    sort={"last_searched_at": "desc"},\n' +
        ')\n' +
        'del_search_ids = list(map(lambda x: x.id, urss[total_results_stored:]))',
      primaryOccurrence: {
        file: 'src/services/recent_search/recent_search_handler.py',
        startLine: 64, endLine: 74,
        enclosingSymbol: 'RecentSearchHandler.upsert',
        triggeredBy: 'recent_search CRUD event',
        excerpt:
          '            urss = await UserRecentSearch.get_many(\n' +
          '                tenant_id=self.tenant_id,\n' +
          '                select=[ColumnExpression(UserRecentSearch.id)],',
      },
      otherOccurrences: [],
      suggestion: {
        proposed:
          'urss = await UserRecentSearch.get_many(\n' +
          '    tenant_id=self.tenant_id,\n' +
          '    select=[ColumnExpression(UserRecentSearch.id)],\n' +
          '    where=And(Equate(UserRecentSearch.user_id, LiteralExpression.as_id(self.user_id))),\n' +
          '    sort={"last_searched_at": "desc"},\n' +
          '    page={"offset": total_results_stored, "limit": 100},\n' +
          ')\n' +
          'del_search_ids = [x.id for x in urss]',
        rationale:
          'The Python slice already discards everything before total_results_stored. Pushing that offset into the query means the service returns only the rows about to be deleted rather than the user’s entire history.',
        equivalenceArgument:
          'The sort key and direction are unchanged, so offsetting by total_results_stored selects exactly the rows the slice selected. The set of ids passed to delete_many is identical.',
        assumptions: ['No user holds more than total_results_stored + 100 recent searches.'],
        expectedImpact: 'A bounded page instead of the user’s full search history.',
      },
      evidence: [
        {
          kind: 'model-definition', file: 'src/services/recent_search/recent_search_handler.py',
          startLine: 71, endLine: 74,
          quote:
            'total_results_stored = RecentSearchConsts.no_of_search_results + RecentSearchConsts.no_results_buffer\n' +
            '            # This is a tweak to overcome the transaction-less disadvantages.',
          relevance: 'Shows the trim threshold that becomes the query offset.',
        },
      ],
      grounding: 'needs-verification',
      groundingNotes: ['Could not confirm the hammer query builder accepts an offset without a matching limit.'],
      modelConfidence: 0.71,
    },
    {
      id: 'f6', kind: 'behavioural',
      title: 'fetch_domain_shared_users filters DomainShare using a Share column',
      summary:
        'A DomainShare query builds its meeting predicate from Share.meeting_id, mixing two models in one WHERE clause.',
      severity: 'critical', category: 'other', engine: 'unknown', accessStyle: 'orm',
      original:
        'return await DomainShare.get_many(\n' +
        '    tenant_id=tenant_id,\n' +
        '    where=And(\n' +
        '        In(DomainShare.email, emails),\n' +
        '        In(Share.meeting_id, list(map(LiteralExpression.as_id, meeting_ids))),\n' +
        '    ),\n' +
        ')',
      primaryOccurrence: {
        file: 'src/services/share_service/share_actions.py',
        startLine: 174, endLine: 182,
        enclosingSymbol: 'fetch_domain_shared_users',
        excerpt:
          '    return await DomainShare.get_many(\n' +
          '        tenant_id=tenant_id,\n' +
          '        where=And(\n' +
          '            In(DomainShare.email, emails),\n' +
          '            In(Share.meeting_id, list(map(LiteralExpression.as_id, meeting_ids)))\n' +
          '        )\n' +
          '    )',
      },
      otherOccurrences: [],
      suggestion: {
        proposed:
          'return await DomainShare.get_many(\n' +
          '    tenant_id=tenant_id,\n' +
          '    where=And(\n' +
          '        In(DomainShare.email, emails),\n' +
          '        In(DomainShare.meeting_id, list(map(LiteralExpression.as_id, meeting_ids))),\n' +
          '    ),\n' +
          ')',
        rationale:
          'Every other predicate in this function is built from DomainShare. Using Share.meeting_id here targets a different table’s column, so the generated WHERE clause does not filter the domain shares by meeting as intended.',
        equivalenceArgument:
          'Not equivalent — this is a correction. The fixed query returns a narrower, correct result set where the current one either errors or returns unfiltered rows.',
        assumptions: [
          'DomainShare exposes a meeting_id column, as its sibling query at line 141 assumes.',
        ],
        expectedImpact: 'Correct filtering, plus a usable index predicate on meeting_id.',
      },
      evidence: [
        {
          kind: 'call-site', file: 'src/services/share_service/share_actions.py',
          startLine: 139, endLine: 141,
          quote: 'select=[ColumnExpression(DomainShare.id)],\n        where=And(Equate(DomainShare.meeting_id, LiteralExpression.as_id(meeting_id))',
          relevance: 'The sibling query uses DomainShare.meeting_id, confirming the column exists.',
        },
      ],
      grounding: 'verified', groundingNotes: [], modelConfidence: 0.93,
    },
  ],
}
