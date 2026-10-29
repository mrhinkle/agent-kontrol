-- Decision write-back lock (#65 review). Nullable. Two writers of the same
-- row claim writeback_lock before listing and creating the GitHub comment.
-- writeback_lock_at expires the claim so a crash after the comment lands
-- can still remove labels. Apply supabase/schema.sql on deploy; this file
-- is the changelog copy.

alter table decisions add column if not exists writeback_lock text;
alter table decisions add column if not exists writeback_lock_at timestamptz;
