-- A subdirectory of supabase/schemas: its files are applied too, after the files above it in
-- byte order of their paths.
create view public.message_counts with (security_invoker = true) as
  select author, count(*) as messages from public.messages group by author;

grant select on public.message_counts to authenticated, service_role;
