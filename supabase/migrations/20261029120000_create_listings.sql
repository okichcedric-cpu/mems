-- ── Marketplace listings ────────────────────────────────────────────────
-- One listing per (seller, collection). The listing id is the stable public
-- identifier (URLs, orders, access grants later) so renaming or unpublishing
-- a collection never breaks links or purchases.
--
-- Writes happen ONLY through the manage-listing edge function (service role),
-- which verifies ownership of the S3 collection and snapshots the preview
-- keys. Clients can read published listings but never write, and can never
-- read preview_keys directly (column-level grant below) — public previews
-- are handed out as short-lived signed URLs by marketplace-listings.

create table if not exists public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.creator_profiles(user_id) on delete cascade,
  collection_name text not null,
  title text not null,
  description text not null default '',
  price_amount integer not null,
  currency text not null default 'KES',
  -- How many photos are publicly previewable, and which ones (snapshot of
  -- the first N S3 keys at publish time). Never exposed to clients directly.
  preview_count integer not null,
  preview_keys text[] not null default '{}',
  photo_count integer not null,
  status text not null default 'published',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint listings_status_valid check (status in ('published', 'unpublished')),
  constraint listings_currency_valid check (currency in ('KES')),
  constraint listings_price_range check (price_amount between 100 and 500000),
  constraint listings_title_len check (char_length(btrim(title)) between 3 and 80),
  constraint listings_description_len check (char_length(description) <= 600),
  constraint listings_preview_range check (preview_count between 1 and 20),
  constraint listings_photo_count_pos check (photo_count >= 1),
  constraint listings_preview_le_photos check (preview_count <= photo_count),
  unique (seller_id, collection_name)
);

create index if not exists listings_published_idx
  on public.listings (created_at desc) where status = 'published';
create index if not exists listings_seller_idx on public.listings (seller_id);

create or replace function public.listings_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists listings_touch on public.listings;
create trigger listings_touch
  before update on public.listings
  for each row execute function public.listings_touch_updated_at();

alter table public.listings enable row level security;

-- Published listings from ACTIVE creators are public; a seller also sees
-- their own (including unpublished). No insert/update/delete policies:
-- writes are service-role only.
drop policy if exists "listings_select_public" on public.listings;
create policy "listings_select_public" on public.listings
  for select using (
    (status = 'published' and exists (
      select 1 from public.creator_profiles c
      where c.user_id = listings.seller_id and c.status = 'active'))
    or auth.uid() = seller_id
  );

-- Column-level read access: everything except preview_keys.
revoke all on public.listings from anon, authenticated;
grant select (
  id, seller_id, collection_name, title, description, price_amount,
  currency, preview_count, photo_count, status, created_at, updated_at
) on public.listings to anon, authenticated;
