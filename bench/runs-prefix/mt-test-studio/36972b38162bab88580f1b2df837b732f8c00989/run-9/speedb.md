# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 4:36:44 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 871 analysed · 2 filtered (below confidence 0 · low priority 2) · 30 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Triage** 866 site(s) triaged · 37 flagged · 3 unsure · 826 clean (5% sent for write-up)  
**Write-up gaps** 6 triaged site(s) were neither written up nor explicitly declined. Those sites were examined and then dropped in silence, so this report is missing whatever they contained.  
**Triage gaps** 5 site(s) came back from triage with no verdict and were escalated to a full write-up rather than assumed clean. That is the safe direction, but a scan with many of them is one whose triage stage is not answering reliably.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 15 published · 19 suppressed

> **speeDB executed nothing.** It read 0 table and 0 index declarations from source. Every speed claim below is a hypothesis about a mechanism, with a command attached to settle it.
>
> Not knowable from source code:
> - Row counts — no table size is recoverable from source.
> - Column selectivity and data distribution.
> - Which indexes actually exist in production, versus which were declared in a migration that may have been superseded, reverted, or never run.
> - Index bloat, and whether an existing index is used at all.

## Summary

| Severity | Same-output optimisations | Behaviour changes |
| --- | --- | --- |
| critical | 0 | 0 |
| high | 1 | 3 |
| medium | 0 | 8 |
| low | 2 | 0 |
| info | 0 | 1 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Preload case-plan sortkeys before the execution loop

`high` · `n-plus-one` · `mysql` · ✅ verified

Fetching each TestCasePlan inside the loop causes one lookup per case; precomputing the relevant plans lets the view do a single query and reuse the results while creating executions.

**Where it is used**

- `tcms/testruns/views.py:316` in `NewTestRunView.post`
- Reached via request-handler

**Current**

```sql
tcp = TestCasePlan.objects.get(plan=plan_obj, case=case)
```

**Proposed**

```sql
if plan_obj:
    plan_case_sortkeys = {
        tcp.case_id: tcp.sortkey
        for tcp in TestCasePlan.objects.filter(plan=plan_obj, case__in=cases_to_add)
    }
else:
    plan_case_sortkeys = {}

loop = 1
for case in cases_to_add:
    sortkey = plan_case_sortkeys.get(case.id, loop * 10)
    test_run.create_execution(
        case=case,
        assignee=form.cleaned_data["default_tester"],
```

**Why this helps** — This moves the plan/case lookup out of the per-case loop so the database can return all matching sortkeys in one query instead of repeated lookups.

**Expected impact** — 1 query for all matching TestCasePlan rows instead of one lookup per case

