# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 2:30:43 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 871 analysed · 2 filtered (below confidence 0 · low priority 2) · 40 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 31 published · 27 suppressed

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
| high | 1 | 8 |
| medium | 7 | 7 |
| low | 3 | 1 |
| info | 0 | 4 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Aggregate execution stats per product in one pass

`high` · `n-plus-one` · `mysql` · ✅ verified

The dashboard loop repeats a `TestRun` lookup and `TestExecution` aggregate for every product, which is the classic per-row query pattern.

**Where it is used**

- `tcms/core/views.py:154` in `DashboardView.get_context_data`
- Reached via request-handler

**Current**

```sql
agg = TestExecution.objects.filter(run__in=active_run_ids).aggregate(
```

**Proposed**

```sql
# Compute active runs and execution counts grouped by product in a single set-oriented query,
# then build the dashboard stats from that grouped result.
active_runs = (
    TestRun.objects.filter(plan__product__in=Product.objects.all(), stop_date__isnull=True)
    .values("plan__product_id")
    .annotate(total=models.Count("pk"))
)
```

**Why this helps** — A grouped query lets MySQL scan and aggregate the matching rows once instead of repeating the same work for each product.

**Expected impact** — One grouped query instead of repeated per-product queries.

**Why the output is unchanged (the model's argument)** — This can be equivalent only if the rewritten code preserves the same per-product result mapping, count semantics, and product ordering that the view expects. It must not introduce or remove rows, columns, or duplicates. Because the original code does not specify an order for the aggregate itself, the key requirement is that each product still receives the same counts and that any presentation ordering remains the same as the product ordering already applied by `order_by("name")`.

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

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [plan__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [plan__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The caller can consume grouped counts instead of per-product aggregates.
- No hidden side effects depend on executing the inner ORM calls once per iteration.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [plan__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Add an index on plan global_id

`medium` · `missing-index` · `mysql` · ✅ verified

`TestPlan.objects.filter(global_id=old_plan_gid).exists()` performs repeated existence checks in the import loop, and an index on `global_id` would let MySQL answer each check by probing the index instead of scanning the table.

**Where it is used**

- `tcms/core/admin_views.py:1028` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
if (
                old_plan_gid
                and TestPlan.objects.filter(global_id=old_plan_gid).exists()
            ):
```

**Proposed**

```sql

```

**Why this helps** — 

**Expected impact** — 

**Why the output is unchanged (the model's argument)** — 

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

**Automated equivalence check** — Not machine-checkable: One side of the change is empty.

Not machine-checkable:

- One side of the change is empty.

**Verification notes**

- Not machine-checkable: One side of the change is empty. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned, the column list, ordering, NULL or duplicate handling.

### Batch execution cloning in a single create call

`medium` · `n-plus-one` · `mysql` · ✅ verified

This loop recreates each execution one by one through `new_run.create_execution(...)`, causing repeated write round-trips while cloning a run.

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
                    type(new_run.execution_model)(
                        run=new_run,
                        case=exe.case,
                        assignee=exe.assignee,
                        sortkey=(i + 1) * 10,
                    )
                    for i, exe in enumerate(source_run.executions.select_related("case"))
                ]
                new_run.execution_model.objects.bulk_create(new_executions)
```

**Why this helps** — Build the cloned executions in memory and send them to the database as a single bulk insert instead of issuing one insert per execution.

**Expected impact** — 1 write call instead of one per execution

**Why the output is unchanged (the model's argument)** — This is behavioural unless `create_execution()` is just a thin insert helper; bulk creation preserves the same inserted rows and columns only if it does not rely on per-row side effects, defaults, signals, or returned primary keys. Ordering of the created executions by `sortkey` is preserved by the computed values, but duplicate handling and error behaviour must also match the helper.

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

- `create_execution()` does not perform extra side effects beyond inserting the row.
- The execution model can be bulk-created safely on this backend.
- `new_run` exposes or can reach the execution model class used by `create_execution()`.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Fetch matching global ids with one values list

`medium` · `over-fetch` · `mysql` · ✅ verified

The code materializes all matching global_id values into a Python set from a filtered queryset; it can fetch just the ids once instead of building a queryset that is later consumed for membership testing.

**Where it is used**

- `tcms/core/admin_views.py:950` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
existing_case_gids = set(
            TestCase.objects.filter(
                global_id__in=list(
                    map(
                        lambda r: r.get("global_id", ""),
                        filter(lambda r: r.get("global_id"), case_rows),
                    )
                )
```

**Proposed**

```sql
existing_case_gids = set(
            TestCase.objects.filter(
                global_id__in=[
                    r["global_id"]
                    for r in case_rows
                    if r.get("global_id")
                ]
            ).values_list("global_id", flat=True)
        )
```

**Why this helps** — This asks the database to return only the matching global_id column values, which is all the code needs to populate the set.

**Expected impact** — The database returns one column instead of full rows for the matching ids

**Why the output is unchanged (the model's argument)** — The same rows are matched because the filter condition is unchanged. The returned column is the same global_id field, and converting the result to a Python set preserves the original duplicate-elimination behavior. Ordering does not matter because the result is immediately wrapped in set(). NULL handling is unchanged because rows without a global_id are still excluded by the input filter and the database query only returns matched ids.

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
- Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [global_id, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [global_id, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The later code only checks membership in existing_case_gids and does not rely on fetching full TestCase objects.
- global_id is the actual column later used in comparisons, not a property that triggers extra logic.

**Evidence**

- `tcms/core/admin_views.py:950` (call-site) — Shows a filtered queryset whose result is immediately converted to a set of global ids.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [global_id, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Push the never-run test-case check into the database

`medium` · `full-scan` · `mysql` · ✅ verified

This code materializes every executed case id into Python before excluding them, which does extra work compared with letting the database apply the exclusion directly.

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

**Why this helps** — This keeps the exclusion in SQL, so the database can evaluate the anti-join directly instead of shipping all distinct case ids into Python first.

**Expected impact** — 1 fewer Python materialization step and no client-side set of all distinct executed case ids; the database does the exclusion in one query.

**Why the output is unchanged (the model's argument)** — The rewritten query returns the same count for every database state: it filters the same `TestCase` rows for the same `section__product=stream`, excludes the same distinct `case_id` values, and still applies `count()` to the same resulting row set. It does not change columns, ordering, NULL handling, duplicate handling, or error behavior.

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

- `TestExecution.case_id` and `TestCase.pk` refer to the same case identifier domain, as implied by the original exclusion.
- The intent is only to count never-run cases, not to reuse the intermediate Python set elsewhere.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Materialize the active field configs once before building the list

`medium` · `over-fetch` · `mysql` · ✅ verified

The loop iterates a queryset directly, so the database work happens when the loop starts and the code repeatedly builds Python dicts from row-by-row ORM iteration.

**Where it is used**

- `tcms/testcases/views.py:352` in `TestCaseSearchView._filter_catalogue`
- Reached via request-handler

**Current**

```sql
for field in TestCaseFieldConfig.objects.filter(
            is_active=True, is_system=False
        ).order_by("order", "label"):
```

**Proposed**

```sql
field_configs = list(
            TestCaseFieldConfig.objects.filter(is_active=True, is_system=False)
            .order_by("order", "label")
        )
        custom_fields = []
        for field in field_configs:
```

**Why this helps** — Evaluating the queryset once up front makes the intent explicit and avoids any repeated queryset evaluation if the loop body or surrounding code is extended later.

**Expected impact** — One queryset evaluation consumed explicitly before the loop, with no repeated ORM evaluation if the result is reused

**Why the output is unchanged (the model's argument)** — This preserves the same rows, the same columns as model instances, and the same ordering from order_by("order", "label"). NULL handling and duplicates are unchanged because the same queryset is evaluated once. Error behavior is unchanged because the same query is executed; only the point of iteration changes.

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

- No CREATE TABLE for testcases_testcasefieldconfig was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.
- The filter expressions are textually unchanged.

**Requires this migration first**

```sql
CREATE INDEX IF NOT EXISTS testcases_testcasefieldconfig_active_system_order_label_idx ON testcases_testcasefieldconfig (is_active, is_system, `order`, label);
```

**Assumptions**

- The queryset is intended to be fully consumed in memory for building custom_fields.
- No code relies on lazy evaluation of the queryset object itself after this block.

**Evidence**

- `tcms/testcases/views.py:352` (call-site) — Shows the queryset being iterated to build the custom_fields list.

**Verification notes**

- Severity is medium, not the low the model proposed: the query runs once per iteration of an enclosing loop, on a request path — but no structural fact could be counted, so it is not rated higher.

### Aggregate executions through the relation directly

`medium` · `round-trip` · `mysql` · ✅ verified

The view first materializes all run ids into Python and then feeds them back into a second query; filtering executions by the plan relation directly removes the intermediate list and lets the database do the join in one pass.

**Where it is used**

- `tcms/testplans/views.py:381` in `TestPlanGetView.get_context_data`
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

**Why this helps** — This removes the intermediate `list(...)` and lets the ORM express the relationship as a single filtered aggregation, so the database can join from executions to runs directly.

**Expected impact** — Eliminates the Python materialization of run ids and the extra ORM step before aggregation

**Why the output is unchanged (the model's argument)** — The rewritten query returns the same aggregate columns with the same names. It counts the same execution rows because `run__plan_id=self.object.pk` selects executions whose run belongs to the same plan as the original `run__in=run_ids`; duplicates are not introduced because the filter is still on the execution table, and NULL handling is unchanged. Ordering is irrelevant because this is an aggregate query.

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

**Requires this migration first**

```sql
CREATE INDEX IF NOT EXISTS ...
```

**Assumptions**

- `TestExecution.run` points to `TestRun` as implied by the existing `run__in` filter.
- No custom queryset filtering on `TestRun.objects.filter(plan_id=...)` is needed beyond the plan relation shown here.

**Verification notes**

- Same-output claim needs review — The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Avoid materializing all products in the context processor

`medium` · `full-scan` · `mysql` · ✅ verified

This context processor turns the product queryset into a Python list on every template render, forcing the database rows to be fetched immediately even though the code only needs to expose the collection to templates.

**Where it is used**

- `tcms/core/context_processors.py:31` in `stream_processor`
- Reached via template render via stream_processor

**Current**

```sql
streams = list(Product.objects.order_by("name"))
```

**Proposed**

```sql
streams = Product.objects.order_by("name")
```

**Why this helps** — Returning the queryset keeps it lazy, so Django can defer loading rows until the template actually iterates them instead of forcing immediate materialization here.

**Expected impact** — Avoids an unconditional fetch and Python list construction in this context processor; rows are only loaded if the template actually uses them.

**Why the output is unchanged (the model's argument)** — The set of rows, columns, ordering, NULL handling, duplicates, and error behavior are unchanged because the same ordered queryset is returned; only the evaluation point changes. The template still sees the same iterable contents when it iterates.

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

**Automated equivalence check** — Verified (django): every mechanically decidable property of the result is identical.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

**Assumptions**

- The template only iterates or otherwise consumes `streams` and does not depend on it already being a concrete list object.

### Reuse the evaluated property queryset before branching

`low` · `round-trip` · `mysql` · ✅ verified

The code calls count() on a queryset-like union solely to test emptiness, which can force an extra query before the loop; evaluating the queryset once and branching on the materialized result avoids that extra round trip.

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
properties = list(self.property_set.union(TestCaseProperty.objects.filter(case=case)))

        if properties:
            for prop_tuple in self.property_matrix(properties, matrix_type):
                execution = self._create_single_execution(
                    case, assignee, build, sortkey
                )
```

**Why this helps** — Materializing the property set once lets Python test emptiness without a separate count query, while also reusing the same evaluated data for the subsequent matrix expansion.

**Expected impact** — 1 existence query removed before entering the loop

**Why the output is unchanged (the model's argument)** — The branch condition stays equivalent because the rewritten code tests whether the same set of properties is empty. The same executions are created when properties are present, and none are created when the set is empty. The same columns and ordering are preserved because this change only affects the emptiness check and the property data source, not the loop body. NULL and duplicate behavior are unchanged as long as the evaluated union yields the same property rows that the original count() was testing for existence. Error behavior is unchanged for the same inputs.

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
CREATE INDEX ...
```

**Assumptions**

- property_matrix accepts an evaluated iterable in place of a queryset/union object.
- The union is only used for existence testing and iteration here, not for further queryset operations later in the method.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Use a primary-key scan for blank-name users

`low` · `full-scan` · `mysql` · ✅ verified

The queryset already orders by primary key, so it can be made more index-friendly by constraining the scan to the primary key path rather than filtering only on two blank-string columns.

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
candidates = user_model.objects.filter(first_name="", last_name="", pk__isnull=False).order_by(
            "pk"
        )
```

**Why this helps** — Adding an always-true primary-key predicate gives MySQL a direct indexed column to anchor the scan while keeping the same rows and iteration order.

**Expected impact** — Lets the database use the primary-key ordering path while still scanning only the matching users

**Why the output is unchanged (the model's argument)** — This returns the same users because every real row has a non-null primary key, so `pk__isnull=False` does not exclude any matching user. The selected columns are unchanged because the queryset shape is unchanged, ordering remains by `pk`, and duplicates/NULL handling are unchanged. This is only safe if the primary key is never NULL, which is true for normal Django model rows.

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

- The queryset is evaluated against a normal Django primary-key column that is never NULL.
- No additional filters or annotations are attached elsewhere to this queryset.

**Evidence**

- `tcms/kiwi_auth/management/commands/backfill_user_names.py:40` (call-site) — This is the queryset being evaluated and iterated in the command.
- `tcms/core/models/__init__.py:3` (model-definition) — This confirms the codebase is using Django ORM models, so queryset evaluation happens at iteration time.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Reuse the fetched test case IDs for the plan query

`low` · `full-scan` · `mysql` · ✅ verified

The form builds the plan queryset from `plan_ids` produced by the already filtered case queryset, which causes an extra database read of the case rows just to derive plan foreign keys.

**Where it is used**

- `tcms/testcases/forms.py:364` in `CloneCaseForm.populate`
- Reached via form population in CloneCaseForm.populate

**Current**

```sql
plan_ids = self.fields["case"].queryset.values_list("plan", flat=True)
```

**Proposed**

```sql
case_qs = TestCase.objects.filter(pk__in=case_ids)
self.fields["case"].queryset = case_qs
plan_ids = case_qs.values_list("plan_id", flat=True).distinct()
self.fields["plan"].queryset = TestPlan.objects.filter(pk__in=plan_ids)
```

**Why this helps** — Using the foreign-key id field avoids pulling whole plan objects through the case queryset, and `distinct()` prevents repeated ids from being sent into the next filter when many cases share a plan.

**Expected impact** — Avoids fetching full plan values from the case rows and reduces the amount of data fed into the plan filter.

**Why the output is unchanged (the model's argument)** — This is behavioral, not equivalent, because adding `distinct()` can change duplicate handling: the original `pk__in=plan_ids` receives repeated ids, while the rewrite removes them before filtering. The row set of `TestPlan.objects.filter(pk__in=...)` is usually the same, but duplicate-handling and evaluation behavior differ, so it cannot be called equivalent.

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

- `plan` is a foreign key on `TestCase` and `plan_id` is available as the raw id column.
- The intent is to avoid re-reading full related objects, not to preserve duplicate ids in the intermediate queryset.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, ordering.

## Behaviour changes and bugs

**These change what the query returns.** They are listed separately on purpose — review each on its merits.

### Preload test-case plan sortkeys before the loop

`high` · `n-plus-one` · `mysql` · ✅ verified

The loop performs a per-case lookup of `TestCasePlan` and falls back to a default sortkey when no row exists, so this is an N+1 pattern that can be collapsed into one prefetch/query step.

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
plan_obj = form.cleaned_data.get("plan")
plan_case_sortkeys = {}
if plan_obj:
    plan_case_sortkeys = {
        tcp.case_id: tcp.sortkey
        for tcp in TestCasePlan.objects.filter(plan=plan_obj, case__in=cases_to_add)
    }

loop = 1
for case in cases_to_add:
    sortkey = plan_case_sortkeys.get(case.id, loop * 10)
    test_run.create_execution(
        case=case,
        assignee=form.cleaned_data["default_tester"],
        sortkey=sortkey,
    )
```

**Why this helps** — This replaces one lookup per case with a single query that loads all matching `TestCasePlan` rows up front, then uses in-memory mapping during the loop.

**Expected impact** — 1 query instead of one per case for the plan-sortkey lookup

**Why the output is unchanged (the model's argument)** — The rewritten code produces the same execution rows and the same columns passed to `create_execution`; for each case it uses the plan-specific `sortkey` when a matching `TestCasePlan` exists and otherwise keeps `loop * 10`, so row contents and NULL/duplicate behaviour are unchanged. The loop ordering stays the same. Assumes `case` objects in `cases_to_add` expose `id` and that `case__in` matches the same cases the per-row `.get(plan=..., case=case)` could have found.

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

**Verification notes**

- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Hoist run-existence checks out of the per-run loop

`high` · `n-plus-one` · `mysql` · ✅ verified

The import path performs an existence query for each run inside the nested plan/run loops, so the database is asked to check one row at a time instead of checking the imported run ids in a batch.

**Where it is used**

- `tcms/core/admin_views.py:1048` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
if (
                    old_run_gid
                    and TestRun.objects.filter(global_id=old_run_gid).exists()
                ):
```

**Proposed**

```sql
run_ids = [
    run_data.get("global_id", "")
    for plan_data in plans_data
    for run_data in plan_data.get("runs", [])
    if run_data.get("global_id", "")
]
existing_run_ids = set(
    TestRun.objects.filter(global_id__in=run_ids).values_list("global_id", flat=True)
)

for plan_data in plans_data:
    for run_data in plan_data.get("runs", []):
        old_run_gid = run_data.get("global_id", "")
        if old_run_gid and old_run_gid in existing_run_ids:
            skipped.append(f"Run {old_run_gid} (already exists)")
            continue
```

**Why this helps** — This turns repeated existence lookups into one batched lookup and then uses in-memory membership checks while iterating the imported data.

**Expected impact** — 1 existence query for all imported run ids instead of one per run

**Why the output is unchanged (the model's argument)** — It preserves the same skipped/created decision for every run because it checks the same global_id values for existence. The output rows are unchanged because this code only controls whether a run is skipped. The ordering of processing stays the same because the outer and inner loops are unchanged. NULL handling is preserved because empty global ids are still excluded by the truthy check. Duplicate handling is preserved because repeated imported ids will still see the same existence result; if the input contains duplicates, each occurrence is treated the same way as before. Error behavior is unchanged for the same inputs because the same query condition is used, just batched.

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
CREATE INDEX on the TestRun.global_id column if it is not already indexed; the context does not show that definition.
```

**Assumptions**

- TestRun.global_id is the same field used by the current existence check.
- The imported run ids can be collected in memory without issue.

**Evidence**

- `tcms/core/admin_views.py:1046` (call-site) — Shows the per-run existence lookup inside the nested import loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [global_id, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Batch tester lookups before importing runs

`high` · `n-plus-one` · `mysql` · ✅ verified

The importer does a username lookup for each run that specifies a tester, which creates a repeated database round trip inside the nested loop.

**Where it is used**

- `tcms/core/admin_views.py:1055` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
user_model.objects.filter(username=tester_name).first()
```

**Proposed**

```sql
tester_names = {
    run_data.get("tester", "")
    for plan_data in plans_data
    for run_data in plan_data.get("runs", [])
    if run_data.get("tester", "")
}
testers_by_username = {
    user.username: user
    for user in user_model.objects.filter(username__in=tester_names)
}

for plan_data in plans_data:
    for run_data in plan_data.get("runs", []):
        tester_name = run_data.get("tester", "")
        tester = testers_by_username.get(tester_name, request.user) if tester_name else request.user
```

**Why this helps** — This replaces one query per tester-bearing run with a single lookup of all referenced usernames, then resolves each run from an in-memory dictionary.

**Expected impact** — 1 username lookup for all imported tester names instead of one per run

**Why the output is unchanged (the model's argument)** — The selected tester is the same as before for every run: if a username exists it is used, otherwise request.user is used, and if no tester name is supplied request.user is used. The returned columns are unchanged because this only affects object resolution in Python. Ordering is unchanged because the surrounding iteration order is preserved. NULL handling is unchanged because the empty-string branch still maps to request.user. Duplicate handling is unchanged because multiple runs with the same tester name will resolve to the same in-memory object, just as repeated database lookups would have returned the same row.

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
CREATE INDEX on the auth user username column may already exist depending on the user model; the context does not show the user table definition.
```

**Assumptions**

- user_model.username is unique enough for a dictionary keyed by username to be safe; Django's default User model enforces uniqueness, but a custom user model must do the same for this rewrite to stay equivalent.
- The set of tester names can be materialized before the import loop.

**Evidence**

- `tcms/core/admin_views.py:1054` (call-site) — Shows the per-run tester lookup inside the nested import loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Batch assignee lookups before importing executions

`high` · `n-plus-one` · `mysql` · ✅ verified

The importer resolves each execution assignee with a separate username query inside the innermost loop, causing repeated round trips for the same access pattern.

**Where it is used**

- `tcms/core/admin_views.py:1081` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
user_model.objects.filter(username=assignee_name).first()
```

**Proposed**

```sql
assignee_names = {
    exec_data.get("assignee", "")
    for plan_data in plans_data
    for run_data in plan_data.get("runs", [])
    for exec_data in run_data.get("executions", [])
    if exec_data.get("assignee", "")
}
assignees_by_username = {
    user.username: user
    for user in user_model.objects.filter(username__in=assignee_names)
}

for plan_data in plans_data:
    for run_data in plan_data.get("runs", []):
        for exec_data in run_data.get("executions", []):
            assignee_name = exec_data.get("assignee", "")
            assignee = assignees_by_username.get(assignee_name) if assignee_name else None
```

**Why this helps** — This collapses many single-row username lookups into one batched query and then does in-memory resolution during the execution loop.

**Expected impact** — 1 username lookup for all imported assignees instead of one per execution

**Why the output is unchanged (the model's argument)** — The assignee chosen for each execution is unchanged: a matching username still yields that user, and a missing or empty assignee still yields None. The query does not change the set of imported executions, their column values, or their order. NULL handling is preserved because empty assignee names still map to None. Duplicate handling is preserved because repeated assignee names resolve to the same in-memory user object instead of repeated database lookups. Error behavior remains the same for the same inputs as long as the usernames used for lookup are valid for the user model.

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
CREATE INDEX on the auth user username column may already exist depending on the user model; the context does not show the user table definition.
```

**Assumptions**

- The user model can be looked up by username with a single batch query and the username values are comparable as strings.
- Materializing the referenced assignee names before the loop is acceptable for the import size.

**Evidence**

- `tcms/core/admin_views.py:1079` (call-site) — Shows the per-execution assignee lookup inside the innermost import loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Prefetch per-stream case counts in bulk

`high` · `n-plus-one` · `mysql` · ✅ verified

The loop issues a separate count query for TestCase.objects.filter(section__product=stream).count() on every stream; that repeated lookup can be replaced with a grouped count computed once for all streams.

**Where it is used**

- `tcms/core/views.py:183` in `DashboardView.get_context_data`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
```

**Proposed**

```sql
case_counts = dict(
    TestCase.objects.filter(section__product__in=streams)
    .values_list("section__product")
    .annotate(total=Count("id"))
)

...
"cases": case_counts.get(stream.pk, 0),
```

**Why this helps** — This turns one count query per stream into a single grouped query over all streams, so the database computes all counts in one pass instead of repeating the same join and count work inside the loop.

**Expected impact** — One grouped count query instead of one count query per stream.

**Why the output is unchanged (the model's argument)** — For each stream, the resulting integer count is the same as the original filter().count() call. The proposal only changes how counts are obtained, not which TestCase rows are counted, and it preserves the same scalar value per stream. Any ordering of stream_stats is unchanged because this only replaces a field value.

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

**Assumptions**

- streams is the collection being iterated in the outer loop and contains the stream objects or ids used in the original code.
- The caller can switch from per-stream counting to a precomputed mapping.
- section__product is the relation used to associate cases with streams, as shown in the original query.

**Evidence**

- `tcms/core/views.py:183` (call-site) — Shows the per-stream count query inside the loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section__product]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: NULL or duplicate handling.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Precompute stream test-case counts in one query

`high` · `n-plus-one` · `mysql` · ✅ verified

The CSV export counts test cases once per stream, causing a repeated ORM count query inside the stream loop.

**Where it is used**

- `tcms/core/views.py:598` in `AllStreamsCsvExportView.get`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
```

**Proposed**

```sql
stream_counts = dict(
    TestCase.objects.filter(section__product__in=streams)
    .values_list("section__product")
    .annotate(total=models.Count("id"))
)

...
writer.writerow([
    stream.name,
    stream_counts.get(stream.pk, 0),
    len(active_run_ids),
    pass_rate,
    stats["failed"],
    stats["blocked"],
    last["stop_date"].strftime("%Y-%m-%d %H:%M") if last else "",
])
```

**Why this helps** — This moves the test-case counting work out of the per-stream loop so the database can aggregate the counts in one grouped query instead of executing a count for each stream.

**Expected impact** — 1 grouped count query instead of one count query per stream

**Why the output is unchanged (the model's argument)** — The rewritten code returns the same count for each stream, with the same CSV columns and row order. `count()` and grouped `Count('id')` both ignore NULLs in the counted column, and no duplicate rows are introduced because the source relation is the same. The only behavioral requirement is that `stream.pk` matches the grouped key used for `section__product`; if that relationship is not what the current filter relies on, the query must be adjusted to preserve the exact same grouping.

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

**Assumptions**

- `section__product` is the same key used to identify each `stream` object in this loop.
- `django.db.models.Count` is available in the module.

**Evidence**

- `tcms/core/views.py:595` (call-site) — Shows the count call is inside the per-stream CSV-writing loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section__product]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Fold the existence check into the create path

`high` · `round-trip` · `mysql` · ✅ verified

This loop does a separate `exists()` lookup before each create; if duplicate rows are not possible, the pre-check just adds an extra round trip per track.

**Where it is used**

- `tcms/testplans/views.py:513` in `CreateStandardRunsView.post`
- Reached via request-handler

**Current**

```sql
if not TestRun.objects.filter(plan=plan, summary=summary).exists():
                TestRun.objects.create(
```

**Proposed**

```sql
TestRun.objects.create(
                    summary=summary,
                    plan=plan,
                    build=build,
                    manager=request.user,
                    default_tester=request.user,
```

**Why this helps** — Avoids the extra lookup before each insert; the database only does the write path once per track.

**Expected impact** — 1 fewer database query per track attempt, but only if the insert path is the desired behavior.

**Why the output is unchanged (the model's argument)** — This is not provably equivalent: the original skips inserts when a matching `(plan, summary)` row already exists, while the rewrite would attempt the insert and may create duplicates or raise an error. Because row existence, duplicates, and error behaviour can change, this is behavioural rather than equivalent.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [exists] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [exists] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE UNIQUE INDEX ...
```

**Assumptions**

- Safe only if the application guarantees no existing `TestRun` can match the same `plan` and `summary`, or if a unique constraint and conflict-handling path are added separately.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, ordering.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Precompute section case counts in one grouped query

`high` · `n-plus-one` · `mysql` · ✅ verified

The loop runs two ORM count queries per section; grouping the case table by section lets the database compute the per-section totals and executed counts in set-based queries instead of repeating work for each row.

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
section_counts = (
            TestCase.objects.filter(section__product=stream)
            .values("section_id")
            .annotate(
                sc_total=models.Count("id"),
                sc_executed=models.Count(
                    "id", filter=models.Q(pk__in=executed_case_ids)
                ),
            )
        )
        counts_by_section = {
            row["section_id"]: row for row in section_counts if row["sc_total"]
        }

        for sec in Section.objects.filter(product=stream).order_by("name"):
            row = counts_by_section.get(sec.id)
            if not row:
                continue
            sc_total = row["sc_total"]
            sc_executed = row["sc_executed"]
```

**Why this helps** — This lets the database aggregate counts for all sections in set-based form, instead of issuing separate count queries for every section.

**Expected impact** — 2 per-section count queries replaced by grouped aggregation queries

**Why the output is unchanged (the model's argument)** — The rewritten code produces the same section rows because it still iterates over the same ordered Section queryset and skips sections with zero cases. The returned columns and per-section percentages remain the same. Ordering is preserved by the same order_by("name") on Section. NULL handling is unchanged because count() ignores NULLs just as before. Duplicate handling is unchanged because count() counts matching case rows; the filter on pk__in executed_case_ids matches the same case set as the original. Error behavior is the same for valid inputs; if executed_case_ids contains values, the count logic remains ORM-based and does not introduce new failure modes.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Differences found:

- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX ...
```

**Assumptions**

- Django supports the filtered Count aggregation used here.
- The intent is to keep the same section ordering and to exclude empty sections exactly as before.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Fetch the latest execution timestamp with an aggregate

`medium` · `full-scan` · `mysql` · ✅ verified

The dashboard loop runs a per-stream query to sort executions by stop_date and pick the first row; using a MAX-style aggregate would let the database compute the same latest timestamp without ordering the matching rows.

**Where it is used**

- `tcms/core/views.py:176` in `DashboardView.get_context_data`
- Reached via request-handler
- Also at `tcms/core/views.py:588`

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
last = (
    TestExecution.objects.filter(
        run__plan__product=stream, stop_date__isnull=False
    )
    .aggregate(last_stop_date=Max("stop_date"))
)
```

**Why this helps** — This lets MySQL compute the latest non-null stop_date directly instead of sorting all matching executions for each stream.

**Expected impact** — Avoids ordering the per-stream execution rows and replaces it with one aggregate computation per stream.

**Why the output is unchanged (the model's argument)** — It returns the same single stop_date value as the current query when one exists, and None when no matching row exists; the calling code already treats absence as falsey. The result is not row-based, so changing from one-row ordering to an aggregate does not alter row duplicates or ordering. The only behavioral difference to watch is that the proposed code must access the aggregated key instead of indexing a queryset row.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [first] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- The filter expressions are textually unchanged.

Differences found:

- The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Ordering ["-stop_date"] is removed. Row order is no longer guaranteed.
- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [none], which changes what the call returns.

**Assumptions**

- Django's Max aggregate is acceptable here and the caller will be updated to read last_stop_date.
- No downstream code depends on the intermediate queryset object itself.

**Evidence**

- `tcms/core/views.py:170` (call-site) — Shows the per-stream execution query that sorts by stop_date and takes the first row.
- `tcms/core/views.py:582` (call-site) — Same pattern appears in the CSV export path.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [none], which changes what the call returns.
- The equivalence argument does not address: the column list.

### Use an aggregate for the latest execution timestamp

`medium` · `full-scan` · `mysql` · ✅ verified

The CSV export repeats the same per-stream sorted lookup for the latest stop_date; a MAX-style aggregate would return the same timestamp without ordering rows for each stream.

**Where it is used**

- `tcms/core/views.py:588` in `AllStreamsCsvExportView.get`
- Reached via request-handler
- Also at `tcms/core/views.py:176`

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
last = (
    TestExecution.objects.filter(
        run__plan__product=stream, stop_date__isnull=False
    )
    .aggregate(last_stop_date=Max("stop_date"))
)
```

**Why this helps** — This asks MySQL for the maximum stop_date directly, avoiding a sort of all matching executions for each stream.

**Expected impact** — Avoids a per-stream sort and replaces it with a single aggregate computation.

**Why the output is unchanged (the model's argument)** — The aggregate yields the same latest stop_date value as ordering descending and taking the first row, and it still ignores NULL stop_date values because the original filter excludes them. It does not change which stream is processed, how many result rows are produced by the export, or any duplicate handling. The caller must read the aggregate result rather than a queryset row, but the semantic output for each stream remains the same.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [first] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- The filter expressions are textually unchanged.

Differences found:

- The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Ordering ["-stop_date"] is removed. Row order is no longer guaranteed.
- The row limit changes from 1 to none.
- The terminal operation changes from [first] to [none], which changes what the call returns.

**Assumptions**

- The export code can be updated to read the aggregate result key.
- No code depends on last being a queryset or model-like dict beyond retrieving stop_date.

**Evidence**

- `tcms/core/views.py:587` (call-site) — Shows the repeated latest-stop_date lookup in the export view.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [none], which changes what the call returns.
- The equivalence argument does not address: the column list.

### Collapse the coverage summary counts into one aggregate

`medium` · `round-trip` · `mysql` · ✅ verified

The view issues four separate count queries over the same test-case scope; a single aggregate query can compute all four counters in one database round trip.

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
summary = TestCase.objects.filter(section__product=stream).aggregate(
            total_cases=models.Count("id"),
            sanity_count=models.Count("id", filter=models.Q(is_sanity=True)),
            regression_count=models.Count("id", filter=models.Q(is_regression=True)),
            automated_count=models.Count("id", filter=models.Q(is_automated=True)),
        )
        total_cases = summary["total_cases"]
        sanity_count = summary["sanity_count"]
        regression_count = summary["regression_count"]
        automated_count = summary["automated_count"]
```

**Why this helps** — The database can evaluate all four counts in one pass over the filtered rows instead of repeating the same filter logic four times.

**Expected impact** — 4 count queries reduced to 1 aggregate query

**Why the output is unchanged (the model's argument)** — The same rows are counted because each aggregate applies the same base filter on section__product=stream and the same boolean predicates as the original queries. The same columns are produced in the same Python variables. No ordering is involved. NULL behavior is unchanged because Count ignores NULLs and the boolean filters preserve the original truth tests. Duplicate handling is unchanged because Count("id") counts rows, matching count(). Error behavior is unchanged for valid inputs.

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
CREATE INDEX ...
```

**Assumptions**

- Django's filtered Count is available in the project version.
- There is no hidden dependence on executing these as separate queries.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Combine the two counts into one filtered query

`medium` · `full-scan` · `mysql` · ✅ verified

The two count() calls scan the same distinct queryset separately; you can compute both counts with one aggregate query instead of two round trips to the database.

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
counts = test_cases.aggregate(
        manual_count=Count("pk", filter=Q(is_automated=False), distinct=True),
        automated_count=Count("pk", filter=Q(is_automated=True), distinct=True),
    )
    manual_count = counts["manual_count"]
    automated_count = counts["automated_count"]
```

**Why this helps** — This lets the database compute both totals in one aggregate pass over the filtered rows instead of evaluating two separate count queries.

**Expected impact** — 1 aggregate query instead of 2 count queries

**Why the output is unchanged (the model's argument)** — It returns the same two named counts for the same queryset filter. The keys and values are unchanged, and each count still only includes distinct TestCase rows matching its boolean predicate. Ordering is irrelevant because the result is a dict. NULL handling and duplicates are unchanged because the original queryset is already distinct and the aggregate keeps distinct row counting on the primary key.

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

**Automated equivalence check** — Contradicted: DISTINCT is removed, which changes duplicate handling.

Confirmed automatically:

- Neither version orders its rows, so neither guarantees an order.

Differences found:

- DISTINCT is removed, which changes duplicate handling.
- The terminal operation changes from [count] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- Django imports Count and Q in this module or they are added.
- The intent is to count unique TestCase rows, matching the existing .distinct() queryset semantics.

**Evidence**

- `tcms/telemetry/api.py:28` (call-site) — Shows the same queryset is counted twice with different boolean filters.

**Verification notes**

- Reclassified as behaviour-changing: DISTINCT is removed, which changes duplicate handling. The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.

### Reuse sibling lookups with one existence query

`medium` · `round-trip` · `mysql` · ✅ verified

The function issues separate existence probes against the same sibling set; it can ask for the candidate names in one query and decide locally.

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
existing_names = set(
        Section.objects.filter(
            product=product,
            parent=parent,
            name__in=[desired_name, f"{desired_name} (copy)"],
        ).values_list("name", flat=True)
    )

    if desired_name not in existing_names:
        return desired_name

    base = f"{desired_name} (copy)"
    if base not in existing_names:
        return base
```

**Why this helps** — This collapses repeated sibling existence checks into one query, then evaluates the candidate names in Python.

**Expected impact** — 1 query instead of 2 existence queries for the shown branch

**Why the output is unchanged (the model's argument)** — It returns the same string as the original for every database state because it tests the same two candidate names against the same sibling scope. The returned value, null behavior, and duplicate handling are unchanged: values_list(flat=True) preserves every matching row name, and converting to a set only affects local membership checks, not the decision about whether any matching row exists. Ordering is irrelevant because the original only uses exists().

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

**Assumptions**

- Only these two candidates are checked in the shown code path; if later branches depend on more names, they must be added to the single IN list.
- Section.name comparisons use the same equality semantics as the existing exact filter.

**Evidence**

- `tcms/testcases/views.py:1073` (call-site) — Shows two separate existence checks against the same sibling queryset.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [none], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [name, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.

### Combine the three case-type counts into one aggregation

`medium` · `full-scan` · `mysql` · ✅ verified

This code scans the same `TestCase` set three times to compute three independent counts, instead of asking the database for all three counts in one grouped aggregation.

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
from django.db.models import Count, Q

case_type_counts = TestCase.objects.filter(section__product=stream).aggregate(
    sanity_count=Count("pk", filter=Q(is_sanity=True)),
    regression_count=Count("pk", filter=Q(is_regression=True)),
    automated_count=Count("pk", filter=Q(is_automated=True)),
)

sanity_count = case_type_counts["sanity_count"]
regression_count = case_type_counts["regression_count"]
automated_count = case_type_counts["automated_count"]
```

**Why this helps** — The database can compute all three conditional counts in one pass over the filtered `TestCase` rows instead of repeating the same filter and count work three times.

**Expected impact** — 1 aggregation query instead of 3 count queries.

**Why the output is unchanged (the model's argument)** — Each count is over the same `TestCase` rows matching `section__product=stream` and the same boolean predicate. `aggregate(Count(..., filter=...))` returns the same scalar values as three separate `.count()` calls, with no change to columns, ordering, NULL handling, duplicate handling, or error behavior.

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

- The project is on a Django version that supports filtered aggregates, which is consistent with the surrounding codebase.
- No caller depends on issuing three separate ORM queries for side effects, which `.count()` does not have.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Split the user lookup into explicit queries

`medium` · `missing-index` · `mysql` · ✅ verified

The existing `Q(email=value) | Q(username=value)` lookup is a single fallback search; rewriting it into separate checks would change which user is returned when email and username collide, so this is not equivalent.

**Where it is used**

- `tcms/core/forms/fields.py:40` in `UserField.clean`
- Reached via unknown

**Current**

```sql
return User.objects.get((Q(email=value) | Q(username=value)))
```

**Proposed**

```sql
user = User.objects.filter(email=value).first()
if user is None:
    user = User.objects.filter(username=value).first()
if user is None:
    raise ValidationError(f'Unknown user: "{value}"')
return user
```

**Why this helps** — This would allow separate indexable lookups, but it changes behavior when both fields match different rows or when more than one row matches.

**Expected impact** — Would avoid a combined disjunction if behavior were allowed to change, but this is not safe as an equivalent rewrite.

**Why the output is unchanged (the model's argument)** — Not equivalent: the original `get(Q(email=value) | Q(username=value))` can raise `MultipleObjectsReturned` if more than one row matches either predicate, and it has no defined preference between email and username matches. The rewrite returns the first matching row and suppresses that error, so rows, error behavior, and duplicate handling can differ.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [get] to [first], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- A row limit (1) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.
- The terminal operation changes from [get] to [first], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- If optimized, the application can tolerate changed collision behavior.

**Evidence**

- `tcms/core/migrations/0001_squashed.py:27` (schema) — Shows the codebase has ORM-based auth/user lookups but does not define a uniqueness guarantee for the fields used in the user search.

**Verification notes**

- Severity is medium, not the info the model proposed: 1 structural fact(s) were counted from the two versions.

### Replace the count check with an existence probe

`low` · `full-scan` · `mysql` · ✅ verified

The delete view counts all superusers to decide whether the current user is the last one, which forces the database to scan matching rows instead of stopping after finding a second row.

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

**Why this helps** — This asks the database whether any other superuser exists and can stop as soon as it finds one, instead of counting every matching row.

**Expected impact** — 1 existence probe instead of a full count of all matching superusers

**Why the output is unchanged (the model's argument)** — The original condition is true exactly when there is one superuser and it is the current user. Excluding the current user and checking for existence is true exactly when no other superuser rows exist. It does not change the returned rows, columns, ordering, NULL handling, duplicates, or error behavior for the surrounding code path.

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

- No CREATE TABLE for kiwi_auth_user was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [exists], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [exists], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX IF NOT EXISTS kiwi_auth_user_is_superuser_idx ON kiwi_auth_user (is_superuser);
```

**Assumptions**

- User.pk uniquely identifies the current row, which is the case for Django model primary keys.
- The intent is to block deletion only when no other superuser besides the one being deleted exists.

**Evidence**

- `tcms/kiwi_auth/admin.py:220` (call-site) — Shows the count-based check inside the delete view.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [exists], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Fetch the mappings once before asserting

`info` · `n-plus-one` · `mysql` · ✅ verified

Move the lookup out of the nested assertion loops so the database is queried once per plan/case pair only if the result set is materialized up front rather than rebuilt each time.

**Where it is used**

- `tcms/rpc/tests/test_testplan.py:324` in `TestAddCase.test_ignores_existing_mappings`
- Reached via test

**Current**

```sql
for plan_id in plans:
            for case_id in cases:
                self.assertEqual(
                    1, TestCasePlan.objects.filter(plan=plan_id, case=case_id).count()
                )
```

**Proposed**

```sql
mappings = {
            (mapping.plan_id, mapping.case_id): mapping
            for mapping in TestCasePlan.objects.filter(plan__in=plans, case__in=cases)
        }
        for plan_id in plans:
            for case_id in cases:
                self.assertEqual(1, int((plan_id, case_id) in mappings))
```

**Why this helps** — This avoids rebuilding and executing a separate count query for every pair by loading the relevant mappings once and checking them in memory.

**Expected impact** — One query to load the relevant mappings instead of one count query per asserted pair

**Why the output is unchanged (the model's argument)** — This is not strictly equivalent: `count()` counts rows matching each pair, while the proposed membership test only checks existence and returns 1 or 0. It preserves the same plan/case iteration order but changes the asserted value semantics, so it is behavioural rather than equivalent.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- The test intent is to verify existence rather than exact row count.
- `plans` and `cases` are finite iterables of IDs.

**Evidence**

- `tcms/rpc/tests/test_testplan.py:324` (call-site) — This is the count query inside the nested loops.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, NULL or duplicate handling.
- This code is reached by a test, so it runs once at install time or never in production.
- Severity is info, not the low the model proposed: this code is reached by a test, so it runs once at install time or never in production.

### Use an existence check instead of counting all superusers

`info` · `unbounded-result` · `mysql` · ✅ verified

This test only needs to confirm one remaining superuser, but `count()` forces the database to count every matching row.

**Where it is used**

- `tcms/kiwi_auth/tests/test_admin.py:219` in `TestUserAdmin.test_superuser_cannot_delete_the_last_superuser`
- Reached via test

**Current**

```sql
get_user_model().objects.filter(is_superuser=True).count()
```

**Proposed**

```sql
get_user_model().objects.filter(is_superuser=True).filter(pk=self.admin.pk).exists()
```

**Why this helps** — If the intent is just to verify that the remaining superuser is still present, an existence check can stop at the first matching row instead of counting all matches.

**Expected impact** — One matching-row probe instead of scanning/counting all matching superuser rows.

**Why the output is unchanged (the model's argument)** — This is not equivalent: `count() == 1` asserts there is exactly one superuser row, while `exists()` only asserts at least one row matches. It preserves no row ordering concerns, but it changes duplicate-handling and the truth condition, so it is behavioral rather than equivalent.

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

**Requires this migration first**

```sql
CREATE INDEX on the `is_superuser` column would help this predicate if the existing schema does not already support it, but index usefulness depends on selectivity and write cost.
```

**Assumptions**

- If the test is meant to check a specific surviving superuser, use that user's primary key or another unique condition.
- If the test truly needs to assert there is exactly one superuser, keep `count()`.

**Evidence**

- `tcms/core/models/__init__.py:3` (model-definition) — Shows the codebase is using Django ORM for user queries and that queryset construction itself is lazy.
- `tcms/kiwi_auth/tests/test_admin.py:219` (call-site) — The second assertion is the expensive count that forces the database to examine all matching superuser rows.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [exists], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- This code is reached by a test, so it runs once at install time or never in production.
- Severity is info, not the low the model proposed: this code is reached by a test, so it runs once at install time or never in production.

### Fetch a single default row directly

`info` · `full-scan` · `mysql` · ✅ verified

The factory builds a queryset and then slices it to the first row, which forces the ORM to materialize a first-row lookup just to obtain one object.

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

**Why this helps** — This asks the ORM for the first row directly instead of building a slice and then indexing into it.

**Expected impact** — Avoids the extra slice object and makes the intent explicit; still one query to fetch one row.

**Why the output is unchanged (the model's argument)** — Both versions return the same single model instance or None as the first row according to the model's default ordering; because the original immediately indexes the slice with `[0]`, it will raise if no rows exist, while `.first()` would not, so this is not equivalent. A safe equivalent rewrite is not available without knowing that at least one row always exists.

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
CREATE INDEX is not required for this change.
```

**Assumptions**

- At least one TestCaseStatus and one Priority row always exist for every test that uses this factory.

**Evidence**

- `tcms/tests/factories.py:167` (call-site) — Shows the queryset slice plus indexing pattern used to obtain a single row.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [none] to [first], which changes what the call returns.
- The equivalence argument does not address: the column list, NULL or duplicate handling.
- This code is reached by a test, so it runs once at install time or never in production.
- Severity is info, not the low the model proposed: this code is reached by a test, so it runs once at install time or never in production.

### Reuse the matched user instead of requerying

`info` · `round-trip` · `mysql` · ✅ verified

The test performs two separate ORM lookups for the same email, one to count rows and another to fetch the first match.

**Where it is used**

- `tcms/kiwi_auth/tests/test_sso.py:88` in `TestProvisioning.test_existing_account_is_matched_by_email_not_duplicated`
- Reached via test

**Current**

```sql
self.assertEqual(User.objects.filter(email=EMAIL).count(), 1)
        self.assertEqual(User.objects.filter(email=EMAIL).first().pk, existing.pk)
```

**Proposed**

```sql
users = list(User.objects.filter(email=EMAIL))
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0].pk, existing.pk)
```

**Why this helps** — This collapses the repeated filter into a single query result that can be reused for both assertions.

**Expected impact** — 1 query instead of 2 for the postcondition checks.

**Why the output is unchanged (the model's argument)** — The rewritten code returns the same rows because it evaluates the same filter once; it returns the same columns because model instances are used in both cases; ordering is irrelevant because the original query has no explicit ordering guarantee; NULL handling is unchanged; duplicate handling is unchanged because `len(users)` counts the same matching rows and `users[0]` refers to the first row from the same result set. Error behavior changes if there are zero matches, because the original `first().pk` would raise differently than `users[0].pk`, so this is only equivalent if the test already guarantees one row.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [count, first] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The row limit changes from 1 to none.
- The terminal operation changes from [count, first] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX is not required for this change.
```

**Assumptions**

- The test expects exactly one matching user after provisioning.

**Evidence**

- `tcms/kiwi_auth/tests/test_sso.py:88` (call-site) — Shows the same filter being executed twice back-to-back.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count, first] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- This code is reached by a test, so it runs once at install time or never in production.

## Suppressed before publication

27 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### not data access — 7

- **Batch execution creation instead of creating one row at a time** — `tcms/testplans/views.py:174`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Batch execution creation in the loop** — `tcms/testruns/views.py:321`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Compute the next sortkey without aggregating twice** — `tcms/testruns/views.py:592`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Use the latest sortkey lookup directly** — `tcms/rpc/api/testrun.py:84`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Replace the reverse lookup with a max-sortkey query** — `tcms/testplans/models.py:67`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Materialize the cloned case queryset before iterating** — `tcms/testplans/models.py:161`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Track the current maximum sortkey in memory** — `tcms/testruns/views.py:592`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.

### wrong direction (proposal issues no fewer queries) — 13

- **Collapse the per-stream run lookup into one aggregated query** — `tcms/core/views.py:566`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid loading full execution rows for case status lookup** — `tcms/rpc/api/testrun.py:160`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the confirmed status primary key instead of querying every clone** — `tcms/testcases/models.py:902`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch creation of environment properties** — `tcms/testruns/views.py:276`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Move status lookup out of the loop** — `scripts/run_assetshare_cases.py:42`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid counting executions with a separate aggregate** — `tcms/core/views.py:403`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Bulk-resolve custom fields before updating values** — `tcms/testcases/views.py:189`
  The proposal issues 6 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch tag lookups before diffing** — `tcms/testcases/views.py:416`
  The proposal issues 3 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Preload active run ids in bulk** — `tcms/core/views.py:154`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Preload active run ids in bulk** — `tcms/core/views.py:566`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fetch all submitted tags in one lookup** — `tcms/testcases/views.py:281`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fetch the site once before iterating comments** — `tcms/core/helpers/comments.py:39`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fold token lookup and last-used stamp into one write path** — `tcms/kiwi_auth/models.py:138`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)

### no-op (proposal identical to the original) — 5

- **Count distinct cases instead of executions** — `tcms/testplans/tests/test_views.py:165`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Count a single distinct case per run** — `tcms/testplans/tests/test_views.py:198`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Deduplicate case counting in the edit form** — `tcms/testruns/tests/test_views.py:825`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Do not flag the config lookup as n-plus-one** — `tcms/rpc/api/testrun.py:39`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Update inactive configs in one set-based statement** — `tcms/testcases/migrations/0036_migrate_testrail_id_custom_field.py:81`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

### cold path (migration, seed or test) — 2

- **Compare primary keys with the cached objects** — `tcms/testplans/tests/tests.py:287`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Push the filtering and ordering to the database once** — `tcms/testcases/migrations/0036_migrate_testrail_id_custom_field.py:56`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._