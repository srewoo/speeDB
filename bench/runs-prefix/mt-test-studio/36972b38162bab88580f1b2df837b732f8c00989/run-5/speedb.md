# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 2:51:13 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 871 analysed · 2 filtered (below confidence 0 · low priority 2) · 41 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Triage** 865 site(s) triaged · 70 flagged · 2 unsure · 793 clean (8% sent for write-up)  
**Triage gaps** 6 site(s) came back from triage with no verdict and were escalated to a full write-up rather than assumed clean. That is the safe direction, but a scan with many of them is one whose triage stage is not answering reliably.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 30 published · 23 suppressed

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
| high | 3 | 1 |
| medium | 9 | 4 |
| low | 6 | 5 |
| info | 0 | 2 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Aggregate executions in one grouped query

`high` · `n-plus-one` · `mysql` · ✅ verified

The execution aggregate is executed once per stream, so the database repeats the same aggregation work for each product instead of processing all streams together.

**Where it is used**

- `tcms/core/views.py:572` in `AllStreamsCsvExportView.get`
- Reached via request-handler

**Current**

```sql
agg = TestExecution.objects.filter(run__in=active_run_ids).aggregate(
                total=Count("pk"), **exec_count_annotations()
            )
```

**Proposed**

```sql
execution_stats = (
            TestExecution.objects.filter(
                run__plan__product__in=streams,
                run__stop_date__isnull=True,
            )
            .values("run__plan__product_id")
            .annotate(total=Count("pk"), **exec_count_annotations())
        )
```

**Why this helps** — This changes the work from one aggregate per stream to one grouped aggregate over all relevant executions, so the database scans and groups the matching executions once.

**Expected impact** — One grouped execution aggregate instead of repeating the same aggregate for every stream.

