-- Changelog only. supabase/schema.sql is what deploys apply.
-- Nullable columns so the decisions table can rebuild the morning brief's
-- .decisions list without calling GitHub again. Existing rows keep working:
-- every new column is nullable and nothing here rewrites a row.

alter table decisions add column if not exists kind text;
alter table decisions add column if not exists labels jsonb;
alter table decisions add column if not exists opened_at timestamptz;
alter table decisions add column if not exists repo_short text;
alter table decisions add column if not exists github_present boolean;
