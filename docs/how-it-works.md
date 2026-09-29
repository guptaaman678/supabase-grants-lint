# How it works

`supabase-grants-lint check` never connects to a database. It parses your migrations with the
Postgres parser, replays them in order into a model of who holds which privilege on which relation,
and checks that model at the end of each migration. [Live mode](live-mode.md) compares the same
model with a real database, read-only, when you ask it to.

## The replay model

The model tracks, in the checked [`schemas`](configuration.md#schemas):

- **Relations:** tables (including partitioned and foreign tables), views and materialized views,
  with their privileges (`select`, `insert`, `update`, `delete`, `truncate`, `references`,
  `trigger`, `maintain`) per role, and their RLS policies (command and roles).
- **Sequences:** created with `create sequence` or by a `serial` column (named
  `<table>_<column>_seq`), with `usage`, `select`, `update`. Identity columns and `uuid` keys create
  nothing to track.
- **Default privileges:** per creator role, schema (or every schema) and object kind, applied to a
  relation only when it is created, using the role that creates it
  ([`migrationRole`](configuration.md#migrationrole), or the role a `set role` switched to).
- **Roles:** `anon`, `authenticated`, `service_role`, `PUBLIC`, and any role in the config. A
  role's effective privileges are its own plus those of `PUBLIC`. A column-level grant counts as
  holding the privilege.

The statements it follows: `create table | view | materialized view | foreign table` (with
`if not exists`, `or replace`, `as`, `partition of`), `create sequence`, `alter ... rename to`,
`alter ... set schema`, `drop`, `grant` and `revoke` on named relations, sequences and
`all tables | all sequences in schema`, `alter default privileges`, `create | alter | drop policy`,
and `set role` / `reset role`. Everything else is parsed and ignored.

Before the first migration, the model starts from
[`platformDefaults`](configuration.md#platformdefaults): with `legacy` (the default), `postgres`
gives `anon`, `authenticated` and `service_role` all privileges on new tables and sequences in
`public`, as Supabase projects did before the change.

## When a migration is checked

Each migration is checked against the model **at its end**: a grant later in the same file counts,
a grant in a later file does not, because the table is unreachable from the moment the first
file is applied until the second is.

The rules that check new relations (GL001 to GL006 and GL008) only enforce migrations after the
[`since`](configuration.md#since) boundary. By default the boundary is the last migration that
opts in (revokes the default table privileges from `anon`, `authenticated` and `service_role`).
Older files are replayed but not enforced, because they were written while the automatic grants
existed. GL007 always looks at the whole history.

A project opted in outside its migrations (from the dashboard, or by the platform change on
2026-10-30) has no such file: set `since` to the last migration applied before it. The replay then
assumes the revoke Supabase published just before the next migration
([`platformRevokeAtSince`](configuration.md#platformrevokeatsince)).

## Declarative schemas

With [declarative schemas](https://supabase.com/docs/guides/local-development/declarative-database-schemas)
the files in `supabase/schemas` describe the database you want, and the Supabase CLI writes the
migrations by diffing that state against your history. Grants and policies are part of that state,
so a table that has no grant there is generated without one (or, for an existing table, with a
revoke). `check` reads these files as well as the migrations (see
[`schemaPaths`](configuration.md#schemapaths) for which files and in what order) and checks them
differently:

- **One unit.** All the files are replayed together and checked at the end, because the diff
  engine orders statements by what they depend on, not by file. A grant in `grants.sql` counts for
  a table in `tables.sql`.
- **No automatic grants.** The replay starts with no default privileges, since the state has to
  carry its own grants once automatic grants are gone. A default-privilege statement in the files
  still applies to the tables after it.
- **Every relation is checked** with GL001 to GL006 and GL008, whatever version `since` names;
  there is no history to exempt. GL000 and GL007 are about migration history and do not apply.
- **Only once the project is opted in**: an opt-in migration was found, `since` is set (config or
  `--since`), or `supabase/config.toml` sets `auto_expose_new_tables = false` under `[api]`. Until
  then the platform still grants new tables automatically, so the files are not checked and one
  `declarative-not-checked` notice says so.

Findings point at the schema file and line, and come after the migrations' findings. Inline
suppressions and `ignore` entries work the same way. `doctor`, `explain` and `diff` read the
migrations only.

## Other migration tools

Any tool that writes plain SQL files works. Point `--dir` at the folder that holds them (Drizzle
Kit: `--dir drizzle`), or set [`migrations`](configuration.md#migrations) to a directory or glob
(Prisma: `"prisma/migrations/*/migration.sql"`, where each migration's version comes from its
directory name). The files must include the grants: an ORM's schema usually has no place for them,
so add them in a custom migration.

## Replays, local resets and preview branches

A replay runs only what is in the files. Preview branches start without automatic grants in
`public`, whatever the base project does, and the local stack gives them unless
`auto_expose_new_tables = false` is set under `[api]` in `supabase/config.toml`. A baseline made
with `supabase db pull` often contains `alter default privileges ... grant all` statements, which
turn the automatic grants back on in every replay while production no longer has them.
[GL007](rules/GL007.md) reports that from the files alone, and `supabase-grants-lint doctor` also
reports the `config.toml` setting.

## Limitations

- **Dynamic SQL:** `DO` blocks and `execute` are not run. A block that mentions grants, tables,
  policies or default privileges is reported as [PARSE002](rules/PARSE002.md), and what it does is
  missing from the model.
- **Objects created outside the migrations:** tables made in the dashboard, by extensions or by
  other tools are unknown. A policy on such a table is reported as a warning by
  [GL003](rules/GL003.md).
- **Unparseable statements** are skipped and reported as [PARSE001](rules/PARSE001.md).
- **Not modelled:** privileges on functions, types and schemas, and role membership (a role
  granted to another role).
- **Row level security** itself is not evaluated: the tool checks that the role holds the privilege
  a policy needs, not what the policy's expression allows.

## Performance

`check` reads every migration file on each run, so its time grows with the history. The target
is under 2 seconds for 100 migration files, measured from a cold start: a fresh Node process that
also loads the Postgres parser.

`npm run bench` builds the CLI, generates synthetic projects with 100 and 500 migration files,
and times `check --format json` on each, one fresh process per run. The generated history starts
with a pulled baseline and the explicit-grants opt-in, then cycles through tables with identity
and serial keys, policies, grants, functions, triggers, views, column changes and a `DO` block,
with some tables left without grants so the rules report findings. The script fails if a run
does not lint every file, or if a 100-file run misses the target.

Measured on 2026-09-26 (Apple M4, 10 cores, 16 GiB, Darwin 25.5.0 arm64, Node 22.16.0; 10 runs per size
after one first run):

| Files | Relations | Median | Slowest | Linting only (median) |
| ----: | --------: | -----: | ------: | --------------------: |
|   100 |        80 | 120 ms |  127 ms |                 57 ms |
|   500 |       400 | 217 ms |  223 ms |                180 ms |

"Linting only" is `summary.durationMs` from the JSON output: config, discovery, parsing, replay
and rules, without process start and parser load. Numbers on your machine will differ; run
`npm run bench` to measure them.
