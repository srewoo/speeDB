/**
 * Line diff, in core rather than in the UI layer.
 *
 * `report/patch.ts` needs this to build unified diffs, and it used to import it
 * from `@/components/Diff` — a React module. That was the only import reaching
 * out of `src/core` into the UI, and it pulled React into the module graph of
 * anything that touched the exporters, including headless callers that have no
 * DOM at all. The function itself never used React; only its file did.
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  leftNo?: number
  rightNo?: number
}

/**
 * Minimal LCS diff. A real dependency is not worth it here — the inputs are
 * single queries, tens of lines at most, and shipping a diff library into an
 * extension bundle costs more than this function.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\s+$/, '').split('\n')
  const b = after.replace(/\s+$/, '').split('\n')

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j]
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  let leftNo = 1
  let rightNo = 1
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]!, leftNo: leftNo++, rightNo: rightNo++ })
      i++; j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]!, leftNo: leftNo++ })
      i++
    } else {
      out.push({ kind: 'add', text: b[j]!, rightNo: rightNo++ })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]!, leftNo: leftNo++ })
  while (j < b.length) out.push({ kind: 'add', text: b[j++]!, rightNo: rightNo++ })
  return out
}
