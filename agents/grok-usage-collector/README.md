# Grok CLI local usage collector

This separate Python 3.9+ collector runs on POSIX systems (macOS/Linux). It reads the Grok CLI's per-session `usage.json` files and sends only validated usage metadata to Agent Kontrol, so the Usage and Costs page can show Grok's API-equivalent (shadow) value. It does not run `grok`, change Grok's configuration, install a service or activate a schedule. It uses the existing usage-ingest endpoint and schema.

The default command is a read-only dry run. It prints a summary, writes no artifact, does not read credentials and makes no network request:

```bash
python3 agents/grok-usage-collector/collector.py \
  --machine macbook-pro --billing-mode subscription
```

`--machine` is required: a stable, non-secret label of lowercase letters, digits, hyphens or underscores. Reuse it on later runs; a different label is a different account. The default scan root is `~/.grok/sessions`. Override it with `--roots DIRECTORY [DIRECTORY ...]` or individual `usage.json` files. The default interval is the last 30 days ending at collection time; `--since` and `--until` take timezone-bearing ISO timestamps (inclusive/exclusive). A turn belongs to the window by its `endedAt`.

`--output`, `--publish`, `--config`, `--url` and `--allow-loopback-http` behave exactly as in the [Claude usage collector](../claude-usage-collector/README.md): a new 0600 file that never overwrites, `MC_URL`/`MC_TOKEN` from the process or a literal env file, an origin-only HTTPS destination, no redirects or proxies, one POST to `/api/usage/ingest` after all validation, and an exact non-demo receipt.

## Source

`grok usage <session-id>` prints the session's `usage.json` (`~/.grok/sessions/<encoded-cwd>/<session-id>/usage.json`) unchanged. The collector reads that file directly, so it does not depend on the CLI being installed or on its output format. It reads nothing else in the session directory: not the chat history, prompts, system prompt or summary. It never descends below `<encoded-cwd>/<session-id>/`, and the encoded-cwd directory name (a path) is never emitted.

## What is measured

- One observation per turn and model, from `turns[].modelUsage`. Turn and session totals are never read. Session totals can include history inherited on resume or fork.
- Dedupe: a turn's identity is a hash of `endedAt`, `turnNumber` and model, without the session ID. A resumed or forked session that repeats a parent's turn collapses into one observation (counted in `coverage.duplicates`), and repeated scans give the same rows.
- Counters: Grok's `inputTokens` includes cached reads, so the fact stores `input_tokens = inputTokens - cachedReadTokens` and `cache_read_tokens = cachedReadTokens`. `cache_write_tokens` is `cacheCreationTokens`. `output_tokens` is `outputTokens`, which already includes `reasoningTokens` (kept as `reasoning_tokens`, never priced again). `api_call_count` is `modelCalls`. A turn where cached exceeds input, reasoning exceeds output, or `modelCalls` is below 1 is malformed.
- Grok's own figure: `costUsdTicks` is Grok's estimate in units of 1e-10 USD. It is stored as `shadow_cost_usd` with `cost_status=local_reported_estimate`, and shown as a cross-check. A turn without it is `local_unpriced`. Agent Kontrol computes the headline API-equivalent value from its own rate table (`src/lib/shadow-rates.ts`) when the summary is read.
- Facts use `source=grok_cli`, `account_id=grok-cli:<machine>`, `billing_provider=xai`, and a fixed `billing_mode=observation`. `--billing-mode` (`unknown` by default, `subscription` or `api`) is recorded in `detail.billing_mode`, so correcting it updates the same rows. Rows marked `api` are left out of the shadow value because API-billed usage is already metered spend.
- `paid_cost_usd=0` is a storage placeholder, not evidence of a zero bill. The summary reports actual charges as unknown.
- Session IDs and turn identities are hashed. Model IDs must match `grok-...`.

## Coverage, bounds and failure

A snapshot with `detail.coverage.version=1`, provider `grok_cli`, the interval, `complete`/`partial` status and numeric counts accompanies the facts. Coverage is limited to the scanned files on this machine: other computers (for example the Mac Mini), deleted sessions and usage Grok did not record are not included. No files at all is partial; a scanned quiet interval can be complete with zero rows.

Malformed files or turns, unreadable files, symlinked `usage.json` files and any bound make coverage partial; valid turns are still kept. A partial run exits **2** (even after a successful publish), a complete run **0**, and invalid options, output, transport or receipt failures **1** with a fixed error code.

Bounds: 5,000 files (newest first by modification time); 200,000 directory entries; 4 MiB per file; 256 MiB in all; 10,000 turns per file; 100,000 observations; 20 MiB output/POST; 64 KiB receipt; 256 KiB config. Files are opened with `O_NOFOLLOW` and `O_NONBLOCK` and checked to be regular files before reading. Windows is unsupported.

## Tests

```bash
python3 -m unittest discover -s tests/unit -p 'test_grok_usage_collector.py' -v
```

They run with the repository's `npm run test:unit:py`, use synthetic files only and make no network request.
