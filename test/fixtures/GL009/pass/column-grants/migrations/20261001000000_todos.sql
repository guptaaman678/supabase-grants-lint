create table public.todos (id uuid primary key, title text);
revoke all on public.todos from anon;
grant select (id, title) on public.todos to anon;
