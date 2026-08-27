# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 1:12:34 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 58 analysed · 815 filtered (below confidence 0 · low priority 815) · 3 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 2 published · 5 suppressed

> **Incomplete scan.** 813 candidate(s) scored below the 0.7 priority floor and were not analysed. They are counted in the coverage figures, not hidden.

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
| high | 0 | 0 |
| medium | 0 | 0 |
| low | 0 | 0 |
| info | 2 | 0 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Materialize the tag names before counting facets

`info` · `other` · `mysql` · ✅ verified

This loop issues a tag facet aggregation directly from a filtered relation; pulling the matching tag names into Python first would not change the result here, but the current form already lets MySQL count through the join in one query, so there is no grounded equivalent rewrite to recommend.

**Where it is used**

- `tcms/rpc/api/testcase.py:500` in `search_page`
- Reached via request-handler

**Current**

```sql
Tag.objects.filter(case__id__in=capped_ids)
            .annotate(cnt=Count("case", distinct=True))
            .values_list("name", "cnt")
```

**Proposed**

```sql
Tag.objects.filter(case__id__in=capped_ids).annotate(cnt=Count("case", distinct=True)).values_list("name", "cnt")
```

**Why this helps** — No rewrite is grounded from the shown code that would reduce database work without changing semantics; the query already asks the database to compute the counts.

**Expected impact** — No change in database calls or result shape.

**Why the output is unchanged (the model's argument)** — The proposed code is identical to the original, so it preserves rows, columns, ordering, NULL handling, duplicates, and errors exactly; because of that, it is not a real optimization proposal.

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

- The selected fields are identical (name, cnt).
- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

**Assumptions**

- No additional filters or ordering are needed at the call site beyond what is shown.

**Evidence**

- `tcms/rpc/api/testcase.py:497` (call-site) — Shows the exact query site and its surrounding loop.

### Keep the ordered execution trend scan as-is

`info` · `other` · `mysql` · ✅ verified

The query already uses a single filtered, ordered ORM iteration with `select_related("status")`; based on the shown context there is no safe equivalent rewrite that would reduce calls or fetched columns without changing behavior.

**Where it is used**

- `tcms/telemetry/api.py:135` in `execution_trends`
- Reached via request-handler

**Current**

```sql
TestExecution.objects.filter(**query)
        .select_related("status")
        .order_by("run_id")
```

**Proposed**

```sql
TestExecution.objects.filter(**query).select_related("status").order_by("run_id")
```

**Why this helps** — No grounded rewrite is visible that would preserve the exact ordered stream of executions while reducing work.

**Expected impact** — No change.

**Why the output is unchanged (the model's argument)** — The proposed code is identical to the original, so it preserves the same rows, columns, ordering, NULL handling, duplicates, and errors exactly; therefore it is not a change.

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

- The loop consumes every row from this queryset as shown.

**Evidence**

- `tcms/telemetry/api.py:134` (call-site) — Shows the exact query and that it is consumed in a loop.

## Suppressed before publication

5 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### no-op (proposal identical to the original) — 5

- **Select only needed execution ids** — `tcms/core/views.py:567`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Leave the configured-field filter unchanged** — `tcms/testcases/custom_fields.py:43`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the active system-field config filter unchanged** — `tcms/testcases/forms.py:170`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Do not report the template queryset as an optimization** — `tcms/testcases/views.py:259`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the confirmed-case filter as written** — `tcms/testplans/views.py:159`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._