create table public.todos (id uuid primary key, title text);
grant select, insert, update, delete on public.todos to service_role;
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'tasks') then
    alter table public.todos rename to tasks;
  end if;
end
$$;
