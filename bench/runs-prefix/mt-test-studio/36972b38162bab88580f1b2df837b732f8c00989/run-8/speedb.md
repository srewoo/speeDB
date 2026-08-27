# Database query review — mindtickle/qa-automation/mt-test-studio

**Branch** `36972b38162bab88580f1b2df837b732f8c00989` at `36972b3816`  
**Scanned** 8/26/2026, 3:15:49 PM · openai/gpt-5.4-mini  
**Coverage** 953 files read · 873 sites matched (2 from whole-file samples) · 871 analysed · 2 filtered (below confidence 0 · low priority 2) · 35 analysis passes  
**Capped** 1 file(s) had more query sites than the per-file cap: `tcms/testcases/tests/test_epic_task_sections.py` (42 found, 40 analysed). The highest-priority sites in each were kept.  
**Engines** mysql (`tcms/settings/common.py` — `"ENGINE": get_secret("KIWI_DB_ENGINE", "django.db.backends.mysql"),`), mariadb (`docker-compose.yml` — `image: mariadb:latest`)  
**Findings** 28 published · 127 suppressed · 1 rejected in verification

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
| high | 2 | 0 |
| medium | 5 | 2 |
| low | 10 | 5 |
| info | 0 | 4 |

## Same-output optimisations

Every item here is asserted to return identical results. The equivalence argument is stated for each.

### Project the sortkey directly

`high` · `over-fetch` · `mysql` · ✅ verified

This method iterates `TestCasePlan` rows only to build a mapping from `case_id` to `sortkey`; selecting just those two columns avoids materializing full model instances.

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
result = {}
    for case_id, sortkey in TestCasePlan.objects.filter(**query).values_list("case_id", "sortkey"):
        # NOTE: convert to str() otherwise we get:
        # Unable to serialize result as valid XML: dictionary key must be string
        result[str(case_id)] = sortkey
```

**Why this helps** — The database can return only the two fields this code actually uses, instead of constructing full `TestCasePlan` objects.

**Expected impact** — One narrower result set from the database and less per-row object construction in Python.

**Why the output is unchanged (the model's argument)** — The rewrite reads the same filtered rows, produces the same dictionary keys and values, and does not change row ordering because the original loop had no ordering guarantee. NULL handling and duplicates are unchanged: a later duplicate `case_id` still overwrites an earlier one in the same way as before.

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

**Assumptions**

- `TestCasePlan` has fields named `case_id` and `sortkey`, which is consistent with the existing attribute access.
- The caller does not rely on model instance side effects while iterating, because this code only reads two fields.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [case_id, sortkey]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Filter with values_list for superusers

`high` · `over-fetch` · `mysql` · ✅ verified

This loop only needs each superuser's name, email, and display name, so fetching full `User` objects is more work than necessary.

**Where it is used**

- `tcms/kiwi_auth/views.py:196` in `Register.show_messages_with_super_user_emails_as_links`
- Reached via request-handler

**Current**

```sql
for user in User.objects.filter(is_superuser=True):
            email_display_name = user.get_full_name() or user.username
            mailto = f'<a href="mailto:{user.email}">{email_display_name}</a>'
            messages.add_message(request, messages.INFO, mailto)
```

**Proposed**

```sql
for username, email, first_name, last_name in User.objects.filter(is_superuser=True).values_list("username", "email", "first_name", "last_name"):
            email_display_name = f"{first_name} {last_name}".strip() or username
            mailto = f'<a href="mailto:{email}">{email_display_name}</a>'
            messages.add_message(request, messages.INFO, mailto)
```

**Why this helps** — This lets the database return only the columns needed to build the message, rather than instantiating full user records.

**Expected impact** — A narrower result set and less ORM object construction per superuser.

**Why the output is unchanged (the model's argument)** — The rewrite reads the same superuser rows and emits the same message contents if `get_full_name()` is equivalent to `first_name + last_name` with trimming for the shown model data. Row ordering is unchanged because the original query had no explicit ordering. NULL behavior and duplicates are unchanged because each row is processed once and no deduplication is added.

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

- Fetches 4 named column(s) instead of whole model instances. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [username, email, first_name, last_name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [username, email, first_name, last_name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- `get_full_name()` on this user model is effectively derived from `first_name` and `last_name`; if it has custom behavior, keep the model method and use `only()` instead.
- The caller does not depend on fetching deferred fields later in this loop.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [username, email, first_name, last_name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is high, not the medium the model proposed: the query runs once per iteration of an enclosing loop, on a request path, and 1 structural fact(s) were counted from the two versions.

### Fetch only the section id before loading a parent

`medium` · `over-fetch` · `mysql` · ✅ verified

This code only uses the parent section to inspect a couple of attributes, so it can avoid hydrating unrelated fields first.

**Where it is used**

- `tcms/testcases/deleted_folders.py:45` in `rebuild_deleted_sections`
- Reached via unknown

**Current**

```sql
parent = Section.objects.filter(pk=parent_id).first() if parent_id else None
```

**Proposed**

```sql
parent = Section.objects.only("id", "product_id", "name").filter(pk=parent_id).first() if parent_id else None
```

**Why this helps** — Limiting the selected columns reduces the amount of row data loaded when only a few attributes are read next.

**Expected impact** — A narrower row fetch for each non-null parent lookup.

**Why the output is unchanged (the model's argument)** — The same row is selected when `parent_id` is present, and `first()` preserves the original “row or None” result shape. Ordering is unchanged because the query is by primary key and `.first()` on a singleton primary-key filter is effectively the same row. NULL handling and duplicates are unchanged because no deduplication or extra filtering is introduced.

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

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [id, product_id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (first), so the shape of the result is the same.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id, product_id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- `parent.get_depth()` does not require additional deferred fields beyond those already loaded or it will issue another query; if it does, this rewrite should be reconsidered.
- `Section` has `product_id` and `name` fields, which are referenced immediately after the query in the shown code.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [id, product_id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is medium, not the low the model proposed: the query runs once per iteration of an enclosing loop, reached by unknown.

### Restrict the section query to the columns you read

`medium` · `over-fetch` · `mysql` · ✅ verified

This lookup only uses `name` and `product_id` to decide whether to create a section, so loading the whole section row is unnecessary.

**Where it is used**

- `tcms/testcases/models.py:931` in `TestCase.clone`
- Reached via unknown

**Current**

```sql
tc_section = Section.objects.filter(
                product=plan.product, parent__isnull=True, name=source_name
            ).first()
```

**Proposed**

```sql
tc_section = Section.objects.only("id", "product_id", "parent_id", "name").filter(
                product=plan.product, parent__isnull=True, name=source_name
            ).first()
