import type { Finding, ScanReport } from '@/core/types'

import { toPatchFile } from './patch'
import { LABELS } from '@/core/analyze/gate'
import { describeEngineProfile } from '@/core/detect/engine-profile'

export type ExportFormat = 'markdown' | 'json' | 'html' | 'patch'

export function exportReport(report: ScanReport, format: ExportFormat, findings?: Finding[]): {
  filename: string
  mime: string
  content: string
} {
  const list = findings ?? report.findings
  const slug = `${report.repo.owner}-${report.repo.name}`.replace(/[^\w.-]+/g, '-')
  const stamp = report.createdAt.slice(0, 10)

  switch (format) {
    case 'json':
      return {
        filename: `speedb-${slug}-${stamp}.json`,
        mime: 'application/json',
        content: JSON.stringify({ ...report, findings: list }, null, 2),
      }
    case 'html':
      return {
        filename: `speedb-${slug}-${stamp}.html`,
        mime: 'text/html',
        // Self-contained so it opens anywhere and prints to PDF cleanly.
        content: toHtml(report, list),
      }
    case 'patch':
      return {
        filename: `speedb-${slug}-${stamp}.patch`,
        mime: 'text/x-patch',
        content: toPatchFile(report, list),
      }
    case 'markdown':
      return {
        filename: `speedb-${slug}-${stamp}.md`,
        mime: 'text/markdown',
        content: toMarkdown(report, list),
      }
  }
}

/**
 * The coverage block.
 *
 * `1,115 query sites found` read as a thoroughness claim while a large share of
 * those sites were `Object.keys()`, comments mentioning OpenSearch, and
 * JavaScript string concatenation. These numbers degrade honestly instead: what
 * matched, what was actually analysed, what was filtered and why, which files
 * were capped, and what the repository says it connects to.
 */
function coverageLines(report: ScanReport): string[] {
  const s = report.stats
  const filtered = s.sitesFiltered.belowConfidence + s.sitesFiltered.lowPriority
  const out = [
    `**Coverage** ${s.filesFetched.toLocaleString()} files read · ` +
      `${s.sitesMatched.toLocaleString()} sites matched` +
      (s.sitesSampled > 0 ? ` (${s.sitesSampled.toLocaleString()} from whole-file samples)` : '') +
      ` · ${s.sitesAnalysed.toLocaleString()} analysed` +
      // A queue the budget never reached is not coverage.
      (s.sitesQueued > s.sitesAnalysed
        ? ` (of ${s.sitesQueued.toLocaleString()} queued — the token budget stopped the scan first)`
        : '') +
      ` · ` +
      `${filtered.toLocaleString()} filtered ` +
      `(below confidence ${s.sitesFiltered.belowConfidence.toLocaleString()} · ` +
      `low priority ${s.sitesFiltered.lowPriority.toLocaleString()}) · ` +
      `${s.chunksAnalysed} analysis passes  `,
  ]

  if (s.truncatedFiles.length > 0) {
    const shown = s.truncatedFiles.slice(0, 5)
    out.push(
      `**Capped** ${s.truncatedFiles.length} file(s) had more query sites than the per-file cap: ` +
        shown.map((t) => `\`${t.path}\` (${t.found} found, ${t.analysed} analysed)`).join(', ') +
        (s.truncatedFiles.length > shown.length ? `, and ${s.truncatedFiles.length - shown.length} more` : '') +
        '. The highest-priority sites in each were kept.  ',
    )
  }

  if (s.triage) {
    // The accounting, stated. A triage stage that flags almost nothing and a
    // triage stage that flags almost everything both produce a bad report, and
    // the ratio is the only warning you get before reading it.
    const total = s.triage.flagged + s.triage.unsure + s.triage.clean
    out.push(
      `**Triage** ${total.toLocaleString()} site(s) triaged · ` +
        `${s.triage.flagged.toLocaleString()} flagged · ` +
        `${s.triage.unsure.toLocaleString()} unsure · ` +
        `${s.triage.clean.toLocaleString()} clean` +
        ` (${Math.round((100 * (s.triage.flagged + s.triage.unsure)) / Math.max(1, total))}% sent for write-up)  `,
    )
  }

  if (report.authorLog && report.authorLog.unaccounted.length > 0) {
    out.push(
      `**Write-up gaps** ${report.authorLog.unaccounted.length.toLocaleString()} triaged site(s) were ` +
        'neither written up nor explicitly declined. Those sites were examined and then dropped in ' +
        'silence, so this report is missing whatever they contained.  ',
    )
  }

  if (s.sitesUnaccounted > 0) {
    out.push(
      `**Triage gaps** ${s.sitesUnaccounted.toLocaleString()} site(s) came back from triage with no verdict ` +
        'and were escalated to a full write-up rather than assumed clean. That is the safe direction, but a ' +
        'scan with many of them is one whose triage stage is not answering reliably.  ',
    )
  }

  if (report.engineProfile) {
    out.push(`**Engines** ${describeEngineProfile(report.engineProfile)}  `)
    if (report.engineProfile.ambiguous) {
      out.push(
        '> Several data stores are declared with equal authority, so no single engine ' +
          'is assumed. Findings are labelled per query site from local dialect evidence.  ',
      )
    }
  }

  out.push(
    `**Findings** ${report.findings.length} published` +
      (report.suppressed.length ? ` · ${report.suppressed.length} suppressed` : '') +
      (report.rejected.length ? ` · ${report.rejected.length} rejected in verification` : ''),
  )

  return out
}

