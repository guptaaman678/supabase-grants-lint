---
'supabase-grants-lint': minor
---

Add live mode: `supabase-grants-lint diff` compares the migrations with a real database (read-only, connection string from `--db-url` or `SUPABASE_DB_URL`, never printed) and reports differences in privileges, default privileges and policies as the new rule GL009 (drift, warn). `doctor --db-url` adds a "Live database" section: whether the database still grants new tables automatically, and the drift count. The Postgres client (`postgres`) is loaded only in live mode, so `check` stays offline.
