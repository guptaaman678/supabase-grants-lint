# FAQ

## Do I need this if I created my project after the change?

Probably yes. Supabase has announced that from 2026-10-30 it stops giving new tables in `public`
automatic grants on every existing project, and new projects can already be created without them.
Either way, the problem is the same: a migration that creates a table and forgets to grant it
applies cleanly, and the first request fails with `42501 permission denied for table`.

Preview branches start without the automatic grants whatever the base project does, and a baseline
made with `supabase db pull` can turn them back on when the migrations are replayed
([GL007](rules/GL007.md)). A project that never had automatic grants can set
`"since": "none"` and `"platformDefaults": "explicit"`, so every migration is enforced.

## Does it touch my database?

No. `check`, `doctor` and `explain` read your migration files and your config, and nothing else.
They open no network connection, send no telemetry and check for no updates. The replay happens in
memory, in a model of the grants, not in a database.

The one exception is opt-in: [live mode](live-mode.md) (`diff`, or `doctor` given `--db-url` or
`SUPABASE_DB_URL`) connects to the database you pass, reads the system catalogs in a read-only
transaction and changes nothing.

## Why does it flag my old migrations?

It should not: the rules that check new relations only enforce migrations after the
[`since`](configuration.md#since) boundary, and older files are only replayed to know what exists.
If old files are flagged, the boundary is not where you expect:

- run `supabase-grants-lint doctor` to see the boundary it found and where it came from;
- with `"since": "none"` (or `--since none`) every file is enforced, on purpose;
- if your project was opted in from the dashboard, set `since` to the last migration applied
  before that.

For a finding in an applied migration that you fix in a new one, add an
[`ignore`](configuration.md#ignore) entry with the reason.

## How is it different from splinter?

[splinter](https://github.com/supabase/splinter) is the linter behind the Supabase dashboard's
Security and Performance Advisors. It queries a live database: what exists now. This tool reads
your migrations before they are applied, so it catches the missing grant in the pull request, and
it knows things a live database cannot tell you, such as which migration created a table or that
replaying the history re-enables automatic grants. They are complementary.

## How is it different from squawk?

[squawk](https://github.com/sbdchd/squawk) lints migrations for statements that are unsafe to run
on a busy database (locks, table rewrites). It checks each statement on its own. This tool replays
the whole history to know who can reach each table at the end of each migration, which a
statement-by-statement linter cannot do. Use both.

## I use declarative schemas, Drizzle or Prisma

Declarative schema files (`supabase/schemas`, or `schema_paths` in `supabase/config.toml`) are
found and checked with no setup; see [Declarative schemas](how-it-works.md#declarative-schemas).
For Drizzle Kit, run `supabase-grants-lint check --dir drizzle`. For Prisma, set
`"migrations": "prisma/migrations/*/migration.sql"` in `grants-lint.config.json`. See
[Other migration tools](how-it-works.md#other-migration-tools).

## Is this made by Supabase?

No. It is an independent open-source project, not affiliated with or endorsed by Supabase.

## A statement I use is reported as unparseable

The parser uses the Postgres 18 grammar. If Postgres accepts a statement the tool reports as
[PARSE001](rules/PARSE001.md), please open an issue with the statement. Until it is fixed, suppress
it with a reason.