export function toMarkdown(report: ScanReport, findings: Finding[]): string {
  const { repo, stats } = report
  const equivalent = findings.filter((f) => f.kind === 'equivalent')
  const behavioural = findings.filter((f) => f.kind === 'behavioural')

  const out: string[] = [
    `# Database query review — ${repo.owner}/${repo.name}`,
    '',
    `**Branch** \`${repo.ref}\` at \`${repo.commitSha.slice(0, 10)}\`  `,
    `**Scanned** ${new Date(report.createdAt).toLocaleString()} · ${report.provider}/${report.model}  `,
    ...coverageLines(report),
    '',
  ]

  if (report.truncatedReason) {
    out.push(`> **Incomplete scan.** ${report.truncatedReason}`, '')
  }

  if (report.schema) {
    out.push(
      '> **speeDB executed nothing.** It read ' +
        `${report.schema.tables} table and ${report.schema.indexes} index declarations from source. ` +
        'Every speed claim below is a hypothesis about a mechanism, with a command attached to settle it.',
      '>',
      '> Not knowable from source code:',
      ...report.schema.unknowable.map((u) => `> - ${u}`),
      '',
    )
  }

  out.push(
    '## Summary',
    '',
    '| Severity | Same-output optimisations | Behaviour changes |',
    '| --- | --- | --- |',
    ...(['critical', 'high', 'medium', 'low', 'info'] as const).map((sev) => {
      const e = equivalent.filter((f) => f.severity === sev).length
      const b = behavioural.filter((f) => f.severity === sev).length
      return `| ${sev} | ${e} | ${b} |`
    }),
    '',
  )

  if (equivalent.length > 0) {
    out.push(
      '## Same-output optimisations',
      '',
      'Every item here is asserted to return identical results. The equivalence argument is stated for each.',
      '',
      ...equivalent.map(findingToMarkdown),
    )
  }

  if (behavioural.length > 0) {
    out.push(
      '## Behaviour changes and bugs',
      '',
      '**These change what the query returns.** They are listed separately on purpose — review each on its merits.',
      '',
      ...behavioural.map(findingToMarkdown),
    )
  }

  if (findings.length === 0) {
    out.push(
      '## No findings',
      '',
      `${stats.sitesAnalysed.toLocaleString()} query site(s) were analysed across ` +
        `${stats.filesFetched.toLocaleString()} file(s). Nothing here reduces a round trip, a scan or ` +
        'a fetch without changing output. That is a good outcome, not an empty one.',
      '',
    )
  }

  if (report.suppressed.length > 0) {
    // Held back, not hidden. A gate that silently eats a true positive is worse
    // than the padding it removes, and the only way to know which it did is to
    // be able to read what it held back.
    const byReason = new Map<string, Finding[]>()
    for (const f of report.suppressed) {
      const key = f.suppression?.reason ?? 'other'
      byReason.set(key, [...(byReason.get(key) ?? []), f])
    }

    out.push(
      '## Suppressed before publication',
      '',
      `${report.suppressed.length} finding(s) were held back by the value gate. They are listed here ` +
        'in full so the gate can be argued with — none of them was silently dropped.',
      '',
    )
    for (const [reason, list] of byReason) {
      out.push(`### ${LABELS[reason as keyof typeof LABELS] ?? reason} — ${list.length}`, '')
      for (const f of list) {
        out.push(
          `- **${f.title}** — \`${f.primaryOccurrence.file}:${f.primaryOccurrence.startLine}\``,
          `  ${f.suppression?.detail ?? ''}`,
        )
      }
      out.push('')
    }
  }

  if (report.rejected.length > 0) {
    out.push(
      '## Dropped during verification',
      '',
      `${report.rejected.length} suggestion(s) cited files or code that do not exist in this repository and were removed before this report was produced.`,
      '',
      ...report.rejected.map((f) => `- **${f.title}** — ${f.groundingNotes.join(' ')}`),
      '',
    )
  }

  out.push('---', '', '_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._')
  return out.join('\n')
}

