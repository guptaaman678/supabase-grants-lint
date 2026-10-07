---
'supabase-grants-lint': minor
---

Engine (experimental): new export `supabase-grants-lint/engine` replays a project's migrations as `check` does and returns the database they build as a plain JSON `SchemaSnapshot` (relations with row level security, privileges and policies; sequences; publications; replay meta). It has `loadEngine`, `replayProjectSync`, `replayProject`, `listReplayInputs`, `publicationMembership` and `EngineError`; see `docs/engine.md`. Any minor release may break the engine API or the snapshot; patch releases never do.

To build the snapshot, the replay now tracks row level security per relation (`alter table ... enable | disable | force | no force row level security`), event triggers, Supabase's automatic RLS template (`ensure_rls` calling `public.rls_auto_enable()`) and publication membership (`create | alter | drop publication`, including `for all tables`, `for tables in schema`, `add table only`, `set table` and `rename to`; row filters, column lists and `publish` options are ignored). A `do` block, or a function a migration calls, that alters, creates or drops a publication marks it uncertain instead of guessing what the body did. Two new config keys drive this: `autoRls` (`"auto"`, `"on"` or `"off"`, default `"auto"`) and `platformPublications` (default `["supabase_realtime"]`, `[]` outside Supabase).

grants-lint's rules, `explain` and `doctor` do not read this state, so their output is unchanged.
