import { useApp } from '@/store/app-store'
import { formatUsd } from '@/config/pricing'
import { IconAlert, IconSpark } from './icons'

/**
 * Shown between detection and the first paid request.
 *
 * The token budget alone is not informed consent — a number of tokens means
 * nothing to most people at the moment they hand over an API key. This is the
 * only point where a real figure exists, because the prompts are already built.
 */
export function CostGate() {
  const pending = useApp((s) => s.pendingEstimate)
  const answer = useApp((s) => s.answerEstimate)
  if (!pending) return null

  const { cost, candidates, passes, cachedPasses } = pending
  const billable = passes - cachedPasses

  return (
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm scan cost"
      onKeyDown={(e) => { if (e.key === 'Escape') answer(false) }}
    >
      <div className="modal">
        <div className="panel__head">
          <h2 className="t-heading">Before this spends anything</h2>
        </div>

        <div className="panel__body stack">
          <div className="stat-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="stat">
              <span className="stat__value t-num-lg">
                {cost.usd === null ? '—' : formatUsd(cost.usd)}
              </span>
              <span className="stat__label">Estimated cost</span>
            </div>
            <div className="stat">
              <span className="stat__value t-num-lg nums">
                {(cost.totalTokens / 1000).toFixed(0)}k
              </span>
              <span className="stat__label">Estimated tokens</span>
            </div>
          </div>

          <p className="t-body-sm dim">
            {candidates.toLocaleString()} query sites, {billable} analysis pass
            {billable === 1 ? '' : 'es'}
            {cachedPasses > 0 ? ` (${cachedPasses} already cached, free)` : ''}.
          </p>

          {cost.usd === null ? (
            <div className="callout callout--warn">
              <span className="callout__icon"><IconAlert size={15} /></span>
              <div className="t-body-sm">
                No published price for this model, so only a token estimate is shown.
                A wrong number would be worse than none.
              </div>
            </div>
          ) : (
            <div className="callout">
              <span className="callout__icon dim2"><IconSpark size={15} /></span>
              <div className="t-body-sm dim">
                An estimate. Input tokens are known; output is projected at roughly a
                third of the per-pass ceiling, so the real figure is usually lower.
              </div>
            </div>
          )}

          <div className="row">
            <button className="btn btn--primary" onClick={() => answer(true)}>
              Run the scan
            </button>
            <button className="btn" onClick={() => answer(false)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