**Why the output is unchanged (the model's argument)** — The set of created executions is unchanged because each case still gets the same sortkey fallback when no matching TestCasePlan exists; rows, columns, duplicates, and ordering of the surrounding loop are preserved, and NULL handling is unchanged because the code still only substitutes a sortkey when a matching record exists.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Moves the query out of the loop: one call for the whole set instead of one per iteration. (Counted from the code, not measured.)
- Replaces a per-row lookup with a single set-membership predicate. (Counted from the code, not measured.)

**Checked against the declared schema**

- No CREATE TABLE for testcases_testcaseplan was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Partly verified (django): Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX IF NOT EXISTS testcases_testcaseplan_plan_case_idx ON testcases_testcaseplan (plan_id, case_id);
```

**Assumptions**

- cases_to_add is a finite iterable of case objects with stable ids
- TestCasePlan has one relevant row per (plan, case) pair as implied by the original .get() call
- Using case.id as the key is safe because the filter returns plans for the same case objects being iterated

**Evidence**

- `tcms/testruns/views.py:313` (call-site) — Shows the per-case lookup pattern inside the loop.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Batch execution creation instead of looping per case

`low` · `batching` · `mysql` · ✅ verified

`run.create_execution(...)` inside the loop issues one database write per confirmed case, so this can be turned into a single bulk insert path if the helper allows it.

**Where it is used**

- `scripts/run_assetshare_cases.py:37` in `unknown`
- Reached via unknown

**Current**

```sql
for i, tc in enumerate(cases):
        run.create_execution(case=tc, build=build, sortkey=(i + 1) * 10)
```

**Proposed**

```sql
cases = list(plan.cases.filter(case_status__name="CONFIRMED").order_by("pk"))
executions = [
    TestExecution(case=tc, build=build, sortkey=(i + 1) * 10, run=run)
    for i, tc in enumerate(cases)
]
TestExecution.objects.bulk_create(executions)
```

**Why this helps** — This replaces repeated per-row create calls with one bulk insert, so the database can process the executions in one write path instead of one call per case.

**Expected impact** — One bulk insert instead of one insert per confirmed case.

**Why the output is unchanged (the model's argument)** — The rewritten code creates the same execution rows for the same confirmed cases with the same `case`, `build`, and `sortkey` values; it preserves the same set of rows and duplicate handling as long as `create_execution` does not add extra side effects, and it does not change query ordering because the input `cases` list is still ordered by `pk`. NULL handling is unchanged because the inserted field values are the same. If `create_execution` performs additional logic beyond row insertion, this would be behavioural rather than equivalent.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

**Automated equivalence check** — Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax).

Not machine-checkable:

- Not a statement this checker can read (non-SQL engine or unsupported syntax).

**Assumptions**

- `create_execution` is only persisting a `TestExecution` row and does not trigger extra business logic, signals, or side effects that must be preserved.
- `TestExecution` has the fields shown in the call site, and bulk insertion is permitted for this model.

**Evidence**

- `scripts/run_assetshare_cases.py:37` (call-site) — Shows the loop that performs one create per case.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Avoid arbitrary status selection by using a deterministic lookup

`low` · `other` · `mysql` · ✅ verified

This code asks for the first confirmed status after ordering by primary key, which is a single query but the finding triage does not show an avoidable database inefficiency beyond a necessary lookup.

**Where it is used**

- `tcms/testcases/views.py:1110` in `SectionCopyView.post`
- Reached via request-handler

**Current**

```sql
confirmed_status = (
            TestCaseStatus.objects.filter(is_confirmed=True).order_by("pk").first()
        )
```

**Proposed**

```sql
confirmed_status = TestCaseStatus.objects.filter(is_confirmed=True).order_by("pk").first()
```

**Why this helps** — No change is needed based on the visible code; this is already one terminal lookup and not an obvious n-plus-one or round-trip problem.

**Expected impact** — none proven from the available context

**Why the output is unchanged (the model's argument)** — Identical rows, columns, ordering, NULL handling, and duplicate handling; this is the original code unchanged because no safe faster rewrite is provable from the excerpt.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.
- The terminal operation is unchanged (first), so the shape of the result is the same.
- The filter expressions are textually unchanged.

**Assumptions**

- A more aggressive rewrite would need model constraints or business rules not visible here.

**Evidence**

- `tcms/testcases/views.py:1110` (call-site) — Visible terminal ORM lookup, but no second query or loop is shown.

**Verification notes**

- Severity is low, not the info the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

## Behaviour changes and bugs

**These change what the query returns.** They are listed separately on purpose — review each on its merits.

### Resolve imported section names in bulk

`high` · `n-plus-one` · `mysql` · ✅ verified

The import path performs `Section.objects.get_or_create(...)` inside the row-processing loop, so each new or existing section name can trigger a separate database lookup while importing many rows.

**Where it is used**

- `tcms/testcases/views.py:753` in `ImportCasesView._do_import`
- Reached via request-handler

**Current**

```sql
sec, _ = Section.objects.get_or_create(
```

**Proposed**

```sql
section_names = {
    val
    for row_num, row in enumerate(reader, start=2)
    for csv_col, field_name in mapping.items()
    if field_name == "section" and val
}
sections = {
    section.name: section
    for section in Section.objects.filter(parent__isnull=True, name__in=section_names)
}
for row_num, row in enumerate(reader, start=2):
    ...
    if field_name == "section":
        sec = sections.get(val)
        if sec is None:
            sec, _ = Section.objects.get_or_create(
                parent__isnull=True,
                name=val,
                defaults={"description": ""},
            )
            sections[val] = sec
        values["section"] = sec
```

**Why this helps** — Prefetching known section rows avoids repeatedly asking the database for the same names during import, and only falls back to `get_or_create` for names not already cached.

**Expected impact** — One bulk lookup for already-known section names instead of repeated per-row lookups

**Why the output is unchanged (the model's argument)** — The rewrite preserves the same section assignment semantics for every CSV row: it still uses the same name and `parent__isnull=True` match, creates missing sections with the same defaults, returns the same section object for repeated names, and does not change row ordering, duplicates, or NULL handling in the imported data; one caveat is that it assumes the `reader` can be iterated or buffered in a way that lets names be collected before row processing.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Moves the query out of the loop: one call for the whole set instead of one per iteration. (Counted from the code, not measured.)
- Replaces a per-row lookup with a single set-membership predicate. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [none] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [none] to [get], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The CSV input can be buffered or rewound so the names can be collected before per-row processing.
- `Section.objects.filter(parent__isnull=True, name__in=...)` returns the same rows that `get_or_create(parent__isnull=True, name=val, ...)` would find when the section already exists.

**Evidence**

- `tcms/testcases/views.py:750` (call-site) — Shows the import loop reaching a section lookup/create for each row.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [none] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Preload active runs per product instead of querying inside the stream loop

`high` · `n-plus-one` · `mysql` · ✅ verified

The dashboard iterates over products and runs a separate `TestRun.objects.filter(plan__product=stream, stop_date__isnull=True)` query for each one, producing an ORM round trip per stream.

**Where it is used**

- `tcms/core/views.py:154` in `DashboardView.get_context_data`
- Reached via request-handler

**Current**

```sql
for stream in Product.objects.all().order_by("name"):
            active_run_ids = list(
                TestRun.objects.filter(
                    plan__product=stream, stop_date__isnull=True
                ).values_list("pk", flat=True)
            )
```

**Proposed**

```sql
streams = list(Product.objects.all().order_by("name"))
active_runs_by_product = {}
for run_id, product_id in TestRun.objects.filter(
    stop_date__isnull=True,
    plan__product__in=streams,
).values_list("pk", "plan__product_id"):
    active_runs_by_product.setdefault(product_id, []).append(run_id)

stream_stats = []
for stream in streams:
    active_run_ids = active_runs_by_product.get(stream.pk, [])
    agg = TestExecution.objects.filter(run__in=active_run_ids).aggregate(
        total=Count("pk"), **exec_count_annotations()
    )
```

**Why this helps** — This replaces one query per product with a single query that fetches all active runs grouped by product, so the database is not repeatedly re-filtered for each stream.

**Expected impact** — 1 query to collect all active runs instead of one query per product

**Why the output is unchanged (the model's argument)** — The product iteration order stays `order_by("name")`; each stream still receives only runs where `plan__product=stream` and `stop_date__isnull=True`; the aggregate sees the same run ids for each product; duplicates and NULL handling are unchanged because the same row identities are collected; the rewrite does not add or remove rows from the final context, only changes how the intermediate ids are retrieved.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Moves the query out of the loop: one call for the whole set instead of one per iteration. (Counted from the code, not measured.)
- Replaces a per-row lookup with a single set-membership predicate. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The selected fields change from [pk, flat=True] to [pk, plan__product_id], so the caller receives different data.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Differences found:

- The selected fields change from [pk, flat=True] to [pk, plan__product_id], so the caller receives different data.
- The terminal operation changes from [none] to [get], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `Product` instances can be safely materialized before the run lookup.
- `plan__product_id` is the foreign-key column backing `plan__product`.

**Evidence**

- `tcms/core/views.py:154` (call-site) — Shows the per-stream query pattern inside the product loop.

**Verification notes**

- Reclassified as behaviour-changing: The selected fields change from [pk, flat=True] to [pk, plan__product_id], so the caller receives different data. The terminal operation changes from [none] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Aggregate stream statistics in one grouped query

`high` · `n-plus-one` · `mysql` · ✅ verified

The view issues one active-run lookup and one execution aggregate per product, so it repeatedly round-trips to compute the same per-stream statistics that can be grouped in a single query instead.

**Where it is used**

- `tcms/core/views.py:566` in `AllStreamsCsvExportView.get`
- Reached via request-handler
- Also at `tcms/core/views.py:154`
- Also at `tcms/core/views.py:572`

**Current**

```sql
for stream in Product.objects.all().order_by("name"):
            active_run_ids = list(
                TestRun.objects.filter(
                    plan__product=stream, stop_date__isnull=True
                ).values_list("pk", flat=True)
            )
            agg = TestExecution.objects.filter(run__in=active_run_ids).aggregate(
                total=Count("pk"), **exec_count_annotations()
            )
```

**Proposed**

```sql
streams = (
    Product.objects.order_by("name")
    .annotate(
        total=Count(
            "testplan__testrun__testexecution",
            filter=Q(testplan__testrun__stop_date__isnull=True),
        ),
        **exec_count_annotations(),
    )
)
for stream in streams:
    agg = {
        "total": stream.total,
        "passed": stream.passed,
        "failed": stream.failed,
        "blocked": stream.blocked,
        "error": stream.error,
        "not_run": stream.not_run,
    }
```

**Why this helps** — This moves the counting to the database once per result set instead of doing a separate run lookup and execution aggregate for every product.

**Expected impact** — One grouped aggregate query instead of two queries per product.

**Why the output is unchanged (the model's argument)** — It preserves the same product rows and ordering because it still iterates products ordered by name; the projected statistics are intended to be the same per product, with the same NULL handling on stop_date via the filter, and duplicates are counted the same way through COUNT over executions. This is behavioural rather than equivalent because it changes how the query is expressed and relies on join semantics that must match the current run-id list exactly.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Issues no database call within the code shown, where the original issues 3. Whether the work moved or disappeared is not decidable from this excerpt. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Differences found:

- The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX on the foreign-key/filter columns may help, but no specific new migration is required from the visible context.
```

**Assumptions**

- Product has the reverse relations used in the proposed join path, and exec_count_annotations() can be expressed against the same joined execution rows without changing its filters.
- The current code’s use of run__in active_run_ids is intended to include exactly executions belonging to active runs for each product.

**Evidence**

- `tcms/core/views.py:566` (call-site) — Shows the per-product loop and per-product execution aggregate.

**Verification notes**

- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Fold per-product execution aggregation into one query

`medium` · `n-plus-one` · `mysql` · ✅ verified

DashboardView computes execution counts by querying active runs and then aggregating executions for each product inside the loop, which creates repeated database work instead of a single grouped aggregation.

**Where it is used**

- `tcms/core/views.py:160` in `DashboardView.get_context_data`
- Reached via request-handler
- Also at `tcms/core/views.py:154`

**Current**

```sql
agg = TestExecution.objects.filter(run__in=active_run_ids).aggregate(
                total=Count("pk"), **exec_count_annotations()
            )
```

**Proposed**

```sql
# Replace the per-product loop body with a grouped annotation/query that returns
# each product and its execution counts in one pass.
```

**Why this helps** — The database can group executions by product directly, avoiding a separate aggregate query for every stream and avoiding materializing active run ids per stream.

**Expected impact** — Eliminates repeated per-product round trips and repeated Python list materialization of run ids.

**Why the output is unchanged (the model's argument)** — This is not equivalent because it changes the query shape and depends on join-path semantics; it is only safe if the grouped joins produce the same product set, the same count semantics, and the same ordering by product name as the current loop.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

**Automated equivalence check** — Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax).

Not machine-checkable:

- Not a statement this checker can read (non-SQL engine or unsupported syntax).

**Requires this migration first**

```sql
CREATE INDEX on the relevant foreign keys may help, but none can be prescribed from the visible schema alone.
```

**Assumptions**

- The surrounding code can consume annotated product rows instead of a separate agg dict.
- The needed joins exist from Product to active runs and executions.

**Evidence**

- `tcms/core/views.py:154` (call-site) — Shows the same per-product aggregate pattern in the dashboard view.

### Avoid creating executions one at a time in the clone loop

`medium` · `n-plus-one` · `mysql` · ✅ verified

The clone path calls execution creation once per source execution, so the database work scales with the number of executions instead of using a set-oriented insert path.

**Where it is used**

- `tcms/testplans/views.py:479` in `Clone.form_valid`
- Reached via request-handler

**Current**

```sql
new_run.create_execution(
                        case=exe.case,
                        assignee=exe.assignee,
                        sortkey=(i + 1) * 10,
                    )
```

**Proposed**

```sql
executions = [
                    TestExecution(
                        run=new_run,
                        case=exe.case,
                        assignee=exe.assignee,
                        sortkey=(i + 1) * 10,
                    )
                    for i, exe in enumerate(source_run.executions.select_related("case").all())
                ]
                TestExecution.objects.bulk_create(executions)
```

**Why this helps** — This changes the write pattern from one insert per execution to a batched insert, reducing the number of round trips and letting the database handle the rows together.

**Expected impact** — 1 write round trip instead of one per execution

**Why the output is unchanged (the model's argument)** — This is not guaranteed equivalent because bulk_create can bypass per-object save logic and signals, and any side effects in create_execution would be skipped; the inserted rows, duplicate handling, and error behavior may differ if create_execution does more than insert the execution row.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

**Automated equivalence check** — Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax).

Not machine-checkable:

- Not a statement this checker can read (non-SQL engine or unsupported syntax).

**Requires this migration first**

```sql
ALTER TABLE `testruns_testexecution` ADD INDEX ...
```

**Assumptions**

- new_run.create_execution only creates the execution row and has no additional side effects or validation that must run per row
- the model and database allow bulk_create for these execution rows without needing returned primary keys immediately

### Collapse the repeated coverage counts into one grouped aggregate

`medium` · `full-scan` · `mysql` · ✅ verified

This view runs four separate COUNT queries over the same product-scoped test cases, so the database repeatedly scans the same filtered rows instead of aggregating them in one pass.

**Where it is used**

- `tcms/core/views.py:856` in `CoverageReportView.get`
- Reached via request-handler

**Current**

```sql
total_cases = TestCase.objects.filter(section__product=stream).count()
        sanity_count = TestCase.objects.filter(
            section__product=stream, is_sanity=True
        ).count()
        regression_count = TestCase.objects.filter(
            section__product=stream, is_regression=True
        ).count()
        automated_count = TestCase.objects.filter(
            section__product=stream, is_automated=True
        ).count()
```

**Proposed**

```sql
counts = TestCase.objects.filter(section__product=stream).aggregate(
            total_cases=Count("id"),
            sanity_count=Count("id", filter=Q(is_sanity=True)),
            regression_count=Count("id", filter=Q(is_regression=True)),
            automated_count=Count("id", filter=Q(is_automated=True)),
        )
        total_cases = counts["total_cases"]
        sanity_count = counts["sanity_count"]
        regression_count = counts["regression_count"]
        automated_count = counts["automated_count"]
```

**Why this helps** — The database can compute all four counts in one grouped aggregate over the same filtered test-case set instead of evaluating four separate count queries.

**Expected impact** — 1 aggregate query instead of 4 separate count queries

**Why the output is unchanged (the model's argument)** — This changes how the counts are obtained but not the reported values: the same filtered rows are counted, the same columns are assigned, ordering is unaffected because counts are scalar values, NULL handling is unchanged because COUNT ignores NULLs the same way here, and duplicates are not introduced or removed.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Issues 1 database call(s) where the original issues 4. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX? None required for equivalence; any benefit still depends on existing indexes and data distribution.
```

**Assumptions**

- Count and Q are imported in this module.
- The view only uses these four scalar counts and does not rely on issuing four distinct queries for side effects, which it should not.

**Evidence**

- `tcms/core/views.py:856` (call-site) — Shows four separate count operations over the same base filter.

### Reuse the filtered queryset for both counts

`medium` · `full-scan` · `mysql` · ✅ verified

The function builds one distinct queryset and then counts its manual and automated subsets separately, which makes the database evaluate two filtered counts over the same base set.

**Where it is used**

- `tcms/telemetry/api.py:28` in `breakdown`
- Reached via request-handler

**Current**

```sql
test_cases = TestCase.objects.filter(**query).distinct()

    manual_count = test_cases.filter(is_automated=False).count()
    automated_count = test_cases.filter(is_automated=True).count()
```

**Proposed**

```sql
test_cases = TestCase.objects.filter(**query).distinct()

    counts = test_cases.aggregate(
        manual=Count("id", filter=Q(is_automated=False)),
        automated=Count("id", filter=Q(is_automated=True)),
    )
    manual_count = counts["manual"]
    automated_count = counts["automated"]
```

**Why this helps** — One aggregate lets the database tally both categories from the same filtered distinct set in a single pass instead of evaluating two separate count queries.

**Expected impact** — 1 aggregate query instead of 2 count queries

**Why the output is unchanged (the model's argument)** — The same filtered test cases are considered, the same two output values are produced, column order is unchanged because the function still returns the same dictionary keys, NULL handling is unchanged because COUNT ignores NULLs, and the distinct handling remains on the base queryset before aggregation. This is behavioral rather than equivalent because the query shape changes, but the returned counts should match for the same database state.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Issues 1 database call(s) where the original issues 2. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct on).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX? None required for the rewrite itself; any benefit depends on existing indexes and how selective the filters are.
```

**Assumptions**

- Count and Q are available in this module.
- The distinct() on the base queryset is intended to remain part of the semantics and is preserved in the rewrite.

**Evidence**

- `tcms/telemetry/api.py:28` (call-site) — Shows the same queryset being counted twice with different predicates.

### Avoid building the union twice

`medium` · `round-trip` · `mysql` · ✅ verified

`properties.count()` forces a database read of the union result and then `property_matrix(properties, matrix_type)` will consume the same union again, so the code performs two separate evaluations instead of one.

**Where it is used**

- `tcms/testruns/models.py:163` in `TestRun`
- Reached via unknown

**Current**

```sql
properties = self.property_set.union(TestCaseProperty.objects.filter(case=case))

        if properties.count():
            for prop_tuple in self.property_matrix(properties, matrix_type):
```

**Proposed**

```sql
properties = self.property_set.union(TestCaseProperty.objects.filter(case=case))
        properties = list(properties)

        if properties:
            for prop_tuple in self.property_matrix(properties, matrix_type):
```

**Why this helps** — Materializing the union once avoids an extra database evaluation for the emptiness check and reuses the same rows for the later matrix generation.

**Expected impact** — 1 database evaluation instead of 2

**Why the output is unchanged (the model's argument)** — This is behavioural, not equivalent: the original `count()` asks the database for a cardinality while the rewrite loads rows, and if the union could yield duplicate or differently ordered rows the downstream iteration may observe them differently; the code also changes when errors would surface if the union query fails. The row set used by the loop is intended to be the same, but the exact database interaction is not identical.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Issues no database call within the code shown, where the original issues 1. Whether the work moved or disappeared is not decidable from this excerpt. (Counted, not measured.)
- Evaluates the queryset once and reuses the result, where the original re-runs it on each use. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- The terminal operation changes from [count] to [none], which changes what the call returns.

**Assumptions**

- `property_matrix` accepts an in-memory iterable as well as a queryset, or the materialized list is otherwise acceptable at this call site.

**Evidence**

- `tcms/testruns/models.py:163` (call-site) — Shows the union is counted before being iterated again.

### Preload required field config with a selective query

`medium` · `full-scan` · `mysql` · ✅ verified

This form method fetches every active system TestRunFieldConfig row before filtering in Python, so the database must return more rows than this form actually needs.

**Where it is used**

- `tcms/testruns/forms.py:83` in `NewRunForm._apply_field_config_required`
- Reached via unknown

**Current**

```sql
config_map = {
            c.field_key: c.is_required
            for c in TestRunFieldConfig.objects.filter(is_system=True, is_active=True)
        }
```

**Proposed**

```sql
config_map = dict(
            TestRunFieldConfig.objects.filter(
                is_system=True, is_active=True, field_key__in=self.SYSTEM_FIELD_MAP.keys()
            ).values_list("field_key", "is_required")
        )
```

**Why this helps** — This asks the database only for the keys this form can use and only the two needed columns, so the ORM does less row materialization and transfers less data.

**Expected impact** — Fewer rows and fewer columns fetched from TestRunFieldConfig on each form initialization.

**Why the output is unchanged (the model's argument)** — The returned mapping contains the same field_key to is_required pairs for any keys the form can consume; rows outside SYSTEM_FIELD_MAP are not used later, but this rewrite is not equivalent because it can omit unrelated rows and changes which objects are fetched. The columns and duplicate handling stay the same for matching keys, and ordering is irrelevant because the result is immediately converted to a dict.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Issues no database call within the code shown, where the original issues 1. Whether the work moved or disappeared is not decidable from this excerpt. (Counted, not measured.)
- Moves the query out of the loop: one call for the whole set instead of one per iteration. (Counted from the code, not measured.)
- Replaces a per-row lookup with a single set-membership predicate. (Counted from the code, not measured.)
- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [field_key, is_required]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The per-row predicate is widened to a single set-membership predicate over the same values, so the row set the database returns is provably the union of the per-row results.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [field_key, is_required]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the caller consumes that union the same way it consumed the per-row results — the row set is the same, the number of Python/Ruby/JS objects handed back is not. That is the guard condition on this rewrite.

**Assumptions**

- SYSTEM_FIELD_MAP lists every field_key this method can act on.
- TestRunFieldConfig.field_key is unique for the active system rows the form relies on.

### Aggregate tag counts through relation indexes

`medium` · `full-scan` · `mysql` · ✅ verified

This view groups all Tag rows and computes counts across two relations, so the database has to scan and aggregate tag-related rows rather than simply reading a prefiltered subset.

**Where it is used**

- `tcms/core/admin_views.py:229` in `TagList.get`
- Reached via unknown

**Current**

```sql
tags = Tag.objects.annotate(
            case_count=Count(
                "case", filter=Q(case__deleted_at__isnull=True), distinct=True
            ),
            execution_count=Count("execution", distinct=True),
        ).order_by("name")
```

**Proposed**

```sql
tags = Tag.objects.annotate(
            case_count=Count(
                "case", filter=Q(case__deleted_at__isnull=True), distinct=True
            ),
            execution_count=Count("execution", distinct=True),
        ).only("name").order_by("name")
```

**Why this helps** — Restricting the tag columns materialized can reduce row width while the counts are computed by the database join/aggregation machinery.

**Expected impact** — Less data transferred for each Tag row while preserving the same aggregation work.

**Why the output is unchanged (the model's argument)** — This keeps the same rows, ordering, NULL handling, and duplicate handling because it only narrows the selected Tag columns; however it is still behavioural if any template accesses additional Tag fields or if deferred loading changes later queries. The annotated counts and ordering remain unchanged.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Fetches 1 named column(s) instead of whole model instances. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- The template only needs Tag.name plus the annotated counts.
- No later code depends on other Tag columns being eagerly loaded.

### Avoid loading every Product instance in the template processor

`medium` · `full-scan` · `mysql` · ✅ verified

This context processor materializes the entire ordered Product table on every successful render path, which forces the database to return every Product row even though the code only passes them through as a list.

**Where it is used**

- `tcms/core/context_processors.py:31` in `stream_processor`
- Reached via unknown

**Current**

```sql
streams = list(Product.objects.order_by("name"))
```

**Proposed**

```sql
streams = list(Product.objects.only("id", "name").order_by("name"))
```

**Why this helps** — Limiting the loaded columns reduces the amount of row data read from MySQL and sent back for every render that reaches this processor.

**Expected impact** — Less row data transferred for every render that invokes this processor.

**Why the output is unchanged (the model's argument)** — The row set, row order, and duplicate handling are unchanged because the same queryset is evaluated with the same ORDER BY; the result is behavioral only if template code later relies on unloaded Product fields. NULL handling is unchanged because no filters are added or removed.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- The template only needs fields available on Product.id and Product.name, or can tolerate deferred loads.
- There is no code in the render path that depends on all Product fields being eagerly populated.

**Verification notes**

- Severity is medium, not the high the model proposed: 2 structural fact(s) were counted from the two versions.

### Batch the permission rename update

`info` · `n-plus-one` · `mysql` · ✅ verified

The backward migration loops over each matching Permission and saves it individually, which performs repeated ORM writes instead of one set-based update.

**Where it is used**

- `tcms/testruns/migrations/0006_rename_test_case_run_to_test_execution.py:22` in `backward_rename_permissions`
- Reached via migration

**Current**

```sql
for permission in permission_model.objects.filter(
        codename__contains="testexecution"
    ):
        old_name = permission.name.replace("test execution", "test case run")
        old_codename = permission.codename.replace("testexecution", "testcaserun")

        permission.codename = old_codename
```

**Proposed**

```sql
permission_model.objects.filter(codename__contains="testexecution").update(
        codename=models.F("codename")
    )
```

**Why this helps** — A bulk update avoids loading each Permission row and issuing a save per row.

**Expected impact** — One bulk update instead of repeated saves

**Why the output is unchanged (the model's argument)** — This is not equivalent because the original code also rewrites permission.name, while the proposed bulk update only shows codename handling; preserving the same rows, columns, NULL behavior, duplicates, and side effects would require the exact per-row transformations to be expressible in a single statement, which is not proven here.

**Speed — not measured.** speeDB does not execute queries. Verify with:

_Count the queries this issues (django)_

```sql
# Count the queries this code path issues, before and after.
from django.test.utils import CaptureQueriesContext
from django.db import connection

with CaptureQueriesContext(connection) as ctx:
    <call the view or function>
print(len(ctx.captured_queries))   # this is the number that must drop

# In a browser, django-debug-toolbar shows the same count per request.
```

What to look for:

- type column — ALL is a full scan; ref/range/const use an index.
- rows column — the planner's estimate of rows examined.
- Extra column — "Using filesort" and "Using temporary" are the expensive ones.

Counted from the statements (not timed):

- Moves the query out of the loop: one call for the whole set instead of one per iteration. (Counted from the code, not measured.)
- Replaces a per-row lookup with a single set-membership predicate. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: One version writes and the other does not (proposal writes), which is not an output-preserving change.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- One version writes and the other does not (proposal writes), which is not an output-preserving change.

**Requires this migration first**

```sql
CREATE INDEX is not required for correctness; any benefit from filtering on codename__contains depends on data distribution.
```

**Assumptions**

- The name field must also be updated in the same way, and the intended change can be expressed as a deterministic bulk update.

**Evidence**

- `tcms/testruns/migrations/0006_rename_test_case_run_to_test_execution.py:22` (call-site) — Shows the migration performs row-by-row processing for every matching Permission.

**Verification notes**

- Reclassified as behaviour-changing: One version writes and the other does not (proposal writes), which is not an output-preserving change.
- The equivalence argument does not address: ordering.
- Reported as an N+1, but the query is not inside a loop in the fetched source. One of those is wrong, and only one of them was checked.
- This code is reached by a migration or seed, so it runs once at install time or never in production.
- Severity is info, not the medium the model proposed: this code is reached by a migration or seed, so it runs once at install time or never in production.

## Suppressed before publication

19 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### wrong direction (proposal issues no fewer queries) — 8

- **Bulk-create environment properties** — `tcms/testruns/views.py:276`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Collapse the repeated permission checks into one evaluation** — `tcms/utils/tests/test_assign_permissions.py:45`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fetch submitted tags in one pass** — `tcms/testcases/views.py:420`
  The proposal issues 3 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch tag lookups before updating tags** — `tcms/testcases/views.py:420`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid filtering executions by a per-product id list** — `tcms/core/views.py:572`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch testcase cloning instead of creating each copy one by one** — `tcms/rpc/api/testcase.py:878`
  The proposal issues 4 database call(s) where the original issues 4, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Push the filter into a bulk update** — `tcms/testcases/migrations/0036_migrate_testrail_id_custom_field.py:56`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Cache the active custom fields before updating values** — `tcms/testcases/views.py:189`
  The proposal issues 3 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)

### no-op (proposal identical to the original) — 7

- **Add a composite index for sibling-name lookup** — `tcms/testcases/models.py:355`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Hoist the filtered field configs into a keyed map** — `tcms/rpc/api/testrun.py:39`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Leave the existence check as-is** — `tcms/testruns/admin.py:94`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Decline the join-based fetch as a round-trip issue** — `tcms/rpc/api/testrun.py:140`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Fetch execution rows in one query and reuse them by case** — `tcms/rpc/api/testrun.py:160`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Decline the N+1 claim for the shared base queryset** — `tcms/telemetry/api.py:78`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Decline the loop-based N+1 claim for active custom fields** — `tcms/testcases/views.py:352`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

### cold path (migration, seed or test) — 1

- **Reuse the fetched plan when comparing the parent** — `tcms/testplans/tests/tests.py:299`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.

### not data access — 2

- **Batch execution inserts instead of creating one row per case** — `tcms/testplans/views.py:176`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Compute the next sortkey without re-aggregating the execution set** — `tcms/testruns/views.py:592`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.

### immaterial (a column narrowing on a query that runs once) — 1

- **Load only the fields needed for copied cases** — `tcms/rpc/api/testcase.py:1404`
  The only thing counted here is a narrower column list (Fetches 4 named column(s) instead of whole model instances. (Counted, not measured.)), on a query that does not run per iteration and is not unbounded. That is a real saving and a small one; publishing it beside a per-request N+1 costs the reader more attention than it returns.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._