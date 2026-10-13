---
'supabase-grants-lint': patch
---

Engine (experimental): under `autoRls: "auto"`, the `public.rls_auto_enable()` fingerprint now counts from the migration after the one that defines it. Tables in that same file (the tables of a `db pull` dump) keep the row level security their own statements give, instead of starting with RLS on. An explicit `ensure_rls` event trigger still applies from its statement. grants-lint's rules do not read RLS, so their output is unchanged.
