-- Move an order to another dispatch day in one step.
-- Run in the Supabase SQL editor after 0001-0014. Changes no data by itself.
--
-- "Missed — dispatch next day" / "Dispatch on another day" used to save in
-- two requests from the browser: add the copy on the new day, then flag the
-- original as moved. If the connection dropped in between, the order was
-- left on both days and counted twice. This does both together, or neither.
--
-- Runs with the caller's permissions, so the usual rules apply: staff can
-- only move orders in their own warehouse.

create or replace function public.reschedule_order(p_id uuid, p_date date)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old public.orders;
  v_new uuid;
begin
  -- Locks the row, so a double tap can't move the same order twice.
  select * into v_old from public.orders where id = p_id for update;
  if not found then
    raise exception 'Order not found, or you can''t change it';
  end if;
  if v_old.exception_type is not null then
    raise exception 'This order is already flagged';
  end if;
  if p_date = v_old.dispatch_date then
    raise exception 'That''s the day it''s already on';
  end if;

  insert into public.orders (order_id, warehouse_id, dispatch_date, created_by, details)
  values (v_old.order_id, v_old.warehouse_id, p_date, auth.uid(), v_old.details)
  returning id into v_new;

  update public.orders
     set exception_type = 'rescheduled', rescheduled_to_id = v_new
   where id = p_id;
  if not found then
    raise exception 'Couldn''t flag the original order'; -- also undoes the insert above
  end if;

  return v_new;
end;
$$;

revoke execute on function public.reschedule_order(uuid, date) from public, anon;
grant execute on function public.reschedule_order(uuid, date) to authenticated;

notify pgrst, 'reload schema';
