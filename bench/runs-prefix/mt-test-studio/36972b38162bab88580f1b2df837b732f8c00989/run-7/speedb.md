# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 3:01:44 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 871 analysed · 2 filtered (below confidence 0 · low priority 2) · 35 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Triage** 869 site(s) triaged · 58 flagged · 0 unsure · 811 clean (7% sent for write-up)  
**Triage gaps** 2 site(s) came back from triage with no verdict and were escalated to a full write-up rather than assumed clean. That is the safe direction, but a scan with many of them is one whose triage stage is not answering reliably.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 19 published · 24 suppressed

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
| high | 0 | 8 |
| medium | 3 | 3 |
| low | 2 | 3 |
| info | 0 | 0 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Hoist assignee lookup out of the execution loop

`medium` · `n-plus-one` · `mysql` · ✅ verified

The execution import path performs a username lookup for each execution row; preloading the referenced users once would avoid repeated ORM round trips while returning the same assignee objects for the same usernames.

**Where it is used**

- `tcms/core/admin_views.py:1081` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
user_model.objects.filter(username=assignee_name).first()
```

**Proposed**

```sql
assignee_name = exec_data.get("assignee", "")
assignee = assignee_map.get(assignee_name) if assignee_name else None
```

**Why this helps** — Build a username-to-user map once before the loop so each execution reuses an in-memory lookup instead of issuing a separate query.

**Expected impact** — 1 query to load the relevant users instead of one query per execution row

**Why the output is unchanged (the model's argument)** — For the same input data, this returns the same user object or None for each assignee name, and still returns None when the name is empty. It does not change selected columns, row ordering, duplicate handling, or NULL handling; any difference in behavior only arises if duplicate usernames exist and the original query would have returned an arbitrary first row, which should not happen under normal user-account assumptions.

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

**Automated equivalence check** — Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax).

Not machine-checkable:

- Not a statement this checker can read (non-SQL engine or unsupported syntax).

**Requires this migration first**

```sql
CREATE INDEX tcms_core_user_username_idx ON auth_user (username);
```

**Assumptions**

- The surrounding code populates assignee_map with the relevant users before this loop.
- Username values are unique in the user table, or the application relies only on the first matching row as before.

**Evidence**

- `tcms/core/admin_views.py:1081` (call-site) — Shows the repeated per-row username lookup inside the import loop.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Fetch the latest execution once per stream

`medium` · `n-plus-one` · `mysql` · ✅ verified

The view issues a separate ordered lookup for the latest finished execution inside the stream loop, so each stream performs its own database round trip instead of reusing already-computed data.

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
last_stop_date = latest_stop_dates.get(stream.id, "")
```

**Why this helps** — Compute the latest stop date for all streams in one grouped query before entering the loop, then look up the precomputed value per stream instead of querying again.

**Expected impact** — 1 query per stream replaced by 1 precomputed query plus in-memory lookups

