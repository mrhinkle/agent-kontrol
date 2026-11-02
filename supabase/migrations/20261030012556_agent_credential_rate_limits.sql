-- Per-credential request quotas (issue #51). Idempotent. Safe to re-run.
-- This file is a changelog. The same statements are in schema.sql, which is
-- what you apply. You do not need to run this file separately.
--
-- Additive only: six columns on agent_credentials. Existing credentials get
-- the defaults, 60 requests per minute and 10000 requests per UTC day.
-- Limits are 1 to 1000000; there is no unlimited value.
--
-- Stored: the two limits, and for the current minute and the current UTC day
-- the window start and the number of requests counted in it.
-- Not stored: request paths, tool names, prompts, or tool input/output.

alter table agent_credentials add column if not exists rate_limit_per_minute integer not null default 60
  constraint agent_credentials_rate_limit_per_minute_range check (rate_limit_per_minute between 1 and 1000000);
alter table agent_credentials add column if not exists rate_limit_per_day integer not null default 10000
  constraint agent_credentials_rate_limit_per_day_range check (rate_limit_per_day between 1 and 1000000);
alter table agent_credentials add column if not exists rate_minute_start timestamptz;
alter table agent_credentials add column if not exists rate_minute_count integer not null default 0
  constraint agent_credentials_rate_minute_count_nonneg check (rate_minute_count >= 0);
alter table agent_credentials add column if not exists rate_day_start timestamptz;
alter table agent_credentials add column if not exists rate_day_count integer not null default 0
  constraint agent_credentials_rate_day_count_nonneg check (rate_day_count >= 0);
