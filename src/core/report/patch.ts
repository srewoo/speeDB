import type { Finding, ScanReport } from '@/core/types'
import { diffLines } from '@/components/Diff'

/**
 * Turn a finding into a unified diff.
 *
 * A report you cannot act on is a report you read once. This is deliberately
 * not an auto-commit: it produces text you can read, paste into a review, or
 * feed to `git apply`. The decision stays with a person, but the mechanical
 * work of retyping a rewrite does not.
 *
 * The hunk is anchored at the finding's real line numbers, so the output
 * applies against the commit that was scanned.
 */
export function toUnifiedDiff(finding: Finding, contextLines = 3): string {
  const occ = finding.primaryOccurrence
  const before = finding.original.replace(/\s+$/, '').split('\n')
  const after = finding.suggestion.proposed.replace(/\s+$/, '').split('\n')

  const start = Math.max(1, occ.startLine)
  const lines = diffLines(finding.original, finding.suggestion.proposed)

  const header = [
    `--- a/${occ.file}`,
    `+++ b/${occ.file}`,
    `@@ -${start},${before.length} +${start},${after.length} @@` +
      (occ.enclosingSymbol ? ` ${occ.enclosingSymbol}` : ''),
  ]

  const body = lines.map((l) =>
    l.kind === 'add' ? `+${l.text}` : l.kind === 'del' ? `-${l.text}` : ` ${l.text}`,
  )

  void contextLines // context comes from the model's excerpt, not re-derived

  return [...header, ...body].join('\n')
}

/**
 * A git-appliable patch for a set of findings.
 *
 * Only same-output findings are included by default: bundling a
 * behaviour-changing rewrite into a file someone might `git apply` in bulk
 * would undo the whole point of separating them.
 */
export function toPatchFile(report: ScanReport, findings: Finding[]): string {
  const included = findings.filter((f) => f.kind === 'equivalent')
  const excluded = findings.length - included.length

  const preamble = [
    `# speeDB — ${report.repo.owner}/${report.repo.name} @ ${report.repo.commitSha.slice(0, 10)}`,
    `#`,
    `# ${included.length} same-output change${included.length === 1 ? '' : 's'}.`,
    ...(excluded > 0
      ? [`# ${excluded} behaviour-changing finding${excluded === 1 ? '' : 's'} were NOT included —`,
         `# review those individually in the report.`]
      : []),
    `#`,
    `# Each hunk is anchored to the scanned commit. Review before applying:`,
    `#   git apply --check speedb.patch`,
    ``,
  ]

  const bodies = included.map((f) => [
    `# ${f.title}`,
    `# ${f.suggestion.expectedImpact}`,
    `# Equivalence: ${f.equivalence?.summary ?? 'not checked'}`,
    toUnifiedDiff(f),
    ``,
  ].join('\n'))

  return [...preamble, ...bodies].join('\n')
}
