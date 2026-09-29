create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  title text not null
);
alter table public.todos enable row level security;
grant select, insert, update, delete on public.todos to service_role with grant option;
-- Takes back only the right to pass the privileges on; service_role keeps them.
revoke grant option for select, insert, update, delete on public.todos from service_role;
