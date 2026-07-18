-- Personal notes — one private freeform scratchpad per user
-- Run this in the Supabase SQL editor (incremental — safe to run after 0001_init.sql)

create table if not exists public.notes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  content text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "notes_owner_only"
  on public.notes for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
