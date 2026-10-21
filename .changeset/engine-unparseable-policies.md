---
'supabase-grants-lint': patch
---

Engine (experimental): a policy statement the parser rejects, such as `create policy if not exists ... on public.todos` (which Postgres does not accept), now sets that relation's `policiesUncertain`, as a `DO` block that changes its policies does. The `DO` block scan also reads the relation after `if not exists`. grants-lint's rules do not read the mark, so their output is unchanged.
