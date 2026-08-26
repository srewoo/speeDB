# bench — the numbers a fix has to move

A fix is only real if it moves a number. This directory defines the numbers.

Nothing here runs automatically on a fresh clone, because two of the three
inputs cannot be synthesised: a **pinned commit** and a **human-adjudicated
audit** of that commit. `score.mjs` refuses to report a green run without both,
and says which is missing.

## Layout

```
repos.json                 the corpus, the gates, and the pre-fix baseline
AUDIT_PROMPT.md            the ground-truth audit, blind to speeDB's output
pin.mjs                    resolve every repo to a commit SHA
detect.mjs                 the --no-llm run: detection metrics, zero tokens
score.mjs                  reconciliation, metrics, gates, scorecard
truth/<id>/<sha>.json      the audit. Version controlled. The durable asset.
runs/<id>/<sha>/           report.json per bench run
results/<date>.md          the scorecard, committed so regressions show in a diff
fixtures/                  frozen inputs for unit tests
```

## Running it

```sh
node bench/pin.mjs                                   # pin every repo, then commit
node bench/detect.mjs --repo mt-test-studio --path ~/src/mt-test-studio
node bench/score.mjs   --repo mt-test-studio --no-llm # free: detection metrics only
node bench/score.mjs                                 # full, needs a real scan + audit
```

`npm run bench` is `score.mjs`; `npm run bench:detect` is `detect.mjs`.

`--no-llm` scores **candidate coverage**, **engine accuracy** and **cold-path
share** without spending a token, because all three are decided before the model
runs. That variant belongs in CI on every push. The full benchmark belongs
before a release.

## Why candidate coverage is the metric to watch first

It isolates detection from the model entirely. If a real N+1 never becomes a
candidate, no prompt change can recover it and every other metric is downstream
of it. The 2026-08-26 baseline was **0/3** — all three of the worst query
patterns in the repository were dropped by the per-file cap before the model saw
anything.

## Getting a full scan into `runs/`

The scan itself happens in the extension, which is where the code runs:

1. Settings → set `temperature: 0`, and use **Rescan without cache**.
2. Scan the pinned commit (paste the repo URL with the SHA as the ref).
3. Export → **JSON**, and save it as `bench/runs/<id>/<sha>/report.json`.

Same model, same temperature, same commit — otherwise consecutive scorecards are
not comparable and the diff means nothing.

## Adjudication

The Claude audit is the reference, not an oracle. Where the two disagree, a human
decides and the decision goes back into the truth file on the entry itself
(`"adjudicated": true` plus a one-line reason). Truth files get better every run;
that is what makes this repeatable.
