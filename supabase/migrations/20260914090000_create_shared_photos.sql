-- Individual photo shares — lets an owner share ONE photo (rather than
-- the whole collection it lives in) with someone by email. The recipient
-- gets that single photo plus the collection's name (for context — "from
-- Ced's Family Trip 2024"), but no access to browse the rest of the
-- collection: authorization everywhere this table is checked
-- (generate-read-url, get-shared-photos) is scoped to the exact
-- `photo_key`, never the collection prefix.
--
-- Deliberately its own table rather than folded into `shared_collections`
-- — the two are checked independently (a photo can be individually
-- shared without the whole collection being shared, and vice versa), and
-- keeping them separate means neither function's authorization logic has
-- to branch on "is this a whole-collection row or a single-photo row".
--
-- Mirrors `shared_collections`' shape (owner_id/owner_email/
-- recipient_email/recipient_id, the same "backfill recipient_id from the
-- verified JWT on first lookup" pattern used in get-shared-collections)
-- plus `collection_name` so the recipient's home screen card and the
-- single-photo detail view can both show the album name without a second
-- lookup. `photo_key` is the photo's full S3 object key, same identity
-- convention photo_captions already uses for photos (they have no
-- database row of their own otherwise).
--
-- IMPORTANT: a collection rename copies every object to a new S3 key
-- prefix (see supabase/functions/rename-collection/index.ts) — that
-- function also rewrites `collection_name` and the `photo_key` prefix on
-- any matching rows here, same as it already does for shared_collections
-- and photo_captions.
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
