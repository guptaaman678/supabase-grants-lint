---
'supabase-grants-lint': minor
---

Engine (experimental): the replay now tracks publication membership (`create | alter | drop publication`, including `for all tables`, `for tables in schema`, `add table only`, `set table` and `rename to`; row filters, column lists and `publish` options are ignored). A renamed table stays in its publications and a dropped one leaves them. A `do` block, or a function a migration calls, that alters, creates or drops a publication marks it uncertain instead of guessing what the body did. New config key `platformPublications` (default `["supabase_realtime"]`, `[]` outside Supabase) lists the publications that exist, empty, before the first migration. grants-lint's rules do not read this state, so their output is unchanged.
