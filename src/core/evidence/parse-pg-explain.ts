import type { ParsedPlan, PlanNode } from './types'

/**
 * Postgres `EXPLAIN` output, in both forms people actually have.
 *
 * `FORMAT JSON` is what the recipes ask for and what the comparison wants — it
 * is unambiguous and carries every field. But most people paste what psql
 * printed, because that is what is on their screen, and refusing it would mean
 * the feature is only usable by people who read the instructions first. So the
 * text form is parsed too, on the understanding that it carries less: the
 * indent tree is reliable, the per-node detail lines are reliable, and anything
 * else is best-effort and noted rather than guessed.
 *
 * What is deliberately *not* done: no attempt to reconstruct fields the output
 * does not contain. An untimed `EXPLAIN` has no actual rows, and inventing them
 * from the estimates would produce a comparison that looks measured and is not.
 * Absent stays `undefined`, and `ParsedPlan.timed` says which kind this is.
 */

export interface ParseResult {
  plan: ParsedPlan | null
  notes: string[]
  error?: string
}

export function parsePgExplain(raw: string): ParseResult {
  const text = raw.trim()
  if (!text) return { plan: null, notes: [], error: 'Nothing was pasted.' }

  // JSON first: `EXPLAIN (FORMAT JSON)` returns an array with one object.
  const asJson = tryJson(text)
  if (asJson) return asJson

  return parseText(text)
}

/* -------------------------------------------------------------- JSON form -- */

function tryJson(text: string): ParseResult | null {
  const start = text.indexOf('[')
  const brace = text.indexOf('{')
  if (start === -1 && brace === -1) return null

  let doc: unknown
  try {
    doc = JSON.parse(text.slice(Math.min(...[start, brace].filter((i) => i !== -1))))
  } catch {
    return null
  }

  const first = Array.isArray(doc) ? doc[0] : doc
  const planNode = (first as Record<string, unknown> | undefined)?.['Plan']
  if (!planNode || typeof planNode !== 'object') return null

  const notes: string[] = []
  const root = fromJsonNode(planNode as Record<string, unknown>, notes)
  const wrapper = first as Record<string, unknown>

  return {
    plan: {
      root,
      timed: root.actualTotalMs !== undefined,
      totalMs: num(wrapper['Execution Time']),
      planningMs: num(wrapper['Planning Time']),
    },
    notes,
  }
}

function fromJsonNode(node: Record<string, unknown>, notes: string[]): PlanNode {
  const children = Array.isArray(node['Plans'])
    ? (node['Plans'] as Record<string, unknown>[]).map((c) => fromJsonNode(c, notes))
    : []

  const loops = num(node['Actual Loops'])
  const rowsPerLoop = num(node['Actual Rows'])

  return {
    nodeType: String(node['Node Type'] ?? 'Unknown'),
    relation: str(node['Relation Name']) ?? str(node['Index Name']),
    // Postgres reports Actual Rows *per loop*. A query inside a loop that ran
    // 400 times reports 1 row, not 400, and comparing that against a batched
    // rewrite's 400 would read as a 400x regression. Multiplying is what makes
    // the two comparable — and it is the whole reason an N+1 shows up here at
    // all.
    actualRows: rowsPerLoop === undefined ? undefined : rowsPerLoop * (loops ?? 1),
    estimatedRows: num(node['Plan Rows']),
    rowsRemovedByFilter: num(node['Rows Removed by Filter']),
    blocksRead: num(node['Shared Read Blocks']),
    blocksHit: num(node['Shared Hit Blocks']),
    actualTotalMs: (() => {
      const t = num(node['Actual Total Time'])
      return t === undefined ? undefined : t * (loops ?? 1)
    })(),
    loops,
    sortMethod: str(node['Sort Method'])
      ? `${str(node['Sort Method'])}${node['Sort Space Used'] ? ` ${node['Sort Space Type']}: ${node['Sort Space Used']}kB` : ''}`
      : undefined,
    detail: pickDetail(node),
    children,
  }
}

const DETAIL_KEYS = [
  'Index Cond', 'Filter', 'Join Filter', 'Hash Cond', 'Recheck Cond',
  'Sort Key', 'Group Key', 'Strategy', 'Parallel Aware',
]

function pickDetail(node: Record<string, unknown>): Record<string, string | number> | undefined {
  const out: Record<string, string | number> = {}
  for (const k of DETAIL_KEYS) {
    const v = node[k]
    if (typeof v === 'string' || typeof v === 'number') out[k] = v
    else if (Array.isArray(v)) out[k] = v.join(', ')
  }
  return Object.keys(out).length ? out : undefined
}

/* -------------------------------------------------------------- text form -- */

