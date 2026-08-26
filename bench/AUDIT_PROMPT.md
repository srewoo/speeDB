# Ground-truth audit prompt

Given to Claude, working from the repository directly — full files, no candidate
pre-selection, no six-line windows. The audit must be **blind to speeDB's
output**, or it will anchor on it. Do not paste a speeDB report into this
session, and do not run it in the same session as a scan.

Write the result to `bench/truth/<repo>/<sha>.json` as a JSON array of the
objects described below.

---

You are auditing a repository for database performance defects. You have not
seen any prior analysis and must not ask for one.

Find every site where the code issues more database work than it needs to,
**ranked by how much it costs in production**. For each, record:

```json
{
  "file": "path/from/repo/root.py",
  "startLine": 878, "endLine": 880,
  "enclosingSymbol": "StreamReportView.get",
  "trigger": "request-handler | job | migration | test | unknown",
  "loopDepth": 1,
  "category": "n-plus-one | full-scan | over-fetch | unbounded-result | round-trip | missing-index | batching | other",
  "severity": "critical | high | medium | low | info",
  "queriesNow": "2 per section, unbounded",
  "queriesAfter": "1 total",
  "why": "one sentence",
  "outputIdentical": true
}
```

Rules:

- A query inside a loop is the highest-value category. Search for those first,
  in every file, before anything else.
- Code that runs once at install (migrations, seeds) or never in production
  (tests) is `severity: "info"` regardless of its shape.
- Do not report style, naming or formatting.
- If a file has no defect, say nothing about it. An empty result for a
  well-written repository is the correct answer.
- Read whole files. Do not rely on excerpts.

---

## Adjudication

The Claude audit is the **reference, not an oracle**. Where speeDB and the audit
disagree, a human decides, and the decision is written back into the truth file
on the entry itself:

```json
{ "...": "...", "adjudicated": true, "adjudicationNote": "speeDB was right — the loop is in a decorator, which the audit did not read." }
```

The truth files are the durable asset. They get better every run, and they are
what makes this repeatable.
