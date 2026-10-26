-- Record the authenticated actor on message and task creation.
-- Changelog only. The same statements are in schema.sql.
-- Existing rows stay null. created_by is unchanged and is not the actor.

alter table messages add column if not exists actor_type text;
alter table messages add column if not exists actor_id text;
alter table tasks add column if not exists actor_type text;
alter table tasks add column if not exists actor_id text;
