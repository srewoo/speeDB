import { describe, expect, it } from 'vitest'
import { buildTriagePrompt, flaggedIds, parseTriage, TRIAGE_SYSTEM_PROMPT } from '../analyze/triage'
import { AUTHOR_SYSTEM_PROMPT, buildAuthorPrompt } from '../analyze/author'
import type { Candidate } from '../types'

/**
 * Phase 2: the analysis is two stages, and the first one has to account for
 * every site it was given.
 *
 * The measured failure: a single request that both triaged and authored produced
 * about three and a half findings per pass whatever the pass contained, and
 * missed defects sitting at the top of its own input. Nothing in the contract
 * required it to say anything at all about a given site, so skipping one was
 * free and invisible. Reconciling ids is what makes it neither.
 */

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: over.id ?? 'app/views.py:10:0',
    file: 'app/views.py',
    startLine: 10,
    endLine: 10,
    excerpt: 'TestCase.objects.filter(section=sec).count()',
    engine: 'mysql',
    accessStyle: 'orm',
    detector: 'django-orm',
    confidence: 0.85,
    priority: 0.9,
    priorityReasons: [],
    scope: {
      loopDepth: 1, loopHeaders: ['for sec in sections:'], symbol: 'V.get',
      symbolLine: 1, opensLoop: false, trigger: 'request-handler',
    },
    ...over,
  }
}

const three = ['a:1:0', 'b:2:0', 'c:3:0'].map((id) => candidate({ id }))

describe('the triage prompt', () => {
  const prompt = buildTriagePrompt({ candidates: three, schemaFiles: [], repoLabel: 'acme/svc @ abc' })

  it('gives every site an id the model is told to echo', () => {
    for (const c of three) expect(prompt).toContain(`## id: ${c.id}`)
    expect(prompt).toMatch(/exactly 3 verdicts/)
  })

  it('states the enclosing scope, which is what makes an N+1 visible', () => {
    expect(prompt).toMatch(/inside 1 loop/)
    expect(prompt).toMatch(/reached by: request-handler/)
  })

  it('sends schema file names only — the full schema is for authoring', () => {
    const withSchema = buildTriagePrompt({
      candidates: three,
      schemaFiles: [{ path: 'db/schema.sql', size: 99, content: 'CREATE TABLE policy (id int);' }],
      repoLabel: 'x',
    })
    expect(withSchema).toContain('db/schema.sql')
    // Triage decides *whether* there is a problem; grounding a claim about one
    // needs the schema, and paying for it on every pass is most of the cost.
    expect(withSchema).not.toContain('CREATE TABLE policy')
  })

  it('tells the model that silence is not an option', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toMatch(/account for every site/i)
    expect(TRIAGE_SYSTEM_PROMPT).toMatch(/Never skip a site/)
    expect(TRIAGE_SYSTEM_PROMPT).toMatch(/silence is not an option/i)
  })

  it('tells the model that most sites are clean', () => {
    // A triage prompt that rewards flagging produces a flagged corpus.
    expect(TRIAGE_SYSTEM_PROMPT).toMatch(/correct answer for most sites/)
  })
})

describe('reconciling the response against what was asked', () => {
  const ids = three.map((c) => c.id)

  it('accepts a complete response', () => {
    const r = parseTriage(JSON.stringify({
      verdicts: [
        { id: 'a:1:0', verdict: 'problem', category: 'n-plus-one', why: 'per-row count' },
        { id: 'b:2:0', verdict: 'clean', category: 'other', why: 'already batched' },
        { id: 'c:3:0', verdict: 'unsure', category: 'over-fetch', why: 'cannot see the caller' },
      ],
    }), ids)
    expect(r.unaccounted).toEqual([])
    expect(r.invented).toEqual([])
    expect(flaggedIds(r)).toEqual(['a:1:0', 'c:3:0'])
  })

  it('names the sites that were skipped instead of assuming them clean', () => {
    const r = parseTriage(JSON.stringify({
      verdicts: [{ id: 'a:1:0', verdict: 'clean', category: 'other', why: 'fine' }],
    }), ids)
    expect(r.unaccounted).toEqual(['b:2:0', 'c:3:0'])
  })

  it('reports an invented id rather than trusting it', () => {
    const r = parseTriage(JSON.stringify({
      verdicts: [
        { id: 'a:1:0', verdict: 'clean', category: 'other', why: '' },
        { id: 'does/not/exist:9:0', verdict: 'problem', category: 'other', why: '' },
      ],
    }), ids)
    expect(r.invented).toEqual(['does/not/exist:9:0'])
    expect(flaggedIds(r)).toEqual([])
  })

  it('ignores a duplicated id rather than double-counting it', () => {
    const r = parseTriage(JSON.stringify({
      verdicts: [
        { id: 'a:1:0', verdict: 'problem', category: 'other', why: '' },
        { id: 'a:1:0', verdict: 'clean', category: 'other', why: '' },
      ],
    }), ids)
    expect(r.verdicts.filter((v) => v.id === 'a:1:0')).toHaveLength(1)
    expect(r.unaccounted).toEqual(['b:2:0', 'c:3:0'])
  })

  it('treats an unparseable response as accounting for nothing', () => {
    for (const junk of ['', 'I could not analyse these.', '{"verdicts": not json']) {
      const r = parseTriage(junk, ids)
      expect(r.unaccounted).toEqual(ids)
      expect(r.parseError).toBeTruthy()
    }
  })

  it('reads a fenced response, because providers add fences', () => {
    const r = parseTriage('```json\n{"verdicts":[{"id":"a:1:0","verdict":"problem","category":"other","why":"x"}]}\n```', ids)
    expect(flaggedIds(r)).toEqual(['a:1:0'])
  })

  it('an unrecognised verdict string is read as clean, not as a problem', () => {
    // Fail closed on flagging: a garbled verdict must not manufacture work.
    const r = parseTriage(JSON.stringify({
      verdicts: ids.map((id) => ({ id, verdict: 'maybe?', category: 'other', why: '' })),
    }), ids)
    expect(flaggedIds(r)).toEqual([])
    expect(r.unaccounted).toEqual([])
  })
})

