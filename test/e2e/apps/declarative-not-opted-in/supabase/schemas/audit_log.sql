-- No grants: fine while the platform grants new tables automatically, an error once opted in.
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid not null,
  action text not null
);
alter table public.audit_log enable row level security;

create policy "actors read their entries" on public.audit_log
  for select to authenticated using (actor = auth.uid());
