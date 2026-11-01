-- ── Marketplace creators ────────────────────────────────────────────────
-- A "marketplace account" is a user with a row here. The profile is PUBLIC
-- (anyone, signed in or not, can read active creators — that's the point of
-- a storefront), so it holds only what a creator chooses to show: a handle,
-- display name and bio. No email, no payout details (those will live in a
-- separate private table when payouts are built).

create table if not exists public.creator_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Used in the public URL (/creator/<handle>). Lowercase letters, digits,
  -- "_" and "-", 3-30 chars, must start with a letter or digit.
  handle text not null,
  display_name text not null,
  bio text not null,
  -- 'suspended' is set by an admin (SQL / dashboard) to hide a creator and
  -- block them from editing — there is no policy letting a user change it.
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint creator_status_valid check (status in ('active', 'suspended')),
  constraint creator_handle_format check (handle ~ '^[a-z0-9][a-z0-9_-]{2,29}$'),
  constraint creator_handle_not_reserved check (handle not in (
    'admin', 'administrator', 'mems', 'marketplace', 'support', 'help',
    'contact', 'official', 'staff', 'moderator', 'api', 'www', 'app',
    'login', 'signup', 'settings', 'root', 'system', 'null', 'undefined'
  )),
  constraint creator_display_name_len
    check (char_length(btrim(display_name)) between 2 and 60),
  constraint creator_bio_len
    check (char_length(btrim(bio)) between 20 and 600)
);

-- Handles are already forced to lowercase by the format check, so a plain
-- unique index is a case-insensitive uniqueness guarantee.
create unique index if not exists creator_profiles_handle_key
  on public.creator_profiles (handle);

create or replace function public.creator_profiles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists creator_profiles_touch on public.creator_profiles;
create trigger creator_profiles_touch
  before update on public.creator_profiles
  for each row execute function public.creator_profiles_touch_updated_at();

alter table public.creator_profiles enable row level security;

-- Anyone may read active creators (the storefront is public); a creator can
-- always read their own row, even if suspended.
drop policy if exists "creator_profiles_select_public" on public.creator_profiles;
create policy "creator_profiles_select_public" on public.creator_profiles
  for select using (status = 'active' or auth.uid() = user_id);

-- A user can create only their own profile, and only as 'active'.
drop policy if exists "creator_profiles_insert_own" on public.creator_profiles;
create policy "creator_profiles_insert_own" on public.creator_profiles
  for insert with check (auth.uid() = user_id and status = 'active');

-- A user can edit only their own profile while it is active. Because both
-- sides require status = 'active', nobody can suspend or un-suspend
-- themselves; that is an admin action done with the service role.
drop policy if exists "creator_profiles_update_own" on public.creator_profiles;
create policy "creator_profiles_update_own" on public.creator_profiles
  for update using (auth.uid() = user_id and status = 'active')
  with check (auth.uid() = user_id and status = 'active');

-- No delete policy: profiles go away when the account is deleted (cascade).
