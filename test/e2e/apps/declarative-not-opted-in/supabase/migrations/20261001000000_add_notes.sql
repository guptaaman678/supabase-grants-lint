-- Written while new tables still got grants automatically; no opt-in migration follows.
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  body text not null
);
alter table public.notes enable row level security;

create policy "anyone reads notes" on public.notes
  for select to anon, authenticated using (true);
