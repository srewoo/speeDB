import { useState } from 'react'
import type { Finding } from '@/core/types'
import { Diff } from './Diff'
import { toUnifiedDiff } from '@/core/report/patch'
import {
  Callout, CopyButton, EngineChip, EquivalenceChip, FileRef, GroundingChip,
  KindChip, PerformanceChip, Section, SeverityChip,
} from './primitives'
import { IconAlert, IconBack, IconFile, IconInfo, IconLink, IconShield, IconSpark } from './icons'

/**
 * Spec §13. The order of these sections is the argument the product makes:
 *   what's wrong → where it runs → what to change → why it's faster →
 *   why the output is identical → the evidence for all of it.
 * The equivalence argument is never collapsed and never below the fold on a
 * same-output finding: it is the claim the whole product rests on.
 */
export function FindingDetail({
  finding, wide, onBack,
}: { finding: Finding; wide: boolean; onBack: () => void }) {
  const [sideBySide, setSideBySide] = useState(wide)
  const occ = finding.primaryOccurrence

  return (
    <div className="page page--reading stack-6">
      <div className="row">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <IconBack size={14} /> All findings
        </button>
      </div>

      <header className="stack-2">
        <h1 className="t-heading">{finding.title}</h1>
        <p className="t-body dim">{finding.summary}</p>
        <div className="row wrap" style={{ marginTop: 2 }}>
          <SeverityChip severity={finding.severity} />
          <KindChip kind={finding.kind} />
          <EngineChip engine={finding.engine} />
          <span className="chip chip--pill">{finding.category.replace(/-/g, ' ')}</span>
          <GroundingChip finding={finding} />
          <EquivalenceChip finding={finding} />
          <PerformanceChip finding={finding} />
        </div>
      </header>

      {finding.grounding === 'needs-verification' ? (
        <Callout tone="warn" icon={<IconAlert size={15} />} title="Check this one before applying">
          <ul className="stack-2">
            {finding.groundingNotes.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        </Callout>
      ) : null}

      {finding.kind === 'behavioural' ? (
        <Callout tone="warn" icon={<IconAlert size={15} />} title="This changes what the query returns">
          Unlike the same-output items, applying this will alter results. That may well be
          the right call — it is separated so the decision is deliberate.
        </Callout>
      ) : null}

      <Section title="Where it runs">
        <div className="panel">
          <div className="panel__body stack-2">
            <div className="row">
              <IconFile size={14} />
              <FileRef file={occ.file} line={occ.startLine} />
            </div>
            {occ.enclosingSymbol ? (
              <p className="t-body-sm dim">
                Inside <code className="t-code">{occ.enclosingSymbol}</code>
              </p>
            ) : null}
            {occ.triggeredBy ? (
              <p className="t-body-sm dim">
                <IconLink size={13} /> Reached via {occ.triggeredBy}
              </p>
            ) : null}
            {occ.excerpt ? <pre className="code t-code">{occ.excerpt.trim()}</pre> : null}
          </div>
        </div>

        {finding.otherOccurrences.length > 0 ? (
          <div className="stack-2" style={{ marginTop: 8 }}>
            <p className="t-caption dim2">
              The same query shape appears in {finding.otherOccurrences.length} other place
              {finding.otherOccurrences.length === 1 ? '' : 's'}:
            </p>
            <ul className="stack-2">
              {finding.otherOccurrences.map((o, i) => (
                <li key={i}><FileRef file={o.file} line={o.startLine} /></li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section
        title="Proposed change"
        action={
          <div className="row">
            <button
              className="chip chip--button chip--pill"
              aria-pressed={sideBySide}
              onClick={() => setSideBySide((s) => !s)}
            >
              {sideBySide ? 'Unified' : 'Side by side'}
            </button>
            <CopyButton text={finding.suggestion.proposed} label="Copy" />
            <CopyButton text={toUnifiedDiff(finding)} label="Copy diff" />
          </div>
        }
      >
        <Diff
          before={finding.original}
          after={finding.suggestion.proposed}
          // Side-by-side needs real width; below ~640px it degrades to unified
          // regardless of the toggle (spec §13.4).
          sideBySide={sideBySide && wide}
        />
      </Section>

      <Section title="Why this should be faster">
        <p className="t-body">{finding.suggestion.rationale}</p>
        {finding.suggestion.expectedImpact ? (
          <div className="callout callout--info" style={{ marginTop: 8 }}>
            <span className="callout__icon" style={{ color: 'var(--accent-600)' }}><IconSpark size={15} /></span>
            <div className="t-body-sm">{finding.suggestion.expectedImpact}</div>
          </div>
        ) : null}
      </Section>

      {finding.performance ? (
        <Section title="Speed check">
          <div className="stack-2">
            <div className={`callout${finding.performance.status === 'questionable' ? ' callout--warn' : ''}`}>
              <span className="callout__icon"><IconAlert size={15} /></span>
              <div className="stack-2" style={{ minWidth: 0 }}>
                <strong className="t-subheading">Nothing here was measured</strong>
                <ul className="stack-2">
                  {finding.performance.unmeasured.map((u, i) => (
                    <li key={i} className="t-body-sm dim">— {u}</li>
                  ))}
                </ul>
              </div>
            </div>

            {finding.performance.counted.length > 0 ? (
              <div className="panel">
                <div className="panel__body stack-2">
                  <strong className="t-micro dim2">Counted from the statements</strong>
                  <ul className="stack-2">
                    {finding.performance.counted.map((c, i) => (
                      <li key={i} className="t-body-sm">— {c}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {/* The whole point: hand over the command that settles it. */}
            {finding.performance.verification.map((v, i) => (
              <div className="panel" key={i}>
                <div className="panel__body stack-2">
                  <div className="row">
                    <strong className="t-micro dim2">{v.label}</strong>
                    <span className="spacer" />
                    <CopyButton text={v.command} />
                  </div>
                  <pre className="code t-code">{v.command}</pre>
                </div>
              </div>
            ))}

            {/*
              * What would prove it right, and what would prove it wrong.
              *
              * The second half is the one that matters. A command with no
              * stated failure condition can be run, produce any output at all,
              * and be read as agreement — which is how a verification step
              * turns into a ritual. Naming the refutation makes "this finding
              * was wrong" a reachable answer rather than an absence of one.
              */}
            {finding.performance.confirms.length > 0 ? (
              <div className="panel">
                <div className="panel__body stack-2">
                  <strong className="t-micro dim2">
                    {finding.performance.measures
                      ? `Measures: ${finding.performance.measures}`
                      : 'What to look for in the output'}
                  </strong>
                  <ul className="stack-2">
                    {finding.performance.confirms.map((c, i) => (
                      <li key={i} className="t-body-sm">✓ {c}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {finding.performance.refutes.length > 0 ? (
              <div className="panel">
                <div className="panel__body stack-2">
                  <strong className="t-micro dim2">What would show this finding is wrong</strong>
                  <ul className="stack-2">
                    {finding.performance.refutes.map((r, i) => (
                      <li key={i} className="t-body-sm dim">✗ {r}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {finding.performance.noRecipeReason ? (
              <div className="callout callout--warn">
                <span className="callout__icon"><IconAlert size={15} /></span>
                <div className="t-body-sm">{finding.performance.noRecipeReason}</div>
              </div>
            ) : null}

            <div className="panel">
              <div className="panel__body stack-2">
                <strong className="t-micro dim2">What to look for in the output</strong>
                <ul className="stack-2">
                  {finding.performance.lookFor.map((l, i) => (
                    <li key={i} className="t-body-sm dim">— {l}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </Section>
      ) : null}

      {finding.indexAdvice && finding.indexAdvice.notes.length > 0 ? (
        <Section title="Checked against the declared schema">
          <div className={`callout${finding.indexAdvice.coveredBy || finding.indexAdvice.duplicateOf ? ' callout--err' : ''}`}>
            <span className="callout__icon"><IconAlert size={15} /></span>
            <ul className="stack-2">
              {finding.indexAdvice.notes.filter(Boolean).map((n, i) => (
                <li key={i} className="t-body-sm">— {n}</li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      {finding.equivalence ? (
        <Section title="Same-output check">
          <div className="stack-2">
            {/* What a machine actually confirmed, kept separate from prose. */}
            {finding.equivalence.verified.length > 0 ? (
              <div className="callout" style={{ borderColor: 'var(--accent-200)', background: 'var(--accent-50)' }}>
                <span className="callout__icon" style={{ color: 'var(--accent-600)' }}><IconShield size={15} /></span>
                <div className="stack-2" style={{ minWidth: 0 }}>
                  <strong className="t-subheading">Checked automatically</strong>
                  <ul className="stack-2">
                    {finding.equivalence.verified.map((v, i) => (
                      <li key={i} className="t-body-sm dim">— {v}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {finding.equivalence.deltas.length > 0 ? (
              <div className={`callout callout--${finding.equivalence.deltas.some((d) => d.severity === 'hard') ? 'err' : 'warn'}`}>
                <span className="callout__icon"><IconAlert size={15} /></span>
                <div className="stack-2" style={{ minWidth: 0 }}>
                  <strong className="t-subheading">Differences found</strong>
                  <ul className="stack-2">
                    {finding.equivalence.deltas.map((d, i) => (
                      <li key={i} className="t-body-sm">— {d.detail}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {finding.equivalence.undecided.length > 0 ? (
              <div className="callout">
                <span className="callout__icon dim2"><IconInfo size={15} /></span>
                <div className="stack-2" style={{ minWidth: 0 }}>
                  <strong className="t-subheading">Not machine-checkable</strong>
                  <ul className="stack-2">
                    {finding.equivalence.undecided.map((u, i) => (
                      <li key={i} className="t-body-sm dim">— {u}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {/* The model's own argument, clearly attributed as such. */}
            <div className="panel">
              <div className="panel__body stack-2">
                <strong className="t-micro dim2">The model&rsquo;s argument, in full</strong>
                <p className="t-body-sm">{finding.suggestion.equivalenceArgument}</p>
              </div>
            </div>
          </div>
        </Section>
      ) : null}

      {finding.suggestion.requiredMigration ? (
        <Section
          title="Run this migration first"
          action={<CopyButton text={finding.suggestion.requiredMigration} />}
        >
          <pre className="code t-code">{finding.suggestion.requiredMigration.trim()}</pre>
        </Section>
      ) : null}

      {finding.suggestion.assumptions.length > 0 ? (
        <Section title="Assumptions">
          <ul className="stack-2">
            {finding.suggestion.assumptions.map((a, i) => (
              <li key={i} className="t-body-sm dim">— {a}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Evidence from this repository">
        {finding.evidence.length === 0 ? (
          <p className="t-body-sm dim2">
            No supporting citations survived verification for this finding.
          </p>
        ) : (
          <ul className="stack-2">
            {finding.evidence.map((e, i) => (
              <li key={i} className="panel">
                <div className="panel__body stack-2">
                  <div className="row wrap">
                    <span className="chip">{e.kind.replace(/-/g, ' ')}</span>
                    <FileRef file={e.file} line={e.startLine} />
                  </div>
                  <pre className="code t-code">{e.quote.trim()}</pre>
                  <p className="t-caption dim">{e.relevance}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