function findingToMarkdown(f: Finding): string {
  const occ = f.primaryOccurrence
  const badge = f.grounding === 'verified' ? '✅ verified' : '⚠️ needs verification'

  const lines = [
    `### ${f.title}`,
    '',
    `\`${f.severity}\` · \`${f.category}\` · \`${f.engine}\` · ${badge}`,
    '',
    f.summary,
    '',
    '**Where it is used**',
    '',
    `- \`${occ.file}:${occ.startLine}\`${occ.enclosingSymbol ? ` in \`${occ.enclosingSymbol}\`` : ''}`,
  ]

  if (occ.triggeredBy) lines.push(`- Reached via ${occ.triggeredBy}`)
  for (const other of f.otherOccurrences) {
    lines.push(`- Also at \`${other.file}:${other.startLine}\``)
  }

  lines.push(
    '',
    '**Current**',
    '',
    '```sql',
    f.original.trim(),
    '```',
    '',
    '**Proposed**',
    '',
    '```sql',
    f.suggestion.proposed.trim(),
    '```',
    '',
    `**Why this helps** — ${f.suggestion.rationale}`,
    '',
    `**Expected impact** — ${f.suggestion.expectedImpact}`,
    '',
    `**Why the output is unchanged (the model's argument)** — ${f.suggestion.equivalenceArgument}`,
    '',
  )

  if (f.performance) {
    lines.push(
      '**Speed — not measured.** speeDB does not execute queries. Verify with:',
      '',
      ...f.performance.verification.flatMap((v) => [`_${v.label}_`, '', '```sql', v.command.trim(), '```', '']),
      'What to look for:',
      '',
      ...f.performance.lookFor.map((l) => `- ${l}`),
      '',
    )
    if (f.performance.counted.length) {
      lines.push('Counted from the statements (not timed):', '', ...f.performance.counted.map((c) => `- ${c}`), '')
    }
  }

  if (f.indexAdvice?.notes.filter(Boolean).length) {
    lines.push('**Checked against the declared schema**', '',
      ...f.indexAdvice.notes.filter(Boolean).map((n) => `- ${n}`), '')
  }

  if (f.equivalence) {
    lines.push(`**Automated equivalence check** — ${f.equivalence.summary}`, '')
    if (f.equivalence.verified.length) {
      lines.push('Confirmed automatically:', '', ...f.equivalence.verified.map((v) => `- ${v}`), '')
    }
    if (f.equivalence.deltas.length) {
      lines.push('Differences found:', '', ...f.equivalence.deltas.map((d) => `- ${d.detail}`), '')
    }
    if (f.equivalence.undecided.length) {
      lines.push('Not machine-checkable:', '', ...f.equivalence.undecided.map((u) => `- ${u}`), '')
    }
  }

  if (f.suggestion.requiredMigration) {
    lines.push('**Requires this migration first**', '', '```sql', f.suggestion.requiredMigration.trim(), '```', '')
  }
  if (f.suggestion.assumptions.length > 0) {
    lines.push('**Assumptions**', '', ...f.suggestion.assumptions.map((a) => `- ${a}`), '')
  }
  if (f.evidence.length > 0) {
    lines.push('**Evidence**', '')
    for (const e of f.evidence) {
      lines.push(`- \`${e.file}:${e.startLine}\` (${e.kind}) — ${e.relevance}`)
    }
    lines.push('')
  }
  if (f.groundingNotes.length > 0) {
    lines.push('**Verification notes**', '', ...f.groundingNotes.map((n) => `- ${n}`), '')
  }

  return lines.join('\n')
}

