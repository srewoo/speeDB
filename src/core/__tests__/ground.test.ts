import { describe, expect, it } from 'vitest'
import { groundFindings } from '../analyze/ground'
import type { Finding } from '../types'

const SOURCE = `from src.utils.asyncpg_db import Database

async def get_all(self):
    rows = await Database.fetch(
        conn,
        "SELECT id, policy_uname, status FROM policy WHERE tenant_id=$1",
        self._tenant_id,
    )
    return rows
`

const SCHEMA = `CREATE TABLE "policy" (
    "id" int4 DEFAULT NULL,
    "tenant_id" int8 NOT NULL
);
CREATE INDEX hierarchy_index ON "policy" USING btree (tenant_id, hierarchy_type);
`

function files() {
  return new Map([
    ['src/policy_handler.py', SOURCE],
    ['db/init-db.sh', SCHEMA],
  ])
}

function baseFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    kind: 'equivalent',
    title: 'Fetch one row instead of all',
    summary: 'Query fetches every row to read the first.',
    severity: 'medium',
    category: 'over-fetch',
    engine: 'postgres',
    accessStyle: 'raw-sql',
    original: 'SELECT id, policy_uname, status FROM policy WHERE tenant_id=$1',
    // A pure reformat: every mechanically decidable property is identical.
    primaryOccurrence: {
      file: 'src/policy_handler.py',
      startLine: 6,
      endLine: 6,
      excerpt: '"SELECT id, policy_uname, status FROM policy WHERE tenant_id=$1",',
    },
    otherOccurrences: [],
    suggestion: {
      proposed: `SELECT id,
       policy_uname,
       status
  FROM policy
 WHERE tenant_id=$1`,
      rationale: 'Only the first row is read.',
      equivalenceArgument:
        'The same rows are returned in the same order; the column list is unchanged, and NULL and duplicate handling are untouched.',
      assumptions: [],
      expectedImpact: 'One row transferred instead of N.',
    },
    evidence: [
      {
        kind: 'schema',
        file: 'db/init-db.sh',
        startLine: 5,
        endLine: 5,
        quote: 'CREATE INDEX hierarchy_index ON "policy" USING btree (tenant_id, hierarchy_type)',
        relevance: 'Shows tenant_id is indexed.',
      },
    ],
    grounding: 'needs-verification',
    groundingNotes: [],
    modelConfidence: 0.9,
    ...over,
  }
}

describe('groundFindings', () => {
  it('verifies a finding whose citations all check out', () => {
    const { kept, rejected } = groundFindings([baseFinding()], { files: files() })
    expect(rejected).toHaveLength(0)
    expect(kept[0]!.grounding).toBe('verified')
    expect(kept[0]!.groundingNotes).toEqual([])
  })

  it('rejects a finding that cites a file which was never read', () => {
    const f = baseFinding({
      primaryOccurrence: { ...baseFinding().primaryOccurrence, file: 'src/imaginary.py' },
    })
    const { kept, rejected } = groundFindings([f], { files: files() })
    expect(kept).toHaveLength(0)
    expect(rejected[0]!.grounding).toBe('rejected')
    expect(rejected[0]!.groundingNotes[0]).toMatch(/does not exist/i)
  })

  it('rejects a finding whose evidence cites a fabricated schema file', () => {
    const f = baseFinding({
      evidence: [
        { kind: 'schema', file: 'db/invented.sql', startLine: 1, endLine: 1, quote: 'CREATE INDEX made_up', relevance: 'x' },
      ],
    })
    const { rejected } = groundFindings([f], { files: files() })
    expect(rejected).toHaveLength(1)
  })

  it('strips an evidence quote that does not appear in a real file', () => {
    const f = baseFinding({
      evidence: [
        { kind: 'schema', file: 'db/init-db.sh', startLine: 1, endLine: 1, quote: 'CREATE INDEX totally_invented ON policy (nope)', relevance: 'x' },
      ],
    })
    const { kept } = groundFindings([f], { files: files() })
    expect(kept[0]!.evidence).toHaveLength(0)
    expect(kept[0]!.grounding).toBe('needs-verification')
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/quote was not found/i)
  })

  it('notes the dimensions a thin equivalence argument fails to address', () => {
    const f = baseFinding({
      suggestion: { ...baseFinding().suggestion, equivalenceArgument: 'Same.' },
    })
    const { kept } = groundFindings([f], { files: files() })
    // The note is raised, and `grounding` stays `verified`: the citations were
    // fine, and a thin prose argument is not a citation failure. Conflating the
    // two capped every ORM finding at `low` severity and told the user its
    // citations could not be confirmed, which was untrue.
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/does not address/i)
    expect(kept[0]!.grounding).toBe('verified')
  })

  it('machine-verifies the equivalence of a reformat, not just the citations', () => {
    const { kept } = groundFindings([baseFinding()], { files: files() })
    expect(kept[0]!.equivalence?.status).toBe('machine-verified')
    expect(kept[0]!.equivalence?.verified.join(' ')).toMatch(/Output columns are identical/)
  })

  it('reclassifies a same-output claim that demonstrably changes the columns', () => {
    // The claim is not a judgement call here: the projection differs, so the
    // finding belongs in the behaviour-changing section regardless of how
    // convincing its prose is.
    const f = baseFinding({
      suggestion: {
        ...baseFinding().suggestion,
        proposed: 'SELECT id FROM policy WHERE tenant_id=$1',
      },
    })
    const { kept } = groundFindings([f], { files: files() })
    expect(kept[0]!.kind).toBe('behavioural')
    expect(kept[0]!.equivalence?.status).toBe('contradicted')
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/Reclassified as behaviour-changing/)
  })

  it('keeps an added LIMIT in the same-output section but demands review', () => {
    // Soft: fewer rows are returned, which caller context can legitimately
    // justify — so it is flagged, not reclassified.
    const f = baseFinding({
      suggestion: {
        ...baseFinding().suggestion,
        proposed: 'SELECT id, policy_uname, status FROM policy WHERE tenant_id=$1 LIMIT 1',
      },
    })
    const { kept } = groundFindings([f], { files: files() })
    expect(kept[0]!.kind).toBe('equivalent')
    // The concern lives in `equivalence.status`, which is the field that means
    // it. `grounding` answers a different question — were the citations real —
    // and here they were.
    expect(kept[0]!.equivalence?.status).toBe('partially-verified')
    expect(kept[0]!.grounding).toBe('verified')
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/row limit|LIMIT/i)
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/only safe if the caller/)
  })

  it('says plainly when a non-SQL change could not be machine-checked', () => {
    const f = baseFinding({
      original: 'db.users.find({ tenantId })',
      suggestion: {
        ...baseFinding().suggestion,
        proposed: 'db.users.find({ tenantId }, { projection: { id: 1 } })',
      },
    })
    const { kept } = groundFindings([f], { files: files() })
    expect(kept[0]!.equivalence?.status).toBe('unverifiable')
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/Not machine-checkable/)
  })

  it('flags an index suggestion that cites no schema evidence', () => {
    const f = baseFinding({
      evidence: [],
      suggestion: {
        ...baseFinding().suggestion,
        proposed: 'CREATE INDEX idx_policy_tenant ON policy (tenant_id)',
      },
    })
    const { kept } = groundFindings([f], { files: files() })
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/cites no schema or migration evidence/i)
  })

  it('tolerates line-number drift rather than rejecting a good finding', () => {
    const f = baseFinding({
      primaryOccurrence: { ...baseFinding().primaryOccurrence, startLine: 8, endLine: 8 },
    })
    const { kept } = groundFindings([f], { files: files() })
    expect(kept[0]!.grounding).toBe('verified')
  })
})