describe('the authoring prompt', () => {
  const sites = [{
    candidate: candidate(),
    verdict: { id: candidate().id, verdict: 'problem' as const, category: 'n-plus-one', why: 'one count per section' },
  }]

  it('carries the triage reason so the model does not re-triage', () => {
    const p = buildAuthorPrompt({ sites, schemaFiles: [], repoLabel: 'x' })
    expect(p).toMatch(/triaged as n-plus-one: one count per section/)
  })

  it('includes the full schema, unlike triage', () => {
    const p = buildAuthorPrompt({
      sites,
      schemaFiles: [{ path: 'db/schema.sql', size: 99, content: 'CREATE TABLE policy (id int);' }],
      repoLabel: 'x',
    })
    expect(p).toContain('CREATE TABLE policy')
  })

  it('permits the author to disagree with triage', () => {
    // Otherwise the accounting contract turns into a quota, and a quota is how
    // a report fills up with findings nobody needed.
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/Disagreeing is a valid answer/)
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/Returning fewer findings than sites is expected/)
  })

  it('keeps the rules that make a finding trustworthy', () => {
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/equivalence rule — this is absolute/)
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/NEVER state or imply a speed multiple/)
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/must appear VERBATIM/)
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/OMIT THIS KEY ENTIRELY/)
  })

  it('warns that building a queryset is not a query', () => {
    // The false counted fact that shipped on the first real scan came from
    // exactly this misunderstanding.
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/building a queryset issues NO query/)
  })
})

