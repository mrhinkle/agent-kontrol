-- pr_review ready queue (#176). Changelog only. The same statement is in schema.sql.
-- Additive: one nullable column on sweep_queues. No existing row changes.
-- ready_items is [{number, head_sha}] for the ready PRs of a pr_review queue, in
-- numeric order, one per ready ref. issue_dispatch rows leave it null. A
-- pr_review row written before this column existed is read back by
-- GET /api/sweep/queues as complete false with error "missing ready_items"
-- until a refreshed observation arrives. sweep_observations keeps the whole
-- payload as jsonb, so the audit row needs no new column. Rollback leaves the
-- column in place; a reverted producer never writes it.
alter table sweep_queues add column if not exists ready_items jsonb;
