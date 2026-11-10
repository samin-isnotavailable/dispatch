-- Pre-book tables, written down.
-- Run in the Supabase SQL editor after 0001-0015.
--
-- products, prebook_batches and prebook_orders were created by hand in the
-- Supabase dashboard, so a database rebuilt from these files had no
-- Prebook tab. The create statements below match the live tables exactly
-- and do nothing where the tables already exist.
--
-- Access: until now any signed-in account could read and add to them, and
-- delete pre-book orders — including an account nobody assigned (the same
-- gap 0010 closed for orders). Now only super admins and staff with a
-- warehouse can. Who may delete is unchanged.

begin;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sku text,
  brand text,
  created_at timestamptz not null default now()
);

create table if not exists public.prebook_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  expected_date date,
  stock_quantity integer not null default 0,
  status text not null default 'active' check (status in ('active', 'arrived', 'closed')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.prebook_orders (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.prebook_batches (id) on delete cascade,
  order_id text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.prebook_batches enable row level security;
alter table public.prebook_orders enable row level security;

-- Signed in AND given a role by the owner (super admin, or staff with a warehouse).
create or replace function public.current_user_is_assigned()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select role = 'super_admin' or warehouse_id is not null
    from public.profiles where id = auth.uid()
  ), false);
$$;

-- products
drop policy if exists "products_select_all" on public.products;
drop policy if exists "products_insert_all" on public.products;
drop policy if exists "products_update_all" on public.products;
drop policy if exists "products_delete_admin" on public.products;
drop policy if exists "products_select_assigned" on public.products;
drop policy if exists "products_insert_assigned" on public.products;
drop policy if exists "products_update_assigned" on public.products;
create policy "products_select_assigned" on public.products for select to authenticated
  using (public.current_user_is_assigned());
create policy "products_insert_assigned" on public.products for insert to authenticated
  with check (public.current_user_is_assigned());
create policy "products_update_assigned" on public.products for update to authenticated
  using (public.current_user_is_assigned()) with check (public.current_user_is_assigned());
create policy "products_delete_admin" on public.products for delete to authenticated
  using (coalesce(public.current_user_role(), '') = 'super_admin');

-- prebook_batches
drop policy if exists "prebook_batches_select_all" on public.prebook_batches;
drop policy if exists "prebook_batches_insert_all" on public.prebook_batches;
drop policy if exists "prebook_batches_update_all" on public.prebook_batches;
drop policy if exists "prebook_batches_delete_admin" on public.prebook_batches;
drop policy if exists "prebook_batches_select_assigned" on public.prebook_batches;
drop policy if exists "prebook_batches_insert_assigned" on public.prebook_batches;
drop policy if exists "prebook_batches_update_assigned" on public.prebook_batches;
create policy "prebook_batches_select_assigned" on public.prebook_batches for select to authenticated
  using (public.current_user_is_assigned());
create policy "prebook_batches_insert_assigned" on public.prebook_batches for insert to authenticated
  with check (public.current_user_is_assigned());
create policy "prebook_batches_update_assigned" on public.prebook_batches for update to authenticated
  using (public.current_user_is_assigned()) with check (public.current_user_is_assigned());
create policy "prebook_batches_delete_admin" on public.prebook_batches for delete to authenticated
  using (coalesce(public.current_user_role(), '') = 'super_admin');

-- prebook_orders
drop policy if exists "prebook_orders_select_all" on public.prebook_orders;
drop policy if exists "prebook_orders_insert_all" on public.prebook_orders;
drop policy if exists "prebook_orders_delete_all" on public.prebook_orders;
drop policy if exists "prebook_orders_select_assigned" on public.prebook_orders;
drop policy if exists "prebook_orders_insert_assigned" on public.prebook_orders;
drop policy if exists "prebook_orders_delete_assigned" on public.prebook_orders;
create policy "prebook_orders_select_assigned" on public.prebook_orders for select to authenticated
  using (public.current_user_is_assigned());
create policy "prebook_orders_insert_assigned" on public.prebook_orders for insert to authenticated
  with check (public.current_user_is_assigned());
create policy "prebook_orders_delete_assigned" on public.prebook_orders for delete to authenticated
  using (public.current_user_is_assigned());

commit;
