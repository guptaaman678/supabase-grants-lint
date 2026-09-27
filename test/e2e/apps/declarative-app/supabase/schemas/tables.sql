create table public.todos (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  title text not null
);
alter table public.todos enable row level security;

create table public.profiles (
  id uuid primary key,
  display_name text
);
alter table public.profiles enable row level security;

create table public.orders (
  id bigserial primary key,
  owner uuid not null,
  total numeric not null
);
alter table public.orders enable row level security;
