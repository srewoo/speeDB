import { useApp } from '@/store/app-store'
import { PROVIDERS } from '@/config/models'
import { Callout, Field } from './primitives'
import { IconAlert, IconDatabase, IconLink, IconSearch, IconShield } from './icons'

export function ConnectScreen() {
  const { repoUrl, branch, recentRepos, settings, error, detected, report } = useApp()
  const { setRepoUrl, setBranch, startScan, setView, dismissError, useDetected } = useApp()

  const provider = PROVIDERS.find((p) => p.id === settings.provider)
  const canScan = repoUrl.trim().length > 0

  return (
    <div className="page stack-6">
      <header className="stack-2">
        <h1 className="t-title">Review a repository&rsquo;s database queries</h1>
        <p className="t-body dim">
          Point speeDB at a GitHub or GitLab repo. It finds every query, then proposes
          rewrites that return exactly the same results — each one checked against the
          code it came from.
        </p>
      </header>

      {/* Home must not be a one-way door: a report already in memory stays
          reachable rather than needing a rescan to see again. */}
      {report ? (
        <div className="callout callout--info">
          <span className="callout__icon" style={{ color: 'var(--accent-600)' }}>
            <IconDatabase size={15} />
          </span>
          <div className="stack-2" style={{ minWidth: 0 }}>
            <span className="t-body-sm">
              You have a report for <strong>{report.repo.owner}/{report.repo.name}</strong>
              {' '}&mdash; {report.findings.length} finding{report.findings.length === 1 ? '' : 's'}.
            </span>
            <div>
              <button type="button" className="btn btn--sm" onClick={() => setView('report')}>
                Back to the report
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <Callout tone="err" icon={<IconAlert size={15} />} title={error.title}>
          <div className="stack-2">
            <span>{error.detail}</span>
            {error.hint ? <span className="dim2">{error.hint}</span> : null}
            <div>
              <button className="btn btn--sm" onClick={dismissError}>Dismiss</button>
            </div>
          </div>
        </Callout>
      ) : null}

      {detected && detected.url !== repoUrl ? (
        <div className="callout callout--info">
          <span className="callout__icon" style={{ color: 'var(--accent-600)' }}>
            <IconLink size={15} />
          </span>
          <div className="stack-2" style={{ minWidth: 0 }}>
            <span className="t-body-sm">
              {detected.pullRequest ? (
                <>
                  You&rsquo;re on <strong>{detected.label}</strong>{' '}
                  {detected.forge === 'github' ? 'pull request' : 'merge request'}{' '}
                  <strong>#{detected.pullRequest}</strong>.
                </>
              ) : (
                <>
                  You&rsquo;re on <strong>{detected.label}</strong>
                  {detected.ref ? <> at <code className="t-code">{detected.ref}</code></> : null}.
                </>
              )}
            </span>
            <div className="row wrap">
              {/* The review moment: findings here can still change the code. */}
              {detected.pullRequest ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => { useDetected(); void startScan({ pullRequest: detected.pullRequest }) }}
                >
                  Scan just this {detected.forge === 'github' ? 'PR' : 'MR'}
                </button>
              ) : null}
              <button type="button" className="btn btn--sm" onClick={useDetected}>
                Use this repository
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <form
        className="stack"
        onSubmit={(e) => { e.preventDefault(); if (canScan) void startScan() }}
      >
        <Field
          label="Repository"
          id="repo-url"
          hint={
            detected && detected.url === repoUrl
              ? 'Detected from the tab you have open.'
              : 'A URL, or just owner/repo. GitLab subgroups and self-hosted hosts work too.'
          }
        >
          <input
            id="repo-url"
            className="input input--mono"
            placeholder="https://github.com/owner/repo"
            value={repoUrl}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setRepoUrl(e.target.value)}
          />
        </Field>

        <Field label="Branch, tag or commit" id="repo-ref" hint="Leave empty to use the default branch.">
          <input
            id="repo-ref"
            className="input input--mono"
            placeholder="main"
            value={branch}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setBranch(e.target.value)}
          />
        </Field>

        <button type="submit" className="btn btn--primary btn--block" disabled={!canScan}>
          <IconSearch size={15} /> Scan repository
        </button>

        {/* Results for a commit are reused for an hour. This is the escape
            hatch for when you want the model to look again anyway. */}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!canScan}
          onClick={() => void startScan({ noCache: true })}
          title="Ignore any cached result for this commit and analyse it again"
        >
          Scan fresh, ignoring cached results
        </button>
      </form>

      <div className="panel">
        <div className="panel__head">
          <span className="t-micro dim2">Analysing with</span>
          <span className="spacer" />
          <button className="btn btn--ghost btn--sm" onClick={() => setView('settings')}>Change</button>
        </div>
        <div className="panel__body stack-2">
          <div className="row-3">
            <span className="t-subheading">{provider?.label}</span>
            <span className="chip chip--mono chip--pill">{settings.model}</span>
          </div>
          {provider?.onDevice ? (
            <div className="row" style={{ color: 'var(--status-ok-fg)' }}>
              <IconShield size={14} />
              <span className="t-caption">Nothing leaves this device.</span>
            </div>
          ) : (
            <p className="t-caption dim2">
              Source code from this repository is sent to {provider?.label} for analysis.
            </p>
          )}
        </div>
      </div>

      {recentRepos.length > 0 ? (
        <section className="stack-2">
          <h2 className="t-micro dim2">Recent</h2>
          <ul className="panel">
            {recentRepos.map((r, i) => (
              <li key={r.url}>
                <button
                  className="finding-row"
                  style={i === 0 ? undefined : { borderTop: 0 }}
                  onClick={() => { setRepoUrl(r.url); }}
                >
                  <div className="row">
                    <IconDatabase size={14} />
                    <span className="t-body-sm" style={{ fontWeight: 600 }}>{r.label}</span>
                    <span className="spacer" />
                    <span className="t-caption dim2">{relativeTime(r.at)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
