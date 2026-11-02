-- GitHub webhook inbox (#77). Changelog only. The same statements are in schema.sql.
-- Additive: one new table and two indexes. No existing table or column changes.

-- One row per delivery. delivery_id is X-GitHub-Delivery for a real delivery.
-- Ids that start with 'sweep:' are reserved for synthetic rows written by the
-- sweeper (#79). POST /api/webhooks/github rejects them. event has no enum so
-- synthetic names fit. id is the consumer cursor (#78). processed_at is set by
-- consumers. Deleting rows older than 30 days belongs to the sweeper (#79).
create table if not exists gh_events (
  id bigserial primary key,
  delivery_id text not null unique check (char_length(delivery_id) between 1 and 200),
  event text not null check (char_length(event) between 1 and 64),
  action text,
  repo text,
  number bigint,
  head_sha text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists gh_events_received_at_idx on gh_events (received_at);
create index if not exists gh_events_pending_idx on gh_events (id) where processed_at is null;
