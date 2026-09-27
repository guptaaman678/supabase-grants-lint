-- Sorts before tables.sql by name; schema_paths in config.toml applies tables.sql first.
create policy "owners read todos" on public.todos
  for select to authenticated using (owner = auth.uid());
create policy "owners add todos" on public.todos
  for insert to authenticated with check (owner = auth.uid());

create policy "profiles are public" on public.profiles
  for select to anon, authenticated using (true);

create policy "owners add orders" on public.orders
  for insert to authenticated with check (owner = auth.uid());
