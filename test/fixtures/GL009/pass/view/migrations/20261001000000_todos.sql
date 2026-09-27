create table public.todos (id uuid primary key, title text);
create view public.titles as select title from public.todos;
