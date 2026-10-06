create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  title text not null
);
alter table public.todos enable row level security;
grant select, insert, update, delete on public.todos to service_role;
-- The deny-all policy does not count, but the owner policy still needs a grant to authenticated.
create policy "No deletes" on public.todos for delete to authenticated using (false);
create policy "Owner reads todos" on public.todos for select to authenticated
  using (auth.uid() = user_id);
