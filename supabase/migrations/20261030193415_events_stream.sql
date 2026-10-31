-- Consumer-scoped outbound event streams (#78). Inert until explicitly registered.
create table if not exists event_stream_consumers (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  credential_id text not null unique references agent_credentials(id) on delete cascade,
  repos text[] not null check (cardinality(repos) between 1 and 50),
  event_types text[] not null check (cardinality(event_types) between 1 and 32),
  enabled boolean not null default true,
  generation bigint not null default 0 check (generation >= 0),
  updated_at timestamptz not null default now()
);
-- Server database owner performs access through the authenticated route.
-- No public/Data API policy grants access to registrations or bindings.
alter table event_stream_consumers enable row level security;
create index if not exists gh_events_repo_cursor_idx on gh_events (repo, id);
