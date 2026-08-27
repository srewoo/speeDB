# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 2:56:30 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 871 analysed · 2 filtered (below confidence 0 · low priority 2) · 33 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Triage** 869 site(s) triaged · 52 flagged · 0 unsure · 817 clean (6% sent for write-up)  
**Triage gaps** 2 site(s) came back from triage with no verdict and were escalated to a full write-up rather than assumed clean. That is the safe direction, but a scan with many of them is one whose triage stage is not answering reliably.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 27 published · 17 suppressed

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
| high | 3 | 7 |
| medium | 7 | 1 |
| low | 7 | 2 |
| info | 0 | 0 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Collapse per-stream queries into grouped aggregates

`high` · `round-trip` · `mysql` · ✅ verified

This dashboard code runs separate run and execution queries for every product stream, which repeats the same database work inside the product loop.

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
            agg = TestExecution.objects.filter(run__in=active_run_ids).aggregate(
                total=Count("pk"), **exec_count_annotations()
            )
```

**Proposed**

```sql
stream_stats = list(
    Product.objects.order_by("name").annotate(
        total=Count("testrun__testexecution", filter=Q(testrun__stop_date__isnull=True)),
        **exec_count_annotations_for_streams()
    )
)
```

**Why this helps** — Let the database compute the per-stream counts with grouped joins instead of issuing a run query and an execution aggregate for each product.

**Expected impact** — Multiple per-product queries replaced by grouped database aggregation

**Why the output is unchanged (the model's argument)** — This can be equivalent if it preserves the same product rows, the same ordering by Product.name, and the same per-stream counts. It must also preserve NULL handling for stop_date__isnull=True and any duplicate semantics from joins. Because the rewritten form changes the shape of the query and the grouping behavior, it is only equivalent if the annotations are constructed to return exactly one result row per product with the same columns the view consumes.

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

**Checked against the declared schema**

- No CREATE TABLE for tcms_testrun was found in the scanned files, so its columns could not be checked.

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
CREATE INDEX `tcms_testrun_plan_id_stop_date_idx` ON `tcms_testrun` (`plan_id`, `stop_date`)
```

**Assumptions**

- The view only needs per-product aggregates and does not rely on the intermediate active_run_ids list.
- The related names and joins used in the annotation helper match the existing schema.
- Any duplicates introduced by joins are accounted for the same way as the current TestExecution.filter(run__in=active_run_ids).aggregate(...) path.

**Evidence**

- `tcms/core/views.py:154` (call-site) — Shows the repeated per-stream run lookup and execution aggregation inside the product loop.

**Verification notes**

- Same-output claim needs review — The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Materialize the queryset once before building the mapping

`high` · `full-scan` · `mysql` · ✅ verified

The loop walks the filtered `TestCasePlan` queryset row by row and issues whatever work Django needs to stream those rows, so collecting the rows first avoids repeated iterator overhead while preserving the same result mapping.

**Where it is used**

- `tcms/rpc/api/testcase.py:782` in `sortkeys`
- Reached via request-handler

**Current**

```sql
for record in TestCasePlan.objects.filter(**query):
```

**Proposed**

```sql
records = list(TestCasePlan.objects.filter(**query))
result = {}
for record in records:
    # NOTE: convert to str() otherwise we get:
    # Unable to serialize result as valid XML: dictionary key must be string
    result[str(record.case_id)] = record.sortkey
```

**Why this helps** — This keeps the same filter and the same `result[str(record.case_id)] = record.sortkey` logic, but makes the database access happen as one queryset evaluation instead of relying on implicit streaming during the loop.

**Expected impact** — 1 queryset evaluation instead of incremental iteration over the queryset object

