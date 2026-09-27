create table public.todos (id uuid primary key, title text);
alter table public.todos enable row level security;
create policy "read" on public.todos for select to authenticated using (true);