function toHtml(report: ScanReport, findings: Finding[]): string {
  const md = toMarkdown(report, findings)
  // Minimal, dependency-free rendering. Print styles included so the browser's
  // "Save as PDF" produces something presentable.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>speeDB — ${escapeHtml(report.repo.owner)}/${escapeHtml(report.repo.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 52rem; margin: 3rem auto; padding: 0 1.5rem;
         font: 15px/1.65 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
         color: #2c2a27; background: #faf8f5; }
  @media (prefers-color-scheme: dark) { body { color: #e8e4de; background: #1b1a18; } }
  h1 { font-size: 1.75rem; letter-spacing: -0.02em; }
  h2 { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid rgba(128,120,110,.28); font-size: 1.25rem; }
  h3 { margin-top: 2rem; font-size: 1.05rem; }
  pre { background: rgba(128,120,110,.12); padding: .85rem 1rem; border-radius: 8px;
        overflow-x: auto; font-size: 13px; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .75rem; border-bottom: 1px solid rgba(128,120,110,.24); }
  blockquote { margin: 1rem 0; padding: .6rem 1rem; border-left: 3px solid #b07a5a;
               background: rgba(176,122,90,.09); }
  @media print { body { background: #fff; color: #000; margin: 0; } h2 { page-break-before: auto; } h3 { page-break-inside: avoid; } }
</style></head>
<body>${renderMarkdown(md)}</body></html>`
}

/** Deliberately small: headings, code fences, tables, lists, bold, inline code. */
function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false
  let inList = false
  let inTable = false

  const closeBlocks = () => {
    if (inList) { out.push('</ul>'); inList = false }
    if (inTable) { out.push('</table>'); inTable = false }
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      closeBlocks()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(escapeHtml(line)); continue }

    if (/^\|/.test(line)) {
      if (/^\|[\s|:-]+\|$/.test(line)) continue
      if (!inTable) { closeBlocks(); out.push('<table>'); inTable = true }
      const cells = line.split('|').slice(1, -1).map((c) => inline(c.trim()))
      out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeBlocks()
      const level = heading[1]!.length
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    if (line.startsWith('> ')) { closeBlocks(); out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); continue }
    if (line.startsWith('- ')) {
      if (!inTable && !inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(line.slice(2))}</li>`)
      continue
    }
    if (line.trim() === '---') { closeBlocks(); out.push('<hr>'); continue }
    if (line.trim() === '') { closeBlocks(); continue }

    closeBlocks()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeBlocks()
  if (inCode) out.push('</code></pre>')
  return out.join('\n')
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
