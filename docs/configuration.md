# Configuration

Every setting is optional. With no config, `supabase-grants-lint check` reads
`supabase/migrations/*.sql`, checks the `public` schema, and finds the enforcement boundary on its
own. If `--dir` points at a folder that has no `supabase/migrations` but holds `.sql` files
itself, that folder is read as the migrations folder, so `--dir supabase/migrations` and
`--dir db/migrations` both work.

## Where the config lives

The first of these that exists is used, and command-line flags override it:

1. the file passed with `--config <file>` (relative to the current directory);
2. `grants-lint.config.json` in the project directory (`--dir`, default the current directory);
3. the `grantsLint` key of `package.json` in the project directory.

Sources replace whole keys: a `rules` or `ignore` in `--config` replaces the one in
`package.json`, it is not merged with it. Flags that override keys: `--since` (`since`) and
`--schema` (`schemas`, repeatable).

```json grants-lint.config.json
{
  "$schema": "https://raw.githubusercontent.com/guptaaman678/supabase-grants-lint/main/schema/config.schema.json",
  "since": "20261001000000",
  "serviceOnly": ["public.audit_log"],
  "rules": { "GL005": "error" },
  "ignore": [
    {
      "rule": "GL001",
      "file": "20261002120000_add_todos.sql",
      "reason": "Granted in 20261003000000 before any deploy"
    }
  ]
}
```

`supabase-grants-lint init` writes a starting file with the `$schema` line and `since`
(`init --since next` sets it to your latest migration). The `$schema` line gives editors
completion and hover help. An invalid config (unknown key, wrong
type, rule ID that does not exist) is a usage error: `check` exits 2 and names the file and key,
with a suggestion for typos.

## Keys

| Key                     | Type                                     | Default                     |
| ----------------------- | ---------------------------------------- | --------------------------- |
| `migrations`            | string or string[]                       | `"supabase/migrations"`     |
| `schemas`               | string[]                                 | `["public"]`                |
| `schemaPaths`           | `"auto"` or string[]                     | `"auto"`                    |
| `since`                 | `"auto"`, `"none"` or a version          | `"auto"`                    |
| `platformDefaults`      | `"legacy"` or `"explicit"`               | `"legacy"`                  |
| `platformRevokeAtSince` | boolean                                  | `true`                      |
| `autoRls`               | `"auto"`, `"on"` or `"off"`              | `"auto"`                    |
| `platformPublications`  | string[]                                 | `["supabase_realtime"]`     |
| `migrationRole`         | string                                   | `"postgres"`                |
| `clientRoles`           | string[]                                 | `["anon", "authenticated"]` |
| `serviceRole`           | string                                   | `"service_role"`            |
| `serviceOnly`           | string[]                                 | `[]`                        |
| `postgresMajor`         | integer (10 or more)                     | `15`                        |
| `rules`                 | `{ "<ID>": "off" \| "warn" \| "error" }` | `{}`                        |
| `ignore`                | `[{ rule, relation?, file?, reason }]`   | `[]`                        |

### migrations

Where the migrations are: a directory (its `*.sql` files, not subdirectories), a glob, a single
`.sql` file, or a list of these, relative to the project directory. The version of a file is the
digits before the first `_` in its name (`20261002120000_add_todos.sql` has version
`20261002120000`). Files replay in name order, like the Supabase CLI applies them. Files without a
version replay last and get a [PARSE001](rules/PARSE001.md) notice. A file named without a version
takes its directory's, for tools that write one directory per migration (Prisma:
`"migrations": "prisma/migrations/*/migration.sql"`).

### schemas

The schemas whose tables, views and sequences are checked. Add every schema you expose through the
Data API (`"schemas": ["public", "api"]`).

### schemaPaths

