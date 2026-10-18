-- ── Push notification tokens + "create your first collection" nudges ──────
-- push_tokens: one row per device token (Expo push token), owned by whoever
-- is currently signed in on that device. Only the native Android app ever
-- registers one, which is what limits nudges to mobile-app users.
--
-- collection_nudges: how many nudges a user has been sent (0, 1, 2). 2 also
-- means "done" — set early if the user turns out to already have a
-- collection, so the sender never re-checks them.

create table if not exists public.push_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'android',
  -- When THIS user first registered THIS token. The nudge schedule
  -- (day 2 / day 7) counts from here, which is what lets the same rule
  -- apply to brand-new signups and long-standing users alike (existing
  -- users start their clock the day they update the app and allow
  -- notifications).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_id_idx
  on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

-- Users may read/delete only their own tokens. Writes go through the
-- SECURITY DEFINER functions below (a token can move between accounts on a
-- shared device, which plain RLS can't express).
drop policy if exists "push_tokens_select_own" on public.push_tokens;
create policy "push_tokens_select_own" on public.push_tokens
  for select using (auth.uid() = user_id);

drop policy if exists "push_tokens_delete_own" on public.push_tokens;
create policy "push_tokens_delete_own" on public.push_tokens
  for delete using (auth.uid() = user_id);

create table if not exists public.collection_nudges (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nudge_count integer not null default 0,
  last_nudged_at timestamptz
);

-- No policies: RLS on with none = only the service role (the edge function)
-- can touch it.
alter table public.collection_nudges enable row level security;

-- Registers (or re-assigns) a device token to the calling user. If the same
-- device was last used by a different account, ownership moves and the
-- nudge clock restarts for the new owner.
create or replace function public.register_push_token(p_token text, p_platform text default 'android')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.push_tokens (token, user_id, platform)
  values (p_token, auth.uid(), coalesce(p_platform, 'android'))
  on conflict (token) do update set
    user_id = excluded.user_id,
    platform = excluded.platform,
    updated_at = now(),
    created_at = case
      when public.push_tokens.user_id = excluded.user_id
        then public.push_tokens.created_at
      else now()
    end;
end;
$$;

-- Removes the calling user's registration of a token (used on sign-out so a
-- signed-out device stops receiving that account's notifications).
create or replace function public.unregister_push_token(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.push_tokens
  where token = p_token and user_id = auth.uid();
$$;

revoke all on function public.register_push_token(text, text) from public, anon;
revoke all on function public.unregister_push_token(text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;
grant execute on function public.unregister_push_token(text) to authenticated;
