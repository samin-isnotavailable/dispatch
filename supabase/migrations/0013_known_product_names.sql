-- Every product name ever saved on an order, as Zagle spells it.
-- Run in the Supabase SQL editor after 0001-0012. Changes no data.
--
-- A screenshot read on the dashboard can lose a space or confuse O and 0
-- ("X1V2" for "X1 V2"). The paste window compares what it read with these
-- names and uses the real one when they're the same apart from that.
-- Runs with the caller's permissions, so only assigned accounts get names.

create or replace function public.known_product_names()
returns setof text
language sql
stable
security invoker
set search_path = public
as $$
  select distinct i->>'name'
  from public.orders o, jsonb_array_elements(o.details->'items') i
  where o.details is not null and coalesce(i->>'name', '') <> '';
$$;

revoke execute on function public.known_product_names() from public, anon;
grant execute on function public.known_product_names() to authenticated;

notify pgrst, 'reload schema';
