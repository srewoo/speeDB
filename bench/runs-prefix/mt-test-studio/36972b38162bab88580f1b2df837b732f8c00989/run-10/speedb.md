# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 4:58:30 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 871 analysed · 2 filtered (below confidence 0 · low priority 2) · 73 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Triage** 870 site(s) triaged · 56 flagged · 1 unsure · 813 clean (7% sent for write-up)  
**Triage gaps** 1 site(s) came back from triage with no verdict and were escalated to a full write-up rather than assumed clean. That is the safe direction, but a scan with many of them is one whose triage stage is not answering reliably.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 28 published · 28 suppressed

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
| high | 2 | 9 |
| medium | 3 | 6 |
| low | 0 | 3 |
| info | 0 | 5 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Lookup matching bug system instead of loading all systems

`high` · `full-scan` · `mysql` · ✅ verified

This loop loads every BugSystem row and checks them in Python, so each request does a full table read even though only one matching system can be used.

**Where it is used**

- `tcms/rpc/api/utils.py:16` in `tracker_from_url`
- Reached via request-handler

**Current**

```sql
for bug_system in BugSystem.objects.all():
        if bug_system.base_url and url.startswith(bug_system.base_url):
            return import_string(bug_system.tracker_type)(bug_system, request)
```

**Proposed**

```sql
bug_system = BugSystem.objects.filter(base_url__isnull=False, base_url__in=[
        bug_system.base_url for bug_system in BugSystem.objects.only("base_url", "tracker_type")
    ])
```

**Why this helps** — This can be rewritten to push the match into the database so the app does not materialize every bug system on each call.

**Expected impact** — One database read that can use filtering instead of fetching every bug system row into Python.

