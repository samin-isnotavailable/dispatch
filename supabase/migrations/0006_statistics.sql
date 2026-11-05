-- Statistics tab data.
-- Run this in the Supabase SQL editor (incremental — safe to run after
-- 0001-0005, and safe to re-run). It adds one function and one index, and
-- changes no existing data or behaviour.
--
-- stats_dataset(from, to, warehouse) returns everything the Statistics
-- tab needs for one date range as a single JSON document (one document
-- rather than a list of rows, so Supabase's 1,000-row response cap never
-- truncates it). The browser does the per-chart arithmetic.
--
-- Counting rules, applied once here so every chart agrees:
--   * only orders captured with details (Zagle card read at capture time);
--   * cancelled orders and the original row of a moved/rescheduled order
--     are left out (the moved copy on its new date is what counts);
--   * an order_id recorded more than once (a confirmed duplicate) counts
--     once — its most recent row wins;
--   * the date range filters on dispatch_date.

-- The exception columns behind "Mark incomplete" (cancelled / moved /
-- other) are already in production — the dashboard has used them for a
-- while — but were never written into a migration. Guard them here so a
-- fresh install that only ran 0001-0005 works too. On production these
-- are no-ops.
alter table public.orders add column if not exists exception_type text;
alter table public.orders add column if not exists exception_note text;
alter table public.orders add column if not exists rescheduled_to_id uuid;

create index if not exists orders_stats_idx
  on public.orders (order_id, created_at desc)
  where details is not null;

create or replace function public.stats_dataset(
  p_from date,
  p_to date,
  p_warehouse uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with clean as (
    select distinct on (o.order_id)
      o.order_id, o.warehouse_id, o.dispatch_date, o.details as d,
      -- Last 11 digits, so "+8801711…" and "01711…" are the same customer.
      nullif(right(regexp_replace(coalesce(o.details->>'phone', ''), '\D', '', 'g'), 11), '') as phone_key
    from public.orders o
    where o.details is not null
      and o.exception_type is distinct from 'cancelled'
      and o.exception_type is distinct from 'rescheduled'
    order by o.order_id, o.created_at desc
  ),
  scoped as (
    select * from clean
    where p_warehouse is null or warehouse_id = p_warehouse
  ),
  in_range as (
    select * from scoped where dispatch_date between p_from and p_to
  ),
  -- Lifetime history (up to the end of the range) for every customer who
  -- ordered inside the range, across all warehouses.
  history as (
    select c.phone_key, c.dispatch_date, c.d
    from clean c
    join (select distinct phone_key from in_range where phone_key is not null) r
      on r.phone_key = c.phone_key
    where c.dispatch_date <= p_to
  ),
  customers as (
    select
      h.phone_key,
      (array_agg(h.d->>'customer_name' order by h.dispatch_date desc))[1] as name,
      (array_agg(h.d->>'district_code' order by h.dispatch_date desc))[1] as district,
      count(*) as orders,
      count(*) filter (where h.dispatch_date >= p_from) as orders_in_range,
      min(h.dispatch_date) as first_date,
      max(h.dispatch_date) as last_date,
      sum(coalesce((h.d->'amounts'->>'items')::numeric, 0) - coalesce((h.d->'amounts'->>'discount')::numeric, 0)) as spent
    from history h
    group by h.phone_key
  ),
  -- Products dispatched in the 90 days before the range, for "slow movers".
  recent as (
    select i->>'name' as name,
      sum(coalesce((i->>'qty')::numeric, 1)) as units,
      max(s.dispatch_date) as last_date
    from scoped s, jsonb_array_elements(coalesce(s.d->'items', '[]'::jsonb)) i
    where s.dispatch_date between p_from - 90 and p_from - 1
    group by 1
  )
  select jsonb_build_object(
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.order_id,
        'wh', r.warehouse_id,
        'date', r.dispatch_date,
        'placed', r.d->'placed_at',
        'source', r.d->'source',
        'sold_by', r.d->'sold_by',
        'district', r.d->'district_code',
        'phone', r.phone_key,
        'coupons', coalesce(r.d->'coupons', '[]'::jsonb),
        'amounts', coalesce(r.d->'amounts', '{}'::jsonb),
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', i->'name', 'qty', i->'qty', 'price', i->'unit_price', 'total', i->'line_total'))
          from jsonb_array_elements(coalesce(r.d->'items', '[]'::jsonb)) i
        ), '[]'::jsonb)
      ))
      from in_range r
    ), '[]'::jsonb),
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'phone', c.phone_key, 'name', c.name, 'district', c.district,
        'orders', c.orders, 'orders_in_range', c.orders_in_range,
        'first', c.first_date, 'last', c.last_date, 'spent', c.spent))
      from customers c
    ), '[]'::jsonb),
    'recent_products', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'units', x.units, 'last', x.last_date))
      from recent x
    ), '[]'::jsonb)
  );
$$;

-- Signed-in users only. It runs with the caller's own permissions, so it
-- can never return rows the caller couldn't already read.
revoke execute on function public.stats_dataset(date, date, uuid) from public, anon;
grant execute on function public.stats_dataset(date, date, uuid) to authenticated;

notify pgrst, 'reload schema';
