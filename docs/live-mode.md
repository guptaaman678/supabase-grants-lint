# Live mode

`check` only reads your migration files. Live mode also reads a real database, read-only, and
tells you where it differs from the migrations: grants made by hand in the SQL editor, tables made
in the dashboard, migrations that were never pushed, and whether the database still grants new
tables to the API roles automatically.

It is the only part of the tool that opens a network connection, and only to the database you
pass. `check`, `explain` and `init` never connect, and `doctor` connects only when given a
database URL.

## Commands

```sh
# Every difference, as GL009 warnings, in any check format
SUPABASE_DB_URL='postgres://...' npx supabase-grants-lint diff

# Fail CI on any drift
npx supabase-grants-lint diff --max-warnings 0 --format github

# The readiness report plus a "Live database" section
SUPABASE_DB_URL='postgres://...' npx supabase-grants-lint doctor
```

The connection string comes from `--db-url` or the `SUPABASE_DB_URL` environment variable. Prefer
the variable: a flag ends up in your shell history and in the process list. The tool never prints
the URL; connection errors are shown with the credentials removed.

`diff` takes the same discovery options as `check` (`--dir`, `--config`, `--since`, `--schema`)
and the same `--format`, `--max-warnings` and `--quiet`. Exit codes are those of `check`, with
connection problems reported as exit code 2.

## Use a read-only role

Live mode only reads the system catalogs (`pg_class`, `pg_attribute`, `pg_default_acl`,
`pg_policies`, `pg_namespace`), inside a read-only transaction. Every role can read them, so the
role needs no grants at all:

```sql
create role grants_lint_reader with login password 'use-a-long-random-password';
alter role grants_lint_reader set default_transaction_read_only = on;
```

Connect as that role with the connection string your dashboard shows, replacing the user and
password. Never use the `postgres` password or a service key for this, and never paste a
connection string into a workflow file or a log: in GitHub Actions, store it as a secret and pass
it as an environment variable.

```yaml
- run: npx supabase-grants-lint diff --max-warnings 0 --format github
  env:
    SUPABASE_DB_URL: ${{ secrets.GRANTS_LINT_DB_URL }}
```

Live mode works through a transaction-mode connection pooler, since it uses no prepared
statements. It asks for TLS and falls back to a plain connection only if the server offers no TLS;
add `?sslmode=require` to the URL to insist on it.

## What is compared

See [GL009](rules/GL009.md) for the full list and the message format. In short, in the configured
schemas and for the client roles, the service role and `PUBLIC`: privileges on every table, view
and sequence, relations that exist on one side only, default privileges for new tables and
sequences, and policies.

The migrations are replayed exactly as `check` replays them, including
[`platformDefaults`](configuration.md#platformdefaults) and the platform revoke at `since`
([`platformRevokeAtSince`](configuration.md#platformrevokeatsince)). If `diff` reports default
privileges "in the migrations, not in the database", your project was opted in outside the
migrations (from the dashboard, or by the 2026-10-30 change): add the opt-in migration `doctor`
prints, so local resets and preview branches match production.

## Limits

- Statements the replay cannot model (dynamic SQL in `do` blocks, reported as PARSE002) run in the
  database, so what they grant shows up as drift.
- Relations that belong to an extension and identity sequences are not compared.
- `maintain` is compared only on Postgres 17 and later, where it exists.
