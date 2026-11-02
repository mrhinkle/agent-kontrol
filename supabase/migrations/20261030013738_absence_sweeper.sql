-- Absence sweeper (#79). Changelog only. The same statements are in schema.sql.
-- Additive: two nullable columns on events, seven new tables, and indexes.
-- No existing table, column, or row changes.

-- Who reported an event, from verified server authentication (never from the
-- request body). kind is legacy | agent | oauth | session. id is mc-token, the
-- credential id, the OAuth client id, or operator. Null on rows written before
-- this column and on dev-open writes: those rows are unmeasured for liveness.
alter table events add column if not exists principal_kind text;
alter table events add column if not exists principal_id text;
create index if not exists events_work_principal_idx
  on events (agent_id, created_at desc)
  where principal_kind is not null and kind in ('session_end', 'milestone', 'status');

-- Explicit consumer registrations. No row is created implicitly.
-- reporters lists the {kind, id} principals whose work events prove liveness.
-- queue maps the work the consumer serves. registered_at is set on insert only.
create table if not exists sweep_consumers (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  agent_ids text[] not null check (cardinality(agent_ids) between 1 and 20),
  reporters jsonb not null check (jsonb_typeof(reporters) = 'array'),
  queue jsonb not null check (jsonb_typeof(queue) = 'object'),
  scheduler_source text,
  scheduler_job text,
  enabled boolean not null default true,
  max_silence_hours numeric not null default 3 check (max_silence_hours > 0 and max_silence_hours <= 168),
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  actor_type text,
  actor_id text
);

-- Append-only audit of every accepted trusted observation and registration.
-- outcome says what the write did to the projection (applied, refreshed,
-- older, replay). principal_* is from authentication.
create table if not exists sweep_observations (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('scheduler_job', 'queue', 'pr_snapshot', 'consumer')),
  source text not null,
  subject text not null,
  seq bigint,
  outcome text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  principal_kind text not null,
  principal_id text not null,
  received_at timestamptz not null
);
create index if not exists sweep_observations_subject_idx on sweep_observations (kind, subject, id desc);

-- Current scheduler job state, one row per source and job. transition is the
-- source's monotonic transition id. A lower transition never replaces a higher
-- one. The same transition only refreshes and only adds or replaces non-null
-- fields. prior_* is the state this transition replaced. resumed is true when
-- this transition was observed going from paused to active; decision is then
-- that resume's own citation.
create table if not exists scheduler_jobs (
  source text not null,
  job_id text not null,
  state text not null check (state in ('active', 'paused')),
  transition bigint not null check (transition >= 1),
  paused_at timestamptz,
  paused_reason text,
  until timestamptz,
  decision text,
  prior_state text,
  prior_transition bigint,
  prior_decision text,
  resumed boolean not null default false,
  observed_at timestamptz,
  stale_after_minutes integer not null default 30 check (stale_after_minutes between 5 and 1440),
  transition_received_at timestamptz not null,
  last_received_at timestamptz not null,
  last_observation_id bigint,
  version bigint not null default 1,
  primary key (source, job_id)
);

-- Queue readiness from a collector, one row per queue. seq orders a source's
-- observations. complete false is unknown, never zero. empty_since is the
-- receipt time of the first observation in an unbroken run of complete,
-- fresh observations with raw work and nothing ready.
create table if not exists sweep_queues (
  queue text primary key,
  source text not null,
  classification text not null check (classification in ('issue_dispatch', 'pr_review')),
  repo text,
  complete boolean not null,
  error text,
  ready_count integer check (ready_count is null or ready_count >= 0),
  raw_count integer check (raw_count is null or raw_count >= 0),
  ready_refs jsonb,
  raw_refs jsonb,
  seq bigint not null,
  observed_at timestamptz,
  stale_after_minutes integer not null default 30 check (stale_after_minutes between 5 and 1440),
  received_at timestamptz not null,
  empty_since timestamptz,
  last_observation_id bigint,
  version bigint not null default 1
);

-- The newest PR snapshot per repository (lowercased owner/name).
create table if not exists sweep_pr_sources (
  repo_key text primary key,
  repo text not null,
  source text not null,
  complete boolean not null,
  error text,
  seq bigint not null,
  observed_at timestamptz,
  stale_after_minutes integer not null default 30 check (stale_after_minutes between 5 and 1440),
  received_at timestamptz not null,
  last_observation_id bigint,
  version bigint not null default 1
);

-- Current-head PR facts from complete snapshots. open false means a later
-- complete snapshot no longer listed it. green_since is the receipt time of
-- the first observation with required checks green at this head and check
-- state; a head or check-state change resets it.
create table if not exists sweep_prs (
  repo_key text not null,
  number integer not null check (number > 0),
  repo text not null,
  title text,
  url text,
  open boolean not null,
  draft boolean,
  opened_at timestamptz,
  mergeable text check (mergeable is null or mergeable in ('mergeable', 'conflicting', 'unknown')),
  head_sha text,
  checks_state text check (checks_state is null or checks_state in ('success', 'pending', 'failure', 'unknown')),
  checks_head_sha text,
  review_started boolean,
  review_head_sha text,
  green_since timestamptz,
  seq bigint not null,
  received_at timestamptz not null,
  version bigint not null default 1,
  primary key (repo_key, number)
);

-- One latch per condition and entity, kept independently of inbox retention.
-- episode counts firings from clear; seq counts emissions within an episode.
create table if not exists sweep_latches (
  condition text not null,
  entity_key text not null,
  active boolean not null default false,
  episode integer not null default 0,
  seq integer not null default 0,
  first_fired_at timestamptz,
  last_emitted_at timestamptz,
  cleared_at timestamptz,
  last_state text,
  last_evaluated_at timestamptz,
  evidence_version bigint,
  updated_at timestamptz not null default now(),
  primary key (condition, entity_key)
);
create index if not exists sweep_latches_active_idx on sweep_latches (condition) where active;
