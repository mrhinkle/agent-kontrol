-- Decisions resolve (#65). Nullable. A database that already has `decisions`
-- gains the actor, the chosen option, and the GitHub write-back stamp.
-- Apply supabase/schema.sql on deploy; this file is the changelog copy.

alter table decisions add column if not exists actor_type text;
alter table decisions add column if not exists actor_id text;
alter table decisions add column if not exists chosen_option text;
alter table decisions add column if not exists writeback text;
