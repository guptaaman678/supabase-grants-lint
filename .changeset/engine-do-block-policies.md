---
'supabase-grants-lint': patch
---

Engine (experimental): each snapshot relation gains `policiesUncertain`, the location of the last `DO` block that creates, alters or drops a policy on it (often `if not exists`, which the replay does not run), or `null`. A policy statement on a relation name built at run time marks every relation that exists at that point. Dropping the relation clears the mark. grants-lint's rules do not read it, so their output is unchanged.
