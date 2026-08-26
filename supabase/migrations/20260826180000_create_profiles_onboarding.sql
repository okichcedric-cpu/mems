-- Minimal per-account profile row, first used to move the first-time
-- onboarding walkthrough's "have they seen it" flag off device-local
-- AsyncStorage and onto the account itself. Previously that flag lived
-- only on-device, so clearing the browser cache, switching browsers, or
-- signing in on a new device made a returning user sit through the
-- onboarding tour again even though nothing about their account had
-- changed. See src/utils/onboarding.ts for the client-side read/write.
--
-- This repo has no other tracked migrations / no `supabase/migrations`
-- history to match a prior convention against — this file establishes
-- one. Apply it via the Supabase SQL editor (or `supabase db push` if
-- you have the CLI linked to this project) before deploying the client
-- change that depends on it.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  onboarding_seen boolean not null default false,
  onboarding_seen_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Each user can only ever read or write their own row — same shape as
-- the RLS already in place on the `collections` table.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
