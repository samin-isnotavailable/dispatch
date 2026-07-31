-- Explicit brand column on products, so pre-book grouping doesn't have to
-- guess brand from the first word of the name (breaks on multi-word
-- brands like "New Balance"). Nullable: existing rows fall back to
-- first-word parsing in the app until backfilled via CSV import.
-- Run this in the Supabase SQL editor (incremental — safe to run after 0001/0002).

alter table if exists public.products
  add column if not exists brand text;
