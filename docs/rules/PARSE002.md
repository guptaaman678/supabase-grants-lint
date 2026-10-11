# PARSE002 dynamic-sql-skipped

Default severity: **info**.

## What it catches

A `DO` block whose body mentions `grant`, `revoke`, `create table`, `create policy` or
`default privileges`, or drops, alters or renames a relation (`drop table`, `drop view`,
`drop materialized view`, `alter table`, or a rename of a table, view or sequence). The replay does
not run PL/pgSQL, so whatever the block does to relations, grants or policies is not modelled: a
table the block drops is still in the replay, and the tool may ask for grants on it.
`alter publication ... drop table` (realtime membership) is not reported. PARSE002 checks every
file, enforced or not. Function bodies are not reported: creating a function runs nothing.

## Why it matters

A grant inside a `DO` block (often wrapped in `execute` or an `if exists` check) is invisible to
the replay. The tool may then report a table as unreachable although the block grants it, or miss
a table the block creates. PARSE002 tells you where the model has a blind spot.

## Failing example

```sql
-- supabase/migrations/20261001000000_revoke_automatic_grants.sql
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
```

```sql
-- supabase/migrations/20261002120000_add_todos.sql
create table public.todos (
  id bigint generated always as identity primary key,
  title text not null
);
do $$
begin
  execute 'grant select, insert, update, delete on public.todos to service_role';
end
$$;
```

Output of `supabase-grants-lint check`:

```text
supabase/migrations/20261002120000_add_todos.sql
  2:1  error  GL001     public.todos is created without a grant to service_role: server-side requests as service_role (edge functions, admin tools) fail with 42501 permission denied, because service_role bypasses RLS but not grants. Grant it the privileges it needs in the same migration.
              fix   grant select, insert, update, delete on public.todos to service_role;
              docs  https://github.com/guptaaman678/supabase-grants-lint/blob/v0.1.0/docs/rules/GL001.md
  6:1  info   PARSE002  DO block not modelled; it mentions grant. The replay does not run it, so any grants, tables or policies it creates are not checked. Move those statements out of the block, or suppress this with a reason.
              docs  https://github.com/guptaaman678/supabase-grants-lint/blob/v0.1.0/docs/rules/PARSE002.md

1 error, 0 warnings  (2 files, 1 relation, 0.0s)
```

GL001 is reported too: the replay did not see the grant inside the block.

## Fix

Move the statements the block runs out of it, as plain SQL.

```sql
-- supabase/migrations/20261002120000_add_todos.sql
create table public.todos (
  id bigint generated always as identity primary key,
  title text not null
);
grant select, insert, update, delete on public.todos to service_role;
```

## When it is safe to disable

When you have checked the blocks by hand and suppress the findings they cause elsewhere. Suppress
each block with a reason rather than turning the rule off, so a new block is still reported.

## Configuration

- Suppress one finding with `-- grants-lint-disable-next-line PARSE002: <reason>` on the line
  above the `do` statement, or an [`ignore`](../configuration.md#ignore) entry.
