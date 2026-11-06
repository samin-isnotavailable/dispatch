-- Fill in missing order details.
-- Run this in the Supabase SQL editor (incremental — safe to run after
-- 0001-0007, and safe to re-run). Changes no existing data by itself.
--
-- Orders typed into the manual box (no laptop / no extension to hand)
-- are saved with just the order ID. Later, when someone sends the same
-- order from Zagle with the extension, or pastes its details in the
-- dashboard, capture_order now fills those details into the ID-only
-- record instead of reporting a duplicate. It returns filled = true (and
-- inserted = true, meaning "saved") in that case; no new row is added.
--
-- Only records in the same warehouse are filled, matching who may edit
-- what (staff can only change their own warehouse's orders). Every
-- ID-only record of that order in the warehouse is filled, so a moved /
-- rescheduled order's copies all get the details too.
--
-- Short order IDs are completed before anything else, so a typed "42420"
-- and Zagle's "WOO-42420" are the same order (see normalize_order_id).


begin;

-- "42420" → "WOO-42420", "261106-0098" → "ORD-261106-0098", and
-- "woo 42420" / "woo42420" → "WOO-42420". Anything else (e.g. a product
-- name sent the old Note way) is returned trimmed but otherwise as typed.
-- Mirrored in src/orderTextParser.js (normalizeOrderId) for the dashboard.
create or replace function public.normalize_order_id(p text)
returns text
language sql
immutable
as $$
  select case
    when t ~* '^(woo|ord)[[:space:]-]*[0-9][0-9-]*$'
      then upper(substring(t from '^([A-Za-z]{3})')) || '-' || regexp_replace(t, '^[A-Za-z]{3}[[:space:]-]*', '')
    when t ~ '^[0-9]{3,7}$' then 'WOO-' || t
    when t ~ '^[0-9]{6}-[0-9]{3,5}$' then 'ORD-' || t
    else t
  end
  from (select btrim(coalesce(p, '')) as t) x;
$$;

grant execute on function public.normalize_order_id(text) to authenticated;

drop function if exists public.capture_order(text, uuid, date, boolean, jsonb);

create or replace function public.capture_order(
  p_order_id text,
  p_warehouse_id uuid,
  p_dispatch_date date,
  p_force boolean default false,
  p_details jsonb default null
)
returns table (
  inserted boolean,
  filled boolean,
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
  v_filled public.orders;
begin
  p_order_id := public.normalize_order_id(p_order_id);
  if p_order_id = '' then
    raise exception 'order_id is required';
  end if;

  -- Mirror the orders RLS write policy (SECURITY DEFINER bypasses RLS).
  -- coalesce() so a caller with no profile is denied, not waved through.
  if coalesce(public.current_user_role(), '') <> 'super_admin'
     and p_warehouse_id is distinct from public.current_user_warehouse() then
    raise exception 'Not authorized to add orders to this warehouse';
  end if;

  -- Serialize concurrent captures of the same order_id.
  perform pg_advisory_xact_lock(hashtext(p_order_id)::bigint);

  -- 1. Fill: this order was recorded here earlier with only its ID.
  if p_details is not null then
    with upd as (
      update public.orders o
         set details = p_details
       where o.order_id = p_order_id
         and o.warehouse_id = p_warehouse_id
         and o.details is null
      returning o.*
    )
    select * into v_filled from upd order by created_at desc limit 1;

    if found then
      -- inserted = true too: "saved, nothing to confirm". Extension 0.2.0
      -- (already on everyone's browser) only looks at `inserted`, so it
      -- shows its green tick instead of an empty duplicate prompt.
      return query select true, true, v_filled, '[]'::jsonb;
      return;
    end if;
  end if;

  -- 2. Duplicate check, as before.
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
    return query select false, false, null::public.orders, v_existing;
    return;
  end if;

  -- 3. New record.
  insert into public.orders (order_id, warehouse_id, dispatch_date, created_by, details)
  values (p_order_id, p_warehouse_id, p_dispatch_date, auth.uid(), p_details)
  returning * into v_new;

  return query select true, false, v_new, coalesce(v_existing, '[]'::jsonb);
end;
$$;

grant execute on function public.capture_order(text, uuid, date, boolean, jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';
