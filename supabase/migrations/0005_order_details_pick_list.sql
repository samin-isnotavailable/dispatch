-- Full order details + product pick list.
-- Run this in the Supabase SQL editor (incremental — safe to run after
-- 0001-0004, and safe to re-run).
--
-- Backward compatible on purpose: production (main) and the test branch
-- share this database, so nothing here changes how existing code behaves.
--   * orders.details is a new nullable column; old code never reads it.
--   * capture_order keeps every existing parameter and only gains an
--     optional p_details, so the current extension and dashboard keep
--     working unchanged.
--   * pick_marks is a new table only the new dashboard uses.

begin;

-- ---------------------------------------------------------------------
-- orders.details — everything read off the Zagle order card at capture
-- time: items, amounts, source/salesperson, customer name, phone,
-- address, district, coupon,
-- courier. Null for orders typed in manually or captured from a page the
-- extension couldn't read. Stored as one JSON document (rather than
-- separate columns) because the card's fields vary order to order.
-- ---------------------------------------------------------------------

alter table public.orders
  add column if not exists details jsonb;

-- ---------------------------------------------------------------------
-- pick_marks — "collected from the shelf" ticks in the Products view.
-- One row per (warehouse, dispatch date, product). picked_qty records how
-- many units were needed when it was ticked, so if another order for the
-- same product arrives later the dashboard shows "2 of 3 collected"
-- instead of a stale tick.
-- ---------------------------------------------------------------------

create table if not exists public.pick_marks (
  warehouse_id uuid not null references public.warehouses (id) on delete cascade,
  dispatch_date date not null,
  product_name text not null,
  picked_qty integer not null check (picked_qty > 0),
  picked_by uuid references auth.users (id) on delete set null,
  picked_at timestamptz not null default now(),
  primary key (warehouse_id, dispatch_date, product_name)
);

alter table public.pick_marks enable row level security;

-- Same access rules as orders: everyone signed in can see every
-- warehouse; only super_admin or that warehouse's own staff can change it.
drop policy if exists "pick_marks_select_all_authenticated" on public.pick_marks;
create policy "pick_marks_select_all_authenticated"
  on public.pick_marks for select
  to authenticated
  using (true);

drop policy if exists "pick_marks_write_own_warehouse_or_admin" on public.pick_marks;
create policy "pick_marks_write_own_warehouse_or_admin"
  on public.pick_marks for all
  to authenticated
  using (
    coalesce(public.current_user_role(), '') = 'super_admin'
    or warehouse_id = public.current_user_warehouse()
  )
  with check (
    coalesce(public.current_user_role(), '') = 'super_admin'
    or warehouse_id = public.current_user_warehouse()
  );

grant select, insert, update, delete on public.pick_marks to authenticated;

-- Live sync of ticks between everyone looking at the same warehouse.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pick_marks'
     ) then
    alter publication supabase_realtime add table public.pick_marks;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- capture_order — same as 0004, plus an optional p_details saved onto the
-- new row. The old 4-argument version is dropped rather than overloaded:
-- with both present, the API can't tell which one a 4-argument call means.
-- Calls that don't pass p_details still resolve to this one via the
-- default.
-- ---------------------------------------------------------------------

drop function if exists public.capture_order(text, uuid, date, boolean);

create or replace function public.capture_order(
  p_order_id text,
  p_warehouse_id uuid,
  p_dispatch_date date,
  p_force boolean default false,
  p_details jsonb default null
)
returns table (
  inserted boolean,
  order_row public.orders,
  existing_matches jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_new public.orders;
begin
  if p_order_id is null or btrim(p_order_id) = '' then
    raise exception 'order_id is required';
  end if;

  -- Mirror the orders insert RLS policy (SECURITY DEFINER bypasses RLS).
  -- coalesce() so a caller with no profile is denied, not waved through.
  if coalesce(public.current_user_role(), '') <> 'super_admin'
     and p_warehouse_id is distinct from public.current_user_warehouse() then
    raise exception 'Not authorized to add orders to this warehouse';
  end if;

  -- Serialize concurrent captures of the same order_id.
  perform pg_advisory_xact_lock(hashtext(p_order_id)::bigint);

  select jsonb_agg(
           jsonb_build_object(
             'id', o.id,
             'warehouse_id', o.warehouse_id,
             'warehouse_name', w.name,
             'dispatch_date', o.dispatch_date,
             'created_at', o.created_at,
             'done', o.done
           )
           order by o.created_at desc
         )
    into v_existing
  from public.orders o
  join public.warehouses w on w.id = o.warehouse_id
  where o.order_id = p_order_id;

  if v_existing is not null and not p_force then
    return query select false, null::public.orders, v_existing;
    return;
  end if;

  insert into public.orders (order_id, warehouse_id, dispatch_date, created_by, details)
  values (p_order_id, p_warehouse_id, p_dispatch_date, auth.uid(), p_details)
  returning * into v_new;

  return query select true, v_new, coalesce(v_existing, '[]'::jsonb);
end;
$$;

grant execute on function public.capture_order(text, uuid, date, boolean, jsonb) to authenticated;

commit;

-- Tell the API layer to pick up the new function signature right away.
notify pgrst, 'reload schema';
