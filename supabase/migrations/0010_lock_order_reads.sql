-- Only super admins and staff with a warehouse can read orders and pick
-- ticks. An account nobody assigned (e.g. a self sign-up) sees nothing.

begin;

drop policy if exists "orders_select_all_authenticated" on public.orders;
create policy "orders_select_assigned_users"
  on public.orders for select
  to authenticated
  using (
    coalesce(public.current_user_role(), '') = 'super_admin'
    or public.current_user_warehouse() is not null
  );

drop policy if exists "pick_marks_select_all_authenticated" on public.pick_marks;
create policy "pick_marks_select_assigned_users"
  on public.pick_marks for select
  to authenticated
  using (
    coalesce(public.current_user_role(), '') = 'super_admin'
    or public.current_user_warehouse() is not null
  );

commit;
