-- Warehouse Dispatch Tracker — initial schema
-- Run this in the Supabase SQL editor (or via `supabase db push`).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'staff' check (role in ('super_admin', 'staff')),
  warehouse_id uuid references public.warehouses (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  done boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists orders_warehouse_created_idx
  on public.orders (warehouse_id, created_at desc);

-- ---------------------------------------------------------------------
-- Helper functions (security definer so RLS policies can safely
-- check the caller's own profile without recursive-policy issues)
-- ---------------------------------------------------------------------

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_user_warehouse()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select warehouse_id from public.profiles where id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.warehouses enable row level security;
alter table public.profiles enable row level security;
alter table public.orders enable row level security;

-- warehouses: everyone signed in can view; only super_admin can manage
create policy "warehouses_select_all_authenticated"
  on public.warehouses for select
  to authenticated
  using (true);

create policy "warehouses_admin_write"
  on public.warehouses for all
  to authenticated
  using (public.current_user_role() = 'super_admin')
  with check (public.current_user_role() = 'super_admin');

-- profiles: a user can see their own profile; super_admin sees everyone
-- (needed so the dashboard can show staff assignments in admin views)
create policy "profiles_select_self_or_admin"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.current_user_role() = 'super_admin');

create policy "profiles_admin_write"
  on public.profiles for all
  to authenticated
  using (public.current_user_role() = 'super_admin')
  with check (public.current_user_role() = 'super_admin');

-- orders: everyone signed in can view every warehouse's orders (staff
-- can "browse" other warehouses read-only); writes are restricted to
-- super_admin, or to staff acting within their own assigned warehouse
create policy "orders_select_all_authenticated"
  on public.orders for select
  to authenticated
  using (true);

create policy "orders_insert_own_warehouse_or_admin"
  on public.orders for insert
  to authenticated
  with check (
    public.current_user_role() = 'super_admin'
    or warehouse_id = public.current_user_warehouse()
  );

create policy "orders_update_own_warehouse_or_admin"
  on public.orders for update
  to authenticated
  using (
    public.current_user_role() = 'super_admin'
    or warehouse_id = public.current_user_warehouse()
  )
  with check (
    public.current_user_role() = 'super_admin'
    or warehouse_id = public.current_user_warehouse()
  );

create policy "orders_delete_admin_only"
  on public.orders for delete
  to authenticated
  using (public.current_user_role() = 'super_admin');

-- ---------------------------------------------------------------------
-- New-user bootstrap: auto-create a profile row (as 'staff', no
-- warehouse) whenever a new auth user signs up. Assign role/warehouse
-- afterwards from the Supabase table editor or an admin screen.
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------
-- Seed warehouses (edit / extend as needed)
-- ---------------------------------------------------------------------

insert into public.warehouses (name) values
  ('Badda'), ('Multiplan'), ('CTG')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- Realtime: make sure the orders table broadcasts changes
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.orders;

-- ---------------------------------------------------------------------
-- Personal notes — one private freeform scratchpad per user
-- ---------------------------------------------------------------------

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
