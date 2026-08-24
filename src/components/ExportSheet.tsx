import { useState } from 'react'
import { exportReport, type ExportFormat } from '@/core/report/export'
import { useApp, visibleFindings } from '@/store/app-store'
import { IconDownload, IconX } from './icons'

const FORMATS: { id: ExportFormat; label: string; detail: string }[] = [
  { id: 'markdown', label: 'Markdown', detail: 'For a PR description, an issue, or a wiki page.' },
  { id: 'html', label: 'HTML', detail: 'Self-contained page. Print it to PDF from the browser.' },
  { id: 'json', label: 'JSON', detail: 'Full structured data, including dropped suggestions.' },
  { id: 'patch', label: 'Patch', detail: 'Unified diff of the same-output changes. Check it with git apply --check.' },
]

export function ExportSheet({ onClose }: { onClose: () => void }) {
  const state = useApp()
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [scope, setScope] = useState<'all' | 'filtered'>('all')

  const report = state.report
  if (!report) return null

  const filtered = visibleFindings(state)
  const findings = scope === 'all' ? report.findings : filtered

  function download() {
    const file = exportReport(report!, format, findings)
    // Blob + object URL, not a data: URI — reports routinely exceed the URL cap.
    const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = file.filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5_000)
    onClose()
  }

  return (
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Export report"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="modal">
        <div className="panel__head">
          <h2 className="t-heading">Export report</h2>
          <span className="spacer" />
          <button className="btn btn--ghost btn--icon" aria-label="Close" onClick={onClose}>
            <IconX size={15} />
          </button>
        </div>

        <div className="panel__body stack">
          <fieldset className="stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="t-micro dim2" style={{ padding: 0 }}>Format</legend>
            {FORMATS.map((f) => (
              <label key={f.id} className="row-3" style={{ alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="radio" name="format" value={f.id}
                  checked={format === f.id}
                  onChange={() => setFormat(f.id)}
                  style={{ marginTop: 3, accentColor: 'var(--accent-solid)' }}
                />
                <span className="stack-2" style={{ gap: 2 }}>
                  <span className="t-body-sm" style={{ fontWeight: 600 }}>{f.label}</span>
                  <span className="t-caption dim2">{f.detail}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <hr className="rule" />

          <fieldset className="stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="t-micro dim2" style={{ padding: 0 }}>Include</legend>
            <label className="row-3" style={{ cursor: 'pointer' }}>
              <input
                type="radio" name="scope" checked={scope === 'all'}
                onChange={() => setScope('all')} style={{ accentColor: 'var(--accent-solid)' }}
              />
              <span className="t-body-sm">All findings <span className="dim2 nums">({report.findings.length})</span></span>
            </label>
            <label className="row-3" style={{ cursor: 'pointer' }}>
              <input
                type="radio" name="scope" checked={scope === 'filtered'}
                onChange={() => setScope('filtered')} style={{ accentColor: 'var(--accent-solid)' }}
              />
              <span className="t-body-sm">Current filter <span className="dim2 nums">({filtered.length})</span></span>
            </label>
          </fieldset>

          <button className="btn btn--primary btn--block" onClick={download} disabled={findings.length === 0}>
            <IconDownload size={15} /> Download
          </button>
        </div>
      </div>
    </div>
  )
}
