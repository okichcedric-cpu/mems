-- In-app reports of harmful/inappropriate content and general feedback from
-- the mobile app. Service-role only (written by the report-app-content function).
create table public.app_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reporter_email text,
  context text not null check (context in ('collection', 'photo', 'general')),
  owner_id uuid,
  collection_name text,
  reason text not null,
  details text not null default '',
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index app_reports_status_idx on public.app_reports (status, created_at desc);
create index app_reports_reporter_idx on public.app_reports (reporter_id, created_at desc);
alter table public.app_reports enable row level security;
-- No policies: only the service role can read or write.
