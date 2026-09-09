import { useMemo } from 'react'
import { diffLines, type DiffLine } from '@/core/report/diff-lines'

export type { DiffLine }

/**
 * Per UI-SPEC §3.5.1 the polarity of every line is carried by FOUR independent
 * cues, all always on: the +/− gutter glyph, a solid-vs-dashed left rail,
 * deliberate lightness separation, and the persistent pane labels below.
 * The result stays readable in greyscale and under deuteranopia.
 */
export function Diff({
  before, after, sideBySide,
}: { before: string; after: string; sideBySide: boolean }) {
  const lines = useMemo(() => diffLines(before, after), [before, after])

  if (sideBySide) {
    return (
      <div className="diff diff--side-by-side">
        <div className="diff__panes">
          <div className="diff__pane">
            <div className="diff__label diff__label--del">
              <span className="glyph" aria-hidden="true">−</span> Current
            </div>
            <div className="diff__body">
              {lines.filter((l) => l.kind !== 'add').map((l, k) => <Line key={k} line={l} side="left" />)}
            </div>
          </div>
          <div className="diff__pane">
            <div className="diff__label diff__label--add">
              <span className="glyph" aria-hidden="true">+</span> Proposed
            </div>
            <div className="diff__body">
              {lines.filter((l) => l.kind !== 'del').map((l, k) => <Line key={k} line={l} side="right" />)}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Narrow: one unified column. Same cues, no horizontal split.
  return (
    <div className="diff">
      <div className="diff__label">
        <span className="glyph diff__label--del" aria-hidden="true">−</span>
        <span className="diff__label--del">Current</span>
        <span className="dim2" aria-hidden="true">→</span>
        <span className="glyph diff__label--add" aria-hidden="true">+</span>
        <span className="diff__label--add">Proposed</span>
      </div>
      <div className="diff__body">
        {lines.map((l, k) => <Line key={k} line={l} side="unified" />)}
      </div>
    </div>
  )
}

function Line({ line, side }: { line: DiffLine; side: 'left' | 'right' | 'unified' }) {
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
  const no = side === 'left' ? line.leftNo : side === 'right' ? line.rightNo : (line.rightNo ?? line.leftNo)
  const label = line.kind === 'add' ? 'Added line' : line.kind === 'del' ? 'Removed line' : undefined

  return (
    <div className={`diff__line diff__line--${line.kind}`}>
      <span className="diff__gutter" aria-hidden="true">{no ?? ''}</span>
      <span className="diff__marker" aria-hidden="true">{marker}</span>
      <span>
        {label ? <span className="sr-only">{label}: </span> : null}
        {line.text || ' '}
      </span>
    </div>
  )
}
