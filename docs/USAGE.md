# Usage and Costs (experimental)

Page: `/usage`. API: `GET /api/usage`, `POST /api/usage/ingest`. Collector: `agents/usage-collector/`.

This is Phase 1 of a fleet usage ledger. It reads Hermes session usage and, when `MC_OPENROUTER_MANAGEMENT_KEY` is set, OpenRouter activity, and shows paid cost next to a "shadow" cost: the list-price value of tokens that were included in a subscription rather than billed per call. Shadow cost is not charged to a card.

Status: experimental. Later phases (subscription fees, more providers, joining task costs) are not built, and the price table is a seeded snapshot (`model_prices`), so figures are estimates.

## What it stores

Token counts, costs, model names and billing metadata only. It never reads or stores prompts or completions.

## Running the collector

```bash
# Dry run against the synthetic fixtures (no Hermes access, nothing posted)
python3 agents/usage-collector/collect_usage.py --dry-run --roots fixtures/hermes \
  --since 2026-09-28 --until 2026-10-06

# Live tick (after agents/usage-collector/install.sh, which installs a macOS launchd agent)
python3 agents/usage-collector/collect_usage.py
```

`fixtures/hermes/` holds synthetic SQLite files only; regenerate them with `python3 scripts/make-fixtures.py`.

## Tables

`model_prices`, `usage_accounts`, `usage_facts`, `account_snapshots` (see `supabase/schema.sql`).

## See also

- [DEPLOY.md](DEPLOY.md)
- [AGENTS.md](AGENTS.md)
- [API.md](API.md)
