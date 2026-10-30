-- Threshold-alert dedupe. Changelog only. The same statements are in schema.sql.
-- Applying this file twice is a no-op: the table and the nullable columns
-- use IF NOT EXISTS. No existing table is rewritten.
-- claim_token is the attempt that owns a claim. restore matches it, plus
-- the cleared_at the claim left behind, so a concurrent clear is kept.

create table if not exists brief_alerts (
  key text primary key,
  first_sent_at timestamptz not null,
  last_sent_at timestamptz not null,
  cleared_at timestamptz,
  claim_token text
);

alter table brief_alerts add column if not exists cleared_at timestamptz;
alter table brief_alerts add column if not exists claim_token text;
