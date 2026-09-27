---
'supabase-grants-lint': minor
---

Check declarative schemas: `check` now also reads the files in `supabase/schemas` (or `schema_paths` in `supabase/config.toml`, or the pg-delta declarative directory), in the order the Supabase CLI applies them. They are checked as one unit, from no automatic grants, so a table, view or sequence there without the grants it needs is reported at its line (GL001 to GL006, GL008). New config key `schemaPaths` (`"auto"`, a list of paths and globs, or `[]` to skip). A migration file without a version in its name takes its directory's, so Prisma's `prisma/migrations/*/migration.sql` layout works; the docs show how to point the tool at Drizzle Kit and Prisma output.
