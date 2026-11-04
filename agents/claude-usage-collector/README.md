# Claude Code local usage collector

This separate Python 3.9+ collector runs on POSIX systems (macOS/Linux), reads Claude Code JSONL files and sends only validated usage metadata to Agent Kontrol. It does not modify the lifecycle hook, install a service, change a subscription, or activate a schedule. It uses the existing usage-ingest endpoint and schema.

The default command is a read-only dry run. It prints a summary, writes no artifact, does not read credentials, and makes no network request:

```bash
python3 agents/claude-usage-collector/collector.py \
  --machine macbook-pro --billing-mode subscription
```

`--machine` is required and must be a stable, non-secret label containing lowercase letters, digits, hyphens or underscores. Reuse it on subsequent runs; different labels produce different accounts. The default scan root is `~/.claude/projects`. Override it with `--roots DIRECTORY [DIRECTORY ...]` or individual `.jsonl` files. Files and directories that are symlinks are not followed and make coverage partial.

The default interval is the last 30 elapsed days ending at collection time. `--since` and `--until` accept timezone-bearing ISO timestamps and form an inclusive/exclusive interval. An observation belongs to its latest response-chunk timestamp. This is local request-time usage, not a reconstructed invoice window.

For a new private metadata artifact, explicitly supply `--output`; the file is created with mode 0600 and an existing file is never overwritten. To publish, explicitly supply `--publish`. Existing `MC_URL` and `MC_TOKEN` are read from the process, or from an explicitly named literal env file:

```bash
python3 agents/claude-usage-collector/collector.py \
  --machine macbook-pro --billing-mode subscription \
  --since 2026-11-01T00:00:00Z --until 2026-11-04T00:00:00Z \
  --output /private/local-directory/claude-usage.json \
  --publish --config /private/local-directory/collector.env \
  --url https://your-agent-kontrol.example
```

The existing config file is parsed as literal data, never executed or changed. `--url` asserts the configured origin; it cannot redirect the credential to another destination. Only an origin-only HTTPS URL is accepted. Redirects and ambient proxies are disabled. Loopback HTTP requires the explicit `--allow-loopback-http` testing flag. Requests time out after 30 seconds. Only an affirmative, non-demo receipt with the exact written-fact count is accepted. All collection and payload validation finishes before the single POST. No live account access or publication occurs during the test suite.

## What is measured

- Only assistant records with `message.usage` are observations. The collector retains validated Claude model IDs, response timestamps, token counters, and an optional request-local `costUSD` estimate. Input/output counters must be nonnegative integers; cache-read/cache-write/reasoning counters default to zero only when absent. Unknown fields are discarded.
- Request identity hashes `sessionId` plus `requestId`; when `requestId` is absent, `message.id` is used. Repeated chunks, copied transcripts and repeated scans collapse to one request. Each cumulative counter and estimate takes its maximum, and the latest timestamp determines window membership. Conflicting model identities discard that request and mark coverage partial.
- Session/request identifiers are hashed before emission. Prompts, completions, tool inputs, raw IDs, file/project paths, arbitrary metadata and raw error messages are never emitted or saved. The JSONL parser necessarily reads source records, but only the explicit metadata allowlist survives extraction.
- Facts use `source=claude_code`, `account_id=claude-code:<machine>`, and a fixed `billing_mode=observation`. The operator assertion is recorded separately in `detail.billing_mode`, so correcting it does not create a second usage series. `--billing-mode` accepts `unknown` (default), `subscription`, or `api`; historical transcript data does not prove the payment method.
- Every local observation has `paid_cost_usd=0` as a storage placeholder, **not evidence of a zero bill**. `cost_status=local_reported_estimate` marks an explicitly reported `costUSD` value, stored only as shadow value. Otherwise `local_unpriced` means the value is unknown. No price lookup or token repricing is performed. The summary reports actual charges as unknown. Subscription invoices and provider API charges are recorded through their separate sources; this collector cannot establish plan fees or extra-usage charges.

## Coverage, bounds and failure

A snapshot accompanies the facts with `detail.coverage.version=1`, provider `claude_code`, the interval, `complete`/`partial` status, and numeric file/error counts. Coverage is limited to the scanned local files and machine. It does not include claude.ai, Cowork cloud, other computers, deleted files, or usage that the local runtime did not record. An empty directory is partial/unavailable; a successfully scanned quiet interval can contain zero observations.

Discovery continues up to the directory-entry bound before choosing files to read. The newest modification times are processed first, up to the file limit, so a large archive does not repeatedly consume the budget before recent files. Modification time is only a priority hint: actual response timestamps determine the observation window, and omitted files always leave coverage partial. An unreadable file stat also makes coverage partial.

Each input file is opened with `O_NOFOLLOW` and `O_NONBLOCK`, then its descriptor is checked for regular-file type and size before a reader is created. A leaf replaced by a symlink or FIFO after discovery is rejected without reading it or blocking, and leaves coverage partial. Read-time byte bounds still apply if a regular file grows. Systems without the required POSIX primitives fail closed with `safe_file_open_unavailable`; Windows is unsupported.

Malformed JSON, missing or invalid required usage metadata, unreadable files, symlinks, conflicting requests or any scan bound make coverage partial. Valid observations from a partial scan may still be published with that partial snapshot; the command then exits **2**, even if the POST succeeds. Complete collection/publication exits **0**. Invalid options, transport, output or receipt failure exits **1** with a fixed safe error code. Never treat file existence or a partial snapshot as a successful complete capture.

Bounds: 2,000 JSONL files; 100,000 enumerated directory entries; 64 MiB per file; 256 MiB total input; 1 MiB per record; 250,000 records; 100,000 request observations; 20 MiB output/POST; 64 KiB receipt; 256 KiB config. Unsupported future transcript shapes require an explicit parser update; the collector does not guess fields or silently price unknown models.

Run the synthetic regression tests through the existing Python test discovery:

```bash
python3 -m unittest discover -s tests/unit -p 'test_claude_usage_collector.py' -v
```

They are also included in the repository's existing `npm run test:unit:py` command. Tests cover duplicate chunks/files, separate process ID stability, billing corrections, windows, malformed metadata, privacy canaries, symlink/FIFO replacement races, read-time size validation, private output, literal config, destination validation, exact receipts and partial publication.
