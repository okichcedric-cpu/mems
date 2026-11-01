-- Second line of defence for the "create your first collection" email.
-- The edge function checks S3 for each candidate, but the email must never go
-- to someone who already has a collection even if that S3 check misbehaves.
-- So the candidate list itself now also excludes anyone who is demonstrably an
-- owner according to the database: they have a collections row, have shared a
-- collection or photo, or have written a caption.
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
    and not exists (select 1 from public.collections c where c.owner_id = u.id)
    and not exists (select 1 from public.shared_collections s where s.owner_id = u.id)
    and not exists (select 1 from public.shared_photos p where p.owner_id = u.id)
    and not exists (select 1 from public.photo_captions pc where pc.owner_id = u.id)
  order by u.created_at, u.id
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
$$;

revoke all on function public.get_nudge_email_candidates(integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_nudge_email_candidates(integer, integer)
  to service_role;
