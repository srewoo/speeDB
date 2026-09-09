import { useEffect, useState, type ReactNode } from 'react'
import { engineSpec, familyLabel } from '@/config/engines'
import type { DbEngine, Finding, Severity } from '@/core/types'
import { IconCheck, IconCopy, IconEye, IconEyeOff } from './icons'

/* ---------------------------------------------------------------- chips -- */

export function SeverityChip({ severity }: { severity: Severity }) {
  return <span className={`chip sev-${severity}`}>{severity}</span>
}

export function EngineChip({ engine }: { engine: DbEngine }) {
  const spec = engineSpec(engine)
  return (
    <span className="chip chip--pill" title={`${familyLabel(spec.family)} · ${spec.language}`}>
      {spec.label}
    </span>
  )
}

export function GroundingChip({ finding }: { finding: Finding }) {
  if (finding.grounding === 'verified') {
    return (
      <span className="chip status-ok" title="Every citation was re-checked against the repository.">
        <IconCheck size={11} /> Verified
      </span>
    )
  }
  return (
    <span
      className="chip status-warn"
      title={finding.groundingNotes.join(' ') || 'Some citations could not be confirmed.'}
    >
      Needs check
    </span>
  )
}

/**
 * The equivalence verdict, kept visually distinct from the grounding badge.
 * They prove different things: grounding says the citations are real,
 * this says how much of the same-output claim was machine-checked.
 */
export function EquivalenceChip({ finding }: { finding: Finding }) {
  const eq = finding.equivalence
  if (!eq) return null

  const map = {
    'machine-verified': ['status-ok', 'Output checked', 'Every mechanically decidable property of the result is identical.'],
    'partially-verified': ['status-warn', 'Partly checked', eq.summary],
    'contradicted': ['sev-critical', 'Output differs', eq.summary],
    'unverifiable': ['', 'Not checkable', eq.summary],
  } as const

  const [cls, label, title] = map[eq.status]
  return <span className={`chip ${cls}`} title={title}>{label}</span>
}

/**
 * The speed claim. Always says "not measured", because it never is — speeDB
 * executes nothing. Sitting beside the equivalence chip, it keeps the two
 * claims visibly separate.
 */
export function PerformanceChip({ finding }: { finding: Finding }) {
  const perf = finding.performance
  if (!perf) return null
  return (
    <span
      className={`chip ${perf.status === 'questionable' ? 'status-warn' : ''}`}
      title={perf.summary}
    >
      {perf.status === 'questionable' ? 'Speed: unverified · data-dependent' : 'Speed: not measured'}
    </span>
  )
}

export function KindChip({ kind }: { kind: Finding['kind'] }) {
  return kind === 'equivalent'
    ? <span className="chip chip--pill" style={{ color: 'var(--accent-600)', borderColor: 'var(--accent-200)', background: 'var(--accent-50)' }}>Same output</span>
    : <span className="chip chip--pill sev-high">Changes behaviour</span>
}

/* --------------------------------------------------------------- fields -- */

export function Field({
  label, hint, error, children, id,
}: { label: string; hint?: string; error?: string; children: ReactNode; id?: string }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="field__error">{error}</span>
        : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  )
}

/** Masked by default with a reveal toggle — keys are never rendered in the clear. */
export function SecretInput({
  id, value, onChange, placeholder, autoComplete = 'off',
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
}) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        className="input input--mono"
        type={revealed ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        style={{ paddingRight: 38 }}
      />
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        style={{ position: 'absolute', right: 2, top: 1, width: 30, height: 30 }}
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
        aria-pressed={revealed}
        onClick={() => setRevealed((r) => !r)}
      >
        {revealed ? <IconEyeOff size={14} /> : <IconEye size={14} />}
      </button>
    </div>
  )
}

export function Toggle({
  checked, onChange, label,
}: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  )
}

/* --------------------------------------------------------------- layout -- */

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: string }) {
  return (
    <div className="stat">
      <span className="stat__value t-num-lg" style={tone ? { color: tone } : undefined}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  )
}

export function Callout({
  tone = 'info', icon, title, children,
}: { tone?: 'info' | 'warn' | 'err'; icon?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <div className={`callout callout--${tone}`}>
      {icon ? <span className="callout__icon">{icon}</span> : null}
      <div className="stack-2" style={{ minWidth: 0 }}>
        {title ? <strong className="t-subheading">{title}</strong> : null}
        <div className="t-body-sm dim">{children}</div>
      </div>
    </div>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true))
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** `path/to/file.py:42` with the basename emphasised — long paths are common. */
export function FileRef({ file, line }: { file: string; line?: number }) {
  const idx = file.lastIndexOf('/')
  const dir = idx === -1 ? '' : file.slice(0, idx + 1)
  const base = idx === -1 ? file : file.slice(idx + 1)
  return (
    <span className="filepath">
      {dir}<b>{base}</b>{line ? `:${line}` : ''}
    </span>
  )
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="stack-2">
      <div className="row">
        <h3 className="t-micro dim2">{title}</h3>
        <span className="spacer" />
        {action}
      </div>
      {children}
    </section>
  )
}