**Why the output is unchanged (the model's argument)** — The original query returns one aggregate row for one stream's active runs; the rewrite returns one grouped row per stream. That is only equivalent if the caller consumes the grouped rows to produce the same per-stream results, with the same count semantics, and still emits one CSV row per stream in the same product order. Because the shape of the intermediate result changes, this is a behavioural rewrite internally, but the final output can remain equivalent if used carefully.

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
- Fetches 1 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [run__plan__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [run__plan__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The consumer can map grouped rows back to the corresponding stream id.
- `exec_count_annotations()` produces aggregates that work with grouping by product id.
- Streams with no executions are still represented with zero counts in the final output.

**Evidence**

- `tcms/core/views.py:572` (call-site) — Shows the repeated aggregate call that is the direct per-stream bottleneck.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [run__plan__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, NULL or duplicate handling.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Materialize the queryset into one SQL aggregation

`high` · `full-scan` · `mysql` · ✅ verified

This loop builds a full Python map from `TestCasePlan.objects.filter(**query)` even though the result can be produced in one grouped query instead of row-by-row object iteration.

**Where it is used**

- `tcms/rpc/api/testcase.py:782` in `sortkeys`
- Reached via request-handler

**Current**

```sql
for record in TestCasePlan.objects.filter(**query):
```

**Proposed**

```sql
from django.db.models import Max

result = {
    str(row["case_id"]): row["sortkey"]
    for row in (
        TestCasePlan.objects.filter(**query)
        .values("case_id")
        .annotate(sortkey=Max("sortkey"))
    )
}
```

**Why this helps** — This lets the database do the grouping and returns only the key/value data needed for the dictionary, instead of instantiating every matching row as a model object.

**Expected impact** — One SQL query that returns only grouped `case_id`/`sortkey` data instead of iterating full model rows in Python.

**Why the output is unchanged (the model's argument)** — This is only equivalent if there is at most one `TestCasePlan` row per `case_id` in the filtered set, because the original loop overwrites duplicates with the last row seen and the replacement uses an aggregate that chooses a specific value. The returned keys stay the same strings, but duplicate handling and row selection can differ, so this is behavioral unless uniqueness is guaranteed.

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
- Fetches 1 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [case_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The per-row predicate is widened to a single set-membership predicate over the same values, so the row set the database returns is provably the union of the per-row results.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [case_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the caller consumes that union the same way it consumed the per-row results — the row set is the same, the number of Python/Ruby/JS objects handed back is not. That is the guard condition on this rewrite.

**Requires this migration first**

```sql
CREATE INDEX for the fields used by the filter, if they are not already indexed; the necessary index depends on the actual contents of `query` and is not visible here.
```

**Assumptions**

- `query` identifies at most one row per `case_id`, or the caller does not rely on which duplicate wins.
- `sortkey` can be aggregated without changing intended semantics.

**Evidence**

- `tcms/rpc/api/testcase.py:776` (call-site) — Shows the function builds a dictionary from the filtered queryset and returns it to the caller.
- `tcms/rpc/api/testcase.py:782` (call-site) — Shows the queryset is iterated row by row to populate the result map.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [case_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the caller consumes that union the same way it consumed the per-row results — the row set is the same, the number of Python/Ruby/JS objects handed back is not. That is the guard condition on this rewrite. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, ordering.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 4 structural fact(s) were counted from the two versions.

### Fetch priorities with a keyed lookup

`high` · `full-scan` · `mysql` · ✅ verified

Replace the unqualified ORM fetch with a map keyed by priority value so later lookups do not depend on scanning the whole priority result set repeatedly.

**Where it is used**

- `tcms/core/admin_views.py:946` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
priority_cache = {p.value: p for p in Priority.objects.all()}
```

**Proposed**

```sql
priority_cache = Priority.objects.in_bulk(field_name="value")
```

**Why this helps** — This lets the ORM ask the database for the same Priority rows but materialize them directly into a dictionary keyed by value, avoiding repeated Python-side search through a list when the cache is used later.

**Expected impact** — Eliminates Python-side linear searches over the priority collection when resolving values later.

**Why the output is unchanged (the model's argument)** — It returns the same Priority rows as the original query; the columns are the same model fields, no ordering is relied on, NULL handling is unchanged, and duplicate priority values would be handled differently only if the schema allows them, so this is equivalent only if value is unique in practice.

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

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

**Requires this migration first**

```sql
ALTER TABLE <priority_table> ADD UNIQUE (value);
```

**Assumptions**

- Priority.value is unique or the code only ever expects one object per value.

**Evidence**

- `tcms/core/admin_views.py:945` (call-site) — Shows the priority data is loaded up-front into a dictionary for later use in the import flow.

**Verification notes**

- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Reuse the stream’s product count instead of querying inside the CSV loop

`medium` · `full-scan` · `mysql` · ✅ verified

This line issues a separate count query for each stream row instead of using data already available in the loop context.

**Where it is used**

- `tcms/core/views.py:598` in `AllStreamsCsvExportView.get`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count(),
```

**Proposed**

```sql
test_case_count,
```

**Why this helps** — If the per-stream test case count can be precomputed or annotated before entering the loop, the export avoids issuing a count query for every stream row.

**Expected impact** — 1 count query per stream instead of one query for each row in the CSV loop.

**Why the output is unchanged (the model's argument)** — This is equivalent only if the replacement value is computed from the same TestCase rows that `TestCase.objects.filter(section__product=stream).count()` would count, with the same handling of matching rows and no change to row order, columns, duplicates, or NULL behavior. Because the replacement is outside this snippet, equivalence depends on preserving the exact same count semantics for each stream.

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

- A precomputed `test_case_count` is available for the current `stream` and is derived from the same filter condition.
- No additional filtering, grouping, or deduplication is introduced in the precomputation.

**Evidence**

- `tcms/core/views.py:595` (call-site) — Shows the count is executed inline while writing each CSV row.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Batch execution creation

`medium` · `batching` · `mysql` · ✅ verified

The view creates executions one at a time inside the nested case loop instead of sending them to the database in a batch.

**Where it is used**

- `tcms/testplans/views.py:174` in `NewTestPlanView.form_valid`
- Reached via request-handler

**Current**

```sql
test_run.create_execution(
                        case=case,
                        assignee=self.request.user,
                        sortkey=sortkey * 10,
                    )
```

**Proposed**

```sql
executions = [
    TestExecution(
        run=test_run,
        case=case,
        assignee=self.request.user,
        sortkey=sortkey * 10,
    )
    for sortkey, case in enumerate(cases, start=10)
]
TestExecution.objects.bulk_create(executions)
```

**Why this helps** — Building the objects in Python and inserting them with one bulk operation removes the repeated per-case write path and lets the database handle the inserts in a batch.

**Expected impact** — 1 batch insert instead of one insert per case

**Why the output is unchanged (the model's argument)** — This is equivalent only if create_execution() does not perform extra per-row side effects, defaulting, or validation beyond storing the same fields. The same rows are inserted with the same column values, and because the original code does not define a row order guarantee for the created executions, ordering is not changed. NULL handling and duplicates remain the same if bulk_create uses the same field values and the database schema permits them.

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
CREATE INDEX/constraint is not required from the visible context.
```

**Assumptions**

- test_run.create_execution() only inserts a TestExecution row for the given fields
- No signals, hooks, or generated fields from create_execution() are required for correctness

**Evidence**

- `tcms/testplans/views.py:174` (call-site) — Shows the repeated per-case creation inside the loop.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Insert executions in bulk

`medium` · `batching` · `mysql` · ✅ verified

The run creation path inserts each execution one by one in the case loop instead of batching the inserts.

**Where it is used**

- `tcms/testruns/views.py:326` in `NewTestRunView.post`
- Reached via request-handler

**Current**

```sql
test_run.create_execution(
                    case=case,
                    assignee=form.cleaned_data["default_tester"],
                    sortkey=sortkey,
                    matrix_type=form.cleaned_data["matrix_type"],
                )
```

**Proposed**

```sql
executions = [
    TestExecution(
        run=test_run,
        case=case,
        assignee=form.cleaned_data["default_tester"],
        sortkey=sortkey,
        matrix_type=form.cleaned_data["matrix_type"],
    )
    for sortkey, case in enumerate(cases_to_add)
]
TestExecution.objects.bulk_create(executions)
```

**Why this helps** — Batching the inserts avoids repeating the write path for each case and lets the database accept the new executions in one operation.

**Expected impact** — 1 batch insert instead of one insert per case

**Why the output is unchanged (the model's argument)** — This is equivalent only if create_execution() has no side effects beyond creating the same TestExecution row. The same rows, columns, NULL values, and duplicate behavior are preserved by bulk inserting the same field values. Row ordering is not guaranteed by the original code, so batching must not introduce any assumption about persisted order beyond what the database already provides.

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
CREATE INDEX/constraint is not required from the visible context.
```

**Assumptions**

- create_execution() does not send notifications or compute additional per-row state
- bulk_create is acceptable for this model and database backend in the project

**Evidence**

- `tcms/testruns/views.py:321` (call-site) — Shows repeated creation in the loop.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Avoid iterating every matched plan row in Python

`medium` · `full-scan` · `mysql` · ✅ verified

The code fetches every row matching `TestCasePlan.objects.filter(**query)` and then extracts only `case_id` and `sortkey`, which can be pushed into the database result set instead of model iteration.

**Where it is used**

- `tcms/rpc/api/testcase.py:782` in `sortkeys`
- Reached via request-handler

**Current**

```sql
result[str(record.case_id)] = record.sortkey
```

**Proposed**

```sql
rows = TestCasePlan.objects.filter(**query).values_list("case_id", "sortkey")
result = {str(case_id): sortkey for case_id, sortkey in rows}
```

**Why this helps** — `values_list()` asks the database to return just the needed columns, avoiding creation of full model objects for each matching row.

**Expected impact** — The database still produces the same matching rows, but Python receives only two columns per row instead of full ORM objects.

**Why the output is unchanged (the model's argument)** — This is equivalent only if each `case_id` appears at most once in the filtered queryset, because the original dict assignment silently keeps the last row for duplicate keys. The string conversion of keys is preserved, the columns returned to Python are the same logical values, but duplicate handling can change if duplicates exist, so the safe classification is behavioral unless uniqueness is guaranteed.

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
CREATE INDEX for the filter fields, if needed; the visible context does not show which fields `query` contains.
```

**Assumptions**

- `TestCasePlan` rows returned by `query` do not contain duplicate `case_id` values, or callers do not depend on last-write-wins behavior.
- No model property side effects are needed from instantiating `TestCasePlan` objects.

**Evidence**

- `tcms/rpc/api/testcase.py:782` (call-site) — Shows only `case_id` and `sortkey` are used from each row.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: ordering.

### Hoist status lookup out of the loop body

`medium` · `round-trip` · `mysql` · ✅ verified

This materializes all `TestExecutionStatus` rows into a dict once and reuses them, avoiding repeated ORM lookups for each iteration that uses `status_name`.

**Where it is used**

- `scripts/run_assetshare_cases.py:42` in `mark`
- Reached via unknown

**Current**

```sql
status = {s.name: s for s in TestExecutionStatus.objects.all()}
```

**Proposed**

```sql
status = TestExecutionStatus.objects.in_bulk(field_name="name")
```

**Why this helps** — This still loads the status rows once, but lets later code do direct key-based access without rebuilding or re-querying status objects.

**Expected impact** — 1 query instead of repeated status fetches if the code path otherwise looked up statuses multiple times.

**Why the output is unchanged (the model's argument)** — The mapping contains the same rows by `name`, with the same objects and no change to query filters, row order, NULL handling, duplicates, or error behavior for existing names. It does not change the result set of any database query; it only changes how the already-fetched rows are organized in memory.

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

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

**Requires this migration first**

```sql
CREATE UNIQUE INDEX if needed on the status name column before relying on key-based lookup by name.
```

**Assumptions**

- `name` is unique for `TestExecutionStatus`, or at least the caller only expects one row per name.
- All later accesses are by exact status name and expect a dict-like lookup.

**Evidence**

- `scripts/run_assetshare_cases.py:44` (call-site) — This function reuses the status mapping on every call, so preloading the statuses once avoids extra ORM work inside the workflow.

**Verification notes**

- The equivalence argument does not address: the column list.

### Aggregate executions directly from the run relation

`medium` · `round-trip` · `mysql` · ✅ verified

The view first materializes all run primary keys into Python and then feeds them back into a second query, creating an unnecessary round trip and in-memory id list.

**Where it is used**

- `tcms/testplans/views.py:380` in `TestPlanGetView.get_context_data`
- Reached via request-handler

**Current**

```sql
run_ids = list(
    TestRun.objects.filter(plan_id=self.object.pk).values_list("pk", flat=True)
)
exec_health = TestExecution.objects.filter(run__in=run_ids).aggregate(
```

**Proposed**

```sql
exec_health = TestExecution.objects.filter(run__plan_id=self.object.pk).aggregate(
    total=Count("pk"),
    passed=Count("pk", filter=Q(status__name="PASSED")),
    failed=Count("pk", filter=Q(status__name="FAILED")),
    blocked=Count("pk", filter=Q(status__name="BLOCKED")),
)
```

**Why this helps** — This keeps the filtering in SQL by joining from executions to runs directly, so the database can compute the aggregate without first shipping all run ids to Python.

**Expected impact** — Eliminates one Python materialization step and lets the database execute the aggregate from a single filtered join

**Why the output is unchanged (the model's argument)** — The rewritten query returns the same aggregate values over the same set of executions because `run__plan_id=self.object.pk` selects executions whose run belongs to the same plan as the original `run__in=run_ids`. It returns the same columns in the same order because the aggregate aliases are unchanged, and ordering is irrelevant because both versions return a single aggregate row. NULL handling and duplicates are preserved because `Count('pk')` over the same matching executions yields the same totals, and the filter on `status__name` is unchanged.

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

**Automated equivalence check** — Partly verified (django): The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- TestExecution.run is the relation used by `run__in=run_ids` and it links to TestRun with a `plan_id` field.
- `Count` and `Q` are already imported in this module.

**Evidence**

- `tcms/testplans/views.py:380` (call-site) — Shows the query pattern that first loads run ids into Python and then reuses them in a second ORM query.

**Verification notes**

- Same-output claim needs review — The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Add a group membership check index

`medium` · `missing-index` · `mysql` · ✅ verified

This lookup can be made to read a narrower access path by indexing the group name used to fetch the admin group, and the membership existence check can then use the group primary key already in hand.

**Where it is used**

- `tcms/kiwi_auth/sso.py:256` in `SSOEmailBackend._sync_bootstrap_admin`
- Reached via unknown

**Current**

```sql
admin_group = Group.objects.filter(name=ADMIN_GROUP).first()
```

**Proposed**

```sql
admin_group = Group.objects.filter(name=ADMIN_GROUP).only("pk").first()
```

**Why this helps** — The database can satisfy the lookup from the indexed name column and return only the primary key needed for the follow-up membership check.

**Expected impact** — One indexed group lookup plus a narrower row fetch instead of loading the full group row for the admin-group check.

**Why the output is unchanged (the model's argument)** — This keeps the same rows, columns, ordering, NULL handling, duplicates, and error behaviour: `.first()` still returns the first matching group or `None`, and the later `exists()` check still uses the same `admin_group.pk` when present. It does not change whether `user.groups.add(admin_group)` runs.

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

**Checked against the declared schema**

- No CREATE TABLE for auth_group was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [pk]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (first), so the shape of the result is the same.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [pk]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Requires this migration first**

```sql
CREATE INDEX idx_auth_group_name ON auth_group(name);
```

**Assumptions**

- `name` is the column used by `Group` for the admin group lookup, and there is no separate ordering requirement beyond Django's `.first()` semantics.
- The follow-up membership check can continue to use `admin_group.pk` without needing any other `Group` fields.

**Evidence**

- `tcms/core/migrations/0001_squashed.py:27` (model-definition) — Shows the code operates on Django auth groups/permissions and that the group lookup is part of bootstrap/admin provisioning.
- `tcms/kiwi_auth/sso.py:256` (call-site) — This is the exact lookup and membership existence check in the site under review.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [pk]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.

### Preload the field-config map in one query

`medium` · `round-trip` · `mysql` · ✅ verified

The config queryset is materialized into a dict and then consulted per custom field, but the current code still needs the full result set from the database for every active system-disabled matching config.

**Where it is used**

- `tcms/rpc/api/testrun.py:39` in `_save_custom_fields`
- Reached via request-handler

**Current**

```sql
configs = {
        config.field_key: config
        for config in TestRunFieldConfig.objects.filter(
            is_active=True, is_system=False, field_key__in=list(custom_fields)
        )
    }
```

**Proposed**

```sql
configs = dict(
        TestRunFieldConfig.objects.filter(
            is_active=True,
            is_system=False,
            field_key__in=list(custom_fields),
        ).values_list("field_key", "id")
    )
```

**Why this helps** — Fetching only the key/id pairs needed to build the lookup dictionary avoids instantiating full model objects for every matching config row.

**Expected impact** — The database still returns one result set, but the Python side receives narrower rows and avoids model construction.

**Why the output is unchanged (the model's argument)** — This is equivalent only if the later code uses the dict as a presence/lookup map and does not depend on any other `TestRunFieldConfig` fields or model methods. It preserves the same matching rows and duplicate handling for distinct `field_key` values, but it changes the object type stored in `configs`, so it is not equivalent if later code expects model instances.

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
- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)

**Checked against the declared schema**

- No CREATE TABLE for testrun_field_config was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [field_key, id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [field_key, id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Requires this migration first**

```sql
CREATE INDEX idx_testrunfieldconfig_lookup ON testrun_field_config(is_active, is_system, field_key);
```

**Assumptions**

- Later code only needs to know whether a config exists for a field key, or only needs the stored identifier.
- `field_key` is unique for the filtered rows, or duplicate keys are impossible in practice.

**Evidence**

- `tcms/rpc/api/testrun.py:39` (call-site) — Shows the queryset is immediately turned into a dictionary and then used for repeated lookups.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [field_key, id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: ordering.

### Remove the unconditional product load from the context processor

`medium` · `full-scan` · `mysql` · ✅ verified

This context processor materializes every Product row on each template render, even though templates may only need the selected stream or no stream data at all.

**Where it is used**

- `tcms/core/context_processors.py:31` in `stream_processor`
- Reached via unknown

**Current**

```sql
streams = list(Product.objects.order_by("name"))
```

**Proposed**

```sql
streams = Product.objects.order_by("name").only("id", "name")
```

**Why this helps** — This keeps the same ordered result set but avoids forcing every column on every Product row to be loaded eagerly.

**Expected impact** — Avoids loading all Product columns for every row; the database still returns the same ordered rows, but less data is transferred and less Python object state is populated.

**Why the output is unchanged (the model's argument)** — The queryset still returns the same Product rows in the same name ordering; column access is narrower but the query result object is the same. NULL handling, duplicates, and error behavior are unchanged because only the fetch strategy changes. If templates or downstream code rely on additional Product fields being present without extra queries, this would not be safe.

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
- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Requires this migration first**

```sql
CREATE INDEX is not required for this rewrite.
```

**Assumptions**

- Templates that consume 'streams' only need fields already selected by Django for ordering and display of product names, or can tolerate deferred loading of other fields.
- Product has no custom manager or queryset side effects that depend on list() materialization.

**Evidence**

- `tcms/core/context_processors.py:30` (call-site) — Shows the context processor eagerly materializes the full ordered Product queryset on every render.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.

### Create the execution once per property tuple

`low` · `n-plus-one` · `mysql` · ✅ verified

The loop creates a new execution for every property tuple and then inserts the tuple’s properties for that execution, so the work is repeated per tuple rather than reusing a single execution when the intent is to fan out properties.

**Where it is used**

- `tcms/testruns/models.py:165` in `TestRun`
- Reached via unknown

**Current**

```sql
execution = self._create_single_execution(
                    case, assignee, build, sortkey
                )
```

**Proposed**

```sql
execution = self._create_single_execution(case, assignee, build, sortkey)
                executions.append(execution)

                for prop_tuple in self.property_matrix(properties, matrix_type):
                    for prop in prop_tuple:
                        TestExecutionProperty.objects.create(
                            execution=execution, name=prop.name, value=prop.value
                        )
```

**Why this helps** — This avoids repeating the execution insert for every tuple and instead reuses one created row while still inserting the per-property rows.

**Expected impact** — Fewer execution inserts; property inserts remain one per property value, but the execution creation is no longer repeated inside the tuple loop.

**Why the output is unchanged (the model's argument)** — This is behavioural, not equivalent: it changes how many executions are created, so the returned rows and duplicates can differ; the original creates one execution per tuple, while the rewrite creates one execution and multiple property rows against it.

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

- The intended behaviour is one execution per case with multiple property rows attached; if each tuple is supposed to become a distinct execution, this rewrite is not safe.

**Evidence**

- `tcms/testruns/models.py:162` (call-site) — Shows the execution is created inside the property-matrix loop, which is the repeated work.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, ordering.
- Reported as an N+1, but the query is not inside a loop in the fetched source. One of those is wrong, and only one of them was checked.
- Severity is low, not the medium the model proposed: it is reported as an N+1, but the query is not inside a loop in the fetched source.

### Add a case-insensitive email index

`low` · `missing-index` · `mysql` · ✅ verified

This existence check can only use an index if the database has an index that matches the case-insensitive email predicate; otherwise it must scan users to answer the uniqueness check.

**Where it is used**

- `tcms/kiwi_auth/forms.py:27` in `validate_email_already_in_use`
- Reached via unknown

**Current**

```sql
if User.objects.filter(email__iexact=email.strip()).exists():
```

**Proposed**

```sql
if User.objects.filter(email__iexact=email.strip()).exists():
    raise forms.ValidationError(_("A user with that email already exists."))
```

**Why this helps** — No safe rewrite is available from the visible code alone; the performance issue is the absence of a visible supporting index for the case-insensitive email lookup.

**Expected impact** — Avoids a table scan for the email uniqueness probe when the index is selective enough to be useful.

**Why the output is unchanged (the model's argument)** — The proposed code is intentionally unchanged because any rewrite that altered the predicate, NULL handling, or duplicate handling would be behavioural. The finding is about indexing support for the same existence test, which would preserve rows, columns, ordering, NULLs, duplicates, and error behaviour.

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
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (exists), so the shape of the result is the same.
- The filter expressions are textually unchanged.

**Assumptions**

- A suitable index or generated/searchable normalized email column exists only if added outside the visible context.
- MySQL must be able to use an index for the case-insensitive comparison; without one, the lookup will scan matching rows.

**Evidence**

- `tcms/kiwi_auth/forms.py:27` (call-site) — Shows the case-insensitive existence check that needs an index to avoid scanning users.

**Verification notes**

- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Filter the access log before selecting related users

`low` · `inefficient-join` · `mysql` · ✅ verified

The queryset is built with `select_related("user")` before any optional filter, so the database may join user rows for the whole log even when a search term narrows the result later.

**Where it is used**

- `tcms/kiwi_auth/views.py:525` in `AccessLog.get`
- Reached via request-handler

**Current**

```sql
events = SSOLoginEvent.objects.select_related("user")
```

**Proposed**

```sql
events = SSOLoginEvent.objects.all()
        if query:
            events = events.filter(email__icontains=query)
        events = events.select_related("user")
```

**Why this helps** — Applying the filter first lets MySQL reduce the `SSOLoginEvent` rows before joining the related `user` table, so the join work is done on a smaller intermediate result.

**Expected impact** — The join against `user` happens only after the optional email filter narrows the base event rows.

**Why the output is unchanged (the model's argument)** — This is equivalent because it returns the same rows, columns, ordering, NULL handling, duplicates, and errors: queryset construction is lazy, and `select_related("user")` does not change the result set, only how related user data is fetched. Moving it after the optional filter preserves the same final queryset contents.

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

**Checked against the declared schema**

- No CREATE TABLE for kiwi_auth_ssologinevent was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Partly verified (django): Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX idx_ssologinevent_email ON kiwi_auth_ssologinevent(email);
```

**Assumptions**

- The template or later code still accesses `event.user`, so the related fetch is still needed.
- No code depends on the intermediate queryset object before the final `select_related("user")` call.

**Evidence**

- `tcms/kiwi_auth/views.py:524` (call-site) — Shows the queryset is created before the optional filter and then passed to rendering.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Use an exact-exists check on the normalized email

`low` · `other` · `mysql` · ✅ verified

This validation query uses `iexact` and then `exists()` to test for another user with the same email, which is the right shape for an index-backed existence check if the stored values are already normalized or the comparison is intentionally case-insensitive.

**Where it is used**

- `tcms/kiwi_auth/forms.py:170` in `ProfileForm.clean_email`
- Reached via unknown

**Current**

```sql
User.objects.filter(email__iexact=email)
            .exclude(pk=self.instance.pk)
            .exists()
```

**Proposed**

```sql
email = self.cleaned_data["email"].strip()
if email and User.objects.filter(email=email).exclude(pk=self.instance.pk).exists():
    raise forms.ValidationError(_("A user with that email already exists."))
return email
```

**Why this helps** — If emails are already stored in normalized form, this keeps the same existence check while allowing a simple equality predicate that can use a normal index lookup.

**Expected impact** — One indexed equality probe instead of a case-insensitive comparison that may be harder to optimize.

**Why the output is unchanged (the model's argument)** — This rewrite is only equivalent if the application guarantees stored emails are normalized to the same casing and whitespace rules as `clean_email`; otherwise it can match a different set of rows because `iexact` is case-insensitive while `=` is not. It returns the same boolean, same columns, and same ordering only for the existence test because `exists()` discards ordering; NULL handling and duplicate handling remain the same only under that normalization assumption.

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

**Automated equivalence check** — Partly verified (django): Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (exists), so the shape of the result is the same.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- User emails are stored in a canonical case/format before reaching this validation, or case-insensitive comparison is not required.
- There is an index on the email field or the database can use the existing one for equality.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is low, not the info the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Reuse the existing case lookup result

`low` · `round-trip` · `mysql` · ⚠️ needs verification

Avoid issuing a second ORM query for the same existing case ids by building the by-gid map from the rows already fetched.

**Where it is used**

- `tcms/core/admin_views.py:959` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
existing_cases_by_gid = {
            c.global_id: c
            for c in TestCase.objects.filter(global_id__in=existing_case_gids)
        }
```

**Proposed**

```sql
existing_cases_by_gid = {
            c.global_id: c
            for c in existing_case_gids
        }
```

**Why this helps** — The code already materializes the existing case ids in the prior query, so this change should build the lookup from that in-memory result instead of asking the database for the same rows again.

**Expected impact** — Removes one database round trip in the import path if the preceding query is adjusted to supply the needed objects.

**Why the output is unchanged (the model's argument)** — This is only equivalent if existing_case_gids is a collection of TestCase objects rather than integers; as written in the surrounding code it is a set of global_id values, so the proposed rewrite would change behavior and is therefore not safe unless the first query is changed to return objects instead of ids. Because of that, no equivalent rewrite can be proven from the shown code alone.

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
ALTER TABLE <testcase_table> ADD INDEX (global_id);
```

**Assumptions**

- A safe rewrite would need the first query to return TestCase objects, not just ids.

**Evidence**

- `tcms/core/admin_views.py:959` (call-site) — This is the second query over the same global ids, which is the extra round trip.

**Verification notes**

- Evidence quote was not found in tcms/core/admin_views.py.
- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned, the column list, ordering, NULL or duplicate handling.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Materialize section lookups by global id

`low` · `missing-index` · `mysql` · ⚠️ needs verification

The code already uses a single filtered query to fetch matching sections by global_id, so the triage as a missing-index issue is not supported by the visible code alone.

**Where it is used**

- `tcms/core/admin_views.py:911` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
{s.global_id: s
            for s in Section.objects.filter(global_id__in=existing_sec_gids)}
```

**Proposed**

```sql
{}
```

**Why this helps** — No safe performance finding can be grounded from the provided context: the schema for Section and any indexes on global_id are not shown, so a missing-index claim cannot be proven.

**Expected impact** — Unknown from the provided context.

**Why the output is unchanged (the model's argument)** — Not applicable because this site is not confirmed to have the triaged problem from the visible evidence.

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

- A Section model definition and its indexes would be needed to evaluate whether global_id__in can use an index effectively.

**Evidence**

- `tcms/core/admin_views.py:911` (call-site) — This is the only visible query; without the Section schema or index definitions, a missing-index diagnosis cannot be established.

**Verification notes**

- The quoted original query was not found verbatim in the cited file.
- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned, the column list, ordering, NULL or duplicate handling.
- Severity is low, not the info the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

## Behaviour changes and bugs

**These change what the query returns.** They are listed separately on purpose — review each on its merits.

### Prefetch executed case ids by section once

`high` · `n-plus-one` · `mysql` · ✅ verified

Inside the section loop, the code issues two count queries per section, so the database repeatedly checks the same section-specific test cases instead of grouping once.

**Where it is used**

- `tcms/core/views.py:877` in `CoverageReportView.get`
- Reached via request-handler

**Current**

```sql
for sec in Section.objects.filter(product=stream).order_by("name"):
            sc_total = TestCase.objects.filter(section=sec).count()
            if not sc_total:
                continue
            sc_executed = TestCase.objects.filter(
                section=sec, pk__in=executed_case_ids
            ).count()
```

**Proposed**

```sql
section_rows = (
            TestCase.objects.filter(section__product=stream)
            .values("section_id", "section__name")
            .annotate(
                sc_total=Count("pk"),
                sc_executed=Count("pk", filter=Q(pk__in=executed_case_ids)),
            )
            .order_by("section__name")
        )
        for row in section_rows:
            if not row["sc_total"]:
                continue
            sec = Section.objects.get(pk=row["section_id"])
            sc_total = row["sc_total"]
            sc_executed = row["sc_executed"]
```

**Why this helps** — This reduces repeated per-section counting by letting the database compute section totals and executed counts in one grouped query.

**Expected impact** — Fewer queries while iterating sections

**Why the output is unchanged (the model's argument)** — This preserves the same sections after the explicit name ordering and keeps the same count semantics for each section. It would still be behavioural if Section.objects.get(pk=...) is not acceptable because it adds extra lookups; a fully equivalent rewrite would need to carry the section object through the grouping query without changing the returned rows, columns, ordering, NULL handling, or duplicates.

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

- Issues 1 database call(s) where the original issues 3. (Counted from the code, not measured.)
- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).

Differences found:

- Ordering changes from ["name"] to ["section__name"].
- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section_id, section__name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- Count and Q are imported.
- A rewrite that preserves the Section object can be expressed in the surrounding view code without changing the response shape.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section_id, section__name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Batch user deactivation in the database layer

`medium` · `batching` · `mysql` · ✅ verified

This loop deactivates each matched user one at a time, causing per-user write work instead of letting the database update all matching rows in a single statement.

**Where it is used**

- `tcms/rpc/api/user.py:172` in `deactivate`
- Reached via request-handler

**Current**

```sql
for user in User.objects.filter(**query):
```

**Proposed**

```sql
users = list(User.objects.filter(**query))
User.objects.filter(pk__in=[user.pk for user in users]).update(is_active=False)
result = [_get_user_dict(user) for user in users]
```

**Why this helps** — This turns many individual writes into one set-based update, so the database updates all matching rows together instead of performing separate save logic per user.

**Expected impact** — One set-based update instead of one deactivation write per matched user, plus one read to collect the users for the response.

**Why the output is unchanged (the model's argument)** — This is only equivalent if `user_utils.deactivate(user)` does nothing beyond setting the same persisted active flag that `update(is_active=False)` changes. If `deactivate()` has side effects, touches related rows, emits signals, or changes more fields, the rewrite is behavioral. The returned list contents and ordering are preserved only if `list(User.objects.filter(**query))` yields the same iteration order as the original loop, which Django does for a queryset without an explicit order only in the same unspecified sense as before.

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

Differences found:

- One version writes and the other does not (proposal writes), which is not an output-preserving change.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `user_utils.deactivate(user)` is equivalent to setting `is_active=False` on the user row, with no extra side effects required.
- The caller does not depend on model save hooks, signals, or timestamps from per-object deactivation.

**Evidence**

- `tcms/rpc/api/user.py:178` (call-site) — Shows each matching user is handled individually inside the loop.

**Verification notes**

- Reclassified as behaviour-changing: One version writes and the other does not (proposal writes), which is not an output-preserving change.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: NULL or duplicate handling.
- Severity is medium, not the high the model proposed: 2 structural fact(s) were counted from the two versions.

### Reuse the sibling queryset for the existence checks

`medium` · `round-trip` · `mysql` · ✅ verified

The function builds one base queryset but then issues repeated sibling-existence probes against it; combining the checks into one database call would avoid multiple round trips while preserving the same chosen name when the logic is unchanged.

**Where it is used**

- `tcms/testcases/views.py:1073` in `_unique_section_name`
- Reached via request-handler

**Current**

```sql
siblings = Section.objects.filter(product=product, parent=parent)

    if not siblings.filter(name=desired_name).exists():
        return desired_name

    base = f"{desired_name} (copy)"
    if not siblings.filter(name=base).exists():
```

**Proposed**

```sql
siblings = Section.objects.filter(product=product, parent=parent)

    candidate_names = {desired_name, f"{desired_name} (copy)"}
    existing_names = set(siblings.filter(name__in=candidate_names).values_list("name", flat=True))

    if desired_name not in existing_names:
        return desired_name

    base = f"{desired_name} (copy)"
    if base not in existing_names:
```

**Why this helps** — This lets the database answer both existence checks in one query instead of probing siblings separately for each candidate name.

**Expected impact** — 2 existence probes become 1 batched lookup

**Why the output is unchanged (the model's argument)** — It returns the same string for every input because it checks the same candidate names against the same sibling set, with the same equality semantics and no change to ordering, NULL handling, duplicates, or errors; only the number of database calls changes.

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

- Issues no database call within the code shown, where the original issues 2. Whether the work moved or disappeared is not decidable from this excerpt. (Counted, not measured.)
- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [exists] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [exists] to [none], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [name, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX is not required because the code already filters on product, parent, and name; any benefit depends on existing selectivity.
```

**Assumptions**

- The intended logic is limited to these two existence checks and the remaining fallback branches continue to use the same sibling scope.
- Section.name comparison semantics remain exact string equality under the database collation in use.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [none], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [name, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned, the column list.
- Severity is medium, not the low the model proposed: 2 structural fact(s) were counted from the two versions.

### Fold the three case-type counts into one aggregate

`medium` · `full-scan` · `mysql` · ✅ verified

The view issues three separate count queries over the same product-scoped TestCase set, so the database scans the same filtered rows three times instead of once.

**Where it is used**

- `tcms/core/views.py:512` in `StreamDashboardView.get`
- Reached via request-handler

**Current**

```sql
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
case_counts = TestCase.objects.filter(section__product=stream).aggregate(
    sanity_count=Count("pk", filter=Q(is_sanity=True)),
    regression_count=Count("pk", filter=Q(is_regression=True)),
    automated_count=Count("pk", filter=Q(is_automated=True)),
)
sanity_count = case_counts["sanity_count"]
regression_count = case_counts["regression_count"]
automated_count = case_counts["automated_count"]
```

**Why this helps** — This asks the ORM for all three counts in one grouped aggregate, so MySQL can evaluate the shared filter once instead of issuing three separate count queries.

**Expected impact** — 1 aggregate query instead of 3 separate count queries

**Why the output is unchanged (the model's argument)** — The rewritten code returns the same three scalar counts, with the same names and null handling via the aggregate results; it does not change the row set, row ordering, or duplicate handling because both versions only compute counts over the same filtered TestCase rows, and no ordering is involved.

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

- Issues 1 database call(s) where the original issues 3. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- django.db.models.Count and Q are already imported in this module.
- The dashboard only needs these counts as separate numbers, not as individual query objects.

**Evidence**

- `tcms/core/views.py:512` (call-site) — Shows three separate count queries against the same product-scoped TestCase relation.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is medium, not the low the model proposed: 1 structural fact(s) were counted from the two versions.

### Add a supporting permission index before this lookup

`medium` · `missing-index` · `mysql` · ✅ verified

This `Permission.objects.get(...)` lookup can only be made faster with an index on the permission columns, but the visible schema does not show one for `content_type` plus `codename`.

**Where it is used**

- `tcms/kiwi_auth/admin.py:236` in `KiwiUserAdmin.delete_view`
- Reached via unknown

**Current**

```sql
permission = Permission.objects.get(
            content_type__app_label="auth", codename="delete_user"
        )
```

**Proposed**

```sql
permission = Permission.objects.select_related("content_type").get(
            content_type__app_label="auth", codename="delete_user"
        )
```

**Why this helps** — This avoids an extra fetch of the related content type row after the permission is found.

**Expected impact** — 1 fewer query when the related content type is accessed

**Why the output is unchanged (the model's argument)** — It returns the same single Permission row, with the same columns needed by the code path, and does not change matching, NULL handling, duplicates, or ordering; it only changes how the related row is loaded.

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

- Adds eager loading (select_related), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Checked against the declared schema**

- No CREATE TABLE for auth_permission was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.
- The filter expressions are textually unchanged.

**Requires this migration first**

```sql
CREATE INDEX idx_permission_content_type_codename ON auth_permission (content_type_id, codename);
```

**Assumptions**

- `Permission` has a `content_type` foreign key, which is implied by the lookup.
- The caller does not depend on lazy-loading `content_type` later as a separate query.

**Evidence**

- `tcms/kiwi_auth/admin.py:236` (call-site) — Shows the exact permission lookup that relies on filtering by permission metadata.

### Combine the coverage counts into fewer queries

`low` · `n-plus-one` · `mysql` · ✅ verified

This view runs several independent count queries for the same product, so the database repeatedly rescans the matching TestCase rows instead of aggregating them in one pass.

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
            total_cases=Count("pk"),
            sanity_count=Count("pk", filter=Q(is_sanity=True)),
            regression_count=Count("pk", filter=Q(is_regression=True)),
            automated_count=Count("pk", filter=Q(is_automated=True)),
        )
        total_cases = counts["total_cases"]
        sanity_count = counts["sanity_count"]
        regression_count = counts["regression_count"]
        automated_count = counts["automated_count"]
```

**Why this helps** — This lets MySQL evaluate the product filter once and compute all four counts in a single aggregation instead of issuing separate count queries.

**Expected impact** — 1 aggregated query instead of 4 separate count queries

**Why the output is unchanged (the model's argument)** — The rewritten code returns the same four numeric values for the same underlying rows, with the same columns used in the surrounding Python code and no change to ordering, NULL handling, or duplicates. It is only equivalent if Django's filtered aggregates are available in this codebase and the same TestCase rows are counted by each predicate.

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

**Assumptions**

- Count and Q are imported from django.db.models in this module.
- The database supports Django filtered aggregates on this project’s MySQL version.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Reported as an N+1, but the query is not inside a loop in the fetched source. One of those is wrong, and only one of them was checked.
- Severity is low, not the medium the model proposed: it is reported as an N+1, but the query is not inside a loop in the fetched source.

### Replace the superuser count with an existence-style check

`low` · `full-scan` · `mysql` · ✅ verified

The delete guard counts all superusers to see whether exactly one remains, which makes the database enumerate the full matching set instead of stopping after the second match.

**Where it is used**

- `tcms/kiwi_auth/admin.py:220` in `KiwiUserAdmin.delete_view`
- Reached via unknown

**Current**

```sql
if user.is_superuser and User.objects.filter(is_superuser=True).count() == 1:
```

**Proposed**

```sql
if user.is_superuser and not User.objects.filter(is_superuser=True).exclude(pk=user.pk).exists():
```

**Why this helps** — Using an existence check lets the database stop as soon as it finds another superuser, instead of counting every matching row.

**Expected impact** — One early-exiting existence probe instead of counting all superusers

**Why the output is unchanged (the model's argument)** — This is behaviourally equivalent for the intended guard: it returns the same boolean decision about whether deleting the current superuser would leave zero superusers. It does not change the deleted user lookup, output columns, ordering, NULL handling, or duplicates. The only semantic difference is that it checks for any other superuser rather than counting exactly one after excluding the current row, so it preserves the same visible control flow for all states where the current code is correct.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [exists], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [exists], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- It is acceptable to treat any other superuser as meaning the last superuser is being deleted.
- User.pk is the same identity used by the earlier get(pk=object_id) call.

**Evidence**

- `tcms/kiwi_auth/admin.py:220` (call-site) — Shows the delete path performs a full count to test for the last superuser.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [exists], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Replace the count with an existence probe

`low` · `full-scan` · `mysql` · ✅ verified

This code counts all superusers just to test whether any exist, so the database does more work than necessary.

**Where it is used**

- `tcms/kiwi_auth/forms.py:80` in `RegistrationForm.save`
- Reached via unknown

**Current**

```sql
if User.objects.filter(is_superuser=True).count() == 0:
```

**Proposed**

```sql
if not User.objects.filter(is_superuser=True).exists():
    user.is_superuser = True
    user.is_active = True
```

**Why this helps** — `exists()` can stop at the first matching row, while `count()` must visit every matching superuser row to compute the total.

**Expected impact** — One existence check instead of counting every matching row.

**Why the output is unchanged (the model's argument)** — This is equivalent for all database states: both forms branch only on whether the filtered set is empty. They return the same boolean condition, do not change rows, columns, ordering, NULL handling, duplicate handling, or error behaviour.

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

**Checked against the declared schema**

- No CREATE TABLE for auth_user was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [exists], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- The terminal operation changes from [count] to [exists], which changes what the call returns.

**Requires this migration first**

```sql
CREATE INDEX idx_user_is_superuser ON auth_user (is_superuser);
```

**Assumptions**

- The intent is only to detect whether at least one superuser exists, not to use the exact count for anything else.

**Evidence**

- `tcms/kiwi_auth/forms.py:80` (call-site) — Shows the count-based emptiness test inside registration.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [exists], which changes what the call returns.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Add an index for the username lookup

`low` · `missing-index` · `mysql` · ✅ verified

The case-insensitive username probe can only avoid scanning users if there is an index that supports the `username__iexact` predicate.

**Where it is used**

- `tcms/kiwi_auth/sso.py:210` in `SSOEmailBackend._get_or_create`
- Reached via unknown

**Current**

```sql
existing = user_model.objects.filter(username__iexact=email).first()
```

**Proposed**

```sql
existing = user_model.objects.filter(username__iexact=email).first()
if existing is not None:
    if not existing.email:
        existing.email = email
        existing.save(update_fields=["email"])
    return existing, False
```

**Why this helps** — No safe code rewrite is visible from the context; the performance issue is the lookup pattern itself, which needs index support to avoid scanning users for a case-insensitive username match.

**Expected impact** — Avoids a scan for the legacy-account lookup when the predicate is selective enough to use the index.

**Why the output is unchanged (the model's argument)** — The proposed code is intentionally unchanged because changing the predicate or the fallback behaviour could alter which row is returned or when `email` is backfilled. The finding is about index support for the same query, so the result set, columns, ordering, NULL handling, duplicates, and errors remain the same.

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

**Automated equivalence check** — Contradicted: One version writes and the other does not (proposal writes), which is not an output-preserving change.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (first), so the shape of the result is the same.
- The filter expressions are textually unchanged.

Differences found:

- One version writes and the other does not (proposal writes), which is not an output-preserving change.

**Assumptions**

- A matching index on username, or a normalized case-insensitive search column, is available only if added separately.
- MySQL can exploit the index for the case-insensitive comparison if the collation/index definition supports it.

**Evidence**

- `tcms/kiwi_auth/sso.py:210` (call-site) — Shows the case-insensitive username lookup used to find an existing account.

**Verification notes**

- Reclassified as behaviour-changing: One version writes and the other does not (proposal writes), which is not an output-preserving change.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Enforce sibling-section uniqueness in the database

`low` · `missing-index` · `mysql` · ✅ verified

This validation does a separate existence lookup for a Section with the same product, parent, and name; a matching unique constraint or index would let the database answer that check directly instead of scanning candidate rows.

**Where it is used**

- `tcms/testcases/models.py:321` in `Section._validate_unique_name`
- Reached via unknown

**Current**

```sql
siblings = Section.objects.filter(
            product_id=self.product_id, parent_id=self.parent_id, name=self.name
        )
```

**Proposed**

```sql
siblings = Section.objects.filter(
            product_id=self.product_id, parent_id=self.parent_id, name=self.name
        )
        if self.pk:
            siblings = siblings.exclude(pk=self.pk)

        if siblings.exists():
            raise ValidationError({"name": "Section name must be unique within its parent and product."})
```

**Why this helps** — The query shape is already a point lookup on three fields, so the database can use a composite uniqueness/index path to evaluate the existence check without inspecting unrelated rows.

**Expected impact** — The existence check can use an indexed point lookup instead of evaluating a broader candidate set.

**Why the output is unchanged (the model's argument)** — This keeps the same filter predicates, the same excluded self row, the same boolean existence test, and the same error behavior; it does not change returned rows, columns, ordering, NULL handling, or duplicates because it is the same ORM query logic. The only safe improvement here would be a matching database constraint or composite index, which preserves query results while changing how the lookup is executed.

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

**Checked against the declared schema**

- No CREATE TABLE for tcms_testcases_section was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [none] to [exists], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [none] to [exists], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX section_product_parent_name_idx ON tcms_testcases_section (product_id, parent_id, name);
```

**Assumptions**

- A composite uniqueness constraint or composite index on (product_id, parent_id, name) can be added without violating existing data.
- The goal is to optimize the validation path; no application-visible behavior change is intended.

**Evidence**

- `tcms/testcases/models.py:321` (schema) — Shows the exact validation query that performs the sibling uniqueness check.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [none] to [exists], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is low, not the medium the model proposed: it concerns an index, whose cost is paid on every write for as long as it exists.

### Batch section fallback lookups

`info` · `round-trip` · `mysql` · ✅ verified

The migration scans all test cases and, for rows without a cached category mapping, performs per-row category and section lookups instead of resolving those fallbacks in bulk.

**Where it is used**

- `tcms/testcases/migrations/0025_add_section.py:41` in `create_sections_from_categories`
- Reached via migration

**Current**

```sql
for tc in TestCase.objects.all():
        sid = cat_to_section.get(tc.category_id)
        if sid is None:
            # Fallback: pick any section for this case's product
            cat = Category.objects.filter(pk=tc.category_id).first()
            if cat:
                sec = Section.objects.filter(product_id=cat.product_id).first()
```

**Proposed**

```sql
testcase_rows = list(TestCase.objects.all().values_list('id', 'category_id'))
missing_category_ids = {category_id for _, category_id in testcase_rows if category_id not in cat_to_section}
category_by_id = {c.pk: c for c in Category.objects.filter(pk__in=missing_category_ids)}
section_by_product_id = {
    product_id: section
    for section in Section.objects.filter(product_id__in={c.product_id for c in category_by_id.values()})
}
for tc_id, category_id in testcase_rows:
    sid = cat_to_section.get(category_id)
    if sid is None:
        cat = category_by_id.get(category_id)
        if cat:
            sec = section_by_product_id.get(cat.product_id)
```

**Why this helps** — This turns the per-test-case fallback into set-based lookups: one query to fetch the missing categories and one query to fetch candidate sections, then Python dictionary access inside the loop.

**Expected impact** — Fewer database round trips in the migration loop: one set-based fetch for missing categories and one set-based fetch for related sections instead of repeated per-row lookups.

**Why the output is unchanged (the model's argument)** — The rewritten code still iterates the same test cases and chooses the same section candidate for each case when the fallback path is needed; it does not change returned rows, columns, ordering, NULL handling, or duplicate handling because it only replaces repeated point lookups with cached results. If Section.objects.filter(product_id=...).first() depended on an implicit database ordering, that behavior must be preserved by keeping the same 'first' semantics on the fetched set.

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
- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [get, first] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The row limit changes from 1 to none.
- The terminal operation changes from [get, first] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id, category_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The fallback path is only using category_id and product_id, so prefetching the referenced rows in bulk is safe.
- Any implicit ordering used by .first() is either unspecified or can be preserved by applying the same ordering in the bulk-fetched section set.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [get, first] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [id, category_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- This code is reached by a migration or seed, so it runs once at install time or never in production.
- Severity is info, not the medium the model proposed: this code is reached by a migration or seed, so it runs once at install time or never in production.

### Fetch both configs in one query

`info` · `n-plus-one` · `mysql` · ✅ verified

The test performs the same lookup twice inside a fixed two-item loop, so it can be collapsed into one queryset fetch for both keys.

**Where it is used**

- `tcms/testcases/tests/test_epic_task_sections.py:1489` in `FieldConfigTestCase.test_both_new_fields_are_registered_and_active`
- Reached via test

**Current**

```sql
config = TestCaseFieldConfig.objects.get(field_key=key)
```

**Proposed**

```sql
configs = {
    cfg.field_key: cfg
    for cfg in TestCaseFieldConfig.objects.filter(field_key__in=("testrail_case_id", "mobile_yaml"))
}
for key in ("testrail_case_id", "mobile_yaml"):
    config = configs[key]
```

**Why this helps** — This replaces repeated primary-key-equivalent lookups with one filtered query and in-Python dispatch over the two returned rows.

**Expected impact** — 1 query instead of 2 individual lookups.

**Why the output is unchanged (the model's argument)** — It returns the same two model instances for the same keys, with the same fields on each object; ordering is unchanged because the test still iterates the same key tuple, and duplicates are impossible because each key is distinct. NULL handling is unchanged because the field lookup is exact. The rewrite is equivalent only if both rows exist; if either is missing, the original raises DoesNotExist on that iteration, while the rewrite would need to preserve that error behavior explicitly.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [get] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [get] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- Both field_key values exist exactly once.
- The test only needs these two rows and not per-iteration database exceptions.

**Evidence**

- `tcms/testcases/tests/test_epic_task_sections.py:1488` (call-site) — Shows the same ORM get is executed once per loop iteration.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [get] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- This code is reached by a test, so it runs once at install time or never in production.
- Severity is info, not the low the model proposed: this code is reached by a test, so it runs once at install time or never in production.

## Suppressed before publication

23 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### wrong direction (proposal issues no fewer queries) — 12

- **Aggregate executions in one grouped query** — `tcms/core/views.py:160`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Push the deterministic ordering into the migration query** — `tcms/testcases/migrations/0036_migrate_testrail_id_custom_field.py:56`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Load permission rows in batches** — `tcms/tests/__init__.py:390`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Preload cloned runs with their executions** — `tcms/testplans/views.py:451`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Cache tester lookups by username** — `tcms/core/admin_views.py:1055`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Cache assignee lookups by username** — `tcms/core/admin_views.py:1081`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch custom-field persistence by reusing the field queryset** — `tcms/testcases/views.py:189`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Resolve selected tags in bulk before attaching them** — `tcms/testcases/views.py:281`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse priority lookups across CSV rows** — `tcms/testcases/views.py:756`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Precompute active runs for all streams** — `tcms/core/views.py:154`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch active runs before aggregating executions** — `tcms/core/views.py:566`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Process candidates in one queryset update** — `tcms/kiwi_auth/management/commands/backfill_user_names.py:40`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)

### no-op (proposal identical to the original) — 6

- **Add a composite index for root-section lookups** — `tcms/testcases/models.py:929`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add an index-backed uniqueness check for field_key** — `tcms/core/admin_views.py:166`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add an index-backed duplicate-name check for tags** — `tcms/core/admin_views.py:259`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add a uniqueness constraint for execution source names** — `tcms/core/admin_views.py:329`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add a uniqueness constraint for priority values** — `tcms/core/admin_views.py:400`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add a uniqueness constraint for product names** — `tcms/core/admin_views.py:483`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

### not data access — 3

- **Batch execution cloning from the source run** — `tcms/testplans/views.py:479`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Batch testcase cloning and linking** — `tcms/testplans/models.py:165`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Use a bulk clone path for plan cases** — `tcms/testplans/models.py:161`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.

### cold path (migration, seed or test) — 1

- **Reuse the created Priority instance instead of reloading it** — `tcms/rpc/tests/test_priority.py:55`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.

### immaterial (a column narrowing on a query that runs once) — 1

- **Reuse the filtered queryset for both counts** — `tcms/telemetry/api.py:28`
  The only thing counted here is a narrower column list (Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)), on a query that does not run per iteration and is not unbounded. That is a real saving and a small one; publishing it beside a per-request N+1 costs the reader more attention than it returns.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._