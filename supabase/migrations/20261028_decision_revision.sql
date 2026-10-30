-- Decision revision (#65 review round 4). Integer optimistic-concurrency
-- token. updated_at is not compared for equality. Apply supabase/schema.sql
-- on deploy; this file is the changelog copy.

alter table decisions add column if not exists revision integer not null default 0;
