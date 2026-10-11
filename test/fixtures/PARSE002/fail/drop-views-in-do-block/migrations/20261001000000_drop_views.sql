do $$
begin
  drop materialized view if exists public.order_totals;
  drop view if exists public.recent_orders;
end
$$;
