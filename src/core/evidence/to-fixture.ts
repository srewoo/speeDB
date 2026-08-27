import type { Finding } from '@/core/types'
import type { PerformanceVerdict } from './types'

/**
 * A refuted finding, exported as a benchmark fixture.
 *
 * This is the point of the whole evidence path, and it is worth stating
 * plainly because it is not obvious from any single piece of it.
 *
 * The benchmark's binding constraint is not the harness — that already computes
 * precision, recall, engine accuracy and candidate coverage, and refuses to
 * report green without a pinned commit and a human-adjudicated audit. The
 * constraint is that **two of six repositories are scored**, because an audit
 * costs a human reading a real codebase, and you cannot buy or synthesise more
 * of those.
 *
 * A `regression` or `no-difference` verdict is a human-confirmed negative
 * against a real commit, produced as a by-product of someone doing their job.
 * It is the same artefact an audit produces, arriving one finding at a time
 * from ordinary use. Exporting it into `bench/fixtures/` is what turns the
 * runtime-evidence feature from a nice capability into the thing that fixes
 * precision permanently rather than once.
 *
 * ## No server, and that is not a limitation here
 *
 * NG7: speeDB has no backend, so this cannot be telemetry and should not be.
 * The export is a file the user chooses to save and a pre-filled issue they
 * choose to open. A false-positive report that leaves the machine without an
 * explicit act would be a worse trade than the data is worth — especially
 * given what a plan capture contains.
 *
 * ## What is deliberately not exported
 *
 * The raw evidence. A fixture needs the *finding* and the *verdict*, not the
 * `EXPLAIN` output that produced it — that output carries production row values
 * in its filter conditions, and a fixture is a file destined for a git
 * repository. The verdict's `because` lines carry the numbers, which is what a
 * regression test needs.
 */

export interface FixtureExport {
  /** Suggested path under `bench/fixtures/`. */
  filename: string
  /** JSON, ready to write. */
  content: string
}

export interface FixtureInput {
  finding: Finding
  verdict: PerformanceVerdict
  repo: string
  commitSha: string
  /** ISO timestamp. Passed in rather than read, so this stays pure. */
  at: string
}

/** True for the verdicts worth keeping as regression fixtures. */
export function isFixtureWorthy(verdict: PerformanceVerdict): boolean {
  // `confirmed` is not exported. A finding that was right is the expected
  // outcome and adds nothing to a corpus of things that went wrong; keeping
  // them would dilute the fixture set with the easy cases.
  //
  // `insufficient-evidence` is not exported either — it is a statement about
  // the capture, not about the finding, and treating it as a negative would
  // teach the gate to suppress findings whose evidence merely was not gathered.
  return verdict.kind === 'regression' || verdict.kind === 'no-difference'
}

export function toFixture(input: FixtureInput): FixtureExport | null {
  if (!isFixtureWorthy(input.verdict)) return null

  const { finding, verdict } = input
  const slug = `${input.repo}-${finding.primaryOccurrence.file}`
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80)

  const body = {
    _comment:
      'A finding that runtime evidence contradicted. Human-confirmed against a real ' +
      'commit, which is the same standard bench/AUDIT_PROMPT.md holds an audit entry to.',
    repo: input.repo,
    commitSha: input.commitSha,
    recordedAt: input.at,

    verdict: verdict.kind,
    // The numbers, not the raw capture. `because` lines cite both sides of
    // every metric, which is what a regression test needs; the EXPLAIN output
    // that produced them carries production row values and does not belong in
    // a git repository.
    evidence: verdict.because,
    staleEvidence: verdict.stale,

    finding: {
      id: finding.id,
      category: finding.category,
      engine: finding.engine,
      severity: finding.severity,
      modelSeverity: finding.modelSeverity,
      title: finding.title,
      file: finding.primaryOccurrence.file,
      startLine: finding.primaryOccurrence.startLine,
      original: finding.original,
      proposed: finding.suggestion.proposed,
      // Both of these are the reason to keep the record. A false positive that
      // the gate rated `high`, with three counted facts and 3-of-3 triage
      // support, is a far more interesting fixture than one it already
      // half-doubted — and the only way to tell them apart later is to record
      // what the tool believed at the time.
      triageSupport: finding.triageSupport,
      countedFacts: finding.performance?.counted ?? [],
      performanceStatus: finding.performance?.status,
      grounding: finding.grounding,
    },

    // What the recipe predicted would refute it. If one of these is what
    // actually happened, the recipe worked and the finding was wrong; if none
    // of them is, the recipe missed a failure mode and that is a second defect
    // worth its own fix.
    predictedRefutations: finding.performance?.refutes ?? [],
  }

  return {
    filename: `${slug}-${finding.id}.json`,
    content: JSON.stringify(body, null, 2) + '\n',
  }
}

/**
 * A pre-filled issue body, for the user who would rather report than commit.
 *
 * Same content, prose-shaped. No network call — the caller opens the URL or
 * copies the text, and that act is the consent.
 */
export function toIssueBody(input: FixtureInput): string {
  const { finding, verdict } = input
  return [
    `### A finding that runtime evidence ${verdict.kind === 'regression' ? 'contradicted' : 'did not support'}`,
    '',
    `**Repo:** ${input.repo} @ \`${input.commitSha.slice(0, 8)}\``,
    `**Finding:** ${finding.title} (\`${finding.category}\`, rated \`${finding.severity}\`)`,
    `**Site:** \`${finding.primaryOccurrence.file}:${finding.primaryOccurrence.startLine}\``,
    '',
    '**What was measured**',
    ...verdict.because.map((b) => `- ${b}`),
    '',
    ...(finding.performance?.counted.length
      ? ['**What speeDB had counted from the source**', ...finding.performance.counted.map((c) => `- ${c}`), '']
      : ['_No structural fact was counted from the two versions._', '']),
    ...(finding.triageSupport
      ? [`**Triage support:** ${finding.triageSupport.flagged} of ${finding.triageSupport.samples} samples flagged this site.`, '']
      : []),
    '**The proposal**',
    '```',
    finding.suggestion.proposed.slice(0, 1500),
    '```',
    '',
    '_No plan output or query log is included: those carry production row values._',
  ].join('\n')
}
