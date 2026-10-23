-- The "create your first collection" EMAIL now goes to every account that
-- still has no collection 2 calendar days (Nairobi time) after signup — not
-- just people with a registered push token. State lives on collection_nudges
-- (one row per user, service-role only):
--   email_sent_at     the email went out (never sent twice)
--   email_skipped_at  they already have a collection, so no email is needed
--   unsubscribed_at   they clicked the unsubscribe link (never email again)
alter table public.collection_nudges
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_skipped_at timestamptz,
  add column if not exists unsubscribed_at timestamptz;

-- Accounts due for the email, oldest first. Lives in SQL because it needs
-- auth.users, which the edge function can't query through the REST API.
-- Callable only by the service role (the edge function) — never by app users.
create or replace function public.get_nudge_email_candidates(
  p_limit integer,
  p_offset integer default 0
)
returns table (user_id uuid, email text)
language sql
security definer
set search_path = public, auth
as $$
  select u.id, u.email::text
  from auth.users u
  left join public.collection_nudges n on n.user_id = u.id
  where u.email is not null
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until < now())
    and coalesce(u.is_anonymous, false) = false
    -- 2nd calendar day after signup, in Nairobi time
    and (u.created_at at time zone 'Africa/Nairobi')::date
        <= (now() at time zone 'Africa/Nairobi')::date - 2
    and n.email_sent_at is null
    and n.email_skipped_at is null
    and n.unsubscribed_at is null
  order by u.created_at, u.id
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.get_nudge_email_candidates(integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_nudge_email_candidates(integer, integer)
  to service_role;
