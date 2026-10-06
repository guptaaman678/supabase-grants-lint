---
'supabase-grants-lint': patch
---

GL002 and GL003 no longer ask for client grants on deny-all policies. A policy whose every `USING` and `WITH CHECK` expression is the constant `false` (for example `create policy "No direct access" on public.audit_log for all using (false);`) admits no row for anyone, so it means "no client access", like a policy that only admits `service_role`. Before, the suggested fix granted `anon` and `authenticated` select, insert, update and delete on such tables.
