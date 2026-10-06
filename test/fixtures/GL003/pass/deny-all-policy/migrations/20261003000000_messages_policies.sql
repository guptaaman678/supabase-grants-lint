-- Deny-all policies on a relation the clients hold no grant on: nothing to make reachable.
create policy "No direct reads" on public.messages for select to anon, authenticated
  using (false);
create policy "No direct writes" on public.messages for update
  using (false) with check (false::bool);
