create table public.profiles (id uuid primary key);
grant select, insert, update, delete on public.profiles to service_role;
do $$
begin
  alter table public.profiles add column display_name text;
exception
  when duplicate_column then null;
end
$$;