**Why the output is unchanged (the model's argument)** — It returns the same keys and values because the same queryset is evaluated with the same filter; the same columns are read from each row; ordering is unchanged because the original queryset has no explicit ordering guarantee; NULL handling and duplicate handling are unchanged because the same assignment into `result` is used; error behavior is unchanged for the same inputs because the same rows are fetched and processed.

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

- Evaluates the queryset once and reuses the result, where the original re-runs it on each use. (Counted from the code, not measured.)

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

**Assumptions**

- `TestCasePlan.objects.filter(**query)` is the only database access in this block.
- The caller does not depend on lazy iteration side effects from the queryset object itself.

**Verification notes**

- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Push the loop-level aggregation into the database

`high` · `full-scan` · `mysql` · ✅ verified

This code iterates every matching TestExecution row in Python and can be rewritten to let the database group and count the executions instead of materializing them one by one.

**Where it is used**

- `tcms/telemetry/api.py:134` in `execution_trends`
- Reached via request-handler

**Current**

```sql
TestExecution.objects.filter(**query)
        .select_related("status")
        .order_by("run_id")
```

**Proposed**

```sql
from django.db.models import Count

counts = (
    TestExecution.objects.filter(**query)
    .values("status__weight")
    .annotate(total=Count("id"))
)
```

**Why this helps** — Grouping by status weight lets MySQL aggregate the matching executions instead of sending every row to Python for counting.

**Expected impact** — The database can compute the counters directly instead of shipping every matching execution row to Python.

**Why the output is unchanged (the model's argument)** — This is only equivalent if the caller needs just the positive/negative/neutral totals and not the per-row iteration order or any other fields. It preserves which executions contribute to each bucket, but it changes the result shape from row iteration to aggregated rows, so it is not equivalent in the strict sense unless the surrounding code is also rewritten to consume the grouped counts. NULL handling, duplicate handling, and row ordering therefore differ from the original iteration.

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
- Replaces an ordered scan and fetch with a single Count aggregate, so the database no longer has to order the rows to return one value. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): Ordering ["run_id"] is removed. Row order is no longer guaranteed.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- The filter expressions are textually unchanged.

Differences found:

- Ordering ["run_id"] is removed. Row order is no longer guaranteed.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [status__weight]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- The surrounding code can be changed to consume aggregated counts rather than individual TestExecution objects.
- The only required output is the three counters shown in the local accumulator.

**Evidence**

- `tcms/telemetry/api.py:134` (call-site) — Shows the queryset is fully iterated in Python inside the trend endpoint.

**Verification notes**

- Same-output claim needs review — Ordering ["run_id"] is removed. Row order is no longer guaranteed.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [status__weight]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.

### Reuse a single username lookup for each imported run

`medium` · `round-trip` · `mysql` · ✅ verified

The import path does a username filter inside the run-processing loop, so each imported run can trigger an extra ORM query before creating the TestRun.

**Where it is used**

- `tcms/core/admin_views.py:1055` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
user_model.objects.filter(username=tester_name).first()
```

**Proposed**

```sql
tester = request.user if not tester_name else tester_by_username.get(tester_name, request.user)
```

**Why this helps** — Look up the imported tester usernames once outside the loop, then reuse the in-memory mapping instead of issuing a query for every run.

**Expected impact** — 1 query per distinct tester username instead of 1 query per imported run

**Why the output is unchanged (the model's argument)** — This preserves the same chosen tester for every imported run: when tester_name is empty it still returns request.user, and when it is present it still falls back to request.user if no matching user exists. It returns the same object type and does not change row selection, ordering, NULL handling, duplicates, or error behavior for the run import itself; the only assumption is that the username-to-user mapping is built from the same `User` rows the original query would search.

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

- Build `tester_by_username` once before the loop from all relevant `User` rows, keyed by username.
- `username` remains the lookup key used by the import format.

**Evidence**

- `tcms/core/admin_views.py:1049` (call-site) — Shows the lookup sits inside the loop that processes imported runs.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.

### Resolve assignees in bulk before iterating executions

`medium` · `round-trip` · `mysql` · ✅ verified

The execution import path performs a username filter for each execution row, which creates an extra ORM query per row when many executions are imported.

**Where it is used**

- `tcms/core/admin_views.py:1075` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
user_model.objects.filter(username=assignee_name).first()
```

**Proposed**

```sql
assignee = assignee_by_username.get(assignee_name) if assignee_name else None
```

**Why this helps** — Prefetch all assignee users once and reuse them during execution creation, avoiding one ORM lookup per execution row.

**Expected impact** — 1 query per distinct assignee username instead of 1 query per execution row

**Why the output is unchanged (the model's argument)** — This keeps the same assignee semantics: empty input still yields None, and a non-empty username still yields the matching user or None if no such user exists. It does not change the created executions, their ordering, duplicate handling, or NULL handling; the only assumption is that the bulk lookup is built from the same `User` table and uses exact username matching like the original query.

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

- Build `assignee_by_username` before the execution loop from the relevant `User` rows.
- Assignee usernames are matched by exact equality, as in the original filter.

**Evidence**

- `tcms/core/admin_views.py:1075` (call-site) — Shows the username lookup is done inside the inner execution loop.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned, the column list.

### Fetch the latest execution once per product stream

`medium` · `round-trip` · `mysql` · ✅ verified

The dashboard computes the latest finished execution with an ordered query inside the stream loop, so it repeats the same pattern for every stream.

**Where it is used**

- `tcms/core/views.py:176` in `DashboardView.get_context_data`
- Reached via request-handler

**Current**

```sql
TestExecution.objects.filter(
                    run__plan__product=stream, stop_date__isnull=False
                )
                .order_by("-stop_date")
                .values("stop_date")
                .first()
```

**Proposed**

```sql
last = latest_stop_date_by_product.get(stream.id)
```

**Why this helps** — Precompute the latest stop_date for all needed products in one grouped query, then read the result from memory inside the stream loop.

**Expected impact** — 1 grouped query instead of one ordered query per stream

**Why the output is unchanged (the model's argument)** — This preserves the same value semantics for each stream because it still chooses the greatest non-NULL stop_date among executions for that stream, and returns the same single-column result shape (`stop_date`) to the surrounding code. It does not alter ordering of the dashboard streams themselves, duplicate handling, or NULL handling for the filtered executions; the only assumption is that the grouped prefetch uses the same join path and non-NULL filter as the original query.

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

- The dashboard already has the set of streams it will display, so the grouped query can be restricted to those product ids.
- The surrounding code only needs the latest `stop_date` value, not the full `TestExecution` row.

**Evidence**

- `tcms/core/views.py:170` (call-site) — Shows the latest-execution lookup is performed inside the per-stream loop.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned.

### Materialize the queryset directly into a dict comprehension

`medium` · `other` · `mysql` · ✅ verified

The loop iterates every matching `TestCasePlan` row and builds the dictionary imperatively; a dict comprehension lets Django still run the same filtered query but avoids the extra Python loop structure.

**Where it is used**

- `tcms/rpc/api/testcase.py:782` in `sortkeys`
- Reached via request-handler

**Current**

```sql
for record in TestCasePlan.objects.filter(**query):
        # NOTE: convert to str() otherwise we get:
        # Unable to serialize result as valid XML: dictionary key must be string
        result[str(record.case_id)] = record.sortkey
```

**Proposed**

```sql
return {
    str(record.case_id): record.sortkey
    for record in TestCasePlan.objects.filter(**query)
}
```

**Why this helps** — This keeps the same single ORM query but expresses the same result-building logic more directly.

**Expected impact** — No database-call reduction; only simpler Python result construction

**Why the output is unchanged (the model's argument)** — The proposed code returns the same keys, values, and duplicate-key behaviour as the loop because later rows still overwrite earlier ones in iteration order. It preserves the same rows from the filtered queryset, the same columns read, and the same NULL handling. Query ordering is not changed.

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
- The filter expressions are textually unchanged.

**Assumptions**

- `TestCasePlan.objects.filter(**query)` already returns the same rows the loop would iterate.
- The queryset ordering, if any, is acceptable to preserve as-is.

**Verification notes**

- Severity is medium, not the low the model proposed: the query runs once per iteration of an enclosing loop, on a request path — but no structural fact could be counted, so it is not rated higher.

### Batch clone executions instead of inserting one at a time

`medium` · `round-trip` · `mysql` · ✅ verified

The clone loop creates a new execution for each source execution with a separate call, so the database must perform one insert path per cloned case.

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
new_executions = [
                    TestExecution(
                        run=new_run,
                        case=exe.case,
                        assignee=exe.assignee,
                        sortkey=(i + 1) * 10,
                    )
                    for i, exe in enumerate(
                        source_run.executions.select_related("case").all()
                    )
                ]
                TestExecution.objects.bulk_create(new_executions)
```

**Why this helps** — This lets Django send the rows to MySQL in one bulk insert operation instead of issuing an insert for each cloned execution.

**Expected impact** — 1 insert path per clone batch instead of one insert path per execution

**Why the output is unchanged (the model's argument)** — The proposed code must preserve the same set of executions, with the same case, assignee, and sortkey values, and it must not change row ordering because the surrounding code does not define any ordering for the insert side effects. NULL handling and duplicates are unchanged because each source execution still maps to exactly one new row; however, this is only equivalent if create_execution does not have extra side effects such as signal dispatch, default-field logic, or related-property creation beyond the shown arguments.

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

- create_execution only constructs the execution row from the shown fields and does not perform additional per-row work that must be preserved.
- bulk_create is acceptable for this model/version and no database-generated value from each insert is required immediately afterward.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Aggregate executions through the join instead of materializing run ids

`medium` · `round-trip` · `mysql` · ✅ verified

The code materializes all matching run primary keys into Python and then issues a second query with an IN list; the database can compute the aggregate directly through the relationship join.

**Where it is used**

- `tcms/testplans/views.py:379` in `TestPlanGetView.get_context_data`
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

**Why this helps** — This removes the Python-side list of run ids and lets the database join TestExecution to TestRun directly while doing the aggregate in one query.

**Expected impact** — One query instead of one query plus Python materialization of all run ids

**Why the output is unchanged (the model's argument)** — Rows: both queries aggregate over executions whose related run belongs to the same plan, so the underlying row set is the same. Columns: both return the same aggregate keys total/passed/failed/blocked. Ordering: aggregate queries return one row-like mapping with no ordering guarantee, unchanged. NULLs: COUNT ignores NULLs in both forms. Duplicates: the join condition run__plan_id=self.object.pk matches the same executions as run__in=run_ids, with no duplicate amplification because each TestExecution points to one run. Error behaviour: both forms succeed or fail on the same invalid plan id input; the rewrite does not change that behavior.

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

- TestExecution has a foreign key named run to TestRun, as implied by run__in.
- The relationship path run__plan_id is valid in this model graph.
- No custom queryset annotations or filters elsewhere depend on the intermediate run_ids list.

**Evidence**

- `tcms/testplans/views.py:379` (call-site) — Shows the two-step pattern: fetch ids into Python, then use them in the aggregate query.

**Verification notes**

- Same-output claim needs review — The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Load product names with a narrow queryset

`medium` · `full-scan` · `mysql` · ✅ verified

This template processor materializes every Product row with `list(Product.objects.order_by("name"))`, even though the comment says it is only exposing selected stream data.

**Where it is used**

- `tcms/core/context_processors.py:31` in `stream_processor`
- Reached via template render via context processor

**Current**

```sql
streams = list(Product.objects.order_by("name"))
```

**Proposed**

```sql
streams = list(Product.objects.order_by("name").only("id", "name"))
```

**Why this helps** — This keeps the same ordering while asking the database to return only the columns needed to build the `Product` objects used here, reducing row width on every render.

**Expected impact** — Less data transferred and less per-row materialization work on each template render.

**Why the output is unchanged (the model's argument)** — It returns the same set of Product rows in the same `name` order, with the same duplicates and NULL handling as the original ordering. The column set seen by callers is unchanged because Django still instantiates Product objects; only unused columns are deferred. Error behavior is unchanged for the same database states.

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

**Requires this migration first**

```sql
ALTER TABLE management_product ADD INDEX ...
```

**Assumptions**

- The template code that consumes `streams` only reads `Product` fields that are loaded by default or can tolerate deferred access if additional fields are touched later.

**Evidence**

- `tcms/core/context_processors.py:31` (call-site) — Shows the processor runs for template rendering and evaluates a queryset into a list.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.

### Batch custom-field persistence

`low` · `n-plus-one` · `mysql` · ✅ verified

The loop performs a queryset lookup and an update-or-create per submitted custom field, causing repeated ORM round trips that can be reduced by loading the active field configs once and doing set-based writes.

**Where it is used**

- `tcms/testcases/views.py:189` in `_save_custom_field_values`
- Reached via request-handler

**Current**

```sql
for field in TestCaseFieldConfig.objects.filter(is_active=True, is_system=False):
        val = request.POST.get(f"custom_{field.field_key}", "").strip()
        TestCaseCustomValue.objects.update_or_create(
            case=test_case,
            field=field,
            defaults={"value": val},
        )
```

**Proposed**

```sql
field_configs = list(TestCaseFieldConfig.objects.filter(is_active=True, is_system=False))
existing_values = {
    row.field_id: row
    for row in TestCaseCustomValue.objects.filter(case=test_case, field__in=field_configs)
}
for field in field_configs:
    val = request.POST.get(f"custom_{field.field_key}", "").strip()
    obj = existing_values.get(field.id)
    if obj is None:
        TestCaseCustomValue.objects.create(case=test_case, field=field, value=val)
    elif obj.value != val:
        obj.value = val
        obj.save(update_fields=["value"])
```

**Why this helps** — This avoids issuing a lookup/update-or-create for every field by reusing one materialized field-config list and one prefetch of existing custom values, then only writing rows that need changes.

**Expected impact** — Fewer ORM round trips: one query to load active field configs, one query to load existing custom values, then only writes for rows that change.

**Why the output is unchanged (the model's argument)** — Rows: it targets the same custom-value rows for the same active non-system fields. Columns: it writes the same case, field, and value data. Ordering: the original has no observable row-order guarantee and the rewrite does not add one. NULLs: both paths still store the POST-derived string after .strip(), so empty input remains an empty string. Duplicates: each field is handled once, matching the original loop. Error behavior: it still relies on the same ORM model constraints; if duplicates would have caused update_or_create issues before, the rewrite is behavior-changing only if such a state exists, so safe equivalence assumes the case/field pair is unique or otherwise singular.

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

- No CREATE TABLE for tcms_testcasecustomvalue was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Partly verified (django): Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX tcms_testcasecustomvalue_case_field_idx ON tcms_testcasecustomvalue (case_id, field_id);
```

**Assumptions**

- TestCaseCustomValue has at most one row per (case, field) pair, or the application expects that unique logical row.
- All active non-system fields must still be processed even when no POST value is supplied.

**Evidence**

- `tcms/testcases/views.py:193` (call-site) — Shows the per-field queryset iteration and per-field update_or_create that drive repeated ORM work.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Reported as an N+1, but the query is not inside a loop in the fetched source. One of those is wrong, and only one of them was checked.
- Severity is low, not the medium the model proposed: it is reported as an N+1, but the query is not inside a loop in the fetched source.

### Exclude already inactive users before deactivation

`low` · `full-scan` · `mysql` · ✅ verified

The loop deactivates every user matched by `query`, so adding an `is_active` filter would avoid writing rows that are already inactive while returning the same set of users to deactivate in the common case.

**Where it is used**

- `tcms/rpc/api/user.py:177` in `deactivate`
- Reached via request-handler

**Current**

```sql
for user in User.objects.filter(**query):
```

**Proposed**

```sql
for user in User.objects.filter(is_active=True, **query):
    user_utils.deactivate(user)

    result.append(_get_user_dict(user))
```

**Why this helps** — Filtering to active users avoids unnecessary writes to rows that are already inactive, so the ORM has fewer objects to update and the database does less write work.

**Expected impact** — Avoids unnecessary row updates for users already inactive

**Why the output is unchanged (the model's argument)** — This is only equivalent if callers expect `deactivate` to return and process only currently active users; otherwise it changes which rows are matched. It preserves columns read from each user and keeps duplicate handling the same, but it can change the result set if `query` can match inactive users or if `deactivate` has side effects on them.

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

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX `...` on the active-user predicate if the existing schema does not already support it
```

**Assumptions**

- `user_utils.deactivate(user)` is a no-op for already inactive users.
- The API is intended to target active users only.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: ordering.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Batch execution creation instead of looping inserts

`low` · `batching` · `mysql` · ✅ verified

The script creates one execution at a time inside the loop, which issues repeated write calls to the database.

**Where it is used**

- `scripts/run_assetshare_cases.py:39` in `<module>`
- Reached via unknown

**Current**

```sql
for i, tc in enumerate(cases):
        run.create_execution(case=tc, build=build, sortkey=(i + 1) * 10)
```

**Proposed**

```sql
executions = [
    TestExecution(case=tc, build=build, sortkey=(i + 1) * 10, run=run)
    for i, tc in enumerate(cases)
]
TestExecution.objects.bulk_create(executions)
```

**Why this helps** — Bulk creation lets the database handle the inserts as a batch instead of one insert per case.

**Expected impact** — Multiple insert calls are replaced by a single batched insert operation.

**Why the output is unchanged (the model's argument)** — This preserves the same inserted rows if `create_execution` only creates a `TestExecution` row with the shown fields. It preserves the same column values for each created execution, and the same number of created executions. It does not guarantee the same side effects as `run.create_execution` if that method also performs extra logic, so this is only equivalent if that helper is a thin create wrapper. Ordering of the in-memory `cases` list is unchanged, and duplicates/NULLs are not altered by the batching itself.

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

- No CREATE TABLE for tcms_testexecution was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax).

Not machine-checkable:

- Not a statement this checker can read (non-SQL engine or unsupported syntax).

**Requires this migration first**

```sql
CREATE INDEX IF NOT EXISTS tcms_testexecution_run_id_idx ON tcms_testexecution (run_id);
```

**Assumptions**

- `run.create_execution` does not do extra work beyond creating the execution row and setting the shown fields.
- `TestExecution` accepts `run=run` as a constructor field, or the model is related so that `bulk_create` can set the foreign key directly.
- The code does not rely on per-row signals or side effects from `create_execution`.

**Evidence**

- `scripts/run_assetshare_cases.py:36` (call-site) — Shows the per-case creation loop that drives repeated writes.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- Severity is low, not the medium the model proposed: the query runs once per iteration of an enclosing loop, reached by unknown.

### Filter the search in one queryset expression

`low` · `inefficient-join` · `mysql` · ✅ verified

The current code builds two filtered querysets and unions them with `|`, which is more work than a single queryset filter over both searchable fields.

**Where it is used**

- `tcms/kiwi_auth/views.py:349` in `UsersRouter.get`
- Reached via request-handler

**Current**

```sql
users = User.objects.exclude(username=settings.ANONYMOUS_USER_NAME).order_by(
            "username"
        )
        if query:
            users = users.filter(username__icontains=query) | users.filter(
                email__icontains=query
            )
```

**Proposed**

```sql
from django.db.models import Q

users = User.objects.exclude(username=settings.ANONYMOUS_USER_NAME).order_by(
    "username"
)
if query:
    users = users.filter(
        Q(username__icontains=query) | Q(email__icontains=query)
    )
```

**Why this helps** — A single OR filter lets the ORM issue one query for the search instead of combining two separately filtered querysets.

**Expected impact** — One queryset evaluation instead of combining two filtered querysets.

**Why the output is unchanged (the model's argument)** — The result rows are intended to be the same user set matched by either username or email. Because both original branches start from the same `users` queryset and the `|` operator combines the matching rows, the rewritten OR filter returns the same columns and the same logical matches. However, exact duplicate handling and ordering must be considered carefully: `|` between querysets can change deduplication and ordering semantics, so this is only safe if the surrounding code does not rely on duplicates and uses the existing `order_by("username")` as the final ordering after filtering. If Django or MySQL query rewriting changes duplicate handling, this becomes behavioural rather than equivalent.

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
- Row ordering is unchanged.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The view only needs the matching users, not two separately materialized querysets.
- No caller depends on duplicate rows or on the intermediate union behavior of `|`.

**Evidence**

- `tcms/kiwi_auth/views.py:349` (call-site) — Shows two filtered querysets are combined when a search term is present.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Batch comment creation with one insert path

`low` · `n-plus-one` · `mysql` · ✅ verified

`add_comment` issues one `Comment.objects.create(...)` per object in `objs`, so it performs repeated database writes and model setup work instead of using a batched insert path.

**Where it is used**

- `tcms/core/helpers/comments.py:39` in `add_comment`
- Reached via unknown

**Current**

```sql
site = Site.objects.get(pk=settings.SITE_ID)
    created = []
    for obj in objs:
        content_type = ContentType.objects.get_for_model(model=obj.__class__)
        comment = Comment.objects.create(
            content_type=content_type,
            site=site,
```

**Proposed**

```sql
site = Site.objects.get(pk=settings.SITE_ID)
    created = []
    comments = []
    for obj in objs:
        content_type = ContentType.objects.get_for_model(model=obj.__class__)
        comments.append(
            Comment(
                content_type=content_type,
                site=site,
                object_id=obj.pk,
                user=user,
                comment=comment_text,
            )
        )
    created = Comment.objects.bulk_create(comments)
    return created
```

**Why this helps** — This turns repeated per-object insert calls into a single batched insert path, reducing database round trips and repeated ORM write overhead.

**Expected impact** — 1 insert batch instead of one insert per object

**Why the output is unchanged (the model's argument)** — The returned set of created `Comment` rows matches the original for the same input objects: the same fields are assigned, the same number of comments are produced, and the order of the input list is preserved in the constructed list. NULL handling is unchanged because the same field values are supplied. This is equivalent only if callers do not depend on per-row `create()` side effects such as signals, default-refresh behavior, or primary-key availability before return; those behaviors can differ with `bulk_create`, so if those matter this becomes behavioural.

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
- The terminal operation is unchanged (get), so the shape of the result is the same.
- The filter expressions are textually unchanged.

**Assumptions**

- `Comment` does not require per-instance save hooks, signals, or database-generated defaults to be observed before return.
- The caller only needs the created comment objects/rows, not individual `create()` side effects.

**Evidence**

- `tcms/core/helpers/comments.py:39` (call-site) — Shows the per-object create inside the loop that drives repeated writes.

**Verification notes**

- Reported as an N+1, but the query is not inside a loop in the fetched source. One of those is wrong, and only one of them was checked.
- Severity is low, not the medium the model proposed: it is reported as an N+1, but the query is not inside a loop in the fetched source.

### Restrict the removal queryset to the needed count check

`low` · `over-fetch` · `mysql` · ✅ verified

The removal path builds a queryset of executions to delete and then uses it only to count non-empty executions, so the code can avoid carrying around the wider queryset shape when it only needs the count filter.

**Where it is used**

- `tcms/testruns/views.py:570` in `UpdateRunCasesView`
- Reached via request-handler

**Current**

```sql
removal_qs = TestExecution.objects.filter(run=run, case_id__in=to_remove)
```

**Proposed**

```sql
removal_qs = TestExecution.objects.filter(
            run=run,
            case_id__in=to_remove,
            status__weight__gt=0,
        )
```

**Why this helps** — If the only immediate use is to count executions that are actually recorded, pushing that predicate into the queryset lets MySQL ignore rows that cannot contribute to the count.

**Expected impact** — Fewer rows considered by the count query when only non-zero-weight executions matter

**Why the output is unchanged (the model's argument)** — This is not equivalent for all inputs because it changes the queryset seen by later code: the original queryset includes all matching executions, while the rewrite excludes rows with status weight 0. That changes rows if the queryset is reused, so it is only behavioural if adopted literally. If the intent is to preserve behavior, keep the original queryset and apply the extra filter in a separate count-only queryset instead.

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

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The queryset is not reused later for deletion or other logic that needs all matching executions.

**Evidence**

- `tcms/testruns/views.py:570` (call-site) — The queryset is created only to feed a count with an additional exclusion, so it is a candidate for pushing filters earlier.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, ordering, NULL or duplicate handling.

### Cache plan-case sortkey lookups before the loop

`low` · `n-plus-one` · `mysql` · ⚠️ needs verification

[Unverified citation] Each case iteration does a `TestCasePlan.objects.get(plan=plan_obj, case=case)` lookup, so the code issues one database read per case instead of fetching the plan-case rows once and reusing them.

**Where it is used**

- `tcms/testruns/views.py:316` in `NewTestRunView.post`
- Reached via request-handler

**Current**

```sql
tcp = TestCasePlan.objects.get(plan=plan_obj, case=case)
```

**Proposed**

```sql
plan_obj = form.cleaned_data.get("plan")
loop = 1
plan_case_sortkeys = {}
if plan_obj:
    plan_case_sortkeys = {
        tcp.case_id: tcp.sortkey
        for tcp in TestCasePlan.objects.filter(plan=plan_obj, case__in=cases_to_add).only("case_id", "sortkey")
    }
for case in cases_to_add:
    sortkey = loop * 10
    if plan_obj and case.id in plan_case_sortkeys:
        sortkey = plan_case_sortkeys[case.id]

    test_run.create_execution(
        case=case,
        assignee=form.cleaned_data["default_tester"],
```

**Why this helps** — This replaces per-case point lookups with one query that fetches all matching plan-case sortkeys up front, so the loop can read from memory instead of hitting the database repeatedly.

**Expected impact** — 1 query instead of one per case in the loop

**Why the output is unchanged (the model's argument)** — The rewritten code uses the same plan and the same cases_to_add set, and it assigns the same sortkey when a matching TestCasePlan exists; when no row exists it keeps `loop * 10`. It preserves the same rows created, the same columns written, the same ordering of created executions, and the same duplicate/NULL behavior for the application path. The only observable difference is that missing rows are handled by membership in a precomputed dictionary instead of raising and catching ObjectDoesNotExist, which is equivalent for the intended control flow because the original exception is swallowed and produces the same sortkey fallback.

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
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Checked against the declared schema**

- No CREATE TABLE for tcms_testcaseplan was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [case_id, sortkey]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [case_id, sortkey]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX idx_testcaseplan_plan_case ON tcms_testcaseplan (plan_id, case_id);
```

**Assumptions**

- TestCasePlan has at most one row per (plan, case), which is required for `.get(...)` to succeed in the original code.
- `cases_to_add` is finite and already materialized at this point.
- `case.id` is the correct key for the foreign-key relationship used by `TestCasePlan.case_id`.

**Verification notes**

- Evidence quote was not found in tcms/testruns/views.py.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [case_id, sortkey]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 4 structural fact(s) were counted from the two versions.
- Severity capped at low: a citation could not be confirmed against the fetched source.

## Behaviour changes and bugs

**These change what the query returns.** They are listed separately on purpose — review each on its merits.

### Hoist the per-stream case count out of the loop

`high` · `full-scan` · `mysql` · ✅ verified

The dashboard recomputes `TestCase.objects.filter(section__product=stream).count()` once per stream, creating a repeated database count query inside the loop.

**Where it is used**

- `tcms/core/views.py:186` in `DashboardView.get_context_data`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
```

**Proposed**

```sql
case_counts = {
    row["section__product"]: row["cases"]
    for row in TestCase.objects.filter(section__product__in=streams)
    .values("section__product")
    .annotate(cases=models.Count("id"))
}

# inside the loop:
"cases": case_counts.get(stream.id, 0),
```

**Why this helps** — This turns one count query per stream into a single grouped aggregation keyed by product, so the database can count all streams in one pass instead of repeating the same filter for each iteration.

**Expected impact** — 1 grouped count query instead of one count query per stream

**Why the output is unchanged (the model's argument)** — It returns the same integer count for each stream, with the same columns and no ordering change. Missing streams still map to 0 via `get(..., 0)`. Because `COUNT(id)` ignores NULL only on the counted column and `id` is not nullable for model primary keys, the result matches `.count()` for this filter. Duplicates are not introduced or removed, and no rows are returned from the query itself.

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
- Fetches 1 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section__product]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX is not required beyond the existing model index on `TestCase.section__product` if present; the benefit depends on how many streams are processed and how selective the filter is.
```

**Assumptions**

- `streams` is the iterable of stream objects used by the loop and is available before building the mapping.
- `section__product` groups TestCase rows by the same stream identifier used in the loop.
- `django.db.models` is available as `models` in this module.

**Evidence**

- `tcms/core/views.py:183` (call-site) — Shows the count is executed inside the per-stream loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section__product]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Precompute the latest execution per stream once

`high` · `full-scan` · `mysql` · ✅ verified

The CSV export issues `TestExecution.objects.filter(...).order_by("-stop_date").values("stop_date").first()` for each stream, repeating a latest-row lookup inside the loop.

**Where it is used**

- `tcms/core/views.py:587` in `AllStreamsCsvExportView.get`
- Reached via request-handler

**Current**

```sql
TestExecution.objects.filter(
                    run__plan__product=stream, stop_date__isnull=False
                )
                .order_by("-stop_date")
                .values("stop_date")
                .first()
```

**Proposed**

```sql
last_by_product = (
    TestExecution.objects.filter(stop_date__isnull=False)
    .values("run__plan__product")
    .annotate(last_stop_date=models.Max("stop_date"))
)
last_map = {
    row["run__plan__product"]: row["last_stop_date"]
    for row in last_by_product
}

# inside the loop:
last_stop_date = last_map.get(stream.id)
```

**Why this helps** — This replaces one ordered lookup per stream with a single grouped aggregate, letting the database compute each product's latest stop date in one query.

**Expected impact** — 1 grouped aggregate instead of one latest-row query per stream

**Why the output is unchanged (the model's argument)** — For each stream, `Max(stop_date)` over the same filtered rows yields the same timestamp value that `.order_by("-stop_date").values("stop_date").first()` would return when a row exists, and `None` when no rows exist. The rewritten code returns the same scalar value used later in the CSV output, with no change to row ordering or duplicate handling because no rowset is exposed. Null rows are excluded by the same `stop_date__isnull=False` filter. If multiple executions share the same maximum stop date, both forms still produce that same stop-date value, even though the chosen physical row is irrelevant here because only the timestamp is used.

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
- Replaces an ordered scan and fetch with a single Max aggregate, so the database no longer has to order the rows to return one value. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The selected fields change from [stop_date] to [run__plan__product], so the caller receives different data.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).

Differences found:

- The selected fields change from [stop_date] to [run__plan__product], so the caller receives different data.
- Ordering ["-stop_date"] is removed. Row order is no longer guaranteed.
- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [get], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX is not required by the rewrite, though the benefit depends on how many streams are exported and how selective the `stop_date__isnull=False` filter is.
```

**Assumptions**

- `stream.id` matches the key produced by `run__plan__product` in the grouping.
- `django.db.models` is available as `models` in this module.
- Only the stop date value is needed downstream, not the execution row itself.

**Evidence**

- `tcms/core/views.py:587` (call-site) — Shows the latest execution lookup is executed inside the per-stream loop.

**Verification notes**

- Reclassified as behaviour-changing: The selected fields change from [stop_date] to [run__plan__product], so the caller receives different data. The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Reuse the per-stream case counts in the CSV export

`high` · `full-scan` · `mysql` · ✅ verified

The CSV export recomputes `TestCase.objects.filter(section__product=stream).count()` inside the loop, duplicating the same database count work for every stream.

**Where it is used**

- `tcms/core/views.py:595` in `AllStreamsCsvExportView.get`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
```

**Proposed**

```sql
case_counts = {
    row["section__product"]: row["cases"]
    for row in TestCase.objects.filter(section__product__in=streams)
    .values("section__product")
    .annotate(cases=models.Count("id"))
}

# inside the loop:
writer.writerow(
    [
        stream.name,
        case_counts.get(stream.id, 0),
        len(active_run_ids),
        pass_rate,
        stats["failed"],
        stats["blocked"],
        last_stop_date.strftime("%Y-%m-%d %H:%M") if last_stop_date else "",
    ]
)
```

**Why this helps** — This avoids repeating the same count query for every exported stream by computing all counts in a single grouped query and then doing in-memory lookups.

**Expected impact** — 1 grouped count query instead of one count query per stream

**Why the output is unchanged (the model's argument)** — The rewritten count value is the same per stream, with the same integer type and same `0` fallback when no cases exist. It does not change any emitted CSV column order or add/remove rows. The grouped count preserves duplicate handling because `.count()` on the filtered queryset and `Count("id")` both count matching case rows, and there is no ordering requirement for the count itself. Null handling is unchanged because the counted primary key is non-nullable.

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
- Fetches 1 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section__product]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX is not required by the rewrite; benefit depends on the number of streams and the selectivity of the existing filter.
```

**Assumptions**

- `streams` is the same iterable driving the export loop.
- `section__product` identifies the stream key used in the mapping.
- `django.db.models` is available as `models` in this module.

**Evidence**

- `tcms/core/views.py:595` (call-site) — Shows the count query is performed during each CSV row write.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section__product]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Reuse the existing tag queryset before adding tags

`high` · `round-trip` · `mysql` · ✅ verified

This loop does one tag lookup per newly submitted tag, so the database is queried repeatedly while processing the same form submission.

**Where it is used**

- `tcms/testcases/views.py:426` in `EditTestCaseView.form_valid`
- Reached via request-handler

**Current**

```sql
tag_obj = Tag.objects.filter(name=name).first()
```

**Proposed**

```sql
existing_tags = {tag.name: tag for tag in Tag.objects.filter(name__in=(submitted - existing))}
for name in submitted - existing:
    tag_obj = existing_tags.get(name)
    if tag_obj:
        self.object.add_tag(tag_obj)
```

**Why this helps** — Fetch all candidate tags in one query, then do in-memory lookups instead of issuing one query per tag name.

**Expected impact** — 1 query instead of one query per submitted tag name

**Why the output is unchanged (the model's argument)** — This preserves the same rows and columns because it still uses the same tag names from submitted - existing and only adds tags when a matching Tag exists. The row ordering is irrelevant because the original code only tests truthiness of .first(), and the set of tags added is the same. NULL handling is unchanged because tag names are compared as before. Duplicate handling is unchanged because submitted and existing are sets, so each name is processed at most once.

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

- No CREATE TABLE for tcms_testcases_tag was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [first] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [get], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX `tcms_testcases_tag_name_idx` ON `tcms_testcases_tag` (`name`)
```

**Assumptions**

- Tag.name uniquely identifies the intended tag object for this workflow, or if multiple rows match the same name the existing code's .first() choice is not required to be preserved exactly.
- Tag.objects.filter(name__in=...) returns all candidate rows needed for the loop.

**Evidence**

- `tcms/testcases/views.py:420` (call-site) — Shows the per-tag ORM lookup inside the submission loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Preload priorities for the import batch

`high` · `round-trip` · `mysql` · ✅ verified

This import path performs a priority lookup for each imported row, so the same reference data may be queried repeatedly inside the CSV-processing loop.

**Where it is used**

- `tcms/testcases/views.py:756` in `ImportCasesView._do_import`
- Reached via request-handler

**Current**

```sql
pri = Priority.objects.filter(
                            value__iexact=val, is_active=True
                        ).first()
```

**Proposed**

```sql
priority_values = {v for v in priority_values_needed if v}
priorities = {
    p.value.lower(): p
    for p in Priority.objects.filter(is_active=True, value__in=priority_values)
}
...
pri = priorities.get(val.lower())
```

**Why this helps** — Load the active priorities needed by the import in a single query, then resolve each row from an in-memory map instead of querying per row.

**Expected impact** — 1 lookup for the needed priorities instead of one lookup per imported row

**Why the output is unchanged (the model's argument)** — This is equivalent for the matching semantics used here if the active priorities are identified by the same value strings the import consumes. It returns the same imported rows, columns, ordering, NULL handling, and duplicates because it only replaces repeated lookups with a cached lookup and still assigns the same Priority object when a match exists. If multiple active priorities differ only by case, the original .first() result depends on database ordering, so exact equivalence would require the cache to preserve that same selection rule.

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

- No CREATE TABLE for tcms_priority was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [first] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [get], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX `tcms_priority_value_idx` ON `tcms_priority` (`value`)
```

**Assumptions**

- The import has a finite set of priority values that can be collected before assignment.
- There is not more than one active Priority row that should match the same input under value__iexact, or preserving the original .first() choice is not required.

**Evidence**

- `tcms/testcases/views.py:750` (call-site) — Shows the priority lookup happening inside the CSV row-processing loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Preload active run ids and aggregate executions in bulk

`high` · `round-trip` · `mysql` · ✅ verified

This loop issues one test-run lookup and one execution aggregate per product; the work can be collapsed into set-based queries instead of repeated per-stream database calls.

**Where it is used**

- `tcms/core/views.py:566` in `AllStreamsCsvExportView.get`
- Reached via request-handler
- Also at `tcms/core/views.py:154`
- Also at `tcms/core/views.py:566`

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
streams = list(Product.objects.all().order_by("name"))
active_runs_by_product = {
    row["plan__product"]: row["run_ids"]
    for row in (
        TestRun.objects.filter(stop_date__isnull=True)
        .values("plan__product")
        .annotate(run_ids=ArrayAgg("pk"))
    )
}
execution_stats_by_product = {
    row["run__plan__product"]: row
    for row in (
        TestExecution.objects.filter(run__stop_date__isnull=True)
        .values("run__plan__product")
        .annotate(total=Count("pk"), **exec_count_annotations())
    )
}
```

**Why this helps** — This moves the per-product lookups into grouped queries so the database can compute the same per-stream data in batches instead of repeating the same pattern inside the loop.

**Expected impact** — Fewer repeated queries: one grouped active-run query and one grouped execution query instead of two database operations per product.

**Why the output is unchanged (the model's argument)** — This is only equivalent if the grouped queries preserve the same product set and produce the same per-product counts as the original code. The original loop iterates over `Product.objects.all().order_by("name")`, so the rewritten code must keep that ordering when rendering results. The result rows and columns from the aggregated data must be mapped back to the same products; if a product has no active runs, the grouped lookup must still yield the same zero/empty outcome as the original `list(...)` plus filtered aggregate. NULL handling and duplicates must match the current `values_list("pk", flat=True)` and `aggregate(...)` behavior exactly, and any change to joins or grouping must not alter which executions are counted.

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

**Automated equivalence check** — Contradicted: The selected fields change from [pk, flat=True] to [plan__product, run__plan__product], so the caller receives different data.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Differences found:

- The selected fields change from [pk, flat=True] to [plan__product, run__plan__product], so the caller receives different data.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX ...
```

**Assumptions**

- `ArrayAgg` or another grouping mechanism is available in this codebase and can represent the same per-product active run ids safely.
- The caller only needs per-product summaries, not the intermediate run-id list itself.
- The product/order rendering still uses `Product.objects.all().order_by("name")` so output ordering is unchanged.

**Verification notes**

- Reclassified as behaviour-changing: The selected fields change from [pk, flat=True] to [plan__product, run__plan__product], so the caller receives different data.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Precompute section case counts in one grouped query

`high` · `full-scan` · `mysql` · ✅ verified

The view runs two `TestCase` count queries per section, so the database re-scans the same table repeatedly inside the loop.

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
sections = list(Section.objects.filter(product=stream).order_by("name"))
section_ids = [sec.pk for sec in sections]
counts = dict(
    TestCase.objects.filter(section_id__in=section_ids)
    .values_list("section_id")
    .annotate(total=models.Count("id"))
)
executed_counts = dict(
    TestCase.objects.filter(section_id__in=section_ids, pk__in=executed_case_ids)
    .values_list("section_id")
    .annotate(total=models.Count("id"))
)

section_data = []
for sec in sections:
    sc_total = counts.get(sec.pk, 0)
    if not sc_total:
        continue
    sc_executed = executed_counts.get(sec.pk, 0)
    sc_pct = round(sc_executed / sc_total * 100) if sc_total else 0
    section_data.append(
        {
            "section": sec,
            "total": sc_total,
            "executed": sc_executed,
            "pct": sc_pct,
        }
    )
```

**Why this helps** — This lets the database aggregate counts by section in set-oriented queries instead of issuing separate count queries for every section.

**Expected impact** — Fewer repeated table scans and fewer ORM round trips: the per-section count work is replaced by grouped aggregation queries.

**Why the output is unchanged (the model's argument)** — The rewrite returns the same sections because it iterates the same `Section.objects.filter(product=stream).order_by("name")` result. It computes the same per-section totals and executed counts, with the same integer values and the same `continue` behavior when the total is zero. The row ordering of the section list is unchanged because the outer loop still uses the same ordering. NULL handling and duplicates are unaffected because the underlying `count()` semantics remain counts of matching rows for each section. One caveat is that this relies on `section_id` being the grouping key for `TestCase.section`; that is safe if `section` is the foreign-key field shown in the code.

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
- Evaluates the queryset once and reuses the result, where the original re-runs it on each use. (Counted from the code, not measured.)

**Checked against the declared schema**

- No CREATE TABLE for tcms_testcase was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Differences found:

- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section_id, section_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX IF NOT EXISTS tcms_testcase_section_id_idx ON tcms_testcase (section_id);
```

**Assumptions**

- `TestCase.section` is the foreign key backing `section_id` and can be grouped on directly.
- `django.db.models.Count` is available in the module or imported before use.

**Evidence**

- `tcms/core/views.py:877` (call-site) — Shows the repeated per-section count pattern inside the loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section_id, section_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Combine the repeated case counts into one aggregate query

`medium` · `round-trip` · `mysql` · ✅ verified

This view runs several separate count queries over the same product-scoped case set and can instead ask the database for all of those counts in one pass.

**Where it is used**

- `tcms/core/views.py:856` in `CoverageReportView.get`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
        TestCase.objects.filter(
            section__product=stream, is_sanity=True
        ).count()
        TestCase.objects.filter(
            section__product=stream, is_regression=True
        ).count()
        TestCase.objects.filter(
            section__product=stream, is_automated=True
        ).count()
```

**Proposed**

```sql
from django.db.models import Count, Q

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

**Why this helps** — A single aggregate query lets MySQL compute all four counts together instead of repeating the same filtered scan four times.

**Expected impact** — 1 query instead of 4 for these counts.

**Why the output is unchanged (the model's argument)** — The aggregate returns the same scalar counts for the same filtered row set, with no change to row ordering because counts are scalar values. NULL handling is unchanged because count ignores NULL values the same way on `id`, and duplicate handling is unchanged because `count()` and `Count("id")` both count matching rows. This remains equivalent as long as the view only uses these four counts.

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

- The `section__product` relationship resolves the same way in the ORM as in the original filters.
- No other side effects depend on issuing four separate queryset evaluations.

**Evidence**

- `tcms/core/views.py:856` (call-site) — Shows four separate count queries over the same base filter.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.

### Remove the repeated count before creating executions

`low` · `round-trip` · `mysql` · ✅ verified

The count check forces a separate query on the property set before the execution and property inserts, so the method does extra round trips when it could rely on the later loop instead.

**Where it is used**

- `tcms/testruns/models.py:165` in `TestRun`
- Reached via unknown

**Current**

```sql
if properties.count():
            for prop_tuple in self.property_matrix(properties, matrix_type):
                execution = self._create_single_execution(
                    case, assignee, build, sortkey
                )
```

**Proposed**

```sql
for prop_tuple in self.property_matrix(properties, matrix_type):
                execution = self._create_single_execution(
                    case, assignee, build, sortkey
                )
                executions.append(execution)

                for prop in prop_tuple:
                    TestExecutionProperty.objects.create(
                        execution=execution, name=prop.name, value=prop.value
                    )
```

**Why this helps** — This avoids an extra query for the empty/non-empty test and lets the existing loop determine whether any execution rows need to be created.

**Expected impact** — 1 fewer query in the non-empty case, and no pre-check query at all

**Why the output is unchanged (the model's argument)** — This is not equivalent: removing the count changes behavior when properties is empty, because the original code skips the loop entirely while the rewrite depends on property_matrix yielding nothing. It also changes error behavior if property_matrix or the iteration over properties has side effects that the count avoided. The rewrite preserves inserted columns and duplicate handling only if those helpers are pure, but that cannot be proven from the context.

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

- property_matrix(properties, matrix_type) yields no tuples when properties is empty.
- No caller relies on the explicit count() query or on any side effects from evaluating properties.count().

**Verification notes**

- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Preload existing run ids for each plan import

`low` · `n-plus-one` · `mysql` · ⚠️ needs verification

[Unverified citation] The nested loop performs `TestRun.objects.filter(global_id=old_run_gid).exists()` for every run, so it repeats a database existence check instead of reusing a preloaded set of run ids.

**Where it is used**

- `tcms/core/admin_views.py:1046` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
TestRun.objects.filter(global_id=old_run_gid).exists()
```

**Proposed**

```sql
existing_run_gids = set(
    TestRun.objects.filter(
        global_id__in=[r.get("global_id", "") for r in plan_data.get("runs", []) if r.get("global_id", "")]
    ).values_list("global_id", flat=True)
)

for run_data in plan_data.get("runs", []):
    old_run_gid = run_data.get("global_id", "")
    if old_run_gid and old_run_gid in existing_run_gids:
        skipped.append(f"Run {old_run_gid} (already exists)")
        continue
    tester_name = run_data.get("tester", "")
    tester = (
```

**Why this helps** — This replaces repeated existence checks with a single query for all run global IDs in the current plan, then checks membership in memory during the inner loop.

**Expected impact** — 1 query instead of one per run

**Why the output is unchanged (the model's argument)** — The rewrite makes the same keep/skip decision for each run because it tests the same `global_id` values against the same TestRun table state. It preserves row content, columns, ordering, NULL handling, and duplicate handling for the import logic: empty `global_id` values still bypass the check, and matching runs still get skipped. As with any preload, the only non-equivalent case would be concurrent writes to `TestRun` during the loop; if that can happen, the original code observes a more current state per iteration.

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

**Checked against the declared schema**

- No CREATE TABLE for tcms_testrun was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [exists] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [exists] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [global_id, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX idx_testrun_global_id ON tcms_testrun (global_id);
```

**Assumptions**

- The `runs` list for a plan is available before the inner loop starts.
- No concurrent writes are expected to alter matching `TestRun.global_id` rows during the import.
- `global_id` comparisons are string-based exactly as in the original guard.

**Verification notes**

- Evidence quote was not found in tcms/core/admin_views.py.
- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [global_id, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.
- Severity capped at low: a citation could not be confirmed against the fetched source.

## Suppressed before publication

17 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### not data access — 3

- **Bulk-create executions instead of creating them one by one** — `tcms/testplans/views.py:174`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Batch execution creation for added cases** — `tcms/testruns/views.py:326`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Hoist the annotated case queryset into a single prefetch path** — `tcms/testplans/models.py:161`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.

### wrong direction (proposal issues no fewer queries) — 9

- **Create executions from a realized case list** — `tcms/testplans/views.py:169`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Split the two counts into separate filtered querysets** — `tcms/telemetry/api.py:28`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the already-built execution queryset for aggregation** — `tcms/core/views.py:403`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Prefetch environment properties in one query** — `tcms/testruns/views.py:276`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Resolve tag names in bulk** — `tcms/testcases/views.py:281`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse imported plan ids instead of probing per plan** — `tcms/core/admin_views.py:1026`
  The proposal issues 4 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Preload executions when serializing test cases** — `tcms/rpc/api/testrun.py:140`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fetch the confirmed status with a single ordered query** — `tcms/rpc/api/testcase.py:878`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the prefetched runs before checking emptiness** — `tcms/testplans/views.py:451`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)

### no-op (proposal identical to the original) — 2

- **Aggregate tag facets after de-duplicating case ids** — `tcms/rpc/api/testcase.py:498`
  The finding proposes no change at all — the suggestion is empty, so there is nothing to apply or review.
- **Load execution statuses once, outside repeated matching work** — `scripts/run_assetshare_cases.py:42`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

### cold path (migration, seed or test) — 3

- **Reuse the cloned parent object instead of reloading it** — `tcms/testplans/tests/tests.py:299`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Materialize the ordered queryset before iterating** — `tcms/testcases/migrations/0036_migrate_testrail_id_custom_field.py:56`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Batch permission updates instead of saving each row** — `tcms/testruns/migrations/0006_rename_test_case_run_to_test_execution.py:22`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._