describe('the accounting is recorded, not discarded', () => {
  /*
   * A defect at priority 1.0, inside a loop, in a request handler was missed on
   * a real two-stage scan — and the cause could not be established, because the
   * report kept no triage outcomes. Three explanations were indistinguishable:
   * triage answered `clean`, triage was never asked, or the author declined it.
   */
  it('a clean verdict is recoverable per site, which is what diagnoses a miss', async () => {
    const { runScan } = await import('@/core/pipeline')
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `src/q${i}.py`,
      size: 200,
      content: `rows = await conn.fetch("SELECT c${i} FROM t${i} WHERE tenant_id=$1", t)`,
    }))

    const provider = {
      id: 'anthropic' as const,
      model: 'claude-sonnet-5',
      isAvailable: async () => ({ ok: true }),
      listModels: async () => [],
      async complete(req: { system: string; user: string }) {
        if (/triaging query sites/.test(req.system)) {
          const ids = [...req.user.matchAll(/^## id: (.+)$/gm)].map((m) => m[1]!)
          return {
            text: JSON.stringify({
              verdicts: ids.map((id, i) => ({
                id,
                verdict: i === 0 ? 'problem' : i === 1 ? 'unsure' : 'clean',
                category: 'n-plus-one',
                why: i === 0 ? 'per-row count' : i === 1 ? 'cannot see the caller' : 'already batched',
              })),
            }),
            promptTokens: 10, completionTokens: 10,
          }
        }
        return { text: JSON.stringify({ findings: [] }), promptTokens: 10, completionTokens: 10 }
      },
    }

    const client = {
      resolve: async () => ({
        forge: 'github' as const, apiOrigin: 'https://api.github.com',
        owner: 'a', name: 'b', ref: 'main', commitSha: 'abc1234567',
      }),
      listFiles: async () => files,
      readFile: async () => '',
      listBranches: async () => ['main'],
      listChangedFiles: async () => null,
      fetchArchive: async () => ({ files, bytes: 1 }),
    }

    const report = await runScan(
      { forge: 'github', apiOrigin: 'https://api.github.com', owner: 'a', name: 'b' },
      {
        provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k',
        temperature: 0, maxOutputTokens: 4000, tokenBudget: 1_000_000, noCache: true,
        triageSitesPerPass: 10,
        deps: { client: client as never, provider: provider as never },
      },
    )

    const log = report.triageLog!
    expect(log).toBeDefined()
    expect(log.flagged).toHaveLength(1)
    expect(log.unsure).toHaveLength(1)
    expect(log.clean.length).toBeGreaterThan(0)
    // The reason is kept for the sites you would question; ids suffice for the rest.
    expect(log.flagged[0]!.why).toBe('per-row count')
    expect(log.unsure[0]!.category).toBe('n-plus-one')
    expect(log.unaccounted).toEqual([])

    // And the counts reach the stats, so the ratio is visible without the log.
    expect(report.stats.triage).toEqual({
      flagged: log.flagged.length, unsure: log.unsure.length, clean: log.clean.length,
    })
  })

  it('a site flagged on a later sample is not left recorded as clean', async () => {
    // With sampling, the same site can come back clean once and flagged once.
    // Recording it as clean would make the log say the opposite of what happened.
    const { parseTriage, flaggedIds } = await import('@/core/analyze/triage')
    const ids = ['a:1:0']
    const first = parseTriage(JSON.stringify({ verdicts: [{ id: 'a:1:0', verdict: 'clean', category: 'other', why: '' }] }), ids)
    const second = parseTriage(JSON.stringify({ verdicts: [{ id: 'a:1:0', verdict: 'problem', category: 'n-plus-one', why: 'per-row' }] }), ids)
    expect(flaggedIds(first)).toEqual([])
    expect(flaggedIds(second)).toEqual(['a:1:0'])
  })
})

describe('the authoring stage accounts for its sites too', () => {
  /*
   * The gap this closes, measured. On a real two-stage run, triage flagged all
   * ten lines of the three known defects with accurate reasons — and the
   * authoring stage wrote up 30 of 72 flagged sites, 42%, dropping every one of
   * those ten without a word. The accounting contract had been applied to triage
   * and not to authoring, so the silent skip simply moved one stage later.
   */
  const ids = ['a:1:0', 'b:2:0', 'c:3:0']

  it('accepts a response that writes up some sites and declines the rest', async () => {
    const { reconcileAuthoring } = await import('@/core/analyze/author')
    const acc = reconcileAuthoring(JSON.stringify({
      findings: [{ siteId: 'a:1:0', title: 'x' }],
      declined: [
        { siteId: 'b:2:0', why: 'already batched' },
        { siteId: 'c:3:0', why: 'not data access' },
      ],
    }), ids)
    expect(acc.authored).toEqual(['a:1:0'])
    expect(acc.declined.map((d) => d.siteId)).toEqual(['b:2:0', 'c:3:0'])
    expect(acc.unaccounted).toEqual([])
  })

  it('names a site that was neither written up nor declined', async () => {
    const { reconcileAuthoring } = await import('@/core/analyze/author')
    const acc = reconcileAuthoring(JSON.stringify({
      findings: [{ siteId: 'a:1:0', title: 'x' }],
    }), ids)
    // This is the 42% failure, made visible.
    expect(acc.unaccounted).toEqual(['b:2:0', 'c:3:0'])
  })

  it('treats an unparseable response as accounting for nothing', async () => {
    const { reconcileAuthoring } = await import('@/core/analyze/author')
    expect(reconcileAuthoring('sorry, I cannot', ids).unaccounted).toEqual(ids)
  })

  it('ignores a siteId that was not in the batch', async () => {
    const { reconcileAuthoring } = await import('@/core/analyze/author')
    const acc = reconcileAuthoring(JSON.stringify({
      findings: [{ siteId: 'not/in/batch:9:0' }],
      declined: [{ siteId: 'also/not:9:0', why: '' }],
    }), ids)
    expect(acc.authored).toEqual([])
    expect(acc.declined).toEqual([])
    expect(acc.unaccounted).toEqual(ids)
  })

  it('the prompt requires a verdict for every site', () => {
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/must account for every site/i)
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/Never leave a site out of both/)
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/Silently omitting a site is the one thing you must not do/)
    // And declining must stay cheap, or the contract becomes a quota.
    expect(AUTHOR_SYSTEM_PROMPT).toMatch(/Declining is a good outcome and costs you nothing/)
  })
})