**Why the output is unchanged (the model's argument)** — This preserves the same row set and columns because it still produces one value per stream; it preserves ordering because the surrounding loop order is unchanged; NULL handling is preserved by mapping missing groups to an empty result and formatting only when a value exists; duplicate executions do not matter because the original only uses the first row after ordering by descending stop_date, which the precomputed grouped maximum must match for the same underlying rows.

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
CREATE INDEX for the join/filter path only if the surrounding precomputation needs it; none is required from the visible context
```

**Assumptions**

- A grouped prefetch query can be added in the surrounding code without changing the CSV column order.
- The relevant execution rows are identified by the same stream relationship shown in the filter.
- The database supports grouping by the stream identifier used in the surrounding queryset.

**Evidence**

- `tcms/core/views.py:588` (call-site) — This is the per-stream lookup that causes repeated database access.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Aggregate executions directly from the plan

`medium` · `round-trip` · `mysql` · ✅ verified

The view first materializes every run id for the plan and then issues a second query against executions, which adds an unnecessary intermediate round trip and list build.

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

**Why this helps** — Filtering executions through the related plan lets the database join from executions to runs itself instead of first fetching all run primary keys into Python.

**Expected impact** — One query instead of two, and no Python list of run ids.

**Why the output is unchanged (the model's argument)** — The aggregate counts the same execution rows because `run__in=run_ids` and `run__plan_id=self.object.pk` identify the same executions for a given plan. It returns the same columns (`total`, `passed`, `failed`, `blocked`) and does not change ordering, NULL handling, or duplicates because the query is an aggregate with no row ordering guarantee. This is equivalent only if `run_id` is the foreign key from execution to run, which is implied by the existing `run__in` filter but not otherwise shown here.

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

- `TestExecution.run` is the foreign key to `TestRun`, as implied by `run__in=run_ids`.
- No custom manager or annotation on `TestExecution` changes the semantics of filtering via `run__plan_id`.

**Evidence**

- `tcms/testplans/views.py:381` (call-site) — Shows the two-step pattern: first collect run ids, then query executions by that collected list.

**Verification notes**

- Same-output claim needs review — The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Filter permissions by exact app label

`low` · `missing-index` · `mysql` · ✅ verified

The permission lookup uses a substring match on `content_type__app_label`, which is broader than the apparent intent and can match unrelated app labels that merely contain `bugs`.

**Where it is used**

- `tcms/bugs/migrations/0002_add_permissions.py:13` in `forwards_add_perms`
- Reached via migration
- Also at `tcms/bugs/migrations/0002_add_permissions.py:23`

**Current**

```sql
app_perms = permission_model.objects.filter(
        content_type__app_label__contains="bugs"
    )
```

**Proposed**

```sql
app_perms = permission_model.objects.filter(
        content_type__app_label="bugs"
    )
```

**Why this helps** — An exact equality comparison lets the database match only the intended app label instead of scanning for a substring and potentially returning unrelated rows.

**Expected impact** — The database can apply a more selective predicate and avoid substring matching work on the joined content type rows.

**Why the output is unchanged (the model's argument)** — This is not equivalent: `contains` can match more rows than exact equality, so the returned permission set may differ for databases containing app labels such as `mybugs` or `bugs_archive`. The row order is unchanged only incidentally; the duplicate and NULL behavior are also different because the predicate itself changes.

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
CREATE INDEX on the joined content type app_label column if one does not already exist, but only if this lookup remains performance-critical; otherwise no schema change is required.
```

**Assumptions**

- The intent is to select only permissions whose content type app label is exactly `bugs`.
- No downstream code depends on the broader substring-matching behavior.

**Evidence**

- `tcms/bugs/migrations/0002_add_permissions.py:13` (call-site) — Shows the exact permission lookup being performed in the migration.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- This code is reached by a migration or seed, so it runs once at install time or never in production.
- Severity is low, not the medium the model proposed: it concerns an index, whose cost is paid on every write for as long as it exists.

### Filter permissions by exact app label

`low` · `missing-index` · `mysql` · ✅ verified

The reverse migration repeats the same substring-based permission lookup, so it has the same broad-match behavior and the same unnecessary predicate cost.

**Where it is used**

- `tcms/bugs/migrations/0002_add_permissions.py:23` in `backwards`
- Reached via migration
- Also at `tcms/bugs/migrations/0002_add_permissions.py:13`

**Current**

```sql
app_perms = permission_model.objects.filter(
        content_type__app_label__contains="bugs"
    )
```

**Proposed**

```sql
app_perms = permission_model.objects.filter(
        content_type__app_label="bugs"
    )
```

**Why this helps** — Exact matching narrows the predicate to only the intended content type app label and avoids substring semantics.

**Expected impact** — The database can evaluate a simpler, more selective filter.

**Why the output is unchanged (the model's argument)** — Not equivalent for the same reason as the forward migration: `contains` may include additional rows that exact equality would exclude, so the result set can change.

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
CREATE INDEX on the content type app label column if the exact-match lookup becomes a hot path; otherwise none.
```

**Assumptions**

- The desired permissions are only those tied to the `bugs` app label exactly.
- The reverse operation should mirror the forward lookup precisely.

**Evidence**

- `tcms/bugs/migrations/0002_add_permissions.py:23` (call-site) — Shows the same substring permission lookup in the reverse migration.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, ordering, NULL or duplicate handling.
- This code is reached by a migration or seed, so it runs once at install time or never in production.
- Severity is low, not the medium the model proposed: it concerns an index, whose cost is paid on every write for as long as it exists.

## Behaviour changes and bugs

**These change what the query returns.** They are listed separately on purpose — review each on its merits.

### Filter statuses in SQL instead of loading all rows

`high` · `over-fetch` · `mysql` · ✅ verified

The view materializes every `TestExecutionStatus` row into Python just to build a name-to-object map, even though only the `UNTESTED` entry is needed for the fallback path.

**Where it is used**

- `tcms/core/admin_views.py:1018` in `StreamImportView.post`
- Reached via request-handler

**Current**

```sql
status_map = {s.name.upper(): s for s in TestExecutionStatus.objects.all()}
```

**Proposed**

```sql
untested = (
    TestExecutionStatus.objects.filter(name__iexact="UNTESTED").first()
    or TestExecutionStatus.objects.order_by("pk").first()
)
```

**Why this helps** — This asks the database for just the matching status row, instead of fetching every status and building a full Python dictionary.

**Expected impact** — One filtered lookup instead of loading all status rows into Python

**Why the output is unchanged (the model's argument)** — The original returns the object whose `name.upper()` is `UNTESTED` if present, otherwise the first row by `pk`. The rewrite returns the same object in the same fallback order. It preserves columns because both forms return a `TestExecutionStatus` instance, not a different projection. It does not change duplicates or NULL handling because `name__iexact` matches the same case-insensitive condition implied by `.upper() == "UNTESTED"`; if multiple rows differ only by case, either version can pick one matching row based on queryset behavior, so the behavior is not made more restrictive. If `name` can be NULL, those rows will not match either form.

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

Differences found:

- Ordering ["pk"] is added, constraining an order that was previously arbitrary.
- A row limit (1) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.
- The terminal operation changes from [none] to [first], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- `TestExecutionStatus.name` is the field used to identify the UNTESTED status.
- There is no code after this snippet that depends on building `status_map` for other statuses.

**Evidence**

- `tcms/core/admin_views.py:1016` (call-site) — Shows the full-table load used only to resolve the untested status.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [none] to [first], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the low the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Batch the repeated run-existence checks

`high` · `n-plus-one` · `mysql` · ✅ verified

This code performs an existence query for every nested run, so the database is asked to repeat the same lookup pattern for each imported run instead of checking all candidate run ids at once.

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
    TestRun.objects.filter(global_id__in=[
        run_data.get("global_id", "")
        for plan_data in plans_data
        for run_data in plan_data.get("runs", [])
        if run_data.get("global_id", "")
    ]).values_list("global_id", flat=True)
)

for plan_data in plans_data:
    for run_data in plan_data.get("runs", []):
        old_run_gid = run_data.get("global_id", "")
        if old_run_gid and old_run_gid in existing_run_gids:
            skipped.append(f"Run {old_run_gid} (already exists)")
            continue
```

**Why this helps** — The database can answer the existence question for all candidate runs in one membership query, avoiding a separate round trip for each run.

**Expected impact** — 1 query to fetch all existing matching runs instead of one existence query per run

**Why the output is unchanged (the model's argument)** — For each non-empty `global_id`, the rewritten code skips exactly when a matching `TestRun` exists, which is the same predicate as before. It does not alter output rows or columns because there is no query result being returned to the caller. It preserves loop order and therefore processing order. Empty `global_id` values still bypass the check exactly as before. Duplicate handling and error behavior remain the same because each run is still examined individually after the precomputed membership set is built.

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

**Assumptions**

- The set of candidate run ids can be materialized before processing.
- `global_id` is the only field used for the skip decision, as in the current code.

**Evidence**

- `tcms/core/admin_views.py:1046` (call-site) — Shows the per-run existence query nested inside the plan and run loops.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [global_id, flat=True]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Preload tester users for the import

`high` · `n-plus-one` · `mysql` · ✅ verified

This code looks up the tester user by username inside the inner loop, so the import repeats a user query for each run that supplies a tester name.

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
users_by_username = {
    user.username: user
    for user in user_model.objects.filter(username__in=tester_names)
}

for plan_data in plans_data:
    for run_data in plan_data.get("runs", []):
        tester_name = run_data.get("tester", "")
        tester = users_by_username.get(tester_name, request.user) if tester_name else request.user
```

**Why this helps** — Fetching all named testers up front lets the code reuse one user lookup result set instead of querying once per run.

**Expected impact** — 1 query to load all referenced testers instead of one per run with a tester name

**Why the output is unchanged (the model's argument)** — For each run, the rewritten code chooses the same user as before: the matching user by `username` if one exists, otherwise `request.user`, and when no tester name is supplied it still uses `request.user`. It does not change returned rows or columns because this is not a result-bearing query. It preserves the outer and inner loop order, so the created run sequence is unchanged. Duplicate handling is unchanged because only the lookup mechanism changes. NULL and empty-string handling remain the same because the code still treats falsy `tester_name` as meaning `request.user`. Error behavior is unchanged except that the user lookup is done via one set-based query instead of many single-row queries.

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

- `username` uniquely identifies a user in the database, or if multiple rows match then the existing `.first()` semantics are not relied on for those cases.
- It is acceptable to precompute the set of tester names before creating runs.

**Evidence**

- `tcms/core/admin_views.py:1049` (call-site) — Shows the repeated per-run username lookup that can be batched.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Precompute case counts outside the stream loop

`high` · `n-plus-one` · `mysql` · ✅ verified

The dashboard counts cases with a separate query for each stream; aggregating counts for all streams once and looking them up in memory avoids repeated database round trips.

**Where it is used**

- `tcms/core/views.py:186` in `DashboardView.get_context_data`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
```

**Proposed**

```sql
case_counts = dict(
    TestCase.objects.values("section__product").annotate(total=models.Count("id")).values_list("section__product", "total")
)
...
"cases": case_counts.get(stream.pk, 0),
```

**Why this helps** — Compute per-stream case totals once in the database, then reuse the result for each stream row.

**Expected impact** — 1 grouped count query instead of one count query per stream

**Why the output is unchanged (the model's argument)** — For each stream, this returns the same integer count of matching TestCase rows as the original filter().count() call. It does not change columns, ordering, NULL handling, or duplicates; the only requirement is that the grouping key used for the lookup matches the original stream identity.

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

**Checked against the declared schema**

- No CREATE TABLE for testcases_testcase was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section__product, section__product, total]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX tcms_core_testcase_section_product_idx ON testcases_testcase (section_id);
```

**Assumptions**

- The surrounding code can import or reference Count for the aggregation.
- The stream identifier used in the lookup is the same key produced by the aggregation.

**Evidence**

- `tcms/core/views.py:186` (call-site) — Shows a per-stream count query inside the dashboard loop.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section__product, section__product, total]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Precompute case counts for all streams

`high` · `n-plus-one` · `mysql` · ✅ verified

The CSV export counts cases inside the stream loop, so the code performs one count query per stream instead of getting all counts in a single aggregate pass.

**Where it is used**

- `tcms/core/views.py:595` in `AllStreamsCsvExportView.get`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(section__product=stream).count()
```

**Proposed**

```sql
case_counts = dict(
    TestCase.objects.values("section__product").annotate(total=Count("id")).values_list("section__product", "total")
)
# ...
case_counts.get(stream.id, 0)
```

**Why this helps** — An aggregate grouped by product can be computed once and then reused for each stream, avoiding repeated count queries inside the loop.

**Expected impact** — 1 aggregate query instead of one count query per stream

**Why the output is unchanged (the model's argument)** — This keeps the same numeric result for each stream, with missing streams still yielding 0; it does not change row ordering or columns because only the source of the per-stream count changes; duplicates are handled the same way because COUNT(id) over the filtered rows matches the original count on that filtered queryset; NULL handling is unchanged because rows not associated to a product still do not contribute.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [get], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [count] to [get], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [section__product, section__product, total]. Whether every attribute the caller touches is in that list is not decidable from the query alone.
- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX for the section/product path only if the aggregate needs it; none is required from the visible context
```

**Assumptions**

- section__product resolves to the same stream identifier used in the loop.
- The export only needs counts by stream and not per-section detail.
- The surrounding code can import Count and build the grouped mapping once.

**Evidence**

- `tcms/core/views.py:598` (call-site) — This count executes for each stream iteration.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [get], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [section__product, section__product, total]. Whether every attribute the caller touches is in that list is not decidable from the query alone. Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 3 structural fact(s) were counted from the two versions.

### Resolve submitted tags in one query

`high` · `n-plus-one` · `mysql` · ✅ verified

Each submitted tag name is looked up with a separate filter/first call; fetching all matching tags for the submitted names at once removes the repeated lookups.

**Where it is used**

- `tcms/testcases/views.py:282` in `NewCaseView.form_valid`
- Reached via request-handler
- Also at `tcms/testcases/views.py:422`

**Current**

```sql
tag_obj = Tag.objects.filter(name=tag_name).first()
```

**Proposed**

```sql
submitted_tags = {t.strip() for t in self.request.POST.getlist("tag") if t.strip()}
            tag_by_name = {
                tag.name: tag
                for tag in Tag.objects.filter(name__in=submitted_tags)
            }
            for tag_name in submitted_tags:
                tag_obj = tag_by_name.get(tag_name)
                if tag_obj:
                    test_case.add_tag(tag_obj)
```

**Why this helps** — This turns one lookup per submitted tag into a single query that returns all matching tags, then uses in-memory matching for the loop.

**Expected impact** — 1 query instead of one per submitted tag name.

**Why the output is unchanged (the model's argument)** — It adds the same tags as before for each submitted name that resolves to an existing Tag; rows are the same because only matching tags are used; columns are unchanged because no result set is exposed; ordering is unchanged for the database results because the original code did not guarantee any ordering beyond looping over submitted names; NULL handling and duplicate handling are preserved because blank names are still skipped and duplicate submitted names can still lead to the same tag being added more than once only if the original loop would have done so; any missing tag still results in no action, as before.

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

- Tag.name uniquely identifies the intended tag set for the submitted form values, or duplicate names are not expected in practice.
- The loop does not rely on database-side ordering of Tag lookups.

**Evidence**

- `tcms/testcases/views.py:282` (call-site) — Shows the repeated lookup pattern inside the tag-processing loop.
- `tcms/testcases/views.py:420` (call-site) — Shows the same repeated lookup pattern in the edit path as well.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Lookup submitted tags in bulk

`high` · `n-plus-one` · `mysql` · ✅ verified

The loop does one `Tag.objects.filter(name=name).first()` lookup per tag name, so the request issues repeated tag queries instead of resolving the whole name set once.

**Where it is used**

- `tcms/testcases/views.py:426` in `EditTestCaseView.form_valid`
- Reached via request-handler

**Current**

```sql
tag_obj = Tag.objects.filter(name=name).first()
```

**Proposed**

```sql
tag_objs = Tag.objects.filter(name__in=submitted - existing)
tag_by_name = {tag.name: tag for tag in tag_objs}
for name in submitted - existing:
    tag_obj = tag_by_name.get(name)
    if tag_obj:
        self.object.add_tag(tag_obj)
```

**Why this helps** — This turns one query per submitted tag into a single set-based lookup, then reuses the in-memory mapping while preserving the same add/remove behavior.

**Expected impact** — 1 query instead of one per submitted tag name

**Why the output is unchanged (the model's argument)** — It targets the same candidate names from `submitted - existing`; rows are limited to matching tags by exact `name` just as before. The loop still skips missing tags, returns the same columns from the Tag model, does not introduce ordering requirements, and preserves duplicate handling because `.first()` on a unique name set is replaced by a direct lookup for each unique name in the set.

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
CREATE INDEX current code already shows `name` lookups, but no index definition for Tag.name is visible in the provided context; if it is not already indexed, add one first.
```

**Assumptions**

- `Tag.name` is unique or at least the code only relies on one matching tag per exact name.
- `submitted - existing` is not so large that fetching all matching tags at once is problematic.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 2 structural fact(s) were counted from the two versions.

### Fetch active runs for all streams in one pass

`high` · `n-plus-one` · `mysql` · ✅ verified

The dashboard loops over streams and runs a separate `TestRun` filter plus aggregation for each stream, producing repeated database work inside the per-stream breakdown.

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
```

**Proposed**

```sql
stream_ids = list(Product.objects.all().order_by("name").values_list("pk", "name"))
active_runs = (
    TestRun.objects.filter(stop_date__isnull=True)
    .values("plan__product")
    .annotate(run_ids=ArrayAgg("pk"))
)
# or another grouping structure that loads active runs once and groups them per product
```

**Why this helps** — Grouping the active runs by product before iterating the streams avoids issuing a separate run query and execution aggregation for each product.

**Expected impact** — 1 grouped load of active runs instead of one run query plus one execution aggregation per stream

**Why the output is unchanged (the model's argument)** — The dashboard still produces one stats entry per product in `Product.objects.all().order_by("name")`, preserving product row ordering. The same active runs are considered because the filter remains `stop_date__isnull=True` and `plan__product`-scoped; only the execution of those lookups changes. The exact rewrite must preserve the aggregate columns and null handling from `exec_count_annotations()`, and because the current code materializes `active_run_ids` before the aggregate, the replacement must return the same set of run ids per product.

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

**Automated equivalence check** — Contradicted: The selected fields change from [pk, flat=True] to [pk, name, plan__product], so the caller receives different data.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Row ordering is unchanged.

Differences found:

- The selected fields change from [pk, flat=True] to [pk, name, plan__product], so the caller receives different data.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX no new migration is required from the visible context, but the benefit depends on existing foreign-key and stop-date selectivity.
```

**Assumptions**

- The intended output does not depend on the order of `active_run_ids` themselves, only on the aggregated counts.
- A grouping strategy such as `values(...).annotate(...)` or a prefetch-style preload can be expressed in the existing ORM without changing the dashboard schema.

**Verification notes**

- Reclassified as behaviour-changing: The selected fields change from [pk, flat=True] to [pk, name, plan__product], so the caller receives different data.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Stop scanning every bug system for a prefix match

`medium` · `full-scan` · `mysql` · ✅ verified

The helper iterates over all bug systems and tests each one in Python, which forces a full scan when the base URL could be matched directly through a database predicate.

**Where it is used**

- `tcms/rpc/api/utils.py:10` in `tracker_from_url`
- Reached via request-handler

**Current**

```sql
for bug_system in BugSystem.objects.all():
        if bug_system.base_url and url.startswith(bug_system.base_url):
            return import_string(bug_system.tracker_type)(bug_system, request)
```

**Proposed**

```sql
bug_system = (
    BugSystem.objects.filter(base_url__isnull=False, base_url__in=prefix_candidates)
    .order_by("-base_url")
    .first()
)
if bug_system:
    return import_string(bug_system.tracker_type)(bug_system, request)
return None
```

**Why this helps** — If the caller can provide or derive a bounded set of candidate prefixes, the database can narrow the search before Python inspects the one chosen row instead of loading every bug system.

**Expected impact** — Reads a narrowed set from the database instead of loading every bug system into Python

**Why the output is unchanged (the model's argument)** — This is only equivalent if the candidate-prefix logic returns exactly the same bug system as the original first-match scan for every input URL; it must preserve the same returned object or None, and the same import side effect. If the candidate set is not provably complete and ordered like the original iteration, the change would be behavioural rather than equivalent.

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
- Caps the result at 1 row(s), where the original was unbounded. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [none] to [first], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).

Differences found:

- Ordering ["-base_url"] is added, constraining an order that was previously arbitrary.
- A row limit (1) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.
- The terminal operation changes from [none] to [first], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX on BugSystem.base_url would help the lookup if one is not already present; no such index is visible in the provided context
```

**Assumptions**

- The code can derive a complete ordered prefix list matching the original `startswith` semantics.
- BugSystem.base_url values are the only match key visible in this context.
- A direct database narrowing is safe only if it preserves the same first-match behavior as the current Python loop.

**Evidence**

- `tcms/rpc/api/utils.py:16` (call-site) — This loop examines every bug system in Python before deciding whether to return.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [none] to [first], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the rows returned, the column list, ordering, NULL or duplicate handling.

### Collapse the repeated coverage counts into one aggregate

`medium` · `round-trip` · `mysql` · ✅ verified

The current code issues several separate count queries for the same stream, so this is a round-trip inefficiency rather than an N+1 loop problem.

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

**Why this helps** — This replaces four separate aggregate queries with one grouped aggregate, so the database only has to evaluate the filtered counts once.

**Expected impact** — 1 query instead of 4 for the coverage counts.

**Why the output is unchanged (the model's argument)** — The proposed aggregate returns the same scalar values for the same filters; it does not change row sets, columns, ordering, NULL handling, duplicates, or error behavior compared with the original count queries.

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
CREATE INDEX if needed on the test case filter columns used here, but none can be justified from the provided schema context.
```

**Assumptions**

- Django's filtered Count support is available in the project version used here.
- The later code only needs these four scalar counts, not intermediate queryset objects.

**Evidence**

- `tcms/core/views.py:856` (call-site) — Shows four separate database count operations over the same product scope.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Compute both counts in one aggregation

`medium` · `round-trip` · `mysql` · ✅ verified

The same filtered testcase set is counted twice with two separate queryset evaluations, so the database has to execute two count queries over the same base filter.

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
from django.db.models import Count, Q

    test_cases = TestCase.objects.filter(**query).aggregate(
        manual=Count("pk", filter=Q(is_automated=False), distinct=True),
        automated=Count("pk", filter=Q(is_automated=True), distinct=True),
    )
    manual_count = test_cases["manual"]
    automated_count = test_cases["automated"]
```

**Why this helps** — This lets the database compute both counts in one aggregation pass over the filtered set instead of evaluating two separate count queries.

**Expected impact** — One aggregated query instead of two separate count queries.

**Why the output is unchanged (the model's argument)** — The rewritten code returns the same two numeric counts for the same `query` and preserves the same filter conditions. It does not change the returned keys or visible output values, but it is behavioral because it changes how the counts are computed and depends on the database's aggregate semantics; duplicate handling stays aligned by using `distinct=True`, and NULL handling is unchanged because the filters are the same.

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

**Requires this migration first**

```sql
CREATE INDEX statements are not needed from the provided context.
```

**Assumptions**

- `breakdown` only needs the counts, not the intermediate queryset object.
- `TestCase` supports counting distinct primary keys in aggregation on this engine.

**Evidence**

- `tcms/telemetry/api.py:28` (call-site) — Shows the same filtered queryset is counted twice.

### Fold execution counts into one grouped query

`low` · `inefficient-join` · `mysql` · ✅ verified

The plan view annotates multiple counts over the same execution relation, which is one grouped query but can still multiply rows across joins and should be checked for unnecessary duplicate work.

**Where it is used**

- `tcms/testplans/views.py:213` in `Edit.get_context_data`
- Reached via request-handler

**Current**

```sql
TestRun.objects.filter(plan=self.object)
            .annotate(
                total_count=Count("executions", distinct=True),
                passed_count=Count(
                    "executions",
                    filter=Q(executions__status__name="PASSED"),
                    distinct=True,
                ),
```

**Proposed**

```sql
TestRun.objects.filter(plan=self.object).annotate(
                total_count=Count("executions", distinct=True),
                passed_count=Count(
                    "executions",
                    filter=Q(executions__status__name="PASSED"),
                    distinct=True,
                ),
```

**Why this helps** — The code already uses one queryset, but the annotation joins to executions and status; if these counts are only needed for display, a purpose-built aggregate or precomputed summary can avoid repeated join work inside the request.

**Expected impact** — Potentially fewer joined rows processed if replaced by a narrower aggregate, but this cannot be asserted from the available context.

**Why the output is unchanged (the model's argument)** — As written, there is not enough context to prove a strictly better equivalent rewrite without changing returned rows or ordering, because the query is already a single ORM query and we do not know the surrounding use of `existing_runs`. Therefore this triage does not hold up as a clear performance bug from the provided context.

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

- The view consumes `existing_runs` only for the annotated counts shown here.
- No later code depends on the queryset remaining lazily annotated.

### Avoid row-multiplying join for case lookup

`low` · `inefficient-join` · `mysql` · ⚠️ needs verification

`TestCase.objects.filter(executions__run_id=run_id)` joins through executions and can duplicate the same case when it has multiple matching executions, so replacing it with a deduplicating form would change duplicate handling.

**Where it is used**

- `tcms/rpc/api/testrun.py:139` in `get_cases`
- Reached via request-handler

**Current**

```sql
TestCase.objects.filter(executions__run_id=run_id).values(
```

**Proposed**

```sql
TestCase.objects.filter(executions__run_id=run_id).distinct().values(
```

**Why this helps** — This lets the ORM collapse repeated `TestCase` rows that come from the join to executions before materializing the result set.

**Expected impact** — Avoids returning duplicate case rows produced by the join.

**Why the output is unchanged (the model's argument)** — This is not equivalent as written because adding or removing `distinct()` changes duplicate handling and can change which rows are returned when the join produces multiple matches for the same case. The original query may return duplicates; the rewrite would not. Columns and ordering are also not proven identical.

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

**Automated equivalence check** — Contradicted: DISTINCT is added, which changes duplicate handling.

Confirmed automatically:

- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- DISTINCT is added, which changes duplicate handling.

**Requires this migration first**

```sql
CREATE INDEX on the execution foreign key and run_id join path if one is not already present; the context does not show the relevant execution table/index definitions, so a concrete migration cannot be grounded here.
```

**Assumptions**

- If the caller depends on one row per case, the current query already violates that expectation whenever a case has multiple executions for the same run.
- A deduplicating rewrite would need to preserve any required ordering separately.

**Verification notes**

- Evidence quote was not found in tcms/rpc/api/testrun.py.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Push the exclusion into SQL

`low` · `full-scan` · `mysql` · ⚠️ needs verification

Materializing all executed case IDs into a Python set forces the database to send every distinct `case_id` before the exclusion is applied.

**Where it is used**

- `tcms/core/views.py:501` in `StreamDashboardView.get`
- Reached via request-handler

**Current**

```sql
executed_case_ids = set(
            TestExecution.objects.values_list("case_id", flat=True).distinct()
        )
```

**Proposed**

```sql
never_run_count = (
    TestCase.objects.filter(section__product=stream)
    .exclude(executions__isnull=False)
    .count()
)
```

**Why this helps** — This lets the database apply the anti-join directly instead of first shipping the full distinct list of executed case IDs to Python.

**Expected impact** — Avoids building a potentially large Python set and lets the database perform the exclusion during query execution.

**Why the output is unchanged (the model's argument)** — This is not provably equivalent from the visible context because `executions__isnull=False` depends on the reverse relation name and the exact join semantics are not shown here; if that relation differs, rows could change. Even if the relation is correct, the rewrite must preserve duplicates, NULL handling, and the count semantics exactly. The current code counts cases whose `pk` is not in a Python set of executed `case_id` values; the proposed anti-join can differ if there are unexpected NULLs or duplicate execution rows unless carefully verified.

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

- No CREATE TABLE for TestExecution was found in the scanned files, so its columns could not be checked.

**Automated equivalence check** — Contradicted: DISTINCT is removed, which changes duplicate handling.

Confirmed automatically:

- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The proposal drops an explicit field list and fetches whole instances, which transfers more per row rather than less.
- DISTINCT is removed, which changes duplicate handling.
- The terminal operation changes from [none] to [count], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Requires this migration first**

```sql
CREATE INDEX on `TestExecution(case_id)` would be the relevant support if one is not already present; the provided schema context does not define the `testruns` model or its indexes.
```

**Assumptions**

- `TestExecution.case_id` references the same key as `TestCase.pk`.
- The reverse relation name `executions` is valid on `TestCase` in this codebase.
- No special handling of NULL `case_id` values is required beyond the current `exclude(pk__in=...)` behavior.

**Verification notes**

- Evidence quote was not found in tcms/core/views.py.
- Reclassified as behaviour-changing: DISTINCT is removed, which changes duplicate handling. The terminal operation changes from [none] to [count], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list, ordering.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

## Suppressed before publication

24 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### wrong direction (proposal issues no fewer queries) — 16

- **Preload plan sortkeys before the per-case loop** — `tcms/testruns/views.py:316`
  The proposal issues 3 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Prefetch custom-field configs before updating values** — `tcms/testcases/views.py:193`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch the stream statistics query work** — `tcms/core/views.py:160`
  The proposal issues 3 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Filter executions by stream instead of materializing run ids** — `tcms/core/views.py:572`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fold the confirmed status lookup into the copy loop** — `tcms/rpc/api/testcase.py:878`
  The proposal issues 4 database call(s) where the original issues 4, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Prefetch environment properties before creating property rows** — `tcms/testruns/views.py:276`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Keep the field-key filter on the database side** — `tcms/rpc/api/testrun.py:41`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the filtered count instead of re-querying per duplicate check** — `tcms/testcases/tests/test_epic_task_sections.py:1098`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Filter custom fields in the database** — `tcms/testcases/views.py:352`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Hoist the existing-plan lookup out of the loop** — `tcms/core/admin_views.py:1026`
  The proposal issues 3 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fetch the latest execution in one query per stream** — `tcms/core/views.py:176`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Preload priorities for the import batch** — `tcms/testcases/views.py:756`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Precompute active run IDs outside the per-stream loop** — `tcms/core/views.py:566`
  The proposal issues 4 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Precompute section counts in one grouped query** — `tcms/core/views.py:877`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Keep the user search within a single queryset** — `tcms/kiwi_auth/views.py:349`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Combine token lookup and last-used stamp** — `tcms/kiwi_auth/models.py:138`
  The proposal issues 2 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)

### not data access — 2

- **Compute the next sortkey once before inserting the batch** — `tcms/testruns/views.py:592`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.
- **Reuse the filtered executions queryset** — `tcms/rpc/api/testrun.py:77`
  Neither the original nor the proposal parses as a query or as ORM data access — this is not database code, so a database finding does not apply to it.

### no-op (proposal identical to the original) — 4

- **Prefetch run executions before cloning them** — `tcms/testplans/views.py:451`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Cache priorities before the import loop** — `tcms/core/admin_views.py:946`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Add a user primary-key fast path** — `tcms/core/forms/fields.py:35`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the user email-or-username lookup as-is** — `tcms/core/forms/fields.py:40`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

### cold path (migration, seed or test) — 2

- **Reuse the fetched plan instead of reloading it** — `tcms/testplans/tests/tests.py:299`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Reuse the already-loaded product objects** — `tcms/testplans/tests/tests.py:287`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._