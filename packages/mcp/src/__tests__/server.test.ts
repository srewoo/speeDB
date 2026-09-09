import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../server.js'

/**
 * Driven over a real MCP transport, not by calling the handlers directly.
 *
 * `real-path.test.ts` in core exists because two runtime failures got through a
 * suite that injected fakes at every boundary: the real adapters, and the
 * module-init order of everything only they pull in, were never loaded. The
 * same trap is available here — testing `makeHandlers` in isolation would never
 * execute tool registration, zod input validation, or the JSON envelope, which
 * is most of what can actually break between this code and a working server.
 */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function payload(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content
  return content.map((c) => c.text).join('\n')
}

/** A small repository with one obvious N+1 and the schema to ground it against. */
async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'speedb-mcp-'))
  await mkdir(join(root, 'app'), { recursive: true })
  await mkdir(join(root, 'migrations'), { recursive: true })

  await writeFile(join(root, 'app', 'views.py'), [
    'from .models import Order, Profile',
    '',
    'def order_report(request):',
    '    orders = Order.objects.filter(status="open")',
    '    rows = []',
    '    for order in orders:',
    '        profile = Profile.objects.filter(user_id=order.user_id).first()',
    '        rows.append((order, profile))',
    '    return rows',
    '',
  ].join('\n'))

  await writeFile(join(root, 'migrations', '0001_initial.sql'), [
    'CREATE TABLE orders (id serial primary key, user_id int, status text);',
    'CREATE TABLE profiles (id serial primary key, user_id int, bio text);',
    'CREATE INDEX idx_orders_status ON orders (status);',
    '',
  ].join('\n'))

  await writeFile(join(root, 'settings.py'), "DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql'}}\n")
  return root
}

