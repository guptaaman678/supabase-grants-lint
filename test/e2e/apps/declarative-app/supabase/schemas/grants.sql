-- Grants live in their own file; they count for tables declared in any schema file.
grant select, insert on public.todos to authenticated;
grant select, insert, update, delete on public.todos to service_role;

grant insert on public.orders to authenticated;
grant select, insert, update, delete on public.orders to service_role;
