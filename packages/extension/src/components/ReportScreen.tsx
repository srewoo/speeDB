import { useMemo, useRef } from 'react'
import type { Finding, ScanReport } from '@/core/types'
import { groupFindings, useApp, visibleFindings } from '@/store/app-store'
import {
  EngineChip, EquivalenceChip, GroundingChip, KindChip, PerformanceChip,
  SeverityChip, FileRef,
} from './primitives'
import { IconAlert, IconDownload, IconSearch, IconSpark } from './icons'

const SEVERITIES: Finding['severity'][] = ['critical', 'high', 'medium', 'low', 'info']

export function ReportScreen({ onOpenExport }: { onOpenExport: () => void }) {
  const state = useApp()
  const { report, filters, selectedFindingId } = state
  const { setFilters, selectFinding, startScan } = state

  const visible = useMemo(() => visibleFindings(state), [state])
  const groups = useMemo(() => groupFindings(visible, filters.groupBy), [visible, filters.groupBy])
  const listRef = useRef<HTMLDivElement>(null)

  if (!report) return null

  const equivalent = report.findings.filter((f) => f.kind === 'equivalent').length
  const behavioural = report.findings.filter((f) => f.kind === 'behavioural').length

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="page stack">
        <header className="stack-2">
          <div className="row-3 wrap">
            <h1 className="t-title">{report.repo.owner}/{report.repo.name}</h1>
            <span className="chip chip--mono chip--pill">{report.repo.ref}</span>
            {report.scope?.kind === 'pull-request' ? (
              <span className="chip chip--pill chip--on">
                #{report.scope.number} · {report.scope.files} changed files
              </span>
            ) : report.scope?.kind === 'changed-files' ? (
              <span className="chip chip--pill chip--on">
                {report.scope.files} changed files
              </span>
            ) : null}
          </div>
          <p className="t-caption dim2 nums">
            {report.stats.filesFetched.toLocaleString()} files read
            {report.stats.filesSkipped
              ? ` (${report.stats.filesSkipped.toLocaleString()} unreadable, skipped)`
              : ''} ·{' '}
            {/* Matched vs analysed, not one number pretending to be both: a raw
                match count read as a thoroughness claim while much of it was
                Object.keys() and comments mentioning a search engine. */}
            {report.stats.sitesMatched.toLocaleString()} sites matched,{' '}
            {report.stats.sitesAnalysed.toLocaleString()} analysed ·{' '}
            {report.model} · {Math.round(report.stats.elapsedMs / 1000)}s
          </p>
          <CoverageNote report={report} />
        </header>

        {report.cache ? (
          <div className="callout">
            <span className="callout__icon dim2"><IconSpark size={15} /></span>
            <div className="stack-2" style={{ minWidth: 0 }}>
              <span className="t-body-sm">
                Cached result from {formatAge(Date.now() - report.cache.storedAt)} ago, for this exact
                commit and model. Expires in {formatAge(report.cache.expiresInMs)}.
              </span>
              <div>
                <button className="btn btn--sm" onClick={() => void startScan({ noCache: true })}>
                  Rescan without cache
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {report.schema ? (
          <div className="callout">
            <span className="callout__icon dim2"><IconAlert size={15} /></span>
            <div className="stack-2" style={{ minWidth: 0 }}>
              <span className="t-body-sm">
                <strong>speeDB did not run anything.</strong> It read{' '}
                {report.schema.tables} table and {report.schema.indexes} index declarations
                from source. Every speed claim below is a hypothesis with a command attached.
              </span>
              <details>
                <summary className="t-caption dim2" style={{ cursor: 'pointer' }}>
                  What cannot be known from source code
                </summary>
                <ul className="stack-2" style={{ marginTop: 8 }}>
                  {report.schema.unknowable.map((u, i) => (
                    <li key={i} className="t-caption dim">— {u}</li>
                  ))}
                </ul>
              </details>
            </div>
          </div>
        ) : null}

        {report.truncatedReason ? (
          <div className="callout callout--warn">
            <span className="callout__icon"><IconAlert size={15} /></span>
            <div className="t-body-sm">{report.truncatedReason}</div>
          </div>
        ) : null}

        <div className="stat-grid">
          <StatTile value={equivalent} label="Same output" tone="var(--accent-600)" />
          <StatTile value={behavioural} label="Behaviour" tone="var(--sev-high-fg)" />
          <StatTile
            value={report.findings.filter((f) => f.grounding === 'verified').length}
            label="Verified"
            tone="var(--status-ok-fg)"
          />
          <StatTile value={report.suppressed.length} label="Suppressed" tone="var(--text-tertiary)" />
          <StatTile value={report.rejected.length} label="Dropped" tone="var(--text-tertiary)" />
        </div>

        {report.suppressed.length > 0 ? (
          <details className="callout">
            <summary className="t-body-sm" style={{ cursor: 'pointer' }}>
              <strong>{report.suppressed.length} finding{report.suppressed.length === 1 ? '' : 's'} held
              back</strong> before publication — expand to review them
            </summary>
            <ul className="stack-2" style={{ marginTop: 10 }}>
              {report.suppressed.map((f) => (
                <li key={f.id} className="stack-1">
                  <span className="t-body-sm">{f.title}</span>
                  <span className="t-caption dim2 nums">
                    {f.primaryOccurrence.file}:{f.primaryOccurrence.startLine}
                  </span>
                  <span className="t-caption dim">{f.suppression?.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {report.rejected.length > 0 ? (
          <p className="t-caption dim2">
            {report.rejected.length} suggestion{report.rejected.length === 1 ? '' : 's'} cited code
            that does not exist in this repository and {report.rejected.length === 1 ? 'was' : 'were'} removed
            before this report was shown.
          </p>
        ) : null}

        <div className="stack-2">
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-tertiary)' }}>
              <IconSearch size={15} />
            </span>
            <input
              className="input"
              style={{ paddingLeft: 32 }}
              placeholder="Filter by title, file or SQL…"
              value={filters.query}
              onChange={(e) => setFilters({ query: e.target.value })}
              aria-label="Filter findings"
            />
          </div>

          <div className="row wrap">
            {SEVERITIES.map((sev) => {
              const on = filters.severities.has(sev)
              const count = report.findings.filter((f) => f.severity === sev).length
              if (count === 0) return null
              return (
                <button
                  key={sev}
                  className={`chip chip--button chip--pill${on ? ` sev-${sev}` : ''}`}
                  aria-pressed={on}
                  onClick={() => {
                    const next = new Set(filters.severities)
                    if (on) next.delete(sev); else next.add(sev)
                    setFilters({ severities: next })
                  }}
                >
                  {sev} <span className="nums dim2">{count}</span>
                </button>
              )
            })}
          </div>

          <div className="row wrap">
            <div className="segmented" role="group" aria-label="Group findings by">
              {(['severity', 'file', 'engine', 'category'] as const).map((by) => (
                <button
                  key={by}
                  aria-pressed={filters.groupBy === by}
                  onClick={() => setFilters({ groupBy: by })}
                >
                  {by}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <button
              className={`chip chip--button chip--pill${filters.onlyVerified ? ' chip--on' : ''}`}
              aria-pressed={filters.onlyVerified}
              onClick={() => setFilters({ onlyVerified: !filters.onlyVerified })}
            >
              Verified only
            </button>
            {report.cache ? null : (
              <button
                className="btn btn--sm"
                title="Discard the cached result and analyse this commit again"
                onClick={() => void startScan({ noCache: true })}
              >
                Rescan
              </button>
            )}
            <button className="btn btn--sm" onClick={onOpenExport}>
              <IconDownload size={13} /> Export
            </button>
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="measure empty stack-2">
          <p className="t-heading">
            {report.findings.length === 0 ? 'No optimisable queries found' : 'Nothing matches those filters'}
          </p>
          <p className="t-body-sm dim">
            {report.findings.length === 0
              ? `speeDB read ${report.stats.filesFetched} files and analysed ${report.stats.sitesAnalysed} query sites. Nothing here reduces a round trip, a scan or a fetch without changing output — that is a good outcome, not an empty one.`
              : 'Try clearing the search box or re-enabling a severity.'}
          </p>
        </div>
      ) : (
        <div
          ref={listRef}
          className="measure"
          role="listbox"
          aria-label="Findings"
          tabIndex={0}
          onKeyDown={(e) => handleListKeys(e, visible, selectedFindingId, selectFinding)}
        >
          {groups.map(([key, items]) => (
            <div key={key}>
              <div className="group-head">
                <span>{key}</span>
                <span className="spacer" />
                <span className="nums">{items.length}</span>
              </div>
              {items.map((f) => (
                <FindingRow
                  key={f.id}
                  finding={f}
                  selected={f.id === selectedFindingId}
                  onSelect={() => selectFinding(f.id)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatTile({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="stat">
      <span className="stat__value t-num-lg" style={{ color: tone }}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  )
}

function FindingRow({
  finding, selected, onSelect,
}: { finding: Finding; selected: boolean; onSelect: () => void }) {
  return (
    <button
      role="option"
      aria-selected={selected}
      className={`finding-row finding-row--${finding.severity}`}
      onClick={onSelect}
    >
      <div className="finding-row__title">
        <span style={{ minWidth: 0 }}>{finding.title}</span>
      </div>
      <p className="t-caption dim" style={{ marginTop: 2 }}>{finding.summary}</p>
      <div className="finding-row__meta">
        <SeverityChip severity={finding.severity} />
        <KindChip kind={finding.kind} />
        <EngineChip engine={finding.engine} />
        <GroundingChip finding={finding} />
        <EquivalenceChip finding={finding} />
        <PerformanceChip finding={finding} />
      </div>
      <div style={{ marginTop: 6 }}>
        <FileRef file={finding.primaryOccurrence.file} line={finding.primaryOccurrence.startLine} />
      </div>
    </button>
  )
}

/** Spec §9.2: the findings list is fully operable from the keyboard. */
function handleListKeys(
  e: React.KeyboardEvent,
  items: Finding[],
  selectedId: string | null,
  select: (id: string | null) => void,
): void {
  const index = items.findIndex((f) => f.id === selectedId)
  let next: number | null = null

  if (e.key === 'ArrowDown' || e.key === 'j') next = Math.min(items.length - 1, index + 1)
  else if (e.key === 'ArrowUp' || e.key === 'k') next = Math.max(0, index - 1)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  else if (e.key === 'Escape') { select(null); return }
  else return

  e.preventDefault()
  const target = items[next === null ? 0 : next]
  if (target) select(target.id)
}


/** "3 min", "1 hr 4 min" — short enough for a one-line banner. */
function formatAge(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 1) return 'less than a minute'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

/**
 * What was filtered, what was capped, and what the repository says it connects
 * to. Silence on any of the three reads as a claim to have covered everything.
 */
function CoverageNote({ report }: { report: ScanReport }) {
  const s = report.stats
  const filtered = s.sitesFiltered.belowConfidence + s.sitesFiltered.lowPriority
  const engines = report.engineProfile?.declared ?? []
  if (filtered === 0 && s.truncatedFiles.length === 0 && engines.length === 0) return null

  return (
    <details className="stack-1" style={{ marginTop: 6 }}>
      <summary className="t-caption dim2" style={{ cursor: 'pointer' }}>
        Coverage and engine detection
      </summary>
      <ul className="stack-1" style={{ marginTop: 6 }}>
        {filtered > 0 ? (
          <li className="t-caption dim nums">
            — {filtered.toLocaleString()} matched sites were filtered before analysis:{' '}
            {s.sitesFiltered.belowConfidence.toLocaleString()} below the confidence floor,{' '}
            {s.sitesFiltered.lowPriority.toLocaleString()} below the per-file priority cap.
          </li>
        ) : null}
        {s.truncatedFiles.map((t) => (
          <li key={t.path} className="t-caption dim nums">
            — <code>{t.path}</code> had {t.found} query sites; the {t.analysed} highest-priority
            were analysed.
          </li>
        ))}
        {engines.map((d) => (
          <li key={`${d.engine}-${d.source}`} className="t-caption dim">
            — <strong>{d.engine}</strong> declared in <code>{d.source}</code>: <code>{d.quote}</code>
          </li>
        ))}
        {engines.length === 0 ? (
          <li className="t-caption dim">
            — No data store is declared in any configuration file, dependency manifest or compose
            file, so engine labels come from local evidence at each query site only.
          </li>
        ) : null}
      </ul>
    </details>
  )
}
