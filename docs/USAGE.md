# Usage and Costs

Page: `/usage`. Read API: `GET /api/usage?window=24h|7d|30d`. Write API: `POST /api/usage/ingest` with the existing collector bearer token.

The page separates three accounting views. Never add them into a single spend total:

- **Hermes attribution:** existing session/profile/cron/model totals, from `hermes_state` only, in a rolling window. Provider invoices may cover the same activity.
- **Provider billing:** OpenRouter inference charges and direct Claude API cost reports, over the corresponding last 1, 7 or 30 completed UTC days. OpenRouter balance is the latest collected balance, not a historical balance. Anthropic cost is after discounts, before credits; separate Priority Tier commitment fees are outside this API.
- **API-equivalent value (shadow cost):** what the tokens used under a flat-rate subscription would have cost at the vendor's published API list prices. It is an estimate and never a charge. It never enters provider billing or any paid total. See [Shadow costs](#shadow-costs).
- **Claude subscription/local usage:** recorded subscription payments by payment date, plus local Claude Code request and token observations. Local token value is an estimate only when explicitly present in the source; an absent estimate or fee is unknown. Local usage cannot establish extra-usage charges and does not cover claude.ai or unscanned devices.

No assumed subscription price or schema migration is required. Shadow costs use their own dated rate table in `src/lib/shadow-rates.ts`. Existing tables are `usage_facts` and `account_snapshots`; model-price estimates for Hermes are unchanged.

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

## Scheduled collection on the deployment

The deployment can collect provider billing itself, so nothing depends on a machine staying up. `GET /api/usage/collect` runs the same adapters as the command-line collector for the last 30 complete UTC days and stores each report. `vercel.json` schedules it once a day at 06:20 UTC on Vercel; on another host, call it from any scheduler.

Set these on the deployment (Production only), not in a file on a machine:

- `CRON_SECRET`: any long random value. Vercel Cron sends it as `Authorization: Bearer $CRON_SECRET`. Without it the scheduled call is refused; `MC_TOKEN` and a dashboard session still work for a manual run.
- `MC_OPENROUTER_MANAGEMENT_KEY` for OpenRouter.
- `MC_XAI_MANAGEMENT_KEY` and `MC_XAI_TEAM_ID` for xAI.
- `MC_ANTHROPIC_ADMIN_KEY` for the Claude API.

A provider with no credentials is skipped. Providers run at the same time and are independent: one failing or running long does not stop the others, and the response is 502 with that provider marked `failed`. The cause goes to the server log as a fixed message with no secret and no provider response. The response body names each provider and a fact count only.

Run it once by hand after setting the variables:

```bash
curl -fsS -H "Authorization: Bearer $MC_TOKEN" https://your-dashboard.example/api/usage/collect
```

Collectors that read local files (Claude Code usage, Hermes) cannot run here; they stay on the machines that hold those files.

## Claude Code and recorded fees

The separate [Claude usage collector](../agents/claude-usage-collector/README.md) scans local JSONL metadata with a stable operator-supplied machine label, deduplicates request chunks/copies and emits hashed identifiers. It does not alter the Claude lifecycle hook. Billing classification is explicit (`unknown` by default); it is not inferred from historical transcripts. Partial scans retain valid observations but cannot claim complete local coverage. Even a complete scan describes only the files scanned.

The [Grok usage collector](../agents/grok-usage-collector/README.md) does the same for the Grok CLI. It reads only each session's `usage.json` under `~/.grok/sessions` (the file `grok usage <session-id>` prints) and emits one row per turn and model with `source=grok_cli` and `account_id=grok-cli:<machine>`. Session totals are never read, because they can include history inherited on resume or fork; each turn is counted once by its own identity. Grok's own per-turn cost figure (`costUsdTicks`) is kept as `shadow_cost_usd` with `cost_status=local_reported_estimate`. `grok.local_usage_status` reflects each machine's newest scan as that scan reported it; like the Claude machine list, it does not check that the scan's interval covers the selected window, so each machine line shows the scanned interval.

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

## Shadow costs

`src/lib/shadow-rates.ts` holds one versioned, dated table of per-million-token API list prices: input, output, cache read, 5-minute and 1-hour cache writes, and any prompt-size tier. Each rate names its source page, [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) or [xAI pricing](https://docs.x.ai/docs/pricing). The current table was checked on 2026-11-26.

- The shadow cost is computed when `GET /api/usage` builds the summary. It is not stored, so a corrected rate reprices every row. The stored `shadow_cost_usd` column keeps its meaning: a value the source itself reported.
- Claude: each Claude Code request row is priced by exact model ID (a routing prefix or `-YYYYMMDD` snapshot suffix is removed; nothing else is matched). Claude Haiku 5.5 requests over 100,000 prompt tokens use the higher tier. The summary is `claude.shadow`.
- Billing mode: rows the operator marked `api` are left out and counted in `excluded_api_requests`, because API-billed tokens are already metered spend. Rows marked `unknown` are priced and counted in `unclassified_requests`.
- Cache writes: collectors report one cache-write total, so writes are priced at the 5-minute rate. The estimate is a lower bound when 1-hour writes occur.
- Unavailable, never $0: a row with no model, an unknown model, missing input or output counts, an invalid cache counter, or no tokens at all is counted in `unpriced` and left out of the total. `usd` is `null` when nothing in the window could be priced, and `status` is `partial` when only some rows were priced.
- Grok: `grok_cli` rows from the Grok usage collector are priced at xAI list prices. `grok-4.7-build` and `grok-4.6-build` (Grok Build's model IDs) use the standard grok-4.7 and grok-4.6 rates, which match the Grok CLI's own cost figure; the "Grok 4.7 Fast (Grok Build only)" listing would double it. Reasoning tokens are already inside output tokens and are not priced again. Grok records tokens per turn, and a turn covers many model calls, so the 200K long-prompt tier is decided on the average prompt per call (it under-counts when only a few calls were long). The summary is `grok.shadow`, with Grok's own figure beside it as `grok.reported_estimate_usd`. With no Grok collection received, `grok.shadow` is unavailable with `unavailable_reason: "no_token_feed"`. Grok through OpenRouter is metered spend, not shadow cost.
- Every row is priced at the current table, including rows older than its check date. The UI shows the check date.

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