/** `  ->  Seq Scan on orders  (cost=0.00..1.2 rows=42 width=8) (actual time=0.1..2.3 rows=40 loops=1)` */
const NODE_LINE = /^(\s*)(?:->\s+)?([A-Z][A-Za-z ]*?)(?:\s+on\s+([\w."]+))?\s+\(cost=/
const ACTUAL = /\(actual time=[\d.]+\.\.([\d.]+) rows=(\d+) loops=(\d+)\)/
const ESTIMATE = /rows=(\d+)\s+width=/
const BUFFERS = /shared hit=(\d+)(?: read=(\d+))?|shared read=(\d+)/
const REMOVED = /Rows Removed by Filter:\s*(\d+)/
const SORT_METHOD = /Sort Method:\s*(.+)$/
const EXEC_TIME = /Execution Time:\s*([\d.]+) ms/
const PLAN_TIME = /Planning Time:\s*([\d.]+) ms/

function parseText(text: string): ParseResult {
  const lines = text.split(/\r?\n/)
  const notes: string[] = []

  /** Nodes with the indent they were found at, so the tree can be rebuilt. */
  const stack: { indent: number; node: PlanNode }[] = []
  let root: PlanNode | null = null
  let current: PlanNode | null = null
  let timed = false

  for (const line of lines) {
    const m = NODE_LINE.exec(line)
    if (m) {
      const indent = m[1]!.length
      const node: PlanNode = {
        nodeType: m[2]!.trim(),
        relation: m[3]?.replace(/"/g, ''),
        children: [],
      }

      const est = ESTIMATE.exec(line)
      if (est) node.estimatedRows = Number(est[1])

      const act = ACTUAL.exec(line)
      if (act) {
        timed = true
        const loops = Number(act[3])
        node.loops = loops
        // Per-loop, same as the JSON form. See fromJsonNode.
        node.actualRows = Number(act[2]) * loops
        node.actualTotalMs = Number(act[1]) * loops
      }

      // Attach to the nearest shallower node.
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop()
      if (stack.length === 0) {
        if (root) {
          notes.push('More than one plan root was found; only the first was read.')
          break
        }
        root = node
      } else {
        stack[stack.length - 1]!.node.children.push(node)
      }
      stack.push({ indent, node })
      current = node
      continue
    }

    // Detail lines belong to the node above them.
    if (!current) continue

    const buf = BUFFERS.exec(line)
    if (buf) {
      if (buf[1] !== undefined) current.blocksHit = Number(buf[1])
      const read = buf[2] ?? buf[3]
      if (read !== undefined) current.blocksRead = Number(read)
    }
    const rem = REMOVED.exec(line)
    if (rem) current.rowsRemovedByFilter = Number(rem[1])
    const sort = SORT_METHOD.exec(line)
    if (sort) current.sortMethod = sort[1]!.trim()
  }

  if (!root) {
    return {
      plan: null,
      notes,
      error:
        'This does not look like Postgres EXPLAIN output — no plan node was found. ' +
        'Paste the output of EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for the most reliable read.',
    }
  }

  if (!timed) {
    notes.push(
      'This is a plan without timings — EXPLAIN rather than EXPLAIN ANALYZE. ' +
      'It shows what the planner intends, not what happened, so it can show a chosen index but cannot show a speed-up.',
    )
  }

  const exec = EXEC_TIME.exec(text)
  const plan = PLAN_TIME.exec(text)

  return {
    plan: {
      root,
      timed,
      totalMs: exec ? Number(exec[1]) : undefined,
      planningMs: plan ? Number(plan[1]) : undefined,
    },
    notes,
  }
}

/* ----------------------------------------------------------------- utils -- */

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/* ------------------------------------------------------------ aggregation -- */

/** Depth-first walk, so callers can total or search without re-implementing it. */
export function walkPlan(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node)
  for (const child of node.children) walkPlan(child, visit)
}

export interface PlanTotals {
  blocksRead: number
  blocksHit: number
  rowsRemovedByFilter: number
  /** Every distinct node type in the plan, for a scan-type comparison. */
  nodeTypes: Set<string>
  /** Node types that read a whole relation. */
  scanNodes: string[]
  /** Sort nodes that spilled to disk. */
  diskSorts: string[]
  /** True when *no* node reported blocks; the capture had no BUFFERS. */
  hasBuffers: boolean
}

const SEQ_SCAN = /^(Seq Scan|Parallel Seq Scan)$/

export function totalsFor(plan: ParsedPlan): PlanTotals {
  const t: PlanTotals = {
    blocksRead: 0, blocksHit: 0, rowsRemovedByFilter: 0,
    nodeTypes: new Set(), scanNodes: [], diskSorts: [], hasBuffers: false,
  }
  walkPlan(plan.root, (n) => {
    t.nodeTypes.add(n.nodeType)
    if (n.blocksRead !== undefined || n.blocksHit !== undefined) t.hasBuffers = true
    t.blocksRead += n.blocksRead ?? 0
    t.blocksHit += n.blocksHit ?? 0
    t.rowsRemovedByFilter += n.rowsRemovedByFilter ?? 0
    if (SEQ_SCAN.test(n.nodeType)) t.scanNodes.push(n.relation ?? n.nodeType)
    // `external merge` / `external sort` mean it did not fit in work_mem. A
    // quicksort in memory was never the cost, whatever the finding argued.
    if (n.sortMethod && /external/i.test(n.sortMethod)) t.diskSorts.push(n.sortMethod)
  })
  return t
}
