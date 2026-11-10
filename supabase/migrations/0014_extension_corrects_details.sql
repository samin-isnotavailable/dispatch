-- Resending an order with the extension corrects pasted / screenshot details.
-- Run in the Supabase SQL editor after 0001-0013. Changes no data by itself.
--
-- Same capture_order as 0008, with one change: when the extension sends an
-- order that's already in this warehouse with details from a paste or a
-- screenshot (which can misread a name, e.g. "X1V2" for "X1 V2"), its
-- details are replaced with the extension's, read straight from the Zagle
-- page. No second row, no duplicate prompt; the extension shows its green
-- tick. Orders first captured by the extension still get the duplicate
-- warning, so a real accidental double-send is still caught.

begin;

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

  -- 1. Fill: this order was recorded here earlier with only its ID — or,
  --    when the extension sends it, with details from a paste / screenshot,
  --    which the extension's reading of the Zagle page replaces.
  if p_details is not null then
    with upd as (
      update public.orders o
         set details = p_details
       where o.order_id = p_order_id
         and o.warehouse_id = p_warehouse_id
         and (
           o.details is null
           or (p_details->>'captured_from' = 'zagle'
               and o.details->>'captured_from' in ('paste', 'screenshot'))
         )
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
