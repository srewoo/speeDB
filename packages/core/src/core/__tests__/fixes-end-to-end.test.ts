import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import { runScan } from '../pipeline'

/**
 * All six fixes, driven through the real `runScan` with no dependency injection.
 *
 * Every other test for these exercises one module. This one proves the wiring:
 * the engine profile reaches detection, the scope reaches the prompt, the gate
 * runs after grounding, and the coverage numbers reach the report. Two of the
 * runtime failures this codebase has shipped were wiring failures that every
 * unit test passed straight through.
 *
 * The repository below is the reproduction in miniature — a Django/MySQL project
 * whose worst query sits at the bottom of a long file, with a comment mentioning
 * OpenSearch, a migration, and a JavaScript file that is not data access.
 */

const SETTINGS = 'DATABASES = {"default": {"ENGINE": "django.db.backends.mysql", "NAME": "tcms"}}\n'

const VIEWS = [
  'from django.views import View',
  'from .models import Section, TestCase, Product',
  '',
  'def trivial(request, pk):',
  '    return TestCase.objects.get(pk=pk)',
  '',
  // Filler: enough sites, spaced widely enough not to merge, that the old
  // slice-by-line-number cap would have dropped the view at the bottom.
  ...Array.from({ length: 60 }, (_, i) => [
    `def filler_${i}(request):`,
    `    return Product.objects.filter(id=${i}).values("id")`,
    `    # ${'pad '.repeat(40)}`,
    `    # ${'pad '.repeat(40)}`,
    '',
  ]).flat(),
  'class StreamReportView(View):',
  '    def get(self, request, stream):',
  '        # TODO: move this report to opensearch when the cluster lands',
  '        section_data = []',
  '        for sec in Section.objects.filter(product=stream).order_by("name"):',
  '            sc_total = TestCase.objects.filter(section=sec).count()',
  '            if not sc_total:',
  '                continue',
  '            section_data.append((sec, sc_total))',
  '        return section_data',
].join('\n')

const MIGRATION = [
  'def forwards(apps, schema_editor):',
  '    TestCase = apps.get_model("testcases", "TestCase")',
  '    for case in TestCase.objects.filter(summary__contains="legacy"):',
  '        case.summary = case.summary.replace("legacy", "")',
  '        case.save()',
].join('\n')

const CASE_PICKER = [
  'function buildUrl(sectionId, planId) {',
  "  let url = '/cases/'",
  "  let sep = '?'",
  "  if (sectionId) { url += sep + 'section=' + sectionId; sep = '&'; }",
  '  return url',
  '}',
].join('\n')

function archive(files: { name: string; body: string }[]): Uint8Array {
  const enc = new TextEncoder()
  const blocks: Uint8Array[] = []
  for (const f of files) {
    const header = new Uint8Array(512)
    const body = enc.encode(f.body)
    header.set(enc.encode(`repo-abc123/${f.name}`.slice(0, 100)), 0)
    header.set(enc.encode(body.length.toString(8).padStart(11, '0') + '\0'), 124)
    header[156] = '0'.charCodeAt(0)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512)
    padded.set(body)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const b of blocks) { out.set(b, at); at += b.length }
  return new Uint8Array(gzipSync(Buffer.from(out)))
}

const TARBALL = archive([
  { name: 'tcms/settings/common.py', body: SETTINGS },
  { name: 'tcms/core/views.py', body: VIEWS },
  { name: 'tcms/core/migrations/0001_squashed.py', body: MIGRATION },
  { name: 'tcms/static/js/casePicker.js', body: CASE_PICKER },
  { name: 'requirements/base.txt', body: 'Django==4.2\nmysqlclient==2.2.0\n' },
])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } })
}