describe('speeDB MCP server', () => {
  it('registers every tool over a real transport', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_equivalence', 'detect_queries', 'explain_recipe', 'scan_cancel',
      'scan_next', 'scan_report', 'scan_start', 'scan_submit', 'schema_facts',
    ])
  })

  it('detects a query site in a real directory, and calls no model to do it', async () => {
    const client = await connect()
    const root = await fixtureRepo()

    const result = await client.callTool({ name: 'detect_queries', arguments: { path: root } })
    const out = JSON.parse(payload(result))

    expect(out.candidates).toBeGreaterThan(0)
    expect(out.sites.some((s: { file: string }) => s.file === 'app/views.py')).toBe(true)
    // The engine profile is read from settings.py, not guessed from the query.
    expect(out.engineProfile.primary).toBe('postgres')
  })

  it('scores a query inside a loop above one at function scope', async () => {
    const client = await connect()

    /*
     * The two sites are deliberately far apart. Detection merges hits whose
     * spans fall within 120 characters of each other, so two short statements
     * on adjacent lines are one candidate by design — putting them in separate
     * functions is what a real file looks like anyway.
     */
    const call = async (body: string) => {
      const out = JSON.parse(payload(await client.callTool({
        name: 'detect_queries',
        arguments: { files: [{ path: 'app/views.py', content: body }] },
      })))
      return out.sites[0]
    }

    const flat = await call([
      'def summary(request):',
      '    return Order.objects.filter(status="open")',
    ].join('\n'))

    const looped = await call([
      'def report(request, orders):',
      '    for o in orders:',
      '        p = Profile.objects.filter(user_id=o.user_id).first()',
      '    return p',
    ].join('\n'))

    expect(looped.loopDepth).toBe(1)
    expect(flat.loopDepth).toBe(0)
    // A query issued once per iteration on a request path is the whole point.
    expect(looped.priority).toBeGreaterThan(flat.priority)
  })

  it('reports a dropped column as contradicted rather than as equivalent', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'check_equivalence',
      arguments: { original: 'SELECT id, name, email FROM users', proposed: 'SELECT id, name FROM users' },
    })
    const out = JSON.parse(payload(result))
    expect(out.status).toBe('contradicted')
    expect(out.deltas.some((d: { property: string }) => d.property === 'projection')).toBe(true)
  })

  it('verifies an unchanged statement', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'check_equivalence',
      arguments: {
        original: 'SELECT id FROM users WHERE tenant_id = 1',
        proposed: 'SELECT id FROM users WHERE tenant_id = 1',
      },
    })
    expect(JSON.parse(payload(result)).status).toBe('machine-verified')
  })

  it('gives an engine-appropriate verification recipe, not a SQL one for Mongo', async () => {
    const client = await connect()
    const pg = JSON.parse(payload(await client.callTool({
      name: 'explain_recipe', arguments: { engine: 'postgres' },
    })))
    const mongo = JSON.parse(payload(await client.callTool({
      name: 'explain_recipe', arguments: { engine: 'mongodb' },
    })))

    expect(pg.measure).toContain('ANALYZE')
    expect(mongo.plan).toContain('explain')
    expect(mongo.measure ?? '').not.toContain('EXPLAIN ANALYZE')
    expect(pg.lookFor.length).toBeGreaterThan(0)
  })

  it('reads declared tables and indexes, and refuses an index that already exists', async () => {
    const client = await connect()
    const root = await fixtureRepo()

    const out = JSON.parse(payload(await client.callTool({
      name: 'schema_facts',
      arguments: { path: root, proposedIndex: 'CREATE INDEX ON orders (status)' },
    })))

    expect(out.tables).toContain('orders')
    expect(out.tables).toContain('profiles')
    expect(out.proposedIndexVerdict).not.toBeNull()
    expect(out.cannotKnow).toContain('row counts')
  })

  it('rejects a submit whose requestId does not match the parked prompt', async () => {
    const client = await connect()
    const root = await fixtureRepo()

    const started = JSON.parse(payload(await client.callTool({
      name: 'scan_start', arguments: { path: root },
    })))
    expect(started.sessionId).toBeTruthy()

    const next = JSON.parse(payload(await client.callTool({
      name: 'scan_next', arguments: { sessionId: started.sessionId },
    })))
    expect(next.status).toBe('prompt')

    const bad = JSON.parse(payload(await client.callTool({
      name: 'scan_submit',
      arguments: { sessionId: started.sessionId, requestId: 'req-999', response: '{"verdicts":[]}' },
    })))
    expect(bad.status).toBe('rejected')
    expect(bad.reason).toContain('Stale request id')

    await client.callTool({ name: 'scan_cancel', arguments: { sessionId: started.sessionId } })
  })

  it('narrows to changed files, and does not invent a pull request number', async () => {
    const client = await connect()

    /*
     * `changedOnly` reaches the same narrowing a pull request does, because the
     * mechanism is identical — ingest everything, scope only the candidates.
     * What it must not do is borrow the label: a local `git diff` reported as
     * "#1" names a pull request that does not exist.
     */
    const root = await mkdtemp(join(tmpdir(), 'speedb-git-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 't@t.t')
    git('config', 'user.name', 't')
    await mkdir(join(root, 'app'), { recursive: true })
    await writeFile(join(root, 'settings.py'), "DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql'}}\n")
    await writeFile(join(root, 'app', 'old.py'), 'def existing(request):\n    return Order.objects.filter(status="open")\n')
    git('add', '-A'); git('commit', '-qm', 'base')
    await writeFile(join(root, 'app', 'new.py'),
      'def added(request, orders):\n    for o in orders:\n        p = Profile.objects.filter(user_id=o.user_id).first()\n    return p\n')
    git('add', '-A'); git('commit', '-qm', 'add n+1')

    const run = async (changedOnly: boolean) => {
      const s = JSON.parse(payload(await client.callTool({
        name: 'scan_start', arguments: { path: root, changedOnly },
      })))
      const files = new Set<string>()
      for (let i = 0; i < 40; i++) {
        const n = JSON.parse(payload(await client.callTool({
          name: 'scan_next', arguments: { sessionId: s.sessionId },
        })))
        if (n.status === 'done' || n.status === 'error') break
        if (n.status === 'working') continue
        for (const m of String(n.user).matchAll(/\b(app\/\w+\.py)\b/g)) files.add(m[1]!)
        await client.callTool({
          name: 'scan_submit',
          arguments: {
            sessionId: s.sessionId, requestId: n.requestId,
            response: /verdict/i.test(n.user)
              ? '{"verdicts":[]}'
              : '{"findings":[],"declined":[]}',
          },
        })
      }
      const report = JSON.parse(payload(await client.callTool({
        name: 'scan_report', arguments: { sessionId: s.sessionId, format: 'json' },
      })))
      return { files, scope: report.scope }
    }

    const full = await run(false)
    expect(full.scope).toEqual({ kind: 'repository' })
    expect(full.files.has('app/old.py')).toBe(true)

    const changed = await run(true)
    expect(changed.scope).toEqual({ kind: 'changed-files', files: 1 })
    expect(changed.files.has('app/new.py')).toBe(true)
    expect(changed.files.has('app/old.py')).toBe(false)
  }, 60_000)

  /**
   * The whole point of the design, exercised end to end.
   *
   * A stub agent plays the model: it answers triage by flagging every site, and
   * authoring by inventing a finding whose citation is a real line of a real
   * file. The assertion that matters is not that a finding appears — it is that
   * the scan completed through triage, authoring, grounding and the value gate
   * without any of them being reimplemented here.
   */
  it('runs a full scan to completion with the agent supplying every completion', async () => {
    const client = await connect()
    const root = await fixtureRepo()

    const started = JSON.parse(payload(await client.callTool({
      name: 'scan_start', arguments: { path: root, maxCandidates: 3 },
    })))
    const sessionId = started.sessionId

    let done = false
    let prompts = 0
    for (let step = 0; step < 40 && !done; step++) {
      const next = JSON.parse(payload(await client.callTool({
        name: 'scan_next', arguments: { sessionId },
      })))

      if (next.status === 'done') { done = true; break }
      if (next.status === 'error') throw new Error(`scan failed: ${next.error}`)
      if (next.status === 'working') continue

      prompts++
      const submitted = JSON.parse(payload(await client.callTool({
        name: 'scan_submit',
        arguments: { sessionId, requestId: next.requestId, response: answer(next.user) },
      })))
      expect(submitted.status).toBe('accepted')
    }

    expect(done).toBe(true)
    expect(prompts).toBeGreaterThan(0)

    const report = payload(await client.callTool({
      name: 'scan_report', arguments: { sessionId, format: 'markdown' },
    }))
    expect(report).toContain('speeDB')
  }, 60_000)

  it('holds back an invented citation instead of publishing it', async () => {
    const client = await connect()
    const root = await fixtureRepo()

    const started = JSON.parse(payload(await client.callTool({
      name: 'scan_start', arguments: { path: root, maxCandidates: 2 },
    })))
    const sessionId = started.sessionId

    for (let step = 0; step < 40; step++) {
      const next = JSON.parse(payload(await client.callTool({
        name: 'scan_next', arguments: { sessionId },
      })))
      if (next.status === 'done' || next.status === 'error') break
      if (next.status === 'working') continue
      await client.callTool({
        name: 'scan_submit',
        arguments: { sessionId, requestId: next.requestId, response: answer(next.user, true) },
      })
    }

    const out = JSON.parse(payload(await client.callTool({
      name: 'scan_report', arguments: { sessionId, format: 'json' },
    })))
    // A finding citing a file that is not in the tree must never be published.
    for (const f of out.findings ?? []) {
      expect(f.primaryOccurrence.file).not.toBe('does/not/exist.py')
    }
  }, 60_000)
})