Your [declarative schema](how-it-works.md#declarative-schemas) files. With `"auto"` they are found
the way the Supabase CLI finds them: `schema_paths` under `[db.migrations]` in
`supabase/config.toml` (relative to `supabase/`), else the pg-delta `declarative_schema_path` when
`[experimental.pgdelta]` is enabled, else `supabase/schemas` if it exists. A list of directories,
globs and `.sql` files (relative to the project directory) replaces that search, and `[]` skips
declarative schemas. Either way the files are read in the CLI's order: entries in the order
listed, each entry's matches sorted by name, directories expanded to every `.sql` file below them,
and a file an earlier entry matched skipped. They are checked only once the project is opted in
(see [Declarative schemas](how-it-works.md#declarative-schemas)).

### since

Which migrations the rules that check new relations (GL001 to GL006 and GL008) enforce: only
those with a version strictly greater than `since`. Older files are still replayed, so their
tables, grants and policies are known.

- `"auto"`: the last migration that revokes the default table privileges (`select`, `insert`,
  `update`, `delete`) from all of `anon`, `authenticated` and `service_role`, for `migrationRole`,
  in a checked schema or in every schema. The revokes may be spread over several statements of the
  file. If there is none, [GL000](rules/GL000.md) reports it and those rules do not run.
- `"none"`: enforce every file, including files without a version.
- a version: set this when your project was opted in without a migration saying so (from the
  dashboard, or by the platform change on 2026-10-30). Use the version of the last migration
  applied before the opt-in.

The `--since` flag takes the same values and wins over the config.

### platformDefaults

The default privileges before the first migration.

- `"legacy"`: `postgres` grants all privileges on new tables and sequences in `public` to `anon`,
  `authenticated` and `service_role`. This is what Supabase projects did before the change, and
  what the local stack still does unless `auto_expose_new_tables = false`.
- `"explicit"`: no default grants, as on a project created without automatic grants.

### platformRevokeAtSince

When `since` is a version (from the config or `--since`, not `"auto"` or `"none"`), assume the
platform revoked the default grants just before the first enforced migration, as it does for
projects opted in from the dashboard and for every existing project on 2026-10-30. The revoke
follows the SQL Supabase published: `select`, `insert`, `update`, `delete` on tables and `usage`,
`select` on sequences, from `anon`, `authenticated` and `service_role`; `truncate`, `references`,
`trigger`, `maintain` and sequence `update` stay (see [GL008](rules/GL008.md)). The output has a
notice naming the file. Set `false` to replay without it.

### autoRls

For the [engine export](engine.md) only: grants-lint's rules do not read row level security, so this key never
changes their output. Supabase offers an opt-in template that enables row level security on every
new table in `public` (event trigger `ensure_rls` calling `public.rls_auto_enable()`). This key
says when the replay assumes it.

- `"auto"`: while an enabled event trigger named `ensure_rls`, or calling a function named
  `rls_auto_enable`, on `ddl_command_end` for `CREATE TABLE` exists in the replayed migrations; and
  from a migration that defines `public.rls_auto_enable()` returning `event_trigger` until it is
  dropped, because a pulled baseline keeps that function but not the trigger.
- `"on"`: from the first migration.
- `"off"`: only explicit `alter table ... enable row level security` statements count.

### platformPublications

For the [engine export](engine.md) only: grants-lint's rules do not read publications, so this key never
changes their output. The publications that exist, with no tables, before the first migration.
Supabase's database image creates `supabase_realtime` empty (hosted projects, the local stack and
preview branches alike), so migrations usually only `alter` it. Set `[]` for Postgres outside
Supabase.

### migrationRole

The role that runs your migrations and owns what they create; its default privileges apply to new
relations. `set role` and `reset role` inside a file change it for the rest of that file.

### clientRoles

Roles that reach tables through the Data API with a user's token. `anon` and `authenticated` are
always checked; list extra roles your policies use (for example a custom role you switch to in a
JWT claim).

### serviceRole

The role server code uses with the service role key. It bypasses row level security but still
needs grants ([GL001](rules/GL001.md)).

### serviceOnly

Relations only server code uses, as `schema.name` or a bare name (matching that name in every
checked schema). They are exempt from the client-role rules [GL002](rules/GL002.md) and
[GL003](rules/GL003.md), and still checked by GL001.

### postgresMajor

The Postgres major version of your project. From 17, [GL008](rules/GL008.md) also checks
`maintain`, and its fix revokes it. The default, 15, keeps fix SQL valid on every supported server.

### rules

Turn a rule off, or change its severity: `"rules": { "GL005": "error", "GL008": "off" }`. A rule
that is off does not run at all.

### ignore

Suppress findings in config, for example for migrations that are already applied. Each entry
needs `rule` and a non-empty `reason`; `relation` and `file` narrow it:

- `relation`: `schema.name` exactly, or a bare name matching it in any schema.
- `file`: the path relative to the current directory, or its last segments
  (`20261002120000_add_todos.sql`). `./` and `\` are normalised.

An entry without a reason is a config error (exit 2). An entry that matches nothing produces a
notice, so stale entries do not pile up.

## Inline suppressions

A comment on the line above the statement a finding points at suppresses it:

```sql
-- grants-lint-disable-next-line GL001: read only by a security definer function
create table public.rate_limits (
  key text primary key,
  hits integer not null
);
```

- Findings point at the statement that caused them: the `create` for GL001, GL002, GL004 and
  GL008, the `create policy` or `alter policy` for GL003, the `grant` or `alter default
privileges` for GL005 to GL007.
- Several rules: `-- grants-lint-disable-next-line GL002, GL003: <reason>`.
- A reason after the colon is required. A comment without one, or naming an unknown rule, is a
  usage error (exit 2).
- A suppression that matches nothing produces a notice.
