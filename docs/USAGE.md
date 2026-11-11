# Usage and Costs

Page: `/usage`. Read API: `GET /api/usage?window=24h|7d|30d`. Write API: `POST /api/usage/ingest` with the existing collector bearer token.

The page separates three accounting views. Never add them into a single spend total:

- **Hermes attribution:** existing session/profile/cron/model totals, from `hermes_state` only, in a rolling window. Provider invoices may cover the same activity.
- **Provider billing:** OpenRouter inference charges and direct Claude API cost reports, over the corresponding last 1, 7 or 30 completed UTC days. OpenRouter balance is the latest collected balance, not a historical balance. Anthropic cost is after discounts, before credits; separate Priority Tier commitment fees are outside this API.
- **Claude subscription/local usage:** recorded subscription payments by payment date, plus local Claude Code request and token observations. Local token value is an estimate only when explicitly present in the source; an absent estimate or fee is unknown. Local usage cannot establish extra-usage charges and does not cover claude.ai or unscanned devices.

No assumed subscription price, new price table or schema migration is required. Existing tables are `usage_facts` and `account_snapshots`; model-price estimates for Hermes are unchanged.

## Provider collector

Run from the repository with its installed dependencies:

```bash
# Read provider reports; emit a metadata summary; do not publish or create a file.
npx tsx scripts/collect-provider-usage.ts --provider all --env-file /path/to/collector.env

# Save a private local payload (exclusive creation; never overwrites an existing file).
npx tsx scripts/collect-provider-usage.ts --provider openrouter --days 7 \
  --env-file /path/to/collector.env --output /path/to/new-provider-report.json

# Explicit publication to the configured Fleet origin.
npx tsx scripts/collect-provider-usage.ts --provider all --env-file /path/to/collector.env --publish
```

Required configuration names (values remain private): `MC_URL`, `MC_TOKEN`, `MC_OPENROUTER_MANAGEMENT_KEY`, `MC_ANTHROPIC_ADMIN_KEY`. The two provider keys need management and Console admin access respectively; ordinary inference keys are not accepted. `OPENROUTER_MANAGEMENT_KEY` and `ANTHROPIC_ADMIN_KEY` are aliases. Process configuration takes precedence over a literal `KEY=value` file; no shell expansion or sourcing occurs. Supply one provider to collect independently if the other is not configured.

Default period: last 30 completed UTC days. `--since` and `--until` may set explicit UTC-midnight inclusive/exclusive boundaries, at most 30 days; OpenRouter cannot retrieve older activity through this endpoint. No credential is sent to a provider-selected URL. Requests reject redirects and are bounded by timeout, response size and pagination. HTTPS origin-only Fleet URLs are required; `--allow-loopback` explicitly enables local HTTP for testing.

All selected reports must be collected and validated before publishing begins. Each account import commits facts and its coverage receipt atomically. Different accounts are independent imports: if a later publish fails, an earlier successful account remains recorded. The CLI exits nonzero on failure; rerun safely. It rejects demo responses and mismatched write counts. Credit balance retrieval is optional: a failed balance read leaves it unknown while valid OpenRouter costs may be imported.

A complete empty report displays $0; absent data is unknown. Partial windows show observed costs labeled partial. Legacy rows without a valid coverage receipt are unverified. Each report carries an identity and row count; rows removed by a later correction are excluded from current totals. A concurrent or interrupted import cannot publish a complete receipt for partially written facts. The latest report is authoritative; collecting a shorter window can make a larger dashboard window partial until the next full capture. Amounts are provider values, not recalculated from token rates. Negative/unsupported-currency reports fail closed. OpenRouter BYOK inference values are excluded from OpenRouter charges.

## Claude Code and recorded fees

The separate [Claude usage collector](../agents/claude-usage-collector/README.md) scans local JSONL metadata with a stable operator-supplied machine label, deduplicates request chunks/copies and emits hashed identifiers. It does not alter the Claude lifecycle hook. Billing classification is explicit (`unknown` by default); it is not inferred from historical transcripts. Partial scans retain valid observations but cannot claim complete local coverage. Even a complete scan describes only the files scanned.

To record an actual Claude subscription payment, create a private JSON file:

```json
{
  "invoice_id": "stable-operator-reference",
  "paid_at": "2026-11-03T12:00:00Z",
  "amount_usd": 7.00,
  "currency": "USD"
}
```

The example amount is synthetic, not a plan price. Use the actual payment amount and date; one stable reference per payment. The collector hashes the reference, and rerunning that reference updates the same fee record. Fees are recognized by payment date with no automatic proration or recurrence.

```bash
npx tsx scripts/collect-provider-usage.ts --provider claude-fee --fee-file /path/to/fee.json
# Add --env-file /path/to/collector.env --publish only when ready to record it.
```

## Operation and activation

These CLIs are manual and dry-run by default. This change does not install or activate a recurring job, provision provider keys, change production environment values or alter existing velocity/Hermes schedules. Production activation requires the existing authorized credential and release flow. Verify a real provider response, non-demo ingest receipt, persisted readback and rendered coverage before describing an integration as live. Optional future daily scheduling should run the same 30-day refresh so provider corrections are captured.

Existing Hermes collection remains in `agents/usage-collector/`; fixtures are synthetic and can be regenerated with `python3 scripts/make-fixtures.py`.

## Verification

`npm run test:ui` includes provider contract, summary, safe transport and receipt regressions. `npm test` includes local Claude collector tests. `npm run test:pg` uses the unchanged schema in a disposable database to verify legacy ID replacement, the Claude source, atomic rollback and correction/coverage readback. Build locally with `MC_SKIP_MIGRATE=1` to avoid schema application.

Primary contracts checked November 4, 2026:

- [OpenRouter activity](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint)
- [OpenRouter credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
- [Anthropic Usage and Cost Analytics](https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api)
- [Claude Code costs and subscription usage](https://code.claude.com/docs/en/costs)
