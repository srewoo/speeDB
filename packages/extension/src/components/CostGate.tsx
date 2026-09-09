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
  // Named, not implied: "this model" is not actionable when the user cannot see
  // which id the live listing handed over.
  const model = useApp((s) => s.settings.model)
  if (!pending) return null

  const { cost, candidates, passes, cachedPasses, stages } = pending
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

          {stages ? (
            /* The work is two different shapes, and only one of them is known in
               advance. Quoting a single pass count described neither. */
            <p className="t-caption dim2">
              {stages.triage.calls.toLocaleString()} triage call
              {stages.triage.calls === 1 ? '' : 's'} across{' '}
              {stages.triage.passes.toLocaleString()} pass
              {stages.triage.passes === 1 ? '' : 'es'}
              {stages.triage.samples > 1 ? ` × ${stages.triage.samples} samples` : ''}, then
              about {stages.author.projectedRequests.toLocaleString()} write-up
              {stages.author.projectedRequests === 1 ? '' : 's'} — {stages.author.assumption}.
            </p>
          ) : null}

          {cost.usd === null ? (
            <div className="callout callout--warn">
              <span className="callout__icon"><IconAlert size={15} /></span>
              <div className="t-body-sm">
                speeDB has no list price for <code>{model}</code>, so only a token
                estimate is shown. A wrong number would be worse than none — check
                the provider's pricing page for this model.
              </div>
            </div>
          ) : (
            <div className="callout">
              <span className="callout__icon dim2"><IconSpark size={15} /></span>
              <div className="t-body-sm dim">
                An estimate. Input tokens are known; output is projected at roughly a
                third of the per-pass ceiling, so the real figure is usually lower.
                {' '}
                {/* A price quoted without its age invites more trust than it has
                    earned: no provider exposes prices in an API, so this comes
                    from a table in the extension that goes stale. */}
                The list price used here was last checked on {cost.pricesVerifiedOn}.
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
