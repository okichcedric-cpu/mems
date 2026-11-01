-- ── Content reports & takedowns ─────────────────────────────────────────
-- Anyone (signed in or not) can report a marketplace listing, or one of its
-- preview photos, through the report-content edge function. Reports are
-- stored here and emailed to contact@mems-app.com for review.
--
-- Table is service-role only: no policies, no client grants, so reporters
-- can't read each other's reports and sellers can't see who reported them.

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.listings(id) on delete set null,
  -- Snapshot, so the report still identifies what was reported if the
  -- listing is later removed.
  listing_title text not null,
  seller_id uuid,
  -- Which public preview photo (0-based), or null for the listing as a whole.
  photo_index integer,
  reason text not null,
  details text not null default '',
  reporter_id uuid references auth.users(id) on delete set null,
  reporter_email text,
  -- Salted hash of the reporter's IP, used only for rate limiting.
  reporter_key text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,

  constraint reports_reason_valid check (reason in (
    'child_safety', 'sexual_content', 'violence_hate', 'copyright',
    'privacy', 'scam_misleading', 'other'
  )),
  constraint reports_status_valid check (status in ('open', 'actioned', 'dismissed')),
  constraint reports_details_len check (char_length(details) <= 1000)
);

create index if not exists reports_listing_idx on public.reports (listing_id);
create index if not exists reports_reporter_key_idx on public.reports (reporter_key, created_at desc);
create index if not exists reports_open_idx on public.reports (created_at desc) where status = 'open';

alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

-- Takedown: a listing an admin (or the child-safety auto-hide) has removed.
-- Public queries only return status = 'published', and manage-listing
-- refuses to let the seller republish a 'removed' listing.
alter table public.listings drop constraint if exists listings_status_valid;
alter table public.listings
  add constraint listings_status_valid
  check (status in ('published', 'unpublished', 'removed'));
