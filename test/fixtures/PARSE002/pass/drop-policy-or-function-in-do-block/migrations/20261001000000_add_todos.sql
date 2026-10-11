create table public.todos (id uuid primary key, user_id uuid);
alter table public.todos enable row level security;
grant select, insert, update, delete on public.todos to service_role;
grant select on public.todos to authenticated;
create policy "owners read" on public.todos for select to authenticated using (true);
do $$
begin
  drop policy if exists "owners read" on public.todos;
  drop function if exists public.todo_count();
end
$$;
