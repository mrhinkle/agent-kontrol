-- Decisions queue: the things only the owner can unblock, in one place.
--
-- Today these live in GitHub labels (owner-gate-*), PR comments that end with an
-- "Ask", coordinator status files and alert messages. None of those is a queue:
-- nothing ages them, nothing records the answer, and the same question gets
-- re-asked. This table is the queue. Rows are upserted by `key`, so a collector
-- that re-sees the same GitHub label does not pile up duplicates; it bumps
-- last_seen_at. An agent asking through MCP (request_decision) mints its own
-- key. Resolving a row records who decided, what, and when — and the resolver
-- is expected to write the answer back to the source (a GitHub comment, a
-- Cortex fact) so the agents that asked can see it.

create table if not exists decisions (
  id bigint generated always as identity primary key,
  key text not null unique,                 -- "github:The-AIE/conference-os#233" | "agent:<id>:<slug>"
  source text not null,                     -- github-label | agent | coordinator | dashboard
  repo text,                                -- owner/name when it came from GitHub
  number int,                               -- issue or PR number
  url text,
  title text not null,
  why text,                                 -- what is waiting on this, and what waiting costs
  options jsonb,                            -- [{"id":"a","label":"...","consequence":"..."}]
  recommended text,                         -- option id the requester recommends, if any
  requested_by text,                        -- agent id or "collector"
  status text not null default 'open',      -- open | decided | deferred | withdrawn
  decision text,                            -- the owner's answer, verbatim
  decided_by text,
  decided_at timestamptz,
  defer_until timestamptz,                  -- deferred rows reappear after this
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists decisions_status_first_seen_idx on decisions (status, first_seen_at);
create index if not exists decisions_repo_number_idx on decisions (repo, number);
