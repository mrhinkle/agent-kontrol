-- Two-way messaging: additive columns so agent replies can be stored and shown.
-- Idempotent. Safe to re-run. Does not drop or rewrite existing rows.
-- Run against the production database by the operator.

alter table messages
  add column if not exists direction text not null default 'inbound';
  -- inbound  = operator → agent (dashboard enqueue / check_inbox)
  -- outbound = agent → operator (reply_to_operator / POST /api/messages/reply)

alter table messages
  add column if not exists in_reply_to bigint;

alter table messages
  add column if not exists thread_id text;

alter table messages
  add column if not exists read_by_dashboard_at timestamptz;

-- Backfill thread_id for legacy rows (one thread per message until replied).
update messages
set thread_id = id::text
where thread_id is null;

-- Pending agent inbox (inbound, not yet acked).
create index if not exists messages_pending_inbound_idx
  on messages (agent_id, acked_at, created_at)
  where direction = 'inbound';

-- The operator's unread replies.
create index if not exists messages_unread_dashboard_idx
  on messages (agent_id, created_at)
  where direction = 'outbound' and read_by_dashboard_at is null;

create index if not exists messages_thread_idx
  on messages (agent_id, thread_id, created_at);
