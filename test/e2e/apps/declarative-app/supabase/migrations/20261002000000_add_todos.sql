-- Generated from the declarative schema when todos was the only table.
create table public.todos (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  title text not null
);
alter table public.todos enable row level security;

create policy "owners read todos" on public.todos
  for select to authenticated using (owner = auth.uid());
create policy "owners add todos" on public.todos
  for insert to authenticated with check (owner = auth.uid());

grant select, insert on public.todos to authenticated;
grant select, insert, update, delete on public.todos to service_role;
