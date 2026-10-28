-- Changelog only. supabase/schema.sql is what deploys apply.
-- Additive labels for mrhinkle/agent-kontrol#84. category is the SKILL.md
-- frontmatter string, or null when the file does not declare one. tags is a
-- JSON array of the declared strings, default []. Existing rows keep working:
-- category stays null and tags becomes []. The taxonomy is not a check constraint.

alter table skills add column if not exists category text;
alter table skills add column if not exists tags jsonb not null default '[]'::jsonb;
