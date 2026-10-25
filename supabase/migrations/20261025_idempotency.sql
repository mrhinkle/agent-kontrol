-- Idempotency keys for create_task, operator messages, and replies.
-- Changelog only. The same statement is in schema.sql.
-- scope is actor_type:actor_id:route. response is null while the write
-- is in progress. A key is unused after expires_at.

create table if not exists idempotency_keys (
  scope text not null,
  idempotency_key text not null,
  request_hash text not null,
  response jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (scope, idempotency_key)
);
