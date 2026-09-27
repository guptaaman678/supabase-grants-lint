create table public.todos (id uuid primary key, title text);
revoke truncate, references, trigger, maintain on public.todos from anon, authenticated;
