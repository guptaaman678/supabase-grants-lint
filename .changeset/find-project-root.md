---
'supabase-grants-lint': patch
---

Find the project from inside `supabase/`. Without `--dir`, `check`, `doctor` and `explain` run from `supabase/` or `supabase/migrations` now use the folder that contains `supabase/` (its config included) and name it in the summary line, and a folder of `.sql` files is linted as `--dir <that folder>` would. The "Migrations directory not found" error now says to run from the project root or pass `--dir <project or migrations folder>`.
