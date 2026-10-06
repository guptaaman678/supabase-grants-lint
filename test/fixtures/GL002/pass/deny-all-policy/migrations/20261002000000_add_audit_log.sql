create table public.audit_log (
  id bigint generated always as identity primary key,
  action text not null
);
alter table public.audit_log enable row level security;
grant select, insert on public.audit_log to service_role;
-- Deny-all policies admit no row for anyone: the author means "no direct client access" (reads
-- go through server code or a security definer function), and no client grant is expected.
create policy "No direct access" on public.audit_log for all using (false);
create policy "No client inserts" on public.audit_log for insert to anon, authenticated
  with check (false::boolean);
