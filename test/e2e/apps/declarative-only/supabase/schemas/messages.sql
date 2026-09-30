-- No migration generated yet: the schema file is the only SQL in the project.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  author uuid not null,
  body text not null
);
alter table public.messages enable row level security;

create policy "members read messages" on public.messages
  for select to authenticated using (true);
create policy "authors post messages" on public.messages
  for insert to authenticated with check (author = auth.uid());

grant select, insert on public.messages to authenticated;
grant select, insert, update, delete on public.messages to service_role;