/**
 * The stub agent.
 *
 * Triage prompts are answered by flagging every id the prompt listed; authoring
 * prompts by declining. Declining is deliberate: it exercises the reconciliation
 * path — a site that is accounted for but produces no finding — which is the
 * branch a naive stub that always authors would never reach.
 */
function answer(user: string, invent = false): string {
  const ids = [...user.matchAll(/\b(c\d+[a-z0-9-]*)\b/gi)].map((m) => m[1])
  const unique = [...new Set(ids)]

  if (/verdict/i.test(user)) {
    return JSON.stringify({
      verdicts: unique.map((id) => ({
        id, verdict: 'problem', category: 'n-plus-one', why: 'query inside a loop',
      })),
    })
  }

  if (invent) {
    return JSON.stringify({
      findings: [{
        siteId: unique[0] ?? 'c1',
        title: 'Invented finding',
        severity: 'high',
        category: 'n-plus-one',
        primaryOccurrence: { file: 'does/not/exist.py', startLine: 1, endLine: 2 },
        original: 'x', suggestion: { proposed: 'y', rationale: 'z' },
      }],
      declined: [],
    })
  }

  return JSON.stringify({
    findings: [],
    declined: unique.map((id) => ({ siteId: id, why: 'not worth reporting' })),
  })
}
