-- Records when the one-off "create your first collection" EMAIL went to a
-- user (sent alongside the first push nudge). Null = not sent yet. Kept
-- separate from nudge_count so an email failure never blocks the push
-- schedule, and the email can be retried on the next daily run.
alter table public.collection_nudges
  add column if not exists email_sent_at timestamptz;
