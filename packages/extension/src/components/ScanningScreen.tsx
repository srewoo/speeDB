import { useApp } from '@/store/app-store'
import { IconStop } from './icons'

const PHASES = [
  { key: 'resolving',  label: 'Resolve repository' },
  { key: 'listing',    label: 'List files' },
  { key: 'fetching',   label: 'Read source' },
  { key: 'detecting',  label: 'Find query sites' },
  { key: 'analysing',  label: 'Analyse' },
  { key: 'grounding',  label: 'Verify citations' },
] as const

/**
 * Spec §11: a scan takes minutes and spends money, so this screen reports real
 * numbers rather than an indeterminate spinner. Every counter here is a fact.
 */
export function ScanningScreen() {
  const { progress, cancelScan, repoUrl } = useApp()
  const currentIndex = PHASES.findIndex((p) => p.key === progress?.phase)

  if (progress?.phase === 'cached') {
    return (
      <div className="page stack-2">
        <h1 className="t-title">Loading cached result</h1>
        <p className="t-body-sm dim">{progress.message}</p>
      </div>
    )
  }

  return (
    <div className="page stack-6">
      <header className="stack-2">
        <h1 className="t-title">Scanning</h1>
        <p className="t-body-sm dim filepath">{repoUrl}</p>
      </header>

      <div className="stack-2">
        <div className={`progress${progress?.fraction === undefined ? ' progress--indeterminate' : ''}`}>
          <div
            className="progress__fill"
            style={progress?.fraction !== undefined ? { width: `${Math.round(progress.fraction * 100)}%` } : undefined}
          />
        </div>
        <p className="t-body-sm dim" aria-live="polite">{progress?.message ?? 'Starting…'}</p>
      </div>

      <ol className="stack-2">
        {PHASES.map((phase, i) => {
          const state = currentIndex === -1 ? 'pending'
            : i < currentIndex ? 'done'
            : i === currentIndex ? 'active' : 'pending'
          return (
            <li key={phase.key} className="row-3">
              <PhaseMark state={state} />
              <span
                className="t-body-sm"
                style={{
                  color: state === 'pending' ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  fontWeight: state === 'active' ? 600 : 400,
                }}
              >
                {phase.label}
              </span>
            </li>
          )
        })}
      </ol>

      <div className="stat-grid">
        <Counter
          value={progress?.filesFetched ?? 0}
          label={progress?.filesSkipped ? `Files read · ${progress.filesSkipped} skipped` : 'Files read'}
        />
        <Counter value={progress?.candidatesFound ?? 0} label="Query sites" />
        <Counter
          value={progress?.chunksTotal ? `${progress.chunksAnalysed}/${progress.chunksTotal}` : '—'}
          label="Passes"
        />
        <Counter value={(progress?.tokensUsed ?? 0).toLocaleString()} label="Tokens" />
      </div>

      <button className="btn btn--block" onClick={cancelScan}>
        <IconStop size={14} /> Stop scan
      </button>
    </div>
  )
}

function Counter({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="stat">
      <span className="stat__value t-num-lg">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  )
}

function PhaseMark({ state }: { state: 'done' | 'active' | 'pending' }) {
  const base: React.CSSProperties = {
    width: 14, height: 14, borderRadius: '50%', flex: 'none',
    border: '1.5px solid var(--border-strong)',
  }
  if (state === 'done') {
    return <span style={{ ...base, background: 'var(--accent-solid)', borderColor: 'var(--accent-solid)' }} />
  }
  if (state === 'active') {
    return <span style={{ ...base, borderColor: 'var(--accent-600)', borderWidth: 4 }} />
  }
  return <span style={base} />
}