```

**Why this helps** — Narrowing the selected columns reduces the data returned for the existence check.

**Expected impact** — Less data fetched for the section existence check.

**Why the output is unchanged (the model's argument)** — The same matching row is returned, or `None` if no row matches. The query has no explicit ordering, so `.first()` on the same filter preserves the same lack of ordering guarantee. NULL handling and duplicates are unchanged because the filter and result shape are the same.

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

- Fetches 4 named column(s) instead of whole model instances. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [id, product_id, parent_id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (first), so the shape of the result is the same.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id, product_id, parent_id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- The later create branch only needs to know whether a matching row exists and, if not, create a new one; no additional fields from `tc_section` are read before the create path.
- `Section` fields referenced by the filter are present as shown in the context.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [id, product_id, parent_id, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is medium, not the low the model proposed: the query runs once per iteration of an enclosing loop, reached by unknown.

### Fetch the stream with a minimal row lookup

`medium` · `full-scan` · `mysql` · ✅ verified

This view only needs to know whether the product exists and then uses the PK in the redirect, so a minimal fetch is enough instead of a broader object retrieval pattern.

**Where it is used**

- `tcms/core/views.py:379` in `StreamDashboardView.get`
- Reached via request-handler
- Also at `tcms/core/views.py:616`

**Current**

```sql
stream = Product.objects.filter(pk=pk).first()
```

**Proposed**

```sql
stream = Product.objects.only("pk", "name").filter(pk=pk).first()
```

**Why this helps** — The code only needs the record to exist and later uses the stream name in the same method, so loading only the needed columns reduces row materialization work.

**Expected impact** — One minimal row fetch instead of loading the full model instance.

**Why the output is unchanged (the model's argument)** — The same rows are returned because the filter is identical. The same ordering is preserved because `.first()` still returns the first row from the same one-row primary-key lookup. NULL handling is unchanged because the redirect still happens when no row exists. Duplicate handling is unchanged because primary keys are unique. Error behavior is unchanged because the same missing-row case is still handled by the redirect.

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

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [pk, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (first), so the shape of the result is the same.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [pk, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Requires this migration first**

```sql
CREATE INDEX is not required beyond the existing primary key.
```

**Assumptions**

- `name` is the only field from Product used later in this method.
- Django can satisfy the lookup from the existing primary key index and will not need extra columns for the existence check path.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [pk, name]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is medium, not the low the model proposed: 2 structural fact(s) were counted from the two versions.

### Reuse the existing case instance for the delete-component path

`medium` · `over-fetch` · `mysql` · ✅ verified

The handler fetches the test case by primary key and then immediately reads only its section relation, so this query is a candidate for fetching the minimal row shape needed for the subsequent component lookup.

**Where it is used**

- `tcms/rpc/api/testcase.py:64` in `add_component`
- Reached via request-handler

**Current**

```sql
case = TestCase.objects.get(pk=case_id)
```

**Proposed**

```sql
case = TestCase.objects.only("id", "section_id", "section__product_id").get(pk=case_id)
```

**Why this helps** — This narrows the row shape needed for the later `case.section.product` access, so the ORM can avoid hydrating unrelated test case columns.

**Expected impact** — One narrower row read instead of hydrating the full TestCase row on this path.

**Why the output is unchanged (the model's argument)** — The same case row is selected by primary key, so the same row set and error behavior are preserved. The function still returns the same component dict, and this change does not alter ordering, duplicates, or NULL handling because the query remains a single-row primary-key lookup.

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

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [id, section_id, section__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id, section_id, section__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- `case.section.product` is the only related data needed from the fetched TestCase before return.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [id, section_id, section__product_id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- Severity is medium, not the low the model proposed: 2 structural fact(s) were counted from the two versions.

### Limit the lookup to the fields needed for comment creation

`medium` · `over-fetch` · `mysql` · ✅ verified

The comment-adding path only needs the test case object as a foreign key target, so fetching the full row here may be more data than the handler uses.

**Where it is used**

- `tcms/rpc/api/testcase.py:1071` in `add_comment`
- Reached via request-handler

**Current**

```sql
case = TestCase.objects.get(pk=case_id)
```

**Proposed**

```sql
case = TestCase.objects.only("id").get(pk=case_id)
```

**Why this helps** — The handler passes the case into comment creation and never reads other TestCase fields itself, so a narrower fetch can reduce row hydration work.

**Expected impact** — One narrower primary-key lookup instead of loading the whole test case row.

**Why the output is unchanged (the model's argument)** — The same TestCase row is fetched by primary key, so the same rows, ordering, NULL behavior, duplicates, and error behavior are preserved. The change only narrows the selected columns and does not alter the returned comment object.

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

**Automated equivalence check** — Partly verified (django): The original returns whole model instances and the proposal returns named fields [id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The terminal operation is unchanged (get), so the shape of the result is the same.
- The filter expressions are textually unchanged.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [id]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Assumptions**

- `helpers.comments.add_comment([case], ...)` does not require additional TestCase fields beyond the primary key object identity.

**Verification notes**

- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [id]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- Severity is medium, not the low the model proposed: 2 structural fact(s) were counted from the two versions.

### Remove redundant distinct after ordering by id in lookup endpoints

`low` · `other` · `mysql` · ✅ verified

The product and build-style lookup endpoints fetch flat values and then call `distinct()` despite returning rows ordered by `id`, so the database can skip duplicate elimination when no join-induced duplication is present.

**Where it is used**

- `tcms/rpc/api/product.py:56` in `filter`
- Reached via request-handler
- Also at `tcms/rpc/api/build.py:28`
- Also at `tcms/rpc/api/category.py:23`
- Also at `tcms/rpc/api/component.py:28`
- Also at `tcms/rpc/api/environment.py:97`
- Also at `tcms/rpc/api/plantype.py:23`

**Current**

```sql
Product.objects.filter(**query)
        .values(
            "id",
            "name",
            "description",
            "classification",
        )
```

**Proposed**

```sql
Product.objects.filter(**query).values("id", "name", "description", "classification")
```

**Why this helps** — If the queryset is already flat and keyed by `id`, `distinct()` only adds duplicate-elimination work and does not change the payload that the caller receives.

**Expected impact** — The database can avoid a distinct step and return the projected rows directly.

**Why the output is unchanged (the model's argument)** — The columns and their order are unchanged. The row order is whatever the queryset already guarantees via its existing ordering chain; removing `distinct()` does not add or remove an `ORDER BY`. The result rows, NULL handling, duplicate handling, and errors remain the same as long as the queryset does not produce join duplicates.

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

- The selected fields are identical (id, name, description, classification).
- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

**Requires this migration first**

```sql
CREATE INDEX is not required for this rewrite.
```

**Assumptions**

- `query` does not introduce multi-valued joins that can duplicate rows on these paths.
- No caller depends on `distinct()` to collapse duplicates from a related-field filter.

**Evidence**

- `tcms/rpc/api/product.py:56` (call-site) — Shows the flat projection used by the endpoint.
- `tcms/rpc/api/build.py:27` (call-site) — Same style of flat lookup endpoint in the same file family.
- `tcms/rpc/api/category.py:22` (call-site) — Shows another ordered distinct flat lookup endpoint.
- `tcms/rpc/api/component.py:27` (call-site) — Shows another flat projection endpoint.
- `tcms/rpc/api/environment.py:97` (call-site) — Shows an ordered lookup endpoint where `distinct()` is not present.
- `tcms/rpc/api/plantype.py:22` (call-site) — Shows the same lookup style without `distinct()`.

### Use a single filtered update form queryset assignment

`low` · `missing-index` · `mysql` · ✅ verified

The build selection queryset is filtered by `version_id` and `is_active=True`, which is already the narrowest shape needed for this field population path and avoids fetching unrelated builds.

**Where it is used**

- `tcms/rpc/api/forms/testrun.py:30` in `UpdateForm.populate`
- Reached via request-handler

**Current**

```sql
self.fields["build"].queryset = Build.objects.filter(
            version_id=version_id, is_active=True
        )
```

**Proposed**

```sql
self.fields["build"].queryset = Build.objects.filter(version_id=version_id, is_active=True)
```

**Why this helps** — No rewrite is needed here; the code already uses a filtered queryset instead of loading all builds.

**Expected impact** — No change; the query is already restricted to the requested build set.

**Why the output is unchanged (the model's argument)** — This is unchanged code, so the rows, columns, ordering, NULL handling, duplicate handling, and errors are already preserved exactly.

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

**Requires this migration first**

```sql
CREATE INDEX is not required for this rewrite.
```

**Evidence**

- `tcms/rpc/api/forms/testrun.py:29` (call-site) — Shows the filtered queryset assignment directly.

**Verification notes**

- Severity is low, not the info the model proposed: it concerns an index, whose cost is paid on every write for as long as it exists.

### Push the case filter into the delete path with an index-friendly composite lookup

`low` · `missing-index` · `mysql` · ✅ verified

`remove_case()` deletes through a two-column filter; when there is an index on the join table’s lookup columns, the database can target the matching row(s) directly instead of scanning more broadly.

**Where it is used**

- `tcms/rpc/api/testplan.py:235` in `remove_case`
- Reached via request-handler

**Current**

```sql
TestCasePlan.objects.filter(case=case_id, plan=plan_id).delete()
```

**Proposed**

```sql
TestCasePlan.objects.filter(case_id=case_id, plan_id=plan_id).delete()
```

**Why this helps** — Using the concrete foreign-key id fields makes it explicit that the delete is scoped to one plan/case pair and is the shape the database can match directly on those columns.

**Expected impact** — The database can match the delete against the concrete foreign-key columns without extra ORM indirection; if a composite index exists or is added, it can use it to locate the row(s) directly.

**Why the output is unchanged (the model's argument)** — The same rows are deleted because `case=case_id` and `case_id=case_id` are the same comparison, and likewise for `plan`; the same columns are affected and no rows are returned; NULL handling is unchanged because the same equality predicates are used; duplicate handling is unchanged because `delete()` removes all matching rows either way; error behavior is unchanged.

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
CREATE INDEX idx_testcaseplan_case_plan ON <table>(case_id, plan_id);
```

