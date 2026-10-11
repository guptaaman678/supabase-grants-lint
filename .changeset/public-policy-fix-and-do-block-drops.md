---
'supabase-grants-lint': patch
---

GL002 and GL003 now fix a policy without a `TO` clause (`PUBLIC`) with a grant to `authenticated` only, not to `anon` and `authenticated`. A grant to either role clears the finding, and the message says to grant `anon` as well only if signed-out visitors should pass the policy, so the suggested SQL no longer opens a table to anyone with the publishable key by default.

PARSE002 now also reports a `DO` block that drops, alters or renames a relation (`drop table`, `drop view`, `drop materialized view`, `alter table`, or a rename of a table, view or sequence). The replay does not run the block, so a table it drops stays in the model, and the tool could ask for grants on a table that no longer exists. `alter publication ... drop table` (realtime membership) is not reported.
