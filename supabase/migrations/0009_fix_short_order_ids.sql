-- One-time cleanup: complete order IDs that were typed in short before
-- 0008, e.g. "40456" → "WOO-40456", "261106-0098" → "ORD-261106-0098".
-- Run AFTER 0008 (it uses normalize_order_id). Safe to re-run: the second
-- run finds nothing to change.
--
-- Why: 0008 completes short IDs for every new entry, but records saved
-- earlier keep the short form, so "40456" never matches Zagle's
-- "WOO-40456" — the duplicate check and the automatic fill-in both miss
-- it. After this, they match.
--
-- Only IDs that look like a short order ID change (3-7 digits, or
-- 6 digits-dash-digits, or woo/ord with odd spacing or case). Product
-- names and serial numbers sent to the Note warehouse are left alone.
--
-- The result table lists every record changed: old ID, new ID, warehouse
-- and dispatch date.

with changed as (
  select o.id, o.order_id as old_id, public.normalize_order_id(o.order_id) as new_id
  from public.orders o
  where o.order_id <> public.normalize_order_id(o.order_id)
)
update public.orders o
   set order_id = c.new_id
  from changed c, public.warehouses w
 where o.id = c.id
   and w.id = o.warehouse_id
returning c.old_id, c.new_id, w.name as warehouse, o.dispatch_date;