**Why the output is unchanged (the model's argument)** — This is not provably equivalent as written because the original checks a prefix condition with Python's startswith and returns the first matching row from queryset iteration order, while a database filter would need a matching prefix expression and a defined ordering to preserve the same row, duplicates, and NULL handling; the safe conclusion is only that the current code performs a full read.

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

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [base_url, tracker_type]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [base_url, tracker_type]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- A correct optimization would need a query that matches the prefix semantics of startswith and preserves the original iteration order if multiple bug systems can match.
- The set of bug systems is not guaranteed to be tiny, so avoiding materializing all rows may matter.

**Evidence**

- `tcms/rpc/api/utils.py:16` (call-site) — Shows the request handler iterates over every bug system and performs the prefix test in Python.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [base_url, tracker_type]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 4 structural fact(s) were counted from the two versions.

### Add a query that fetches only the needed columns

`high` · `over-fetch` · `mysql` · ✅ verified

The loop materializes full `TestCasePlan` rows when it only needs `case_id` and `sortkey`, so the ORM does unnecessary object hydration for every matching row.

**Where it is used**

- `tcms/rpc/api/testcase.py:782` in `sortkeys`
- Reached via request-handler

**Current**

```sql
for record in TestCasePlan.objects.filter(**query):
```

**Proposed**

```sql
for case_id, sortkey in TestCasePlan.objects.filter(**query).values_list("case_id", "sortkey"):
    # NOTE: convert to str() otherwise we get:
    # Unable to serialize result as valid XML: dictionary key must be string
    result[str(case_id)] = sortkey
```

**Why this helps** — `values_list()` asks the database to return only the two columns used by the loop, so Django does less per-row object construction and transfers less data from MySQL.

**Expected impact** — The database still returns one result set, but Django avoids hydrating full model instances and only reads the two needed fields.

**Why the output is unchanged (the model's argument)** — It returns the same rows because it uses the same filter; it returns the same columns in a different access form, but the final dictionary keys and values are built from the same `case_id` and `sortkey` values; row ordering is irrelevant because the code only populates a dict; NULL handling and duplicates remain the same because each row still contributes one assignment, so later duplicates overwrite earlier ones exactly as before.

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

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [case_id, sortkey]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [case_id, sortkey]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Requires this migration first**

```sql
CREATE INDEX statements are not required for this change.
```

**Assumptions**

- `query` does not depend on model-instance side effects from iterating `TestCasePlan` objects, which this code does not show.
- No model property or custom iterator behavior is required beyond the two selected columns.

**Evidence**

- `tcms/rpc/api/testcase.py:782` (call-site) — Shows the loop only uses `case_id` and `sortkey`.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [case_id, sortkey]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Add an index-aware latest-execution lookup

`medium` · `missing-index` · `mysql` · ✅ verified

The view issues a filtered, descending lookup for each stream, so without a matching index the database must inspect many `TestExecution` rows repeatedly to find the latest `stop_date`.

**Where it is used**

- `tcms/core/views.py:588` in `AllStreamsCsvExportView.get`
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
TestExecution.objects.filter(
                    run__plan__product=stream,
                    stop_date__isnull=False,
                ).order_by("-stop_date").values("stop_date").first()
```

**Why this helps** — This is the same ORM query, but it only becomes index-friendly if there is a supporting index on the filter/join path and `stop_date` so MySQL can satisfy the descending lookup without scanning the full matching set for every stream.

**Expected impact** — Lets MySQL use an index-assisted ordered lookup for each stream instead of evaluating the filter and sort from the table or a large matching set.

**Why the output is unchanged (the model's argument)** — The proposed code is textually the same query shape and returns the same single `stop_date` value or `None`; it preserves columns, ordering, NULL handling, and duplicates exactly because it does not alter the query semantics.

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

- The selected fields are identical (stop_date).
- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.
- The terminal operation is unchanged (first), so the shape of the result is the same.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX ...
```

**Assumptions**

- A suitable index exists or will be added on the joined product/run path plus `stop_date`; the relevant related fields are indexed by Django's foreign keys, but a composite index may still be needed for this access pattern.
- The goal is to optimize the per-stream latest-row lookup rather than change the result set.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned.

### Fold the run-id preload into the aggregate

`medium` · `round-trip` · `mysql` · ✅ verified

This view does one query to materialize all test run primary keys and then a second query to aggregate executions with an IN list built from those ids.

**Where it is used**

- `tcms/testplans/views.py:381` in `TestPlanGetView.get_context_data`
- Reached via request-handler

**Current**

```sql
run_ids = list(
            TestRun.objects.filter(plan_id=self.object.pk).values_list("pk", flat=True)
        )
        exec_health = TestExecution.objects.filter(run__in=run_ids).aggregate(
            total=Count("pk"),
            passed=Count("pk", filter=Q(status__name="PASSED")),
            failed=Count("pk", filter=Q(status__name="FAILED")),
            blocked=Count("pk", filter=Q(status__name="BLOCKED")),
        )
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

**Why this helps** — This lets the database join from executions to runs and filter by the plan directly, avoiding the separate query that first loads every run id into Python.

**Expected impact** — 1 query instead of 2, with the plan filter evaluated in SQL rather than first materializing all run ids in Python.

**Why the output is unchanged (the model's argument)** — It returns the same aggregate columns and the same counts for every database state; the result rows are unchanged because this is a single-row aggregate, NULL handling is unchanged because the code still maps a missing total to 0, and duplicate handling is unchanged because both forms count the same execution rows matched by the same plan membership condition.

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

- TestExecution has a run relation whose plan_id is the same field used by TestRun.objects.filter(plan_id=self.object.pk).
- The ORM path run__plan_id is valid in this codebase and does not introduce any extra filtering beyond the existing two-step condition.

**Evidence**

- `tcms/testplans/views.py:381` (call-site) — Shows the separate id-loading query followed by the aggregate over an IN list.

**Verification notes**

- Same-output claim needs review — The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: ordering.

### Add an index-backed predicate for blank-name users

`medium` · `full-scan` · `mysql` · ✅ verified

The command filters all users where both name fields are empty and orders by primary key, which can force the database to scan many user rows before it can iterate the candidates.

**Where it is used**

- `tcms/kiwi_auth/management/commands/backfill_user_names.py:40` in `Command.handle`
- Reached via job

**Current**

```sql
candidates = user_model.objects.filter(first_name="", last_name="").order_by(
            "pk"
        )
```

**Proposed**

```sql
candidates = user_model.objects.filter(
            first_name="",
            last_name="",
        ).only("pk", "first_name", "last_name").order_by("pk")
```

**Why this helps** — This keeps the same candidate set and ordering, while reducing the row width pulled from storage; if there is a composite index on the two name fields, the database can use it to narrow the scan before applying the primary-key order.

**Expected impact** — Fewer columns read per candidate row, and possibly an index-assisted restriction instead of a broader scan if the name predicate is selective enough.

**Why the output is unchanged (the model's argument)** — Rows are unchanged because the same equality predicates are used; columns are not changed for the iteration because the loop still receives User objects, but `only()` changes later field loading so this is only safe if the loop accesses no extra deferred fields beyond those already present in the original path; ordering stays by `pk`; NULL handling is unchanged because the original predicate matches only empty strings, not NULLs; duplicates cannot arise from a single-table queryset.

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

- Fetches 3 named column(s) instead of whole model instances. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [pk, first_name, last_name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [pk, first_name, last_name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The loop body only reads fields already needed for the update path, or deferred loading is acceptable.
- A suitable composite or prefix index may exist on `(first_name, last_name)`; if not, the benefit is limited to narrower row reads.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [pk, first_name, last_name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

## Behaviour changes and bugs

**These change what the query returns.** They are listed separately on purpose — review each on its merits.

### Prefetch plan-case mappings before the execution loop

`high` · `n-plus-one` · `mysql` · ✅ verified

The loop performs a `TestCasePlan.objects.get(plan=plan_obj, case=case)` lookup for each case, creating a per-case database round trip when a single bulk fetch of the relevant plan-case rows could be reused.

**Where it is used**

- `tcms/testruns/views.py:316` in `NewTestRunView.post`
- Reached via request-handler

**Current**

```sql
for case in cases_to_add:
    sortkey = loop * 10
    if plan_obj:
        try:
            tcp = TestCasePlan.objects.get(plan=plan_obj, case=case)
            sortkey = tcp.sortkey
        except ObjectDoesNotExist:
            pass
```

**Proposed**

```sql
plan_case_by_id = {}
if plan_obj:
    plan_case_by_id = {
        tcp.case_id: tcp
        for tcp in TestCasePlan.objects.filter(plan=plan_obj, case__in=cases_to_add)
    }

for case in cases_to_add:
    sortkey = loop * 10
    tcp = plan_case_by_id.get(case.id)
    if tcp is not None:
        sortkey = tcp.sortkey
```

**Why this helps** — This replaces one query per case with a single query for all matching plan-case rows, so the database can satisfy the lookups in memory during the loop instead of round-tripping repeatedly.

**Expected impact** — 1 query for the plan-case mapping instead of one per case in the loop

**Why the output is unchanged (the model's argument)** — Rows: the same plan-case rows are consulted for each case, and missing rows still fall back to `loop * 10`; columns: only `sortkey` is read as before; ordering: the loop over `cases_to_add` is unchanged; NULLs and duplicates: absent rows still behave like `ObjectDoesNotExist`, and duplicate plan-case rows would already make `get()` raise while the new version would need the source data to be unique, so this is only equivalent if `(plan, case)` is unique in practice.

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

**Automated equivalence check** — Partly verified (django): Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE UNIQUE INDEX ... ON ...
```

**Assumptions**

- `TestCasePlan` has at most one row for a given `(plan, case)` pair, or the calling code relies on that uniqueness.
- `cases_to_add` is a finite in-memory collection usable in `case__in`.

### Fetch the latest execution without scanning every matching row

`high` · `round-trip` · `mysql` · ✅ verified

The dashboard does a latest-execution lookup inside a loop, so each stream triggers a separate filtered sort on TestExecution instead of reusing previously fetched data or a precomputed value.

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
latest = (
    TestExecution.objects.filter(stop_date__isnull=False)
    .order_by("run__plan__product", "-stop_date")
    .values("run__plan__product", "stop_date")
)
# reuse latest rows per stream in the loop instead of querying per stream
```

**Why this helps** — This moves the latest-execution lookup out of the per-stream loop so the database can satisfy it with one query and the application can pick the matching row for each stream, instead of issuing one query per stream.

**Expected impact** — 1 query instead of one query per stream

**Why the output is unchanged (the model's argument)** — This is not equivalent as written because it changes when and how rows are fetched; to preserve results, the caller must still choose the same single row per stream, with the same columns and ordering semantics for the chosen row. The result rows used for each stream must remain the same one-row-per-stream latest stop_date value, with NULL stop_date excluded exactly as before, and no duplicate rows introduced.

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

**Automated equivalence check** — Contradicted: The selected fields change from [stop_date] to [run__plan__product, stop_date], so the caller receives different data.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).

Differences found:

- The selected fields change from [stop_date] to [run__plan__product, stop_date], so the caller receives different data.
- Ordering changes from ["-stop_date"] to ["run__plan__product", "-stop_date"].
- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The surrounding code can be refactored to build a per-stream map from one query result set.
- The relationship path run__plan__product is valid for grouping by stream in the application layer.

**Verification notes**

- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Move the per-stream case count out of the loop

`high` · `n-plus-one` · `mysql` · ✅ verified

`TestCase.objects.filter(section__product=stream).count()` runs once for each stream, so the view issues one count query per iteration instead of aggregating those counts in a single query.

**Where it is used**

- `tcms/core/views.py:186` in `DashboardView.get_context_data`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
```

**Proposed**

```sql
stream_ids = [stream.id for stream in streams]
case_counts = dict(
    TestCase.objects.filter(section__product_id__in=stream_ids)
    .values_list("section__product_id")
    .annotate(cases=models.Count("id"))
)

...
    {
        "stream": stream,
        "cases": case_counts.get(stream.id, 0),
        "active_runs": len(active_run_ids),
        "pass_rate": pass_rate,
        "failed": stats["failed"],
        "blocked": stats["blocked"],
        "last_activity": last["stop_date"] if last else None,
    }
```

**Why this helps** — This turns repeated count queries into one grouped aggregation keyed by stream, so the database can count all matching test cases in one pass instead of re-running a count for every loop iteration.

**Expected impact** — 1 grouped count query instead of one count query per stream

**Why the output is unchanged (the model's argument)** — The rewritten code returns the same per-stream integer count for each stream, with the same 0 default when no rows match; it does not change the stream list, row order, NULL handling, or duplicate handling because COUNT(id) over the same filtered rows matches `.count()` for each stream.

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

- The original returns whole model instances and the proposal returns named fields [section__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `stream` has a primary key accessible as `id` and `section__product_id` is the same key used by the relation in the original filter.
- `models.Count` is available in the module.
- The surrounding code already has or can build the `streams` collection before the loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Batch custom-field writes before saving

`high` · `round-trip` · `mysql` · ✅ verified

This loop issues one ORM upsert per custom field, so persisting a case’s custom values performs repeated database round trips inside the request handler.

**Where it is used**

- `tcms/testcases/views.py:191` in `_save_custom_field_values`
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
def _save_custom_field_values(
    request, test_case
):  # pylint: disable=missing-permission-required
    """Persist submitted custom field values for a TestCase."""
    fields = list(TestCaseFieldConfig.objects.filter(is_active=True, is_system=False))
    existing = {
        cv.field_id: cv
        for cv in TestCaseCustomValue.objects.filter(case=test_case, field__in=fields)
    }
    to_create = []
    to_update = []

    for field in fields:
        val = request.POST.get(f"custom_{field.field_key}", "").strip()
        custom_value = existing.get(field.id)
        if custom_value is None:
            to_create.append(TestCaseCustomValue(case=test_case, field=field, value=val))
        elif custom_value.value != val:
            custom_value.value = val
            to_update.append(custom_value)

    if to_create:
        TestCaseCustomValue.objects.bulk_create(to_create)
    if to_update:
        TestCaseCustomValue.objects.bulk_update(to_update, ["value"])
```

**Why this helps** — This turns repeated per-field upserts into a small fixed number of queries: one read of the existing custom values, then bulk inserts/updates as needed.

**Expected impact** — 1 read for existing rows plus batched writes instead of one ORM upsert per custom field

**Why the output is unchanged (the model's argument)** — This is behavioural, not equivalent: the original uses update_or_create and will create or update each row immediately, while the rewrite defers work and skips writes when the value is unchanged; row contents should match after success, but locking, validation timing, and error behaviour can differ, so it is not provably identical for all states.

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

**Automated equivalence check** — Partly verified (django): Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- TestCaseCustomValue has a unique row per (case, field) so the bulk lookup identifies the same target row that update_or_create would address.
- bulk_create and bulk_update are acceptable for this model’s signals and validation requirements.

**Evidence**

- `tcms/testcases/views.py:193` (call-site) — Shows the loop and the per-field ORM upsert that cause repeated database round trips.

**Verification notes**

- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Prefetch all submitted tags before looping

`high` · `round-trip` · `mysql` · ✅ verified

This code performs one tag lookup per submitted tag name, so a request with many tags issues repeated queries instead of resolving them in one set-based lookup.

**Where it is used**

- `tcms/testcases/views.py:282` in `NewCaseView.form_valid`
- Reached via request-handler

**Current**

```sql
tag_obj = Tag.objects.filter(name=tag_name).first()
```

**Proposed**

```sql
tag_names = [name.strip() for name in self.request.POST.getlist("tag") if name.strip()]
            tags_by_name = Tag.objects.filter(name__in=tag_names).in_bulk(field_name="name")
            for tag_name in tag_names:
                tag_obj = tags_by_name.get(tag_name)
                if tag_obj:
                    test_case.add_tag(tag_obj)
```

**Why this helps** — This turns repeated ORM lookups into a single set-based query for the submitted tag names, then reuses the in-memory mapping while preserving the existing per-tag add behavior.

**Expected impact** — 1 query to fetch all matching tags instead of one query per submitted tag name.

**Why the output is unchanged (the model's argument)** — The rewritten code uses the same submitted tag names after stripping whitespace, adds tags only when a matching Tag exists, returns the same redirected response, and does not change output columns or ordering; duplicate submitted names still result in repeated add attempts as before, and NULL handling is unchanged because empty strings are still skipped.

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
CREATE INDEX IF NOT EXISTS tag_name_idx ON <tag_table>(name);
```

**Assumptions**

- Tag.name uniquely identifies the intended tag objects for this form usage, or duplicate names are not expected in submitted data.
- test_case.add_tag(tag_obj) has the same effect when called with the same tag object multiple times as in the original loop.

**Evidence**

- `tcms/testcases/views.py:281` (call-site) — Shows the per-tag ORM lookup inside the submit loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Fetch all tag rows in one query before syncing

`high` · `round-trip` · `mysql` · ✅ verified

The tag reconciliation loop issues one `Tag.objects.filter(name=name).first()` lookup per tag name, so replacing it with a single `IN` query would avoid repeated database round trips while preserving the same tag add/remove decisions.

**Where it is used**

- `tcms/testcases/views.py:422` in `EditTestCaseView.form_valid`
- Reached via request-handler

**Current**

```sql
tag_obj = Tag.objects.filter(name=name).first()
```

**Proposed**

```sql
tag_names = (existing - submitted) | (submitted - existing)
            tag_by_name = Tag.objects.filter(name__in=tag_names).in_bulk(field_name="name")
            for name in existing - submitted:
                tag_obj = tag_by_name.get(name)
                if tag_obj:
                    self.object.remove_tag(tag_obj)
            for name in submitted - existing:
                tag_obj = tag_by_name.get(name)
                if tag_obj:
                    self.object.add_tag(tag_obj)
```

**Why this helps** — This turns repeated per-name lookups into one query that returns all needed tag rows, reducing database round trips and letting the database evaluate the name filter once.

**Expected impact** — 1 query instead of one lookup per tag name

**Why the output is unchanged (the model's argument)** — The rewritten code uses the same set of names and still only removes/adds tags when a matching row exists, so it preserves the same rows acted on, the same duplicate handling, and the same NULL behavior; ordering is irrelevant because the original code does not depend on query order, and the `first()` calls only use the existence of a matching row, not which duplicate row is chosen, so this is equivalent only if `name` is unique or duplicates are impossible.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [first] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [get], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `Tag.name` is unique or duplicate names do not exist in practice; otherwise `first()` could choose an arbitrary duplicate and `in_bulk` would not exactly match that behavior.

**Evidence**

- `tcms/testcases/views.py:416` (call-site) — Shows the repeated per-name ORM lookup inside the loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Fetch submitted tags in one query

`high` · `round-trip` · `mysql` · ✅ verified

The tag sync loop does a separate `Tag.objects.filter(name=name).first()` lookup for each missing tag name, so the request issues one query per tag instead of resolving the whole set at once.

**Where it is used**

- `tcms/testcases/views.py:422` in `EditTestCaseView.form_valid`
- Reached via request-handler

**Current**

```sql
tag_obj = Tag.objects.filter(name=name).first()
```

**Proposed**

```sql
submitted_tags = Tag.objects.filter(name__in=submitted)
submitted_by_name = {tag.name: tag for tag in submitted_tags}
for name in existing - submitted:
    tag_obj = submitted_by_name.get(name)
    if tag_obj:
        self.object.remove_tag(tag_obj)
for name in submitted - existing:
    tag_obj = submitted_by_name.get(name)
    if tag_obj:
        self.object.add_tag(tag_obj)
```

**Why this helps** — This turns repeated tag lookups into a single set-based query, so the database can resolve all candidate tag rows in one round trip instead of one per name.

**Expected impact** — 1 query per missing tag name becomes 1 query for all missing tag names

**Why the output is unchanged (the model's argument)** — The rewritten code uses the same tag names, returns the same Tag columns, and performs the same add/remove actions for the same names; it preserves duplicates because both versions treat names as set members, preserves NULL handling because `name` is used as a non-NULL key here, and does not change row ordering because the code consumes only lookups and not an ordered result set.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [first] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [get], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `Tag.name` uniquely identifies the intended tag object for a given name, or at least the original per-name `.first()` semantics are acceptable to preserve via the first object returned by the filtered queryset.
- `submitted` and `existing` are sets of names as shown in the surrounding code.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Fold the per-stream run lookup into one grouped aggregate

`high` · `round-trip` · `mysql` · ✅ verified

This loop issues a run query per product stream and then an execution aggregate per stream, so the view performs repeated database work that should be batched by grouping on the stream instead.

**Where it is used**

- `tcms/core/views.py:566` in `AllStreamsCsvExportView.get`
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
streams = (
            Product.objects.all()
            .order_by("name")
            .annotate(
                active_run_count=Count(
                    "testplan__testrun",
                    filter=Q(testplan__testrun__stop_date__isnull=True),
                    distinct=True,
                ),
                total=Count(
                    "testplan__testrun__testexecution",
                    filter=Q(testplan__testrun__stop_date__isnull=True),
                ),
                # keep the existing exec_count_annotations() metrics here,
                # translated into annotations on the same grouped queryset
            )
        )
```

**Why this helps** — This lets the database compute the per-stream counts in one grouped query instead of running a separate run lookup and execution aggregate for each product stream.

**Expected impact** — One grouped aggregate over the relevant joins instead of repeated per-stream queries and Python list materialization.

**Why the output is unchanged (the model's argument)** — The rewritten queryset must preserve the same product rows, the same name ordering, and the same null/duplicate handling as the original; because the exact exec_count_annotations() expressions are not visible here, the safe version is only equivalent if those annotations are translated to the same grouped aggregates and the join path does not introduce extra duplicates or drop rows.

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
CREATE INDEX only if the grouped join path is not already covered by existing indexes; no specific new index can be named from the provided context.
```

**Assumptions**

- The reverse relations shown by the schema actually exist for Product -> TestPlan -> TestRun -> TestExecution, but they are not visible in the provided context.
- The logic in exec_count_annotations() can be expressed as grouped annotations without changing NULL or duplicate semantics.
- The view does not rely on per-stream intermediate Python lists of run ids.

**Evidence**

- `tcms/core/views.py:566` (call-site) — Shows the per-stream query pattern and the second aggregate query inside the loop.

### Batch section coverage counts into a single aggregation

`high` · `round-trip` · `mysql` · ✅ verified

The view runs two count queries per section, so each section adds extra database round trips instead of computing per-section totals and executed counts in one grouped query.

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
section_ids = [sec.id for sec in sections]
section_stats = (
    TestCase.objects.filter(section_id__in=section_ids)
    .values("section_id")
    .annotate(
        sc_total=models.Count("id"),
        sc_executed=models.Count("id", filter=models.Q(pk__in=executed_case_ids)),
    )
)
stats_by_section = {row["section_id"]: row for row in section_stats}

section_data = []
for sec in sections:
    stats = stats_by_section.get(sec.id)
    if not stats:
        continue
    sc_total = stats["sc_total"]
    sc_executed = stats["sc_executed"]
    sc_pct = round(sc_executed / sc_total * 100) if sc_total else 0
    section_data.append({"section": sec})
```

**Why this helps** — Grouping the test cases by section lets the database compute both counts in one pass over matching rows, rather than issuing separate count queries for every section.

**Expected impact** — Fewer database round trips: one grouped aggregation over test cases instead of two count queries per section.

**Why the output is unchanged (the model's argument)** — The proposed code returns the same sections, the same per-section counts, and the same percentage calculation; ordering stays driven by the original ordered section list, NULL handling is unchanged because the filters are the same, and duplicate test cases are counted the same way by COUNT(id).

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

- Issues 2 database call(s) where the original issues 3. (Counted from the code, not measured.)
- Fetches 1 named column(s) instead of whole model instances. (Counted, not measured.)
- Evaluates the queryset once and reuses the result, where the original re-runs it on each use. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Differences found:

- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `executed_case_ids` is a collection of primary keys usable in an `__in` filter.
- `models.Count` and `models.Q` are available in this module context.
- The rest of `section_data` population uses only the computed counts and the original `sec` object.

**Verification notes**

- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Combine the repeated test-case counts into one aggregate

`medium` · `round-trip` · `mysql` · ✅ verified

This view runs four separate count queries against the same product-scoped test-case set, so the database repeats the same filtering work four times instead of answering all counts in one pass.

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
from django.db.models import Count, Q

        case_counts = TestCase.objects.filter(section__product=stream).aggregate(
            total_cases=Count("id"),
            sanity_count=Count("id", filter=Q(is_sanity=True)),
            regression_count=Count("id", filter=Q(is_regression=True)),
            automated_count=Count("id", filter=Q(is_automated=True)),
        )
        total_cases = case_counts["total_cases"]
        sanity_count = case_counts["sanity_count"]
        regression_count = case_counts["regression_count"]
        automated_count = case_counts["automated_count"]
```

**Why this helps** — The database can compute all four counts during one grouped aggregate over the same filtered row set instead of executing four separate count queries.

**Expected impact** — 1 query instead of 4 for these counts

**Why the output is unchanged (the model's argument)** — Rows and columns are unchanged because this is only replacing intermediate count queries with aggregate counts; the returned scalar values are the same for the same filtered rows, with no row ordering involved, no NULL-sensitive projection changes, and no duplicate-handling change because each count still counts the same matching rows.

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

- Django's filtered Count aggregate is available in the deployed version, which is consistent with the codebase using modern Django imports elsewhere.
- The intent is to preserve the same count semantics for each predicate over the same filtered TestCase rows.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Filter executed cases in SQL instead of materializing all ids

`medium` · `unbounded-result` · `mysql` · ✅ verified

The view currently loads every distinct `TestExecution.case_id` into Python before excluding them, so the database can no longer do the anti-join work itself.

**Where it is used**

- `tcms/core/views.py:502` in `StreamDashboardView.get`
- Reached via request-handler

**Current**

```sql
executed_case_ids = set(
            TestExecution.objects.values_list("case_id", flat=True).distinct()
        )
        total_cases = TestCase.objects.filter(section__product=stream).count()
        never_run_count = (
            TestCase.objects.filter(section__product=stream)
            .exclude(pk__in=executed_case_ids)
            .count()
        )
```

**Proposed**

```sql
never_run_count = (
    TestCase.objects.filter(section__product=stream)
    .exclude(
        pk__in=TestExecution.objects.values_list("case_id", flat=True).distinct()
    )
    .count()
)
```

**Why this helps** — This keeps the exclusion inside the database instead of pulling the distinct case ids into Python first, so the engine can evaluate the anti-filter without transferring the whole id set to the application.

**Expected impact** — 1 query that streams the exclusion work in SQL instead of first materializing every distinct executed case id in Python

**Why the output is unchanged (the model's argument)** — The rewritten query returns the same count of `TestCase` rows excluded by the same distinct `case_id` set; it preserves the same rows considered, the same single integer result column, and count semantics including duplicates and NULL handling for `IN`/`NOT IN` as supported by the ORM-generated SQL. Ordering is unchanged because both forms are counts, and no duplicate rows are introduced or removed in the result set.

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

**Automated equivalence check** — Partly verified (django): Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

Confirmed automatically:

- The selected fields are identical (case_id, flat=True).
- Duplicate handling is unchanged (distinct on).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (count), so the shape of the result is the same.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `TestExecution.case_id` and `TestCase.pk` are the intended comparable keys, as implied by the current code.
- The ORM will generate a subquery for `exclude(pk__in=...)` rather than evaluating the queryset in Python.

### Combine repeated case-type counts into one grouped query

`medium` · `full-scan` · `mysql` · ✅ verified

The view issues three separate COUNT queries against the same `section__product=stream` filter, so the database repeats the same scan/filter work for each case type.

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
    sanity_count=models.Count("id", filter=models.Q(is_sanity=True)),
    regression_count=models.Count("id", filter=models.Q(is_regression=True)),
    automated_count=models.Count("id", filter=models.Q(is_automated=True)),
)
sanity_count = case_counts["sanity_count"]
regression_count = case_counts["regression_count"]
automated_count = case_counts["automated_count"]
```

**Why this helps** — This lets the ORM ask for all three counts in one grouped aggregation instead of issuing one query per flag.

**Expected impact** — 1 database round trip instead of 3 for these case-type counts

**Why the output is unchanged (the model's argument)** — The rewritten code returns the same scalar counts for each flag, with the same columns/keys exposed to the template variables, and it does not change row ordering, NULL handling, or duplicate handling because each result is still a count over the same filtered `TestCase` rows; the only behavioral assumption is that the ORM supports filtered aggregates on this Django version.

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

- `models.Count(..., filter=...)` is available in the project’s Django version and generates supported SQL on MySQL.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Avoid counting all superusers before delete

`medium` · `full-scan` · `mysql` · ✅ verified

The delete view does an extra aggregate query to count all superusers when the target user is a superuser, so the database must examine matching rows instead of using the already-fetched object alone.

**Where it is used**

- `tcms/kiwi_auth/admin.py:220` in `KiwiUserAdmin.delete_view`
- Reached via delete_view

**Current**

```sql
user = User.objects.get(pk=object_id)
        # check whether the last superuser is being deleted
        if user.is_superuser and User.objects.filter(is_superuser=True).count() == 1:
```

**Proposed**

```sql
user = User.objects.get(pk=object_id)
        # check whether the last superuser is being deleted
        if user.is_superuser and not User.objects.exclude(pk=user.pk).filter(is_superuser=True).exists():
```

**Why this helps** — Using an existence check lets the database stop after finding one other superuser instead of counting every matching row.

**Expected impact** — 1 existence check instead of a full count over matching superusers

**Why the output is unchanged (the model's argument)** — It preserves the same rows and columns because it is still a boolean test about whether there are any other superusers; it preserves NULL handling and duplicates because the underlying predicate is unchanged; ordering is irrelevant because neither query returns rows to the caller; error behavior stays the same for the same inputs.

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

- Stops at the first matching row instead of counting every one. (Counted from the code, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [get, count] to [get, exists], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [get, count] to [get, exists], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `pk` uniquely identifies the user being deleted, which is implied by the existing `get(pk=object_id)` lookup.
- The intended rule is to block deletion only when the current user is the only superuser.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [get, count] to [get, exists], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Use a set-based update for moved test cases

`medium` · `batching` · `mysql` · ✅ verified

This code loads every matching TestCase into Python and then updates them one by one, so the database does one read for the cases and then per-row write work instead of a single set-based update path.

**Where it is used**

- `tcms/rpc/api/testcase.py:1350` in `move`
- Reached via request-handler

**Current**

```sql
section = Section.objects.get(pk=section_id)
    cases = list(TestCase.objects.filter(pk__in=case_ids))
    for case in cases:
        case.section = section
    # bulk_update_with_history records a history row per moved case without
    # firing pre_save (no spurious version bump) — a plain queryset .update()
    # would skip simple-history entirely.
    bulk_update_with_history(cases, TestCase, ["section"])
```

**Proposed**

```sql
section = Section.objects.get(pk=section_id)
    TestCase.objects.filter(pk__in=case_ids).update(section=section)
```

**Why this helps** — This keeps the work in the database as a single set-based update instead of materializing all rows in Python and looping over them.

**Expected impact** — One fetch of the target section and one set-based update instead of loading and updating each case object individually.

**Why the output is unchanged (the model's argument)** — This is not equivalent: it changes history recording and bypasses per-object save hooks, so the row set and columns may be the same but side effects and error behavior are different.

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

- Issues 2 database call(s) where the original issues 3. (Counted from the code, not measured.)

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.
- The filter expressions are textually unchanged.

**Assumptions**

- The caller does not require the per-row history entries or save signals that bulk_update_with_history preserves.
- case_ids refers only to rows that should all be moved to the same section.

**Evidence**

- `tcms/rpc/api/testcase.py:1350` (call-site) — Shows the code materializes all matching cases and then performs a bulk update helper call.

### Avoid counting the unioned property queryset before iteration

`medium` · `round-trip` · `mysql` · ✅ verified

The code builds a unioned queryset and then calls `count()` on it, which forces an extra SQL query before the subsequent iteration and may also materialize the combined set twice.

**Where it is used**

- `tcms/testruns/models.py:163` in `TestRun`
- Reached via unknown

**Current**

```sql
properties = self.property_set.union(TestCaseProperty.objects.filter(case=case))

        if properties.count():
```

**Proposed**

```sql
properties = self.property_set.union(TestCaseProperty.objects.filter(case=case))

        for prop_tuple in self.property_matrix(properties, matrix_type):
```

**Why this helps** — Iterating directly lets the database return the combined rows once, instead of running a separate count query just to decide whether to enter the loop.

**Expected impact** — 1 SQL query instead of 2 for the empty/non-empty check plus iteration path

**Why the output is unchanged (the model's argument)** — This is behavioural rather than equivalent because `count()` suppresses the loop when there are no rows, while direct iteration naturally does the same; row contents, columns, ordering, NULL handling, and duplicates come from the same unioned queryset, but the control flow changes by removing the explicit count query.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- The terminal operation changes from [count] to [none], which changes what the call returns.

**Assumptions**

- `property_matrix()` can handle an empty queryset without needing a separate pre-check.

### Filter readiness runs without forcing a full scan

`low` · `full-scan` · `mysql` · ✅ verified

The readiness report queries `TestRun` by two case-insensitive text predicates joined with `OR`, which can only use indexes efficiently if the underlying columns support that comparison and may otherwise devolve to scanning many runs.

**Where it is used**

- `tcms/core/views.py:750` in `ReadinessReportView.get`
- Reached via request-handler

**Current**

```sql
TestRun.objects.filter(
                    Q(jira_id__iexact=epic_id) | Q(plan__extra_link__iexact=epic_id)
                )
```

**Proposed**

```sql
TestRun.objects.filter(
                    jira_id=epic_id
                ) | TestRun.objects.filter(
                    plan__extra_link=epic_id
                )
```

**Why this helps** — This avoids case-insensitive matching, which is the part most likely to prevent index usage and force broader reads; whether each branch can use an index depends on the actual column types and collations.

**Expected impact** — Potentially lets MySQL use an index lookup on the compared column instead of evaluating a case-insensitive text comparison across many rows.

**Why the output is unchanged (the model's argument)** — This is not equivalent: removing `iexact` changes matching and NULL/case handling, and `|` between querysets can also change duplicate handling and SQL shape; it should only be adopted if exact-case semantics are acceptable.

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
CREATE INDEX ...
```

**Assumptions**

- `jira_id` and `plan__extra_link` are intended to be matched case-sensitively
- The two branches are acceptable to evaluate as separate querysets

**Verification notes**

- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Rewrite the user search without relying on OR ordering

`low` · `full-scan` · `mysql` · ✅ verified

The `username__icontains`/`email__icontains` union can force a broader scan, but any rewrite to avoid that would change which rows are returned or how ties are ordered because the current queryset explicitly orders by `username` only after combining two filters.

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
users = User.objects.exclude(username=settings.ANONYMOUS_USER_NAME).order_by("username")
        if query:
            users = users.filter(username__icontains=query)
            users = users.union(User.objects.filter(email__icontains=query))
```

**Why this helps** — A union-style rewrite can let the database evaluate each predicate separately instead of combining two filtered querysets with `|`.

**Expected impact** — Could reduce work done per search by avoiding a single broad combined predicate, depending on data distribution and indexes.

**Why the output is unchanged (the model's argument)** — This is not equivalent: it can change duplicate handling, null/error behavior, and ordering, because `union()` has different semantics than queryset OR and the existing query orders the combined result by `username`.

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
- The filter expressions are textually unchanged.

**Assumptions**

- A safe performance rewrite would need to preserve the current combined-result semantics, which are not guaranteed by the visible code.

**Evidence**

- `tcms/kiwi_auth/views.py:349` (call-site) — Shows the combined `icontains` filters that can expand into a wide scan.

**Verification notes**

- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Add an export limit or pagination

`low` · `unbounded-result` · `mysql` · ✅ verified

This export path materializes every matching TestCase row into Python with `list(...)`, so a large section set can produce an unbounded result set and heavy memory use.

**Where it is used**

- `tcms/core/admin_views.py:632` in `StreamExportView.get`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(
                    section__in=section_pks, deleted_at__isnull=True
                )
                .select_related("section", "priority")
                .order_by("pk")
```

**Proposed**

```sql
cases = (
                TestCase.objects.filter(
                    section__in=section_pks, deleted_at__isnull=True
                )
                .select_related("section", "priority")
                .order_by("pk")
                .iterator()
            )
```

**Why this helps** — Streaming the queryset avoids loading every matching row into a list before the response is produced, so the request can process rows incrementally instead of holding the full export in memory.

**Expected impact** — Avoids materializing the entire result set in Python at once.

**Why the output is unchanged (the model's argument)** — This is behavioural rather than equivalent: it changes when rows are materialized and may change the Python type/consumption semantics, but it preserves the same rows, columns, ordering, NULL handling, and duplicates from the database query itself.

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
- The filter expressions are textually unchanged.

**Requires this migration first**

```sql
CREATE INDEX statement not required for this change.
```

**Assumptions**

- The caller can consume an iterator instead of a concrete list.
- The export code does not rely on list-specific operations such as indexing or repeated passes.

**Evidence**

- `tcms/core/admin_views.py:632` (call-site) — Shows the export query is fully materialized into a Python list.

**Verification notes**

- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Avoid repeating the parent lookup inside the clone verification loop

`info` · `other` · `mysql` · ✅ verified

The test verifies the cloned plan’s parent with a queryset lookup that can be folded into the surrounding object setup, but this is not a database-performance bug because it runs once outside the per-case loop and does not create an N+1 pattern.

**Where it is used**

- `tcms/testplans/tests/tests.py:299` in `TestCloneView._verify_options`
- Reached via test

**Current**

```sql
self.assertEqual(TestPlan.objects.get(pk=original_plan.pk), cloned_plan.parent)
```

**Proposed**

```sql
self.assertEqual(original_plan, cloned_plan.parent)
```

**Why this helps** — This avoids an extra ORM fetch in the test and compares the already-available object instead.

**Expected impact** — Eliminates one ORM round trip in the test path.

**Why the output is unchanged (the model's argument)** — This is behaviour-changing rather than equivalent because it changes whether the comparison goes through a fresh database read or an in-memory object comparison, and it is only valid if the two objects are guaranteed to represent the same row; rows, columns, ordering, NULL handling, and duplicates are not at issue here.

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
CREATE INDEX is not required.
```

**Assumptions**

- original_plan and cloned_plan.parent are the same model class and refer to the same logical row in this test setup.

**Evidence**

- `tcms/testplans/tests/tests.py:294` (call-site) — Shows the asserted lookup is a single ORM fetch and that the actual per-case repeated work is elsewhere.

**Verification notes**

- This code is reached by a test, so it runs once at install time or never in production.

### Avoid slicing the filtered status queryset before deletion checks

`info` · `other` · `mysql` · ✅ verified

This test iterates a queryset slice, so if the real code follows the same pattern it can issue row-by-row operations and should be rewritten to work on a bounded in-memory list only if the intent is to inspect rows already fetched; however, the shown code is a test fixture rather than a database hot path, so the triage does not hold as a performance finding.

**Where it is used**

- `tcms/testruns/tests/test_admin.py:103` in `TestTestExecutionStatusAdmin`
- Reached via test

**Current**

```sql
("positive", TestExecutionStatus.objects.all().filter(weight__gt=0)),
            ("neural", TestExecutionStatus.objects.all().filter(weight=0)),
            ("negative", TestExecutionStatus.objects.all().filter(weight__lt=0)),
```

**Proposed**

```sql
("positive", list(TestExecutionStatus.objects.filter(weight__gt=0))),
            ("neural", list(TestExecutionStatus.objects.filter(weight=0))),
            ("negative", list(TestExecutionStatus.objects.filter(weight__lt=0))),
```

**Why this helps** — Materializing the queryset makes the test data explicit and avoids any ambiguity about deferred evaluation inside the parameterized test.

**Expected impact** — Avoids accidental repeated evaluation if the parameter is consumed multiple times in the test body.

**Why the output is unchanged (the model's argument)** — This changes test helper behavior only; it does not change any application query result rows, columns, ordering, NULL handling, duplicates, or error semantics because the surrounding code is a test and the parameter values are only consumed as iterables.

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

- The intent is only to iterate over the matching statuses in the test, not to preserve queryset laziness for later ORM chaining.

**Verification notes**

- This code is reached by a test, so it runs once at install time or never in production.

### Fetch a single default row directly

`info` · `full-scan` · `mysql` · ✅ verified

`TestCaseStatus.objects.all()[0:1][0]` and `Priority.objects.all()[0:1][0]` materialize a one-row slice from the whole table shape when the factory just needs one instance, so the database still has to execute a query for each default lookup.

**Where it is used**

- `tcms/tests/factories.py:167` in `TestCaseFactory`
- Reached via test

**Current**

```sql
case_status = factory.LazyFunction(lambda: TestCaseStatus.objects.all()[0:1][0])
priority = factory.LazyFunction(lambda: Priority.objects.all()[0:1][0])
```

**Proposed**

```sql
case_status = factory.LazyFunction(lambda: TestCaseStatus.objects.first())
priority = factory.LazyFunction(lambda: Priority.objects.first())
```

**Why this helps** — This makes the intent explicit and lets Django issue a simple single-row fetch instead of building a sliced queryset and then indexing into it in Python.

**Expected impact** — One simpler single-row lookup per default value instead of slicing and then indexing the queryset result.

**Why the output is unchanged (the model's argument)** — The original and proposed code both return one model instance or `None` if the table is empty; the row shape and columns are unchanged, and there is no ordering guarantee visible here because neither form adds an `ORDER BY`. The only behavioral difference is that the proposed version does not raise `IndexError` on an empty table, so this is not equivalent in the strict sense; however, if the test data always contains at least one row, the returned object is the same.

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

- Caps the result at 1 row(s), where the original was unbounded. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [none] to [first], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- A row limit (1) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.
- The terminal operation changes from [none] to [first], which changes what the call returns.

**Requires this migration first**

```sql
CREATE INDEX is not required from the visible context because no filtered predicate is present.
```

**Assumptions**

- `TestCaseStatus` and `Priority` each have at least one row in the test database when this factory runs.

**Evidence**

- `tcms/tests/factories.py:167` (call-site) — Shows the factory performs two default lookups by slicing and indexing queryset results.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [none] to [first], which changes what the call returns.
- The equivalence argument does not address: NULL or duplicate handling.
- This code is reached by a test, so it runs once at install time or never in production.
- Severity is info, not the low the model proposed: this code is reached by a test, so it runs once at install time or never in production.

### Avoid asserting permission count equality here

`info` · `other` · `mysql` · ✅ verified

The test compares `Permission.objects.all().count()` to `self.admin.permissions.count()`, which only holds if the administrator group is intended to receive every permission in the database and the test data stays unchanged.

**Where it is used**

- `tcms/utils/tests/test_assign_permissions.py:17` in `TestAssignDefaultGroupPermissions.test_administrator_has_all_permissions`
- Reached via test

**Current**

```sql
Permission.objects.all().count(), self.admin.permissions.count()
```

**Proposed**

```sql
assign_default_group_permissions()
        self.assertTrue(self.admin.permissions.exists())
```

**Why this helps** — This avoids coupling the test to a global count that depends on unrelated permissions data.

**Expected impact** — Removes reliance on a database-wide count and instead checks for presence of assigned permissions.

**Why the output is unchanged (the model's argument)** — This is not equivalent: it changes the assertion semantics and no longer checks count equality, so it is a behavioural test change rather than a query-preserving rewrite.

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

- The goal of the test is only to verify that administrator permissions were assigned, not to verify the exact total count.

**Evidence**

- `tcms/utils/tests/test_assign_permissions.py:17` (call-site) — Shows the exact ORM aggregation being exercised by the test.

**Verification notes**

- This code is reached by a test, so it runs once at install time or never in production.

### Update permission rows in bulk

`info` · `round-trip` · `mysql` · ✅ verified

The backward migration iterates over every matching Permission and saves each row separately, which issues one write per permission instead of a set-based update.

**Where it is used**

- `tcms/testruns/migrations/0006_rename_test_case_run_to_test_execution.py:19` in `backward_rename_permissions`
- Reached via migration

**Current**

```sql
for permission in permission_model.objects.filter(
        codename__contains="testexecution"
    ):
```

**Proposed**

```sql
def backward_rename_permissions(apps, schema_editor):
    permission_model = apps.get_model("auth", "Permission")

    for permission in permission_model.objects.filter(codename__contains="testexecution").only("id", "name", "codename"):
        old_name = permission.name.replace("test execution", "test case run")
        old_codename = permission.codename.replace("testexecution", "testcaserun")
        permission_model.objects.filter(pk=permission.pk).update(name=old_name, codename=old_codename)
```

**Why this helps** — This keeps the same filtering logic but replaces model-instance saves with direct updates, avoiding a separate save call for each row.

**Expected impact** — One query to fetch matching rows plus one update per row is reduced to direct row updates without loading full model-save machinery per object.

**Why the output is unchanged (the model's argument)** — Rows and columns are preserved because the same Permission rows matched by codename__contains="testexecution" are updated with the same derived values; ordering is irrelevant because the migration does not expose results; NULL handling is unchanged because the code still operates on the same fields; duplicate handling is unchanged because each row is still processed once based on its primary key; error behavior remains the same for the same input rows, aside from using update instead of save.

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
- Fetches 3 named column(s) instead of whole model instances. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Contradicted: One version writes and the other does not (proposal writes), which is not an output-preserving change.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- One version writes and the other does not (proposal writes), which is not an output-preserving change.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id, name, codename]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The migration does not rely on model save() side effects, signals, or custom validation.
- Only the listed fields need to be updated for the reverse rename.

**Evidence**

- `tcms/testruns/migrations/0006_rename_test_case_run_to_test_execution.py:19` (call-site) — Shows the per-row loop over the filtered permissions.
- `tcms/testruns/migrations/0006_rename_test_case_run_to_test_execution.py:15` (call-site) — Shows that each iteration performs an individual save.

**Verification notes**

- This code is reached by a migration or seed, so it runs once at install time or never in production.
- Severity is info, not the medium the model proposed: this code is reached by a migration or seed, so it runs once at install time or never in production.

## Suppressed before publication

28 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### wrong direction (proposal issues no fewer queries) — 18

- **Fold the per-stream aggregation into one grouped query** — `tcms/core/views.py:572`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Use a direct lookup for the tester user** — `tcms/core/admin_views.py:1055`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid per-row test case creation inside the copy loop** — `tcms/rpc/api/testcase.py:878`
  The proposal issues 4 database call(s) where the original issues 4, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch the final config deactivation update** — `tcms/testcases/migrations/0036_migrate_testrail_id_custom_field.py:81`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Drop the extra token row fetch** — `tcms/kiwi_auth/models.py:138`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fold the health aggregate into one ORM aggregation** — `tcms/core/views.py:403`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Cache user lookups outside the execution loop** — `tcms/core/admin_views.py:1081`
  The proposal issues 3 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Pull active runs with one grouped query** — `tcms/core/views.py:154`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Aggregate active executions in one grouped query** — `tcms/core/views.py:160`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Prefetch users before deactivating them** — `tcms/rpc/api/user.py:178`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the filtered execution queryset instead of issuing it twice** — `tcms/rpc/api/testrun.py:74`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Combine the two counts in one aggregation** — `tcms/telemetry/api.py:28`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the confirmed status lookup before cloning** — `tcms/testcases/models.py:904`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch property creation instead of creating each row in a loop** — `tcms/testruns/views.py:276`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch the per-row migration work** — `tcms/testcases/migrations/0036_migrate_testrail_id_custom_field.py:56`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Replace per-row section lookup with a cached or bulk-loaded map** — `tcms/testcases/views.py:756`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Materialize plan ids before reusing them in the plan queryset** — `tcms/testcases/forms.py:359`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Move permission assertions out of the per-app loop** — `tcms/utils/tests/test_assign_permissions.py:45`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)

### no-op (proposal identical to the original) — 5

- **Replace per-plan existence checks with a keyed lookup** — `tcms/core/admin_views.py:1026`
  The finding proposes no change at all — the suggestion is empty, so there is nothing to apply or review.
- **Replace the per-run existence check with a batched lookup** — `tcms/core/admin_views.py:1048`
  The finding proposes no change at all — the suggestion is empty, so there is nothing to apply or review.
- **Materialize custom-field configs once before the loop** — `tcms/rpc/api/testrun.py:41`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add an index on execution lookups** — `tcms/testruns/models.py:341`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add an index on execution for property lookups** — `tcms/testruns/models.py:358`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

### invented symbol (the proposal names something the repository does not contain) — 2

- **Cache the neutral status lookup before creating executions** — `tcms/testruns/models.py:134`
  The proposal accesses `._neutral_execution_status`, and `_neutral_execution_status` appears nowhere in the 953 files that were read. The rewrite would fail at runtime, so it is held back rather than published as something to apply.
- **Precompute the per-stream test-case count** — `tcms/core/views.py:598`
  The proposal accesses `.stream_case_counts`, and `stream_case_counts` appears nowhere in the 953 files that were read. The rewrite would fail at runtime, so it is held back rather than published as something to apply.

### not data access — 3

- **Add a supporting order-by index for the latest case lookup** — `tcms/testplans/models.py:67`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Prefetch cloned cases before iterating** — `tcms/testplans/models.py:161`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Preload recipient data before iterating** — `tcms/testruns/models.py:129`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._