describe('grounding means citations, and nothing else', () => {
  /*
   * Measured cause of a real failure: across 27 findings in three runs on
   * mt-test-studio, not one came out above `low`. Predicate equivalence is
   * undecidable on every ORM rewrite, so every ORM finding picked up an
   * "undecidable" note; the note landed in the same array as the citation
   * checks; `grounding` became `needs-verification`; the gate capped severity at
   * `low`; and the report said "one or more citations could not be confirmed".
   * Only the last step was visible to the user, and it was false.
   */
  it('an undecidable equivalence does not make the citations unconfirmed', () => {
    const f = baseFinding({
      original: 'TestCase.objects.filter(section=sec).count()',
      suggestion: {
        ...baseFinding().suggestion,
        proposed: 'TestCase.objects.filter(section__in=secs).values("section").annotate(n=Count("id"))',
        equivalenceArgument: 'Same rows, same columns, same ordering, same NULL and duplicate handling.',
      },
    })
    // Evidence cleared so the only thing under test is the equivalence note —
    // a cited file missing from this one-file map would reject on its own.
    f.evidence = []
    f.primaryOccurrence = { ...f.primaryOccurrence, excerpt: 'TestCase.objects.filter(section=sec).count()' }
    // Padded so the cited line is inside the file — an out-of-range line is a
    // real citation failure and would mask what this test is about.
    const source = [
      'def get(self, request, stream):',
      '    for sec in sections:',
      '        sc_total = TestCase.objects.filter(section=sec).count()',
      '        continue',
    ].join('\n')
    f.primaryOccurrence = { ...f.primaryOccurrence, startLine: 3, endLine: 3 }
    const { kept } = groundFindings([f], { files: new Map([[f.primaryOccurrence.file, source]]) })

    expect(kept).toHaveLength(1)

    expect(kept[0]!.equivalence?.status).not.toBe('machine-verified')
    expect(kept[0]!.grounding).toBe('verified')
    expect(kept[0]!.groundingNotes.join(' ')).not.toMatch(/citation/i)
  })

  it('a fabricated evidence path still rejects the finding', () => {
    const f = baseFinding({
      evidence: [{
        kind: 'schema', file: 'db/invented.sql', startLine: 1, endLine: 1,
        quote: 'CREATE INDEX nope ON policy (x)', relevance: 'made up',
      }],
    })
    const { kept, rejected } = groundFindings([f], { files: files() })
    expect(kept).toHaveLength(0)
    expect(rejected).toHaveLength(1)
  })

  it('a genuine citation failure still degrades grounding', () => {
    const f = baseFinding({
      primaryOccurrence: { ...baseFinding().primaryOccurrence, excerpt: 'this text is nowhere in the file at all' },
    })
    const { kept } = groundFindings([f], { files: files() })
    expect(kept[0]!.grounding).toBe('needs-verification')
    expect(kept[0]!.groundingNotes.join(' ')).toMatch(/Excerpt does not match|not found verbatim/i)
  })
})
