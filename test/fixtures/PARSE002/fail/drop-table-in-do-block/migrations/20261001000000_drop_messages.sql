create table public.messages (id uuid primary key, body text);
grant select, insert, update, delete on public.messages to service_role;
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'messages') then
    drop table public.messages;
  end if;
end
$$;
