-- Server-side duplicate check for order capture.
-- Run this in the Supabase SQL editor (incremental — safe to run after
-- 0001/0002/0003).
--
-- Both capture paths (the browser extension's right-click "Send to
-- warehouse" and the dashboard's manual add box) used to INSERT directly,
-- so nothing stopped the same order_id from being captured twice — e.g.
-- the same order right-clicked by two different staff, or re-added after
-- a page refresh. This RPC centralizes the check server-side so it can't
-- be skipped by a client that calls the API directly, and uses an
-- advisory lock so two near-simultaneous captures of the same order_id
-- can't both slip past the check before either one inserts.
--
-- Call with p_force = false first. If `inserted` comes back false, show
-- the caller the rows in `existing_matches` and ask for confirmation;
-- call again with p_force = true to record the duplicate intentionally.
-- This does not touch the reschedule flow in src/dashboard.js
-- (applyException), which re-inserts the same order_id as a deliberate,
-- system-tracked state transition rather than a duplicate capture.

-- `orders.dispatch_date` is already in production (both the extension and
-- the dashboard's manual-add box have sent it on every insert since
-- before this migration), but it was never captured in a committed
-- migration — 0001_init.sql's orders table doesn't have it. Guard it here
-- so this migration also works on a fresh install that only ran
-- 0001-0003, without touching the column already in use everywhere else.
alter table if exists public.orders
  add column if not exists dispatch_date date not null default current_date;

create or replace function public.capture_order(
  p_order_id text,
  p_warehouse_id uuid,
  p_dispatch_date date,
  p_force boolean default false
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

  -- Mirror the orders_insert_own_warehouse_or_admin RLS policy by hand,
  -- since SECURITY DEFINER bypasses RLS inside this function. coalesce()
  -- matters here: a bare `role <> 'super_admin'` evaluates to NULL (not
  -- true) when the caller has no profile row, and plpgsql's IF treats a
  -- NULL condition as false — silently skipping the check instead of
  -- denying. Failing closed (deny when role is unknown) avoids that.
  if coalesce(public.current_user_role(), '') <> 'super_admin'
     and p_warehouse_id is distinct from public.current_user_warehouse() then
    raise exception 'Not authorized to add orders to this warehouse';
  end if;

  -- Serialize concurrent captures of the same order_id so two requests
  -- racing each other can't both pass the "no duplicate" check below.
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

  insert into public.orders (order_id, warehouse_id, dispatch_date, created_by)
  values (p_order_id, p_warehouse_id, p_dispatch_date, auth.uid())
  returning * into v_new;

  return query select true, v_new, coalesce(v_existing, '[]'::jsonb);
end;
$$;

grant execute on function public.capture_order(text, uuid, date, boolean) to authenticated;
