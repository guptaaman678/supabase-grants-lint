create table public.todos (id uuid primary key, title text);
alter table public.todos enable row level security;
create policy "read" on public.todos for select to authenticated using (true);
grant select on public.todos to authenticated;
grant select, insert, update, delete on public.todos to service_role;
