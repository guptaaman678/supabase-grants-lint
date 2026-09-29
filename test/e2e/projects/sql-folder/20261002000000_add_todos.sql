create table public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null
);
alter table public.todos enable row level security;
create policy "owners read todos" on public.todos
  for select to authenticated using (auth.uid() = user_id);
grant select on public.todos to authenticated;
