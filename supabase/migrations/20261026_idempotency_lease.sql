-- Lease on idempotency claims. Additive. schema.sql is the canonical copy.
-- started_at begins a 30 second lease while response is null. claim_token
-- is the attempt that owns the lease. A null response older than the lease
-- can be taken over by a retry with the same arguments. A stored response,
-- including the unknown-outcome marker, is left in place.

alter table idempotency_keys add column if not exists started_at timestamptz;
alter table idempotency_keys add column if not exists claim_token text;
