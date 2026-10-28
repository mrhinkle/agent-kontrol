-- Threshold-alert dedupe. Changelog only. The same statements are in schema.sql.
-- Applying this file twice is a no-op: the table and the nullable column
-- both use IF NOT EXISTS. No existing table is rewritten.

create table if not exists brief_alerts (
  key text primary key,
  first_sent_at timestamptz not null,
  last_sent_at timestamptz not null,
  cleared_at timestamptz
);

alter table brief_alerts add column if not exists cleared_at timestamptz;
