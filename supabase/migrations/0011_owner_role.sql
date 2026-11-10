-- Owner role.
-- Run in the Supabase SQL editor after 0001-0010.
--
-- super_admin = sees and edits every warehouse's orders, sees Statistics.
-- owner       = a super_admin who can also add / remove people and
--               warehouses (the /admin page). Only you.
--
-- Before this, every super_admin could manage users and warehouses.

begin;

alter table public.profiles add column if not exists is_owner boolean not null default false;

create or replace function public.current_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_owner from public.profiles where id = auth.uid()), false);
$$;

-- Warehouses: everyone signed in still reads them; only the owner adds,
-- renames or removes.
drop policy if exists "warehouses_admin_write" on public.warehouses;
drop policy if exists "warehouses_owner_write" on public.warehouses;
create policy "warehouses_owner_write"
  on public.warehouses for all
  to authenticated
  using (public.current_user_is_owner())
  with check (public.current_user_is_owner());

-- Profiles: only the owner changes roles and warehouses (so a super_admin
-- can't promote anyone, or themselves to owner).
drop policy if exists "profiles_admin_write" on public.profiles;
drop policy if exists "profiles_owner_write" on public.profiles;
create policy "profiles_owner_write"
  on public.profiles for all
  to authenticated
  using (public.current_user_is_owner())
  with check (public.current_user_is_owner());

-- The owner account. Change the email if yours is different.
update public.profiles
   set is_owner = true, role = 'super_admin', warehouse_id = null
 where id = (select id from auth.users where email = 'samin141714@gmail.com');

-- Every capture looks orders up by order_id (duplicate check, fill-in).
create index if not exists orders_order_id_idx on public.orders (order_id);

commit;

-- Should list exactly one row: you.
select u.email, p.role, p.is_owner
from public.profiles p join auth.users u on u.id = p.id
where p.is_owner;
