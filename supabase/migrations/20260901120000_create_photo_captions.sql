-- Per-photo captions, shown on the "back" of a photo in the single-photo
-- viewer (a flip animation reveals this card). Photos themselves have no
-- database row today — they're plain S3 objects, identified only by their
-- S3 key (see src/app/collection/[id].tsx's `Photo` type) — so this table
-- is the first place a photo gets any persistent state of its own.
--
-- Keyed by the FULL S3 object key rather than a synthetic id, matching
-- how the rest of the app already treats S3 keys as the stable identity
-- for a photo. IMPORTANT: a collection rename copies every object to a
-- new S3 key prefix (see supabase/functions/rename-collection/index.ts),
-- so that function must also rewrite the `photo_key` prefix on any
-- matching rows here — see the update in that file.
--
-- RLS is owner-only for both read and write, same shape as `collections`
-- and `profiles`. Shared-collection viewers can still read captions, but
-- (matching how shared photo listings already work) that happens through
-- the `list-photos` edge function using the service-role key — NOT
-- through RLS, since a viewer's auth.uid() is never the owner_id here.
create table if not exists public.photo_captions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  photo_key text not null,
  caption text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, photo_key)
);

alter table public.photo_captions enable row level security;

drop policy if exists "photo_captions_select_own" on public.photo_captions;
create policy "photo_captions_select_own" on public.photo_captions
  for select using (auth.uid() = owner_id);

drop policy if exists "photo_captions_insert_own" on public.photo_captions;
create policy "photo_captions_insert_own" on public.photo_captions
  for insert with check (auth.uid() = owner_id);

drop policy if exists "photo_captions_update_own" on public.photo_captions;
create policy "photo_captions_update_own" on public.photo_captions
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "photo_captions_delete_own" on public.photo_captions;
create policy "photo_captions_delete_own" on public.photo_captions
  for delete using (auth.uid() = owner_id);
