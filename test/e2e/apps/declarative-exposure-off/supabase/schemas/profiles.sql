-- No migration yet and no opt-in migration: auto_expose_new_tables = false opts the project in.
create table public.profiles (
  id uuid primary key,
  display_name text
);
alter table public.profiles enable row level security;

create policy "profiles are public" on public.profiles
  for select to anon, authenticated using (true);

-- anon is missing: its policy above can never apply.
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;