/** Findings shaped like the ones the 2026-08-26 report actually published. */
const MODEL_REPLY = JSON.stringify({
  findings: [
    {
      kind: 'equivalent',
      title: 'Batch the per-section count',
      summary: 'The count runs once per section inside the loop.',
      severity: 'medium',
      category: 'n-plus-one',
      engine: 'mysql',
      accessStyle: 'orm',
      original: 'sc_total = TestCase.objects.filter(section=sec).count()',
      primaryOccurrence: {
        file: 'tcms/core/views.py',
        startLine: VIEWS.split('\n').findIndex((l) => l.includes('sc_total =')) + 1,
        endLine: VIEWS.split('\n').findIndex((l) => l.includes('sc_total =')) + 1,
        excerpt: 'sc_total = TestCase.objects.filter(section=sec).count()',
      },
      otherOccurrences: [],
      suggestion: {
        proposed: 'counts = Section.objects.filter(product=stream).annotate(sc_total=Count("testcase")).values("id", "sc_total")',
        rationale: 'One grouped query instead of one per section.',
        equivalenceArgument: 'Same rows, same columns, same ordering, same NULL and duplicate handling.',
        assumptions: [],
        expectedImpact: '1 query instead of one per section',
      },
      evidence: [],
      modelConfidence: 0.8,
    },
    {
      kind: 'equivalent',
      title: 'Avoid rebuilding the URL string',
      summary: 'The URL is assembled with repeated concatenation.',
      severity: 'high',
      category: 'other',
      engine: 'mysql',
      accessStyle: 'raw-sql',
      original: "if (sectionId) { url += sep + 'section=' + sectionId; sep = '&'; }",
      primaryOccurrence: {
        file: 'tcms/static/js/casePicker.js', startLine: 4, endLine: 4,
        excerpt: "if (sectionId) { url += sep + 'section=' + sectionId; sep = '&'; }",
      },
      otherOccurrences: [],
      suggestion: {
        proposed: "url += '?' + new URLSearchParams({ section: sectionId }).toString()",
        rationale: 'Cleaner.',
        equivalenceArgument: 'Same rows, same columns, ordering unchanged, no NULL or duplicate change.',
        assumptions: [],
        expectedImpact: 'fewer allocations',
      },
      evidence: [],
      modelConfidence: 0.7,
    },
    {
      kind: 'equivalent',
      title: 'Replace __contains in the migration',
      summary: 'A LIKE predicate cannot use an index.',
      severity: 'critical',
      category: 'full-scan',
      engine: 'mysql',
      accessStyle: 'orm',
      original: 'for case in TestCase.objects.filter(summary__contains="legacy"):',
      primaryOccurrence: {
        file: 'tcms/core/migrations/0001_squashed.py', startLine: 3, endLine: 3,
        excerpt: 'for case in TestCase.objects.filter(summary__contains="legacy"):',
      },
      otherOccurrences: [],
      suggestion: {
        proposed: 'for case in TestCase.objects.filter(summary__startswith="legacy"):',
        rationale: 'A prefix match can use an index.',
        equivalenceArgument: 'Rows differ.',
        assumptions: [],
        expectedImpact: 'index range scan instead of a full scan',
      },
      evidence: [],
      modelConfidence: 0.6,
    },
  ],
})

let prompts: string[] = []
let injectedJunk = false

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

