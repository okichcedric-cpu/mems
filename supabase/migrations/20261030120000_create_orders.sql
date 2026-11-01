-- ── Marketplace orders ──────────────────────────────────────────────────
-- One row per purchase attempt. A buyer's access to a collection is "a paid
-- order exists for them" — nothing else grants it.
--
-- Orders keep their OWN snapshot of what was bought (seller, collection,
-- title, price) instead of depending on the listing row, so the buyer keeps
-- access and a receipt even if the listing is later edited, unpublished or
-- removed. listing_id is informational (set null if the listing disappears).
--
-- All writes are service-role only (edge functions). Prices always come from
-- the listings table on the server, never from the client.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings(id) on delete set null,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  -- Seller/collection snapshot (the S3 prefix the buyer gets access to).
  seller_id uuid not null,
  collection_name text not null,
  title text not null,

  amount integer not null,
  currency text not null default 'KES',
  -- Revenue split, fixed when the payment is confirmed.
  fee_percent numeric(5,2) not null default 0,
  fee_amount integer not null default 0,
  seller_amount integer not null default 0,

  status text not null default 'pending',
  merchant_reference text not null,
  pesapal_tracking_id text,

  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  -- Set once the receipt / sale-notification emails have been sent, so a
  -- repeated webhook never sends them twice.
  emails_sent_at timestamptz,

  constraint orders_status_valid check (status in ('pending', 'paid', 'failed', 'refunded')),
  constraint orders_amount_pos check (amount > 0),
  constraint orders_split_valid check (fee_amount >= 0 and seller_amount >= 0)
);

create unique index if not exists orders_merchant_reference_key
  on public.orders (merchant_reference);
-- A tracking id belongs to at most one order.
create unique index if not exists orders_tracking_id_key
  on public.orders (pesapal_tracking_id) where pesapal_tracking_id is not null;
-- A buyer can hold only one PAID order per seller collection.
create unique index if not exists orders_one_paid_per_buyer_collection
  on public.orders (buyer_id, seller_id, collection_name) where status = 'paid';
create index if not exists orders_buyer_idx on public.orders (buyer_id, created_at desc);
create index if not exists orders_seller_idx on public.orders (seller_id, created_at desc);
create index if not exists orders_collection_paid_idx
  on public.orders (seller_id, collection_name) where status = 'paid';

alter table public.orders enable row level security;

-- Buyers see their own orders; sellers see orders for their collections.
drop policy if exists "orders_select_buyer" on public.orders;
create policy "orders_select_buyer" on public.orders
  for select using (auth.uid() = buyer_id);

drop policy if exists "orders_select_seller" on public.orders;
create policy "orders_select_seller" on public.orders
  for select using (auth.uid() = seller_id);

-- Nobody can write from the client. Hide the Pesapal tracking id too.
revoke all on public.orders from anon, authenticated;
grant select (
  id, listing_id, buyer_id, seller_id, collection_name, title, amount, currency,
  fee_percent, fee_amount, seller_amount, status, merchant_reference,
  created_at, paid_at, refunded_at
) on public.orders to authenticated;

-- ── Seller earnings (read-only view for the future dashboard) ───────────
-- Paid minus refunded; payouts will be subtracted once the payout ledger
-- exists. security_invoker so RLS on orders applies (a seller sees only
-- their own totals).
create or replace view public.seller_earnings
with (security_invoker = true) as
  select
    seller_id,
    count(*) filter (where status = 'paid') as sales_count,
    coalesce(sum(seller_amount) filter (where status = 'paid'), 0) as earned
  from public.orders
  group by seller_id;

grant select on public.seller_earnings to authenticated;
