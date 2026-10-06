create table public.messages (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  body text not null
);
alter table public.messages enable row level security;
grant select, insert, update, delete on public.messages to service_role;
