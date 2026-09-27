# supabase-grants-lint

Find the Supabase migrations that break on a fresh environment: tables the Data API cannot reach
(PostgREST `42501 permission denied for table`) once new tables stop getting automatic grants.

[![npm](https://img.shields.io/npm/v/supabase-grants-lint)](https://www.npmjs.com/package/supabase-grants-lint)
[![ci](https://github.com/guptaaman678/supabase-grants-lint/actions/workflows/ci.yml/badge.svg)](https://github.com/guptaaman678/supabase-grants-lint/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/guptaaman678/supabase-grants-lint/badge)](https://scorecard.dev/viewer/?uri=github.com/guptaaman678/supabase-grants-lint)
[![mutation testing](https://github.com/guptaaman678/supabase-grants-lint/actions/workflows/mutation.yml/badge.svg)](https://github.com/guptaaman678/supabase-grants-lint/actions/workflows/mutation.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![supabase-grants-lint check reports three missing grants, the printed fixes are appended, and a second check is clean](media/demo.gif)

It replays your SQL migrations, works out who can reach every table, and prints the `grant` that
fixes each finding. `check` reads files only: no database connection, no telemetry. An opt-in
[live mode](#live-mode) compares the migrations with a real database, read-only.

## Quick start

In a project with a `supabase/migrations` folder (Node 22 or later):

```sh
npx supabase-grants-lint check
npx supabase-grants-lint doctor
```

- `check` lints the migrations and exits 1 on an error finding.
- `doctor` is a readiness report for 2026-10-30: whether the project is opted in, whether replaying
  the history turns automatic grants back on, and which existing tables a fresh database would not
  expose.

To run it on every pull request:

```sh
npx supabase-grants-lint init --since next
```

This writes `grants-lint.config.json` and `.github/workflows/grants-lint.yml`. `--since next`
enforces every migration you add from now on and leaves the existing ones alone. Commit both files
and open a pull request: the check runs on it.

## What breaks on 2026-10-30

Supabase has announced that from 2026-10-30 new tables, views and sequences in `public` stop getting
automatic grants for `anon`, `authenticated` and `service_role` on every existing project. Preview
branches already work this way, and so can new projects and local stacks with
`auto_expose_new_tables = false`.
A migration that creates a table and forgets to `grant` applies cleanly, row level security looks
right, and the first request fails. Five traps are easy to miss:

- **Replaying history turns the grants back on.** A baseline made with `supabase db pull` can
  contain `alter default privileges ... grant all`, so local resets and preview branches give new
  tables grants production no longer has ([GL007](docs/rules/GL007.md)).
- **The revoke is narrow.** Per the SQL Supabase published, it removes `select`, `insert`, `update`
  and `delete` (and sequence `usage`, `select`), and leaves `truncate`, `references` and `trigger`
  (plus `maintain` on Postgres 17+) on every new table ([GL008](docs/rules/GL008.md)).
- **`service_role` bypasses row level security, not grants.** Edge functions and admin tools using
  the service role key get `42501` too ([GL001](docs/rules/GL001.md)).
- **Policies without grants are dead.** `create policy ... to authenticated` on a table
  `authenticated` holds no grant on never applies ([GL002](docs/rules/GL002.md),
  [GL003](docs/rules/GL003.md)).
- **`serial` columns need their sequence.** A client that inserts into a table with a `serial`
  column needs `usage` on its sequence; identity columns and `uuid` keys do not
  ([GL004](docs/rules/GL004.md)).

## GitHub Action

```yaml
name: Grants lint

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  grants-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: guptaaman678/supabase-grants-lint@v0
```

Findings show up as annotations on the pull request and in the Security tab (SARIF). Inputs,
outputs and private-repository notes: [docs/github-action.md](docs/github-action.md).

## Rules

| Rule                               | Name                       | Default | Catches                                                                     |
| ---------------------------------- | -------------------------- | ------- | --------------------------------------------------------------------------- |
| [GL000](docs/rules/GL000.md)       | no-enforcement-baseline    | warn    | No opt-in migration and no `since`, so the new-relation rules do not run    |
| [GL001](docs/rules/GL001.md)       | missing-service-role-grant | error   | A new relation `service_role` cannot read or write                          |
| [GL002](docs/rules/GL002.md)       | unreachable-new-relation   | error   | A new relation with policies for a client role that holds no grant on it    |
| [GL003](docs/rules/GL003.md)       | dead-policy                | error   | A policy whose roles lack the privilege its command needs                   |
| [GL004](docs/rules/GL004.md)       | serial-sequence-usage      | error   | A client-insertable `serial` column whose sequence the client cannot use    |
| [GL005](docs/rules/GL005.md)       | blanket-grant              | warn    | `grant ... on all tables in schema` re-granting every relation              |
| [GL006](docs/rules/GL006.md)       | default-privileges-regrant | error   | `alter default privileges ... grant` turning automatic grants back on       |
| [GL007](docs/rules/GL007.md)       | replay-reenables-defaults  | warn    | A replay of the history ends with automatic grants production does not have |
| [GL008](docs/rules/GL008.md)       | leftover-privileges        | warn    | `truncate`, `references`, `trigger` left to `anon` or `authenticated`       |
| [GL009](docs/rules/GL009.md)       | drift                      | warn    | A live database whose grants or policies differ from the migrations         |
| [PARSE001](docs/rules/PARSE001.md) | unparseable-statement      | info    | A statement the Postgres parser rejects (skipped)                           |
| [PARSE002](docs/rules/PARSE002.md) | dynamic-sql-skipped        | info    | A `DO` block or `execute` that changes grants or tables (not modelled)      |

Each page shows a failing example, the real output, the fix and when it is safe to disable the rule.

## Configuration

Everything is optional. Put settings in `grants-lint.config.json` (or `package.json#grantsLint`);
the most useful ones:

```json
{
  "$schema": "https://raw.githubusercontent.com/guptaaman678/supabase-grants-lint/main/schema/config.schema.json",
  "since": "20261001000000",
  "schemas": ["public"],
  "serviceOnly": ["public.audit_log"],
  "rules": { "GL005": "error" }
}
```

- `since`: enforce only migrations after this version. `"auto"` (default) finds your opt-in
  migration; set a version if the project was opted in from the dashboard or on 2026-10-30.
- `schemas`: every schema you expose through the Data API.
- `serviceOnly`: tables only server code uses, exempt from the client-role rules.
- `rules`, `ignore` and inline `-- grants-lint-disable-next-line GL002: <reason>` comments turn
  findings off, always with a reason.

All keys and flags: [docs/configuration.md](docs/configuration.md). Other commands:
`supabase-grants-lint explain public.todos` prints the grant timeline of one table, and
`--format json|sarif|github` changes the output.

## Live mode

`check` never connects to a database. To compare the migrations with a real one (grants made by
hand in the SQL editor, tables made in the dashboard, migrations never pushed), pass a connection
string for a read-only role:

```sh
SUPABASE_DB_URL='postgres://...' npx supabase-grants-lint diff
```

Differences are [GL009](docs/rules/GL009.md) warnings; `doctor` adds a "Live database" section when
given the same variable or `--db-url`. Setup and the role to create:
[docs/live-mode.md](docs/live-mode.md).

## FAQ

"Does it touch my database?", "Why does it flag my old migrations?", "How is it different from
splinter and squawk?": see the [FAQ](docs/faq.md).

## How it works

The migrations are parsed with the real Postgres parser and replayed, in order, into a model of
which role holds which privilege on which table and sequence, including default privileges and
row level security policies. Each migration is checked against that model at its end, so a grant
later in the same file counts and a grant in a later file does not. Details and limitations (dynamic
SQL, objects created outside migrations): [docs/how-it-works.md](docs/how-it-works.md).

Not affiliated with or endorsed by Supabase.

## License

[MIT](LICENSE)
