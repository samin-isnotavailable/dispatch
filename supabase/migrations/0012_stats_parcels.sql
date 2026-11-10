-- Statistics: parcels per warehouse, and orders missing details.
-- Run in the Supabase SQL editor after 0001-0011. Changes no data.
--
-- Same stats_dataset as 0007, plus:
--   parcels — every order dispatched in the range, per warehouse, including
--             ones typed in by hand without details (cancelled / moved rows
--             left out, an order ID counted once per warehouse).
--   missing — those without details, so the Statistics tab can warn that
--             revenue / product / customer numbers don't include them.

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
  -- Every order in the range, with or without details.
  all_in_range as (
    select o.order_id, o.warehouse_id, o.dispatch_date, o.details
    from public.orders o
    where o.dispatch_date between p_from and p_to
      and (p_warehouse is null or o.warehouse_id = p_warehouse)
      and o.exception_type is distinct from 'cancelled'
      and o.exception_type is distinct from 'rescheduled'
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
        'area', r.d->'area',
        'name', r.d->'customer_name',
        'address', r.d->'address',
        'status', r.d->'status',
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
    ), '[]'::jsonb),
    'parcels', coalesce((
      select jsonb_agg(jsonb_build_object('wh', p.warehouse_id, 'parcels', p.parcels, 'missing', p.missing))
      from (
        select a.warehouse_id, count(distinct a.order_id) as parcels,
               count(distinct a.order_id) filter (where a.details is null) as missing
        from all_in_range a
        group by a.warehouse_id
      ) p
    ), '[]'::jsonb),
    'missing', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.order_id, 'wh', m.warehouse_id, 'date', m.dispatch_date) order by m.dispatch_date desc)
      from (select distinct order_id, warehouse_id, dispatch_date from all_in_range where details is null limit 100) m
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.stats_dataset(date, date, uuid) from public, anon;
grant execute on function public.stats_dataset(date, date, uuid) to authenticated;

notify pgrst, 'reload schema';
