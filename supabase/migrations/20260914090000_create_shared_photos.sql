create table if not exists public.shared_photos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  owner_email text not null,
  collection_name text not null,
  photo_key text not null,
  recipient_email text not null,
  recipient_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (owner_id, photo_key, recipient_email)
);

create index if not exists shared_photos_recipient_email_idx
  on public.shared_photos (recipient_email);

create index if not exists shared_photos_recipient_id_idx
  on public.shared_photos (recipient_id);

create index if not exists shared_photos_owner_photo_idx
  on public.shared_photos (owner_id, photo_key);

alter table public.shared_photos enable row level security;

-- Owner-only via RLS, same shape as photo_captions — the recipient-facing
-- read path (get-shared-photos) and the recipient_id backfill / rename
-- cascade both go through the service-role key instead, same as
-- shared_collections already does, so they're unaffected by these
-- policies applying only to the owner's own auth.uid().
drop policy if exists "shared_photos_select_own" on public.shared_photos;
create policy "shared_photos_select_own" on public.shared_photos
  for select using (auth.uid() = owner_id);

drop policy if exists "shared_photos_insert_own" on public.shared_photos;
create policy "shared_photos_insert_own" on public.shared_photos
  for insert with check (auth.uid() = owner_id);

drop policy if exists "shared_photos_delete_own" on public.shared_photos;
create policy "shared_photos_delete_own" on public.shared_photos
  for delete using (auth.uid() = owner_id);
