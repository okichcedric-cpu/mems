-- Collections currently have no database row at all — a "collection" is
-- purely an S3 folder prefix (${owner_id}/${name}/...), discovered by
-- listing common prefixes. That works fine for storage, but there's
-- nowhere to hang collection-level metadata like an optional "memory
-- date" (when the photos in it actually happened, as opposed to when
-- they were uploaded).
--
-- This table is intentionally minimal: it exists to carry metadata
-- ABOUT a collection, not the collection's photos themselves (those stay
-- in S3, untouched). A collection can exist with or without a row here —
-- absence of a row simply means "no memory date set yet".
create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  memory_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

create index if not exists collections_owner_id_idx
  on public.collections (owner_id);

-- Keep updated_at accurate on every edit (e.g. renaming, changing the date).
create or replace function public.collections_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists collections_set_updated_at on public.collections;
create trigger collections_set_updated_at
  before update on public.collections
  for each row execute function public.collections_set_updated_at();

alter table public.collections enable row level security;

-- Owners have full control over their own collections' metadata.
drop policy if exists "Owners can view their own collections" on public.collections;
create policy "Owners can view their own collections"
  on public.collections for select
  using (auth.uid() = owner_id);

drop policy if exists "Owners can insert their own collections" on public.collections;
create policy "Owners can insert their own collections"
  on public.collections for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can update their own collections" on public.collections;
create policy "Owners can update their own collections"
  on public.collections for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Owners can delete their own collections" on public.collections;
create policy "Owners can delete their own collections"
  on public.collections for delete
  using (auth.uid() = owner_id);

-- People a collection has been shared with can also see its memory date
-- (read-only) — it's their memory too, and it's what makes opening a
-- shared collection feel the same as opening your own.
drop policy if exists "Recipients can view shared collections' metadata" on public.collections;
create policy "Recipients can view shared collections' metadata"
  on public.collections for select
  using (
    exists (
      select 1
      from public.shared_collections sc
      where sc.owner_id = collections.owner_id
        and sc.collection_name = collections.name
        and (
          sc.recipient_id = auth.uid()
          or sc.recipient_email = auth.email()
        )
    )
  );
