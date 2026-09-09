# @speedb/mcp

Scan a repository for database queries and check every proposed rewrite against
the source — as an MCP server, with **no API key**.

```sh
claude mcp add speedb -- npx -y @speedb/mcp
```

## You are the model

Most analysis tools ask for a key and call a provider. This one doesn't. The
agent that calls it — Claude Code, Codex, anything speaking MCP — supplies the
reasoning, and the server supplies everything that can be checked by machine.

`scan_start` hands you a prompt through `scan_next`; you answer with
`scan_submit`; the scan resumes. What runs around your answers is not
negotiable, and that is the point:

- **Every citation is re-checked.** A finding that cites a file not in the tree
  is dropped. A quote that does not appear verbatim strips the citation and
  downgrades the finding. Line ranges are checked against the real file.
- **Equivalence is machine-checked** where it is decidable, and labelled where
  it is not. Output columns and order, `DISTINCT`, `GROUP BY`, set operations,
  `ORDER BY`, row limits. Predicate equivalence needs a solver, not a parser, so
  it is reported as undecided rather than as verified.
- **Worthless findings are held back with a stated reason** — no-ops, wrong-
  direction round-trip claims, cold-path performance claims in migrations and
  tests, proposals that reference symbols appearing nowhere in the repository.
- **Speed is never asserted.** There is no database connection, no query plan,
  no row counts, no timings. Facts derivable from the two statements are
  counted; everything else is named as unmeasured, with the exact `EXPLAIN` to
  run and which line of its output answers the question.

So a confident, wrong answer from the model gets caught by the machine, and a
correct one arrives with its evidence attached.

## Tools

Free and deterministic — no model call, useful on their own:

| Tool | What it does |
| --- | --- |
| `detect_queries` | Every query site in a repo, ranked by whether it is likely to matter. Rules over comment-masked source, with loop depth and enclosing symbol. |
| `check_equivalence` | Do these two statements return the same rows? Four verdicts, each difference named. SQL and ORM chains. |
| `explain_recipe` | The exact `EXPLAIN` / `.explain()` / profile call for 60+ engines, and what to look for in the output. |
| `schema_facts` | Declared tables and indexes; flags an index that duplicates or is a prefix of an existing one. |

The scan loop:

| Tool | What it does |
| --- | --- |
| `scan_start` | Begin a scan of a local checkout or a GitHub/GitLab repo. |
| `scan_next` | Get the next prompt, or the finished report. |
| `scan_submit` | Answer the prompt. `requestId` must match. |
| `scan_report` | The report as markdown, json, html, or a `git apply`-able patch. |
| `scan_cancel` | Abort and free the repository held in memory. |

## Local first

`scan_start` takes a `path` to a checkout on disk. An agent is usually already
sitting in the repository, often on a branch nobody has pushed — making it push
first so the tool can download what is on the same disk would be absurd, and
would rule out the case this is best at: reviewing a change before anyone else
sees it.

```
scan_start { path: "/Users/me/src/api", changedOnly: true }
```

`repoUrl` scans a GitHub or GitLab repository instead, ingesting the whole tree
in a single archive request rather than one request per file.

## What it does not do

It has no database connection. It cannot tell you whether the planner will pick
your index, whether that index already exists in production, what it costs on
write, or — for vector search — what it does to recall. Those are named
individually in every finding rather than glossed over.

An empty report is stated as the good outcome it usually is.

## Privacy

Storage is pinned to memory. Nothing this server learns about your code is
written to disk. Scanning a local path makes no network request at all.

MIT licensed. Built on [`@speedb/core`](https://www.npmjs.com/package/@speedb/core).