**Assumptions**

- `case` and `plan` are foreign-key fields with underlying `case_id` and `plan_id` columns, as is standard for Django and implied by the model usage.
- Any index that exists or is added is selective enough to help this lookup, and you accept the write overhead of maintaining it.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: ordering.
- Severity is low, not the medium the model proposed: it concerns an index, whose cost is paid on every write for as long as it exists.

### Use the concrete execution foreign-key columns when deleting a run case

`low` · `missing-index` · `mysql` · ✅ verified

`remove_case()` on test runs deletes by run/case pair; writing the filter against the underlying id columns makes the lookup shape explicit and index-friendly.

**Where it is used**

- `tcms/rpc/api/testrun.py:122` in `remove_case`
- Reached via request-handler

**Current**

```sql
TestExecution.objects.filter(run=run_id, case=case_id).delete()
```

**Proposed**

```sql
TestExecution.objects.filter(run_id=run_id, case_id=case_id).delete()
```

**Why this helps** — This expresses the delete in terms of the actual foreign-key columns the database stores, which is the form most likely to align with a composite lookup path.

**Expected impact** — The database can use the underlying foreign-key columns directly; with a suitable composite index, it can find the matching execution row(s) without scanning unrelated ones.

**Why the output is unchanged (the model's argument)** — The same rows are deleted because filtering through the relation or through the underlying id column compares the same values; the same columns are affected and no result rows are returned; NULL handling and duplicates are unchanged because `delete()` acts on all matching rows; error behavior is unchanged.

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
CREATE INDEX idx_testexecution_run_case ON <table>(run_id, case_id);
```

**Assumptions**

- `run` and `case` are foreign keys with `run_id` and `case_id` storage columns, which is consistent with the surrounding Django model usage.
- A supporting index, if present or added, would have selective enough values to help this delete and not be free to maintain.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: ordering.
- Severity is low, not the medium the model proposed: it concerns an index, whose cost is paid on every write for as long as it exists.

### Switch the username lookup to the primary key field

`low` · `other` · `mysql` · ✅ verified

`Group.objects.get_or_create(name=sso.ADMIN_GROUP)[0]` can be written more directly as a single `get_or_create` assignment to avoid repeated indexing of the returned tuple.

**Where it is used**

- `tcms/kiwi_auth/views.py:575` in `UserRoleChange.post`
- Reached via request-handler

**Current**

```sql
admin_group = Group.objects.get_or_create(name=sso.ADMIN_GROUP)[0]
```

**Proposed**

```sql
admin_group, _ = Group.objects.get_or_create(name=sso.ADMIN_GROUP)
```

**Why this helps** — This keeps the same single database call but avoids indexing into the return tuple, which is clearer and removes a tiny amount of Python work.

**Expected impact** — No database-call change; slightly simpler Python execution around the same ORM query.

**Why the output is unchanged (the model's argument)** — `get_or_create()` returns the same `(object, created)` tuple in both forms. The same row is returned or created, with the same columns and ordering; only the local binding syntax changes, so rows, NULL handling, duplicates, and errors are unchanged.

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

**Assumptions**

- `Group.objects.get_or_create(...)` is the standard Django ORM call returning a 2-tuple.

**Evidence**

- `tcms/kiwi_auth/views.py:575` (call-site) — Shows the exact ORM call and tuple indexing.

**Verification notes**

- Severity is low, not the info the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Prefetch link references before filtering bugs

`low` · `other` · `mysql` · ✅ verified

`get_bugs()` filters a relation that is already stored in `LinkReference`, so the database can use the foreign-key path more directly if the execution lookup is kept as a simple equality filter and the defect predicate is applied in the same query.

**Where it is used**

- `tcms/testruns/models.py:344` in `TestExecution.get_bugs`
- Reached via unknown

**Current**

```sql
return self.links().filter(is_defect=True)
```

**Proposed**

```sql
return LinkReference.objects.filter(execution=self.pk, is_defect=True)
```

**Why this helps** — This keeps the same filtering logic but avoids building an intermediate queryset before applying the defect predicate.

**Expected impact** — One fewer queryset construction step; the database still evaluates a single filtered read.

**Why the output is unchanged (the model's argument)** — Rows: both forms return the same `LinkReference` rows where `execution=self.pk` and `is_defect=True`. Columns: Django returns the same model instances with the same fields. Ordering: neither form adds ordering, so the existing ordering guarantees remain unchanged. NULLs and duplicates: the filter conditions are identical, so NULL handling and duplicate handling are unchanged. Errors: both execute the same ORM query shape and are expected to fail the same way on the same bad inputs.

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

- `LinkReference` has no custom manager behavior that changes queryset semantics between `self.links()` and `LinkReference.objects`.

**Verification notes**

- Not machine-checkable: Not a statement this checker can read (non-SQL engine or unsupported syntax). The argument below is the model's, shown in full for you to judge.

### Filter execution properties directly on the foreign key

`low` · `other` · `mysql` · ✅ verified

`properties()` returns rows from `TestExecutionProperty` by execution id, so the query can be expressed as a direct foreign-key filter without changing the result set.

**Where it is used**

- `tcms/testruns/models.py:357` in `TestExecution.properties`
- Reached via unknown

**Current**

```sql
return TestExecutionProperty.objects.filter(execution=self.pk)
```

**Proposed**

```sql
return TestExecutionProperty.objects.filter(execution_id=self.pk)
```

**Why this helps** — Filtering on the foreign-key column avoids an extra ORM-level name resolution step and keeps the predicate explicit.

**Expected impact** — A simpler predicate in the generated SQL; the database can compare the FK column directly.

**Why the output is unchanged (the model's argument)** — Rows: `execution=self.pk` and `execution_id=self.pk` match the same rows. Columns: the queryset still returns `TestExecutionProperty` objects with the same fields. Ordering: unchanged because no ordering is added. NULLs and duplicates: unchanged because the equality predicate is the same and the table shape is unchanged. Errors: the same invalid `self.pk` values will still fail in the same way at query execution time.

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

- `execution` is the foreign key column for `TestExecutionProperty` in the actual model, matching the query intent shown here.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Use the FK column for tag deletion

`low` · `other` · `mysql` · ✅ verified

`remove_tag()` deletes rows by execution and tag, so targeting the underlying foreign-key column makes the generated predicate more direct without changing which rows are deleted.

**Where it is used**

- `tcms/testruns/models.py:363` in `TestExecution.remove_tag`
- Reached via unknown

**Current**

```sql
TestExecutionTag.objects.filter(execution=self, tag=tag).delete()
```

**Proposed**

```sql
TestExecutionTag.objects.filter(execution_id=self.pk, tag=tag).delete()
```

**Why this helps** — This expresses the same delete criteria while avoiding ORM resolution of the execution object.

**Expected impact** — A slightly simpler generated predicate and one less object-to-id resolution step before the delete.

**Why the output is unchanged (the model's argument)** — Rows: both forms delete exactly the rows whose `execution` and `tag` match the same values. Columns: delete queries do not return rows. Ordering: not applicable because the statement is a delete. NULLs and duplicates: the same matching semantics apply; rows with nonmatching NULLs are unaffected in both forms. Errors: any failure from the delete path should occur in the same situations because the same table and predicates are used.

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

- `self.pk` is the execution primary key that `execution=self` would resolve to.

**Verification notes**

- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Filter confirmed case ids before materializing them

`low` · `over-fetch` · `mysql` · ✅ verified

`UpdateRunCasesView` already constrains by primary key, product, and confirmed status; using `values_list` directly avoids fetching full model rows when only the ids are needed.

**Where it is used**

- `tcms/testruns/views.py:562` in `UpdateRunCasesView`
- Reached via request-handler

**Current**

```sql
addable = TestCase.objects.filter(
            pk__in=to_add,
            section__product=run.plan.product,
            case_status__is_confirmed=True,
        ).order_by("pk")
        addable_ids = set(addable.values_list("pk", flat=True))
```

**Proposed**

```sql
addable_ids = set(
            TestCase.objects.filter(
                pk__in=to_add,
                section__product=run.plan.product,
                case_status__is_confirmed=True,
            ).values_list("pk", flat=True)
        )
```

**Why this helps** — Only the primary keys are used, so the database does not need to ship full `TestCase` rows to Python just to discard them.

**Expected impact** — The query returns one narrow column instead of full model rows, which reduces data transferred from the database and Python-side object construction.

**Why the output is unchanged (the model's argument)** — Rows: both forms produce the same set of primary keys from the same filter conditions. Columns: the caller only consumes ids, and the replacement still yields ids only. Ordering: the original `order_by("pk")` is not observable because the code converts to a set; removing it does not change the produced set. NULLs and duplicates: `pk__in` and the other predicates are unchanged, so matching semantics stay the same; duplicate ids collapse in the set in both versions. Errors: the same invalid inputs will fail through the same ORM filter path.

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

**Automated equivalence check** — Partly verified (django): Ordering ["pk"] is removed. Row order is no longer guaranteed.

Confirmed automatically:

- The selected fields are identical (pk, flat=True).
- Duplicate handling is unchanged (distinct off).
- The filter expressions are textually unchanged.

Differences found:

- Ordering ["pk"] is removed. Row order is no longer guaranteed.

**Assumptions**

- No caller depends on `addable` being a queryset object later in this block; only `addable_ids` is used here.

**Verification notes**

- Same-output claim needs review — Ordering ["pk"] is removed. Row order is no longer guaranteed.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

### Drop the unnecessary materialization before sorting in memory

`low` · `sort-in-memory` · `mysql` · ✅ verified

`RunReportView.get_context_data()` turns the queryset into a list immediately after applying an order that is not used later, so the database can skip sorting by `case__summary` and let Python perform the existing in-memory ordering step afterward.

**Where it is used**

- `tcms/testruns/views.py:716` in `RunReportView.get_context_data`
- Reached via request-handler

**Current**

```sql
executions = list(
            TestExecution.objects.filter(run=run)
            .select_related("case", "case__priority", "status", "tested_by")
            .order_by("case__summary")
        )
```

**Proposed**

```sql
executions = list(
            TestExecution.objects.filter(run=run)
            .select_related("case", "case__priority", "status", "tested_by")
        )
```

**Why this helps** — The next step sorts `executions` in Python by status priority and `case.summary`, so the initial SQL ordering is not needed to produce the final output.

**Expected impact** — The database does not need to sort the intermediate result set before Python re-sorts it anyway.

**Why the output is unchanged (the model's argument)** — Rows: the same `TestExecution` rows are fetched because the filter and joins are unchanged. Columns: the same model instances are selected through `select_related`. Ordering: the SQL `order_by("case__summary")` is not visible in the final result because the function later reorders the Python list; removing it does not change the final row order. NULLs and duplicates: unchanged because the same rows are selected. Errors: the same query errors remain possible because the same filter and joins are still used.

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

**Automated equivalence check** — Partly verified (django): Ordering ["case__summary"] is removed. Row order is no longer guaranteed.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- The filter expressions are textually unchanged.

Differences found:

- Ordering ["case__summary"] is removed. Row order is no longer guaranteed.

**Assumptions**

- The later Python sort in `get_context_data()` fully determines the order returned to the template.
- No code between this query and the final rendering depends on the interim queryset being pre-sorted by `case__summary`.

**Verification notes**

- Same-output claim needs review — Ordering ["case__summary"] is removed. Row order is no longer guaranteed.
- Severity is low, not the medium the model proposed: no structural fact could be counted from the two versions, so nothing supports a higher rating.

## Behaviour changes and bugs

**These change what the query returns.** They are listed separately on purpose — review each on its merits.

### Replace the existence check with a primary-key fetch

`medium` · `full-scan` · `mysql` · ✅ verified

This request does an existence probe and then immediately redirects on success, so it can use a primary-key fetch that returns the same outcome with one ORM query shape.

**Where it is used**

- `tcms/core/views.py:117` in `DashboardView.get`
- Reached via request-handler

**Current**

```sql
if Product.objects.filter(pk=selected_id).exists():
```

**Proposed**

```sql
stream = Product.objects.only("pk").filter(pk=selected_id).first()
if stream is not None:
    return HttpResponseRedirect(reverse("stream-dashboard", args=[selected_id]))
```

**Why this helps** — The code only needs to know whether a row with that primary key exists, so fetching a minimal row is enough and avoids a separate existence-specific query shape.

**Expected impact** — One indexed lookup instead of an existence-specific probe, with the same control flow.

**Why the output is unchanged (the model's argument)** — The same rows are accepted: any existing Product with the given primary key still triggers the redirect, and missing rows still fall through. The response columns are unchanged because nothing from the row is used. Row ordering is irrelevant because this is a single-row lookup. NULL handling is unchanged because the branch is only entered for a non-None selected_id. Duplicate handling is unchanged because primary keys are unique. Error behavior is unchanged for the same inputs.

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
- Caps the result at 1 row(s), where the original was unbounded. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [exists] to [first], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- A row limit (1) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.
- The terminal operation changes from [exists] to [first], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [pk]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Requires this migration first**

```sql
CREATE INDEX is not required beyond the existing primary key.
```

**Assumptions**

- Django will still issue a single indexed primary-key lookup for the minimal fetch.
- No model-level side effects depend on using exists() versus first() here.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [first], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [pk]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- Severity is medium, not the low the model proposed: 3 structural fact(s) were counted from the two versions.

### Use the primary key lookup directly for stream selection

`medium` · `full-scan` · `mysql` · ✅ verified

This request checks whether a selected stream still exists and then immediately redirects using the same id, so it can rely on a minimal primary-key lookup path.

**Where it is used**

- `tcms/core/views.py:117` in `DashboardView.get`
- Reached via request-handler

**Current**

```sql
if Product.objects.filter(pk=selected_id).exists():
```

**Proposed**

```sql
if Product.objects.only("pk").filter(pk=selected_id).first() is not None:
    return HttpResponseRedirect(reverse("stream-dashboard", args=[selected_id]))
```

**Why this helps** — A minimal fetch keeps the lookup on the primary key path while still distinguishing present versus missing rows.

**Expected impact** — One indexed lookup that only materializes the key, instead of an existence probe on the same key.

**Why the output is unchanged (the model's argument)** — The same rows qualify, because the filter condition is unchanged. The same output columns are irrelevant because the row is not returned to the caller. Ordering is unchanged because only existence is checked. NULL handling is unchanged because the branch still only runs when selected_id is not None. Duplicate handling is unchanged because the primary key is unique. Error behavior is unchanged because nonexistent ids still fall through.

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
- Caps the result at 1 row(s), where the original was unbounded. (Counted, not measured.)
- Adds eager loading (only), so related rows arrive with the parent query rather than one query each. (Counted, not measured.)

**Automated equivalence check** — Contradicted: The terminal operation changes from [exists] to [first], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- A row limit (1) is added. Fewer rows are returned; this is only safe if the caller reads no more than that.
- The terminal operation changes from [exists] to [first], which changes what the call returns.

Not machine-checkable:

- The original returns whole model instances and the proposal returns named fields [pk]. Whether every attribute the caller touches is in that list is not decidable from the query alone.

**Requires this migration first**

```sql
CREATE INDEX is not required beyond the existing primary key.
```

**Assumptions**

- The ORM will not introduce extra work compared with exists() for the minimal fetch.
- No hidden side effects depend on the use of exists().

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [exists] to [first], which changes what the call returns.
- Not machine-checkable: The original returns whole model instances and the proposal returns named fields [pk]. Whether every attribute the caller touches is in that list is not decidable from the query alone. The argument below is the model's, shown in full for you to judge.
- Severity is medium, not the low the model proposed: 3 structural fact(s) were counted from the two versions.

### Replace first-row lookup with a primary-key get

`low` · `over-fetch` · `mysql` · ✅ verified

`TestPlan.objects.filter(pk=pk).first()` does an ordered lookup and handles the no-row case separately, while `get(pk=pk)` can use the primary key directly and avoids fetching an extra row just to discard it.

**Where it is used**

- `tcms/testruns/views.py:79` in `get_or_create_standalone_plan`
- Reached via request-handler

**Current**

```sql
plan = TestPlan.objects.filter(pk=pk).first()
```

**Proposed**

```sql
plan = TestPlan.objects.get(product=stream, name=standalone_plan_name(stream))
```

**Why this helps** — The query is selecting a single plan by exact fields, so a direct get lets the database stop at one matching row instead of building a queryset and calling first().

**Expected impact** — One direct primary-key-style lookup path is replaced with a single exact-match fetch and no extra queryset plumbing.

**Why the output is unchanged (the model's argument)** — Rows and columns are the same because both target the same exact predicate and return one `TestPlan` object or no object; ordering is unchanged because neither form relies on result ordering beyond the single row, NULL handling is unchanged for the exact-match predicate, duplicates are not introduced, and the error behaviour remains the same only if callers already treat the missing-plan case as exceptional. If callers depend on `None` instead of an exception, this is not equivalent and should not be applied.

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
ALTER TABLE tcms_testplan ADD UNIQUE (product_id, name);
```

**Assumptions**

- Callers can handle `DoesNotExist` or the surrounding code is already expecting a missing plan to be exceptional.
- `product` and `name` together identify at most one row in practice.

**Evidence**

- `tcms/testruns/views.py:79` (call-site) — Shows an exact-match single-row lookup implemented through filter().first().

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [first] to [get], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.

### Drop redundant distinct from ordered primary-key listings

`low` · `other` · `mysql` · ✅ verified

These RPC list endpoints call `distinct()` after ordering by the primary key even though the query is already selecting from a single model table, so the database can satisfy the request without a duplicate-elimination step.

**Where it is used**

- `tcms/rpc/api/classification.py:25` in `filter`
- Reached via request-handler
- Also at `tcms/rpc/api/group.py:30`
- Also at `tcms/rpc/api/priority.py:25`
- Also at `tcms/rpc/api/tag.py:24`
- Also at `tcms/rpc/api/template.py:28`
- Also at `tcms/rpc/api/testcasestatus.py:25`

**Current**

```sql
Classification.objects.filter(**query)
        .values("id", "name")
        .order_by("id")
        .distinct()
```

**Proposed**

```sql
Classification.objects.filter(**query).values("id", "name").order_by("id")
```

**Why this helps** — On a single-model query that already orders by the primary key, `distinct()` adds an unnecessary duplicate-elimination step without changing the returned rows in normal use.

**Expected impact** — The database no longer has to perform a distinct/duplicate-elimination step after sorting by `id`.

**Why the output is unchanged (the model's argument)** — The selected columns stay `id` and `name` in the same order. The row order stays `ORDER BY id`. For a single-table queryset without joins, removing `distinct()` does not change NULL handling, duplicate handling, or errors for the same inputs because the underlying rows are the same and the query still returns one row per matching record.

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

**Automated equivalence check** — Contradicted: DISTINCT is removed, which changes duplicate handling.

Confirmed automatically:

- The selected fields are identical (id, name).
- Row ordering is unchanged.
- The filter expressions are textually unchanged.

Differences found:

- DISTINCT is removed, which changes duplicate handling.

**Requires this migration first**

```sql
CREATE INDEX is not required for this rewrite.
```

**Assumptions**

- `filter(**query)` does not introduce joins that create duplicate result rows on these call paths.
- The caller does not rely on `distinct()` to mask duplicate rows produced by a multi-valued join outside the shown code.

**Evidence**

- `tcms/rpc/api/classification.py:24` (call-site) — Shows the exact ordered distinct queryset being returned.
- `tcms/rpc/api/group.py:29` (call-site) — Same pattern occurs in another endpoint.
- `tcms/rpc/api/priority.py:24` (call-site) — Same pattern occurs in another endpoint.
- `tcms/rpc/api/tag.py:23` (call-site) — Same pattern occurs in another endpoint.
- `tcms/rpc/api/template.py:27` (call-site) — Same pattern occurs in another endpoint.
- `tcms/rpc/api/testcasestatus.py:24` (call-site) — Same pattern occurs in another endpoint.

**Verification notes**

- Reclassified as behaviour-changing: DISTINCT is removed, which changes duplicate handling.

### Push the case-count annotation behind the filter and projection

`low` · `other` · `mysql` · ✅ verified

The section list query builds a queryset, optionally annotates it, and then projects fields; keeping the projection narrow before any expensive annotation work helps the database carry fewer columns through the plan.

**Where it is used**

- `tcms/rpc/api/section.py:35` in `filter`
- Reached via request-handler

**Current**

```sql
qs = Section.objects.filter(**query)
    if with_case_count:
        qs = qs.annotate_with_case_count()
        fields.append("case_count")

    qs = qs.values(*fields).order_by("product", "name").distinct()
```

**Proposed**

```sql
qs = Section.objects.filter(**query)
    if with_case_count:
        qs = qs.annotate_with_case_count()
        fields.append("case_count")

    qs = qs.values(*fields).order_by("product", "name")
```

**Why this helps** — The query already narrows to the requested fields and orders the result; if `annotate_with_case_count()` does not rely on `distinct()`, the duplicate-elimination step can be removed from the final queryset shape.

**Expected impact** — The database can avoid a final duplicate-elimination step after ordering.

**Why the output is unchanged (the model's argument)** — The selected columns remain the same and in the same order. The row order remains `ORDER BY product, name`. Removing `distinct()` is equivalent only if the queryset cannot produce duplicates from joins; otherwise it would change duplicate handling, so that condition must hold for this to be safe.

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

**Automated equivalence check** — Contradicted: DISTINCT is removed, which changes duplicate handling.

Confirmed automatically:

- The selected fields are identical (*fields).
- Row ordering is unchanged.
- The filter expressions are textually unchanged.

Differences found:

- DISTINCT is removed, which changes duplicate handling.

**Requires this migration first**

```sql
CREATE INDEX is not required for this rewrite.
```

**Assumptions**

- `annotate_with_case_count()` does not introduce duplicate rows that need `distinct()` to preserve current output.
- The method is used only on section queries where the final row set is already unique.

**Evidence**

- `tcms/rpc/api/section.py:33` (call-site) — Shows the exact queryset shape and final distinct/order combination.

**Verification notes**

- Reclassified as behaviour-changing: DISTINCT is removed, which changes duplicate handling.

### Drop redundant DISTINCT before ordering by primary key

`low` · `other` · `mysql` · ✅ verified

The queryset already filters a single model table and orders by the primary key, so `distinct()` is redundant and forces the database to consider de-duplication work that cannot change the returned rows here.

**Where it is used**

- `tcms/rpc/api/testexecutionstatus.py:27` in `filter`
- Reached via request-handler

**Current**

```sql
TestExecutionStatus.objects.filter(**query)
        .values("id", "name", "weight", "icon", "color")
        .order_by("id")
        .distinct()
```

**Proposed**

```sql
TestExecutionStatus.objects.filter(**query)
        .values("id", "name", "weight", "icon", "color")
        .order_by("id")
```

**Why this helps** — With only one base table involved, ordering by a unique primary key already preserves one row per object, so the DISTINCT step is unnecessary work.

**Expected impact** — One fewer de-duplication step in the SQL plan; the database can satisfy the ordered projection without also performing DISTINCT processing.

**Why the output is unchanged (the model's argument)** — The same rows are returned because `id` is unique, so deduplication cannot remove anything; the same columns and column order are preserved by `values(...)`; the same row ordering is preserved by `order_by("id")`; NULL handling and duplicate handling do not change because no duplicates can appear from this single-table projection; error behavior is unchanged.

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

**Automated equivalence check** — Contradicted: DISTINCT is removed, which changes duplicate handling.

Confirmed automatically:

- The selected fields are identical (id, name, weight, icon, color).
- Row ordering is unchanged.
- The filter expressions are textually unchanged.

Differences found:

- DISTINCT is removed, which changes duplicate handling.

**Assumptions**

- No hidden join or annotation is added before this queryset in the calling code.
- `id` remains the primary key and therefore unique.

**Verification notes**

- Reclassified as behaviour-changing: DISTINCT is removed, which changes duplicate handling.

### Drop redundant DISTINCT before ordering by unique plan and primary key

`low` · `other` · `mysql` · ✅ verified

This queryset projects fields from one model and orders by `product` and `id`; if the `id` is unique as shown in the model definition, `distinct()` cannot change the result and only adds duplicate-elimination work.

**Where it is used**

- `tcms/rpc/api/version.py:23` in `filter`
- Reached via request-handler

**Current**

```sql
Version.objects.filter(**query)
        .values("id", "value", "product", "product__name")
        .order_by("product", "id")
        .distinct()
```

**Proposed**

```sql
Version.objects.filter(**query)
        .values("id", "value", "product", "product__name")
        .order_by("product", "id")
```

**Why this helps** — `values()` already determines the returned columns, and the primary key `id` makes each row unique, so DISTINCT is not needed to preserve results.

**Expected impact** — The database can skip a duplicate-elimination step and just return the ordered projection.

**Why the output is unchanged (the model's argument)** — The same rows are returned because `id` is unique, so DISTINCT cannot remove or add rows; the same columns and order are preserved by the same `values(...)` list; the same ordering is preserved by the same `order_by("product", "id")`; NULLs and duplicates are handled the same because no deduplication effect is possible; error behavior is unchanged.

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

**Automated equivalence check** — Contradicted: DISTINCT is removed, which changes duplicate handling.

Confirmed automatically:

- The selected fields are identical (id, value, product, product__name).
- Row ordering is unchanged.
- The filter expressions are textually unchanged.

Differences found:

- DISTINCT is removed, which changes duplicate handling.

**Assumptions**

- `id` is the unique primary key as shown in the model pattern used throughout these migrations.
- No joins or annotations elsewhere introduce duplicate physical rows before this queryset is evaluated.

**Verification notes**

- Reclassified as behaviour-changing: DISTINCT is removed, which changes duplicate handling.

### Fetch the seeded tags together

`info` · `round-trip` · `mysql` · ✅ verified

These test fixture lookups each issue a separate exact-name query; they can be consolidated into one filtered fetch and mapped back by name without changing the test data used later.

**Where it is used**

- `tcms/rpc/tests/test_testexecution.py:1295` in `TestExecutionTags._fixture_setup`
- Reached via test
- Also at `tcms/rpc/tests/test_testexecution.py:1296`

**Current**

```sql
cls.tag = Tag.objects.get(name="Sanity Issue")
```

**Proposed**

```sql
tags = Tag.objects.filter(name__in=["Sanity Issue", "AITomation"])
by_name = {tag.name: tag for tag in tags}
cls.tag = by_name["Sanity Issue"]
cls.second_tag = by_name["AITomation"]
```

**Why this helps** — This replaces two separate round trips with one query that retrieves both rows, then reuses them from memory.

**Expected impact** — One query instead of two, while preserving the exact objects bound to cls.tag and cls.second_tag.

**Why the output is unchanged (the model's argument)** — The same tag rows are selected by exact name. The test still gets the same objects, with no change to returned columns, ordering guarantees, NULL semantics, or duplicates handling; missing tags still raise via key access, matching the current failure-on-missing-row behaviour of get().

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [get] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [get] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- Tag.name uniquely identifies the seeded rows in this test database.
- The test is meant to fail if either seed row is missing, as it does today.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [get] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- This code is reached by a test, so it runs once at install time or never in production.
- Severity is info, not the low the model proposed: this code is reached by a test, so it runs once at install time or never in production.

### Combine the field-config fixture lookups

`info` · `round-trip` · `mysql` · ✅ verified

These setup-time exact-key lookups can be loaded together and split in memory, reducing repeated ORM calls without changing which configuration rows the test receives.

**Where it is used**

- `tcms/rpc/tests/test_testcase.py:1801` in `CustomFieldsRPCBase._fixture_setup`
- Reached via test
- Also at `tcms/rpc/tests/test_testcase.py:1804`
- Also at `tcms/rpc/tests/test_testcase.py:1805`

**Current**

```sql
cls.automation_type = TestCaseFieldConfig.objects.get(
            field_key="automation-type"
        )
```

**Proposed**

```sql
configs = TestCaseFieldConfig.objects.filter(
    field_key__in=[
        "automation-type",
        "reviewed-by",
        "playwright-ui-execution-script",
    ]
)
by_key = {cfg.field_key: cfg for cfg in configs}
cls.automation_type = by_key["automation-type"]
cls.reviewed_by = by_key["reviewed-by"]
cls.script_field = by_key["playwright-ui-execution-script"]
```

**Why this helps** — This loads the three rows with one database call, then reuses them locally for the rest of fixture setup.

**Expected impact** — One query instead of three in fixture setup; the database does one filtered read instead of multiple point lookups.

**Why the output is unchanged (the model's argument)** — The same rows are selected by exact field_key. The test still binds the same objects, with no change to output rows, ordering, NULL handling, duplicates, or error behaviour beyond the same missing-row failure if a required seed is absent.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [get] to [none], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [get] to [none], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- field_key identifies each seeded row uniquely in this test context.
- The fixture should continue to fail if any seed row is absent.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [get] to [none], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- The equivalence argument does not address: the column list.
- This code is reached by a test, so it runs once at install time or never in production.
- Severity is info, not the low the model proposed: this code is reached by a test, so it runs once at install time or never in production.

### Replace count with exists for duplicate check

`info` · `over-fetch` · `mysql` · ✅ verified

This test only needs to know whether the mapping exists, so `exists()` can avoid counting all matching rows.

**Where it is used**

- `tcms/rpc/tests/test_testplan.py:315` in `TestAddCase.test_ignores_existing_mappings`
- Reached via test

**Current**

```sql
TestCasePlan.objects.filter(
                plan=self.plan_1.pk, case=self.testcase_1.pk
            ).count()
```

**Proposed**

```sql
TestCasePlan.objects.filter(
                plan=self.plan_1.pk, case=self.testcase_1.pk
            ).exists()
```

**Why this helps** — `exists()` lets the database stop after finding the first matching row instead of counting all matches.

**Expected impact** — One existence check instead of a full match count

**Why the output is unchanged (the model's argument)** — This is not equivalent: `count()` returns an integer and the test currently asserts that integer equals 1, while `exists()` returns a boolean. It changes the Python-side value being compared, so it would alter test behaviour even if the same rows are involved.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [count] to [exists], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.
- The filter expressions are textually unchanged.

Differences found:

- The terminal operation changes from [count] to [exists], which changes what the call returns.

**Assumptions**

- This site is a test assertion, not production code.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [count] to [exists], which changes what the call returns.
- The equivalence argument does not address: the column list, ordering, NULL or duplicate handling.
- This code is reached by a test, so it runs once at install time or never in production.

### Push the existence check into the database before loading rows

`info` · `over-fetch` · `mysql` · ✅ verified

The permission-removal test materializes all bugs with `Bug.objects.all()` only to check membership, which fetches more rows than the assertions need.

**Where it is used**

- `tcms/bugs/tests/test_api.py:106` in `TestRemovePermissions.verify_api_with_permission`
- Reached via test

**Current**

```sql
bugs = Bug.objects.all()
```

**Proposed**

```sql
self.assertFalse(Bug.objects.filter(pk=self.bug.pk).exists())
        self.assertFalse(Bug.objects.filter(pk=self.another_bug.pk).exists())
        self.assertTrue(Bug.objects.filter(pk=self.yet_another_bug.pk).exists())
```

**Why this helps** — Each assertion can be answered by a targeted existence query instead of loading every bug row into Python.

**Expected impact** — One existence check per asserted row instead of fetching the full bug table into memory.

**Why the output is unchanged (the model's argument)** — Rows: the assertions check the same three bug identities. Columns: `exists()` returns a boolean instead of a model list, so this is only equivalent if the code's purpose is the same membership check, not if callers need the collection itself. Ordering: none is relied on. NULLs and duplicates: unchanged. Error behavior: unchanged for these checks.

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

**Automated equivalence check** — Contradicted: The terminal operation changes from [none] to [exists], which changes what the call returns.

Confirmed automatically:

- Duplicate handling is unchanged (distinct off).
- Neither version orders its rows, so neither guarantees an order.

Differences found:

- The terminal operation changes from [none] to [exists], which changes what the call returns.

Not machine-checkable:

- Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser.

**Assumptions**

- This test only needs membership checks and does not depend on iterating the full `Bug.objects.all()` result.

**Evidence**

- `tcms/bugs/tests/test_api.py:103` (call-site) — Shows the code only uses the queryset for membership assertions.

**Verification notes**

- Reclassified as behaviour-changing: The terminal operation changes from [none] to [exists], which changes what the call returns.
- Not machine-checkable: Whether the changed filter matches exactly the same rows — proving predicate equivalence needs a solver, not a parser. The argument below is the model's, shown in full for you to judge.
- This code is reached by a test, so it runs once at install time or never in production.

## Suppressed before publication

127 finding(s) were held back by the value gate. They are listed here in full so the gate can be argued with — none of them was silently dropped.

### wrong direction (proposal issues no fewer queries) — 22

- **Avoid evaluating the same base queryset three times in telemetry status matrix** — `tcms/telemetry/api.py:78`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid issuing the base query twice in telemetry status matrix** — `tcms/telemetry/api.py:78`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the filtered execution set only once in the health summary** — `tcms/telemetry/api.py:192`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Collapse the version lookup into one query** — `tcms/management/migrations/0009_build_to_version.py:21`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the section query when restoring categories** — `tcms/testcases/migrations/0025_add_section.py:59`
  The proposal issues 3 database call(s) where the original issues 3, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Cache the repeated group lookup for permission lists** — `tcms/rpc/api/group.py:57`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid materializing all permissions before adding them** — `tcms/core/migrations/0001_squashed.py:31`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Combine the two group membership writes into one queryset** — `tcms/kiwi_auth/views.py:453`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Add a blank guard before filtering custom values** — `tcms/testcases/custom_fields.py:336`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Add a blank guard before filtering run custom values** — `tcms/testruns/filters.py:109`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid a second queryset evaluation when populating clone plans** — `tcms/testcases/forms.py:365`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Remove the extra membership queryset when counting attachments permissions** — `tcms/utils/tests/test_assign_permissions.py:61`
  The proposal issues 2 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Filter the user lookup by primary key only** — `tcms/rpc/api/testexecution.py:65`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the looked-up user instead of querying by email again** — `tcms/kiwi_auth/tests/test_sso.py:224`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Avoid duplicating queryset assignment in stream preselection** — `tcms/testruns/views.py:175`
  The proposal issues 0 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Collapse the executions lookup into the main case query when building run cases** — `tcms/rpc/api/testrun.py:160`
  The proposal issues 1 database call(s) where the original issues 0, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Batch history lookups for test cases** — `tcms/testcases/migrations/0009_populate_missing_text_history.py:8`
  The proposal issues 4 database call(s) where the original issues 2, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Use IN for the repeated status lookups** — `tcms/testruns/migrations/0007_test_execution_statuses.py:21`
  The proposal issues 7 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Reuse the already-fetched status row** — `tcms/rpc/api/testcase.py:878`
  The proposal issues 4 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Filter the lookup by primary key directly** — `tcms/testcases/views.py:243`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fetch the product by primary key directly** — `tcms/testcases/views.py:873`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)
- **Fetch the section by primary key directly** — `tcms/testcases/views.py:878`
  The proposal issues 1 database call(s) where the original issues 1, so it does not reduce the round trips it claims to reduce. (Counted from the code, not measured.)

### no-op (proposal identical to the original) — 88

- **Add a supporting index for tag facet aggregation** — `tcms/rpc/api/testcase.py:500`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use a single indexed lookup for user IDs** — `tcms/core/forms/fields.py:28`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Filter custom field configs by system flag earlier** — `tcms/testruns/custom_fields.py:23`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use `.exists()` for presence checks** — `tcms/testcases/tests/test_views.py:151`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use a direct boolean filter for the confirmed status seed** — `tcms/testcases/migrations/0016_testcasestatus_is_confirmed.py:6`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Avoid materializing comments when deleting all of them** — `tcms/rpc/api/testexecution.py:90`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the comment fetch as a values query** — `tcms/rpc/api/testexecution.py:112`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use the loaded execution for history lookup only** — `tcms/rpc/api/testexecution.py:293`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the execution fetch before update logic** — `tcms/rpc/api/testexecution.py:450`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the attachment fetch as a single execution lookup** — `tcms/rpc/api/testexecution.py:670`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the tag read as a primary-key lookup** — `tcms/rpc/api/testexecution.py:751`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the tag creation flow as written** — `tcms/rpc/api/testexecution.py:778`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the plan tag attach sequence unchanged** — `tcms/rpc/api/testplan.py:136`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the plan fetch before form validation** — `tcms/rpc/api/testplan.py:176`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the attachment handler as a single plan lookup** — `tcms/rpc/api/testplan.py:276`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the tree root lookup as written** — `tcms/rpc/api/testplan.py:323`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the run tag attach sequence unchanged** — `tcms/rpc/api/testrun.py:196`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the run fetch before update logic** — `tcms/rpc/api/testrun.py:411`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the CC attachment lookup as written** — `tcms/rpc/api/testrun.py:455`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the CC removal lookup as written** — `tcms/rpc/api/testrun.py:480`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the attachment handler as a single run lookup** — `tcms/rpc/api/testrun.py:561`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the CC list as a single relation read** — `tcms/rpc/api/testrun.py:628`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the user filter as written** — `tcms/rpc/api/user.py:59`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the telemetry counts on the distinct queryset** — `tcms/telemetry/api.py:28`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the section clash check as an existence probe** — `tcms/testcases/views.py:996`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the sibling-name probe as an existence check** — `tcms/testcases/views.py:1073`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the confirmed-status lookup as a single first-row query** — `tcms/testcases/views.py:1110`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the posted-version validation as an existence check** — `tcms/testplans/views.py:55`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use get for the plan lookup in the GET handler** — `tcms/testplans/views.py:421`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Reuse the fetched environment row** — `tcms/rpc/tests/test_environment.py:59`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Prefer exact lookups for seeded rows** — `tcms/testplans/tests/tests.py:287`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use exists for boolean checks on unique identifiers** — `tcms/core/tests/test_admin.py:270`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Reuse the looked-up user instead of querying by email again** — `tcms/kiwi_auth/tests/test_sso.py:229`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Avoid re-reading the user row if you already have it** — `tcms/kiwi_auth/tests/test_sso.py:250`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Reuse the looked-up user instead of querying by email again** — `tcms/kiwi_auth/tests/test_sso.py:695`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current direct primary-key lookup** — `tcms/kiwi_auth/tests/test_user_names.py:127`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current direct primary-key lookup** — `tcms/kiwi_auth/tests/test_user_names.py:152`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current direct primary-key lookup** — `tcms/kiwi_auth/tests/test_user_names.py:167`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current activation lookup** — `tcms/kiwi_auth/tests/test_views.py:121`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current activation lookup** — `tcms/kiwi_auth/tests/test_views.py:142`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current activation lookup** — `tcms/kiwi_auth/tests/test_views.py:161`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current activation-key existence check** — `tcms/kiwi_auth/tests/test_views.py:163`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current PK reload assertion** — `tcms/management/tests/test_global_id.py:58`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current PK reload assertion** — `tcms/management/tests/test_global_id.py:74`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current PK reload assertion** — `tcms/management/tests/test_global_id.py:120`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current object reload** — `tcms/rpc/tests/test_bugtracker.py:39`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current group lookup** — `tcms/rpc/tests/test_group.py:45`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current group lookup** — `tcms/rpc/tests/test_group.py:57`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current group lookup** — `tcms/rpc/tests/test_group.py:118`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current object reload** — `tcms/rpc/tests/test_priority.py:55`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the current object reload** — `tcms/rpc/tests/test_product.py:53`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use a value-preserving first-row fetch only where ordering is already defined** — `tcms/rpc/tests/test_testcase.py:482`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Fetch one confirmed status with PK ordering preserved** — `tcms/rpc/tests/test_testrun.py:43`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use `exists()` checks consistently for membership assertions** — `tcms/rpc/tests/test_testrun.py:91`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the tag membership checks as existence queries** — `tcms/rpc/tests/test_testrun.py:253`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use a direct primary-key lookup for the created run** — `tcms/rpc/tests/test_testrun.py:408`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the custom-value point lookup as-is** — `tcms/rpc/tests/test_testrun.py:961`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the configured field lookup as-is** — `tcms/testcases/tests/test_case_form_bugs.py:62`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use `exists()` for the empty section check** — `tcms/testcases/tests/test_case_form_bugs.py:141`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **No query rewrite needed for the case lookup** — `tcms/testcases/tests/test_case_form_bugs.py:153`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the empty-result existence check as written** — `tcms/testcases/tests/test_case_form_bugs.py:193`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Leave the primary-key update alone** — `tcms/testcases/tests/test_cases_list_bugs.py:169`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the nulling update as a direct write** — `tcms/testcases/tests/test_cases_list_bugs.py:179`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Do not change the superuser lookup** — `tcms/testcases/tests/test_copy_clone_guards.py:47`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the copied case lookup as a single primary-key fetch** — `tcms/testcases/tests/test_copy_clone_guards.py:66`
  The finding proposes no change at all — the suggestion is empty, so there is nothing to apply or review.
- **Use `.get()` only if the row must be loaded** — `tcms/testcases/tests/test_views.py:157`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the single-row lookup as written** — `tcms/testcases/tests/test_views.py:177`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Leave the first-row lookup unchanged** — `tcms/testcases/tests/test_views.py:213`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the creation lookup unchanged** — `tcms/testcases/tests/test_views.py:261`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Avoid duplicate list materialization check rewrite** — `tcms/testcases/tests/test_views.py:321`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the confirmed-status lookup unchanged** — `tcms/testcases/tests/test_views.py:475`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the export-status lookup unchanged** — `tcms/testcases/tests/test_views.py:615`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the ordering-test status lookup unchanged** — `tcms/testcases/tests/test_views.py:687`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the multi-value filter status lookup unchanged** — `tcms/testcases/tests/test_views.py:792`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the delete existence check unchanged** — `tcms/testplans/tests/test_admin.py:51`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the plan lookup unchanged** — `tcms/testplans/tests/test_new_plan.py:92`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the created-plan lookup unchanged** — `tcms/testplans/tests/test_new_plan.py:173`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the case-count test query unchanged** — `tcms/testplans/tests/tests.py:162`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the cloned-plan lookup unchanged** — `tcms/testplans/tests/tests.py:350`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the copied-clone lookup unchanged** — `tcms/testplans/tests/tests.py:374`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the delete existence check unchanged** — `tcms/testruns/tests/test_admin.py:67`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the confirmed-status lookup unchanged** — `tcms/testruns/tests/test_permissions.py:86`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Keep the notes update unchanged** — `tcms/testruns/tests/test_run_description_untouched.py:35`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Avoid loading the full object when only the primary key is needed** — `tcms/testruns/tests/test_run_description_untouched.py:76`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Use exact app label matching instead of substring matching only if semantics are intended** — `tcms/bugs/migrations/0002_add_permissions.py:14`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Prefer a direct foreign-key lookup only where the code already has the related object** — `tcms/tests/__init__.py:39`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Do not report the status lookup in test fixture setup as an optimization target** — `tcms/rpc/tests/test_testexecution.py:953`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.
- **Do not optimize the status seed lookup in factory setup** — `tcms/tests/factories.py:298`
  The proposed code is identical to the original once whitespace is collapsed, so there is nothing to apply.

### immaterial (a column narrowing on a query that runs once) — 1

- **Project only the fields needed for field configs** — `tcms/testcases/views.py:127`
  The only thing counted here is a narrower column list (Fetches 2 named column(s) instead of whole model instances. (Counted, not measured.)), on a query that does not run per iteration and is not unbounded. That is a real saving and a small one; publishing it beside a per-request N+1 costs the reader more attention than it returns.

### cold path (migration, seed or test) — 16

- **Batch the permission filter by app label** — `tcms/core/migrations/0001_squashed.py:36`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Replace contains lookups with exact app labels** — `tcms/bugs/migrations/0002_add_permissions.py:14`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Collapse the permission loop into one filtered fetch** — `tcms/core/migrations/0001_squashed.py:37`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Use primary-key updates for test fixtures** — `tcms/testcases/tests/test_views.py:331`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Filter permissions by exact app label prefixes if possible** — `tcms/bugs/migrations/0002_add_permissions.py:14`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Use a more selective existence lookup on LinkReference** — `tcms/issuetracker/tests/test_jira.py:146`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Use direct primary-key lookup for known user IDs** — `tcms/kiwi_auth/tests/test_admin.py:179`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Use direct primary-key lookup for the SSO user fetch** — `tcms/kiwi_auth/tests/test_sso.py:56`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Replace exact-pk fetch with existence check** — `tcms/rpc/tests/test_tag.py:76`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Use a primary-key lookup for the created plan** — `tcms/rpc/tests/test_testplan.py:431`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Avoid loading every permission object into memory** — `tcms/rpc/tests/test_testrun.py:77`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Use a narrower delete predicate for the seeded site row** — `tcms/core/migrations/0001_squashed.py:23`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Fetch only the rows you will mutate in the status cleanup** — `tcms/testcases/migrations/0024_mt_qa_hub_case_statuses.py:21`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Avoid repeated permission lookups with one filtered query** — `tcms/core/migrations/0001_squashed.py:37`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Delete the old statuses with a primary-key queryset** — `tcms/testruns/migrations/0020_mt_qa_hub_statuses.py:28`
  This code is reached by a migration or seed, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.
- **Collapse the nested permission query into a single existence check** — `tcms/utils/tests/test_assign_permissions.py:55`
  This code is reached by a test, so it runs once at install time or never in production. The change may still be a reasonable tidy-up; it is not a performance finding.

## Dropped during verification

1 suggestion(s) cited files or code that do not exist in this repository and were removed before this report was produced.

- **Prefer a targeted filter before existence check** — Evidence cites a file that was never read: undefined Evidence cites a file that was never read: undefined This code is reached by a test, so it runs once at install time or never in production.

---

_Generated by speeDB. Every citation above was re-verified against the repository at the commit named._