---
'supabase-grants-lint': minor
---

Engine (experimental): the replay now tracks row level security per relation (`alter table ... enable | disable | force | no force row level security`), event triggers, and Supabase's automatic RLS template (`ensure_rls` calling `public.rls_auto_enable()`). New config key `autoRls` (`"auto"`, `"on"` or `"off"`, default `"auto"`) says when new tables in `public` start with RLS on. grants-lint's rules do not read this state, so their output is unchanged.