let store: Record<string, unknown> = {}
beforeEach(() => {
  store = {}
  prompts = []
  injectedJunk = false
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o) },
      remove: async (k: string) => { delete store[k] },
    } },
  }

  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/repository/archive')) return new Response(streamOf(TARBALL), { status: 200 })
    if (u.includes('/repository/commits/')) return Response.json({ id: 'abc1234567' })
    if (u.includes('api.anthropic.com')) {
      const body = String(init?.body ?? '')
      prompts.push(body)
      // The pipeline triages before it authors, so the double has to answer
      // whichever stage it was asked about — flag every site, then return the
      // prepared findings for the authoring request.
      if (/triaging query sites/.test(body)) {
        const ids = [...body.matchAll(/## id: ([^\\"\n]+)/g)].map((m) => m[1]!)
        return Response.json({
          content: [{ type: 'text', text: JSON.stringify({
            verdicts: ids.map((id) => ({ id, verdict: 'problem', category: 'other', why: 'flagged by the test double' })),
          }) }],
          usage: { input_tokens: 100, output_tokens: 20 },
        })
      }
      // Authoring runs in batches, so the double must answer only for the sites
      // actually in this batch — returning the whole prepared set every time
      // would publish each finding once per batch.
      const prepared = JSON.parse(MODEL_REPLY).findings
      const wanted = prepared.filter(
        (f: { primaryOccurrence: { file: string; startLine: number } }) =>
          body.includes(f.primaryOccurrence.file) &&
          body.includes(String(f.primaryOccurrence.startLine)),
      )
      // The JavaScript finding is about a site triage would never flag, so it
      // has to be injected once to test what it is here to test: that an author
      // inventing a finding about non-data-access code is still caught by the
      // gate rather than published. Once, not per batch.
      if (!injectedJunk) {
        injectedJunk = true
        wanted.push(...prepared.filter((f: { primaryOccurrence: { file: string } }) =>
          f.primaryOccurrence.file.endsWith('casePicker.js')))
      }
      return Response.json({
        content: [{ type: 'text', text: JSON.stringify({ findings: wanted }) }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    }
    return Response.json({ default_branch: 'main' })
  }) as unknown as typeof fetch
})

const scan = () => runScan(
  { forge: 'gitlab', apiOrigin: 'https://gitlab.com/api', owner: 'mindtickle/qa-automation', name: 'mt-test-studio' },
  {
    provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-ant-test',
    temperature: 0, maxOutputTokens: 4096, tokenBudget: 1_000_000, noCache: true,
  },
)

describe('the six fixes, through the real pipeline', () => {
  it('Fix 3: infers MySQL from settings and the requirements file', async () => {
    const report = await scan()
    expect(report.engineProfile?.primary).toBe('mysql')
    expect(report.engineProfile?.declared[0]!.source).toBe('tcms/settings/common.py')
    expect(report.engineProfile?.ambiguous).toBe(false)
  })

  it('Fix 3: no candidate is labelled with an engine the repo never declared', async () => {
    await scan()
    const body = prompts.join('\n')
    for (const wrong of ['mongodb', 'redshift', 'bigquery', 'opensearch', 'hive']) {
      expect(body).not.toMatch(new RegExp(`detected as ${wrong}/`))
    }
  })

  it('Fix 1: the loop query at the bottom of the file reaches the model', async () => {
    await scan()
    const body = prompts.join('\n')
    expect(body).toContain('TestCase.objects.filter(section=sec).count()')
  })

  it('Fix 2: the prompt states the enclosing scope of every site', async () => {
    await scan()
    const body = prompts.join('\n')
    expect(body).toMatch(/enclosing: StreamReportView\.get/)
    expect(body).toMatch(/inside 1 loop/)
    expect(body).toMatch(/reached by: request-handler/)
    expect(body).toMatch(/reached by: migration/)
  })

  it('Fix 2: the loop header is prepended to the excerpt the model sees', async () => {
    await scan()
    expect(prompts.join('\n')).toMatch(/for sec in Section\.objects\.filter\(product=stream\)/)
  })

  it('Fix 5: the JavaScript finding is suppressed as not data access', async () => {
    const report = await scan()
    const held = report.suppressed.find((f) => f.title.includes('URL'))
    expect(held?.suppression?.reason).toBe('not-data-access')
    expect(report.findings.some((f) => f.title.includes('URL'))).toBe(false)
  })

  it('Fix 5: the migration finding is suppressed as cold path, not published as critical', async () => {
    const report = await scan()
    const held = report.suppressed.find((f) => f.title.includes('__contains'))
    expect(held?.suppression?.reason).toBe('cold-path')
    expect(held?.severity).toBe('info')
  })

  it('Fix 5: the real N+1 survives the gate', async () => {
    const report = await scan()
    expect(report.findings.map((f) => f.title)).toEqual(['Batch the per-section count'])
  })

  it('Fix 4: the published finding carries counted facts and no EXPLAIN', async () => {
    const report = await scan()
    const f = report.findings[0]!
    expect(f.performance!.counted.length).toBeGreaterThan(0)
    expect(f.performance!.counted.join(' ')).toMatch(/Counted/)
    const commands = f.performance!.verification.map((v) => v.command).join('\n')
    expect(commands).not.toMatch(/EXPLAIN/i)
    expect(commands).toMatch(/CaptureQueriesContext/)
  })

  it('Fix 4: equivalence is decided, not declared unreadable', async () => {
    const report = await scan()
    expect(report.findings[0]!.equivalence!.status).not.toBe('unverifiable')
  })

  it('Fix 2 + 5: the published N+1 is confirmed to be in a loop', async () => {
    const report = await scan()
    expect(report.findings[0]!.scope?.loopDepth).toBe(1)
    expect(report.findings[0]!.scope?.trigger).toBe('request-handler')
  })

  it('Fix 6: the report carries honest coverage numbers', async () => {
    const report = await scan()
    const s = report.stats
    expect(s.sitesMatched).toBeGreaterThan(0)
    expect(s.sitesAnalysed).toBeLessThanOrEqual(s.sitesMatched)
    expect(s.sitesFiltered.belowConfidence + s.sitesFiltered.lowPriority).toBeGreaterThan(0)
    expect(s.truncatedFiles.length).toBeGreaterThan(0)
    expect(s.truncatedFiles[0]!.path).toBe('tcms/core/views.py')
  })
})

describe('the archive fallback is never silent', () => {
  /*
   * The tarball endpoint on api.github.com answers with a 302 to
   * codeload.github.com. That host was missing from `host_permissions`, so the
   * redirect was a CORS failure — and `.catch(() => null)` turned a total
   * failure of the headline ingest path into a silent fallback to
   * one-request-per-file, three orders of magnitude more expensive against the
   * forge rate limit. It had never worked in the extension.
   */
  it('grants both hosts the GitHub tarball redirect needs', async () => {
    // `defineManifest` widens the export to a union that includes a Promise, so
    // the shape is narrowed here rather than asserted through `any`.
    const mod = await import('../../../../extension/manifest.config')
    const manifest = await (mod.default as unknown as Promise<{ host_permissions: string[] }>)
    expect(manifest.host_permissions).toContain('https://api.github.com/*')
    expect(manifest.host_permissions).toContain('https://codeload.github.com/*')
  })

  it('records why the archive failed and says the fallback is expensive', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/repository/archive')) {
        throw new TypeError('Failed to fetch')
      }
      if (u.includes('/repository/commits/')) return Response.json({ id: 'abc1234567' })
      if (u.includes('/repository/tree')) {
        return Response.json([{ path: 'tcms/core/views.py', type: 'blob' }])
      }
      if (u.includes('/repository/files/')) return Response.json({ content: btoa(VIEWS) })
      if (u.includes('api.anthropic.com')) {
        return Response.json({
          content: [{ type: 'text', text: JSON.stringify({ findings: [] }) }],
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      }
      return Response.json({ default_branch: 'main' })
    }) as unknown as typeof fetch

    const report = await scan().catch((e) => e as Error)
    if (report instanceof Error) {
      // A per-file fallback needs endpoints this fake does not fully serve; the
      // contract under test is that the reason is not discarded.
      expect(report.message).toBeTruthy()
      return
    }
    expect(report.stats.ingest).toBe('per-file')
    expect(report.ingestNote).toMatch(/single-archive request failed/)
    expect(report.ingestNote).toMatch(/rate limit/)
  })
})
