# Langfuse fleet activity

Mission Control can export newly saved activity events and completed dispatcher runs to a private Langfuse project.
The `/observability` page shows completed-run counts, runtime percentiles, failures, usage coverage and reported model totals. It also reports configuration readiness and links to the project.
It never treats configured credentials as proof of delivery.

## Activation (owner action)

Choose the Langfuse project and region, then approve configuration and deployment.
Use server-only environment variables in the intended Vercel environment:

| Variable | Purpose |
| --- | --- |
| `LANGFUSE_ENABLED` | Must be exactly `true`; otherwise no export occurs. |
| `LANGFUSE_BASE_URL` | Origin of the chosen Cloud region or self-hosted instance, without an API path. HTTPS required except loopback development. No default region. |
| `LANGFUSE_PUBLIC_KEY` | Project public key. |
| `LANGFUSE_SECRET_KEY` | Project secret key. Never use a `NEXT_PUBLIC_` name. |
| `LANGFUSE_PROJECT_URL` | Optional project UI URL, such as `https://us.cloud.langfuse.com/project/PROJECT_ID`. Same origin as the base URL; no query string. |

No credentials are bundled into client components, logged, or written to this repository.
Configuration is disabled by default. Turning the enable flag off disables future export.
Historical data already sent to Langfuse is unaffected by that flag.

## Activity export contract

- `report()` saves an event in Neon first, including calls from `/api/ingest` and MCP `report_status`.
  Only successful inserts schedule export through Next.js `after()`.
- Each activity event becomes one completed, zero-duration OTLP `event` observation.
  Its trace/span IDs derive from the stored event ID and agent reference.
  A hashed agent/session pair groups observations into Langfuse sessions.
- Only approved event kinds, explicit statuses and platforms, timestamps, numeric event IDs, and hashed
  agent/session references are sent. Free-form titles, summaries, details, raw errors,
  prompts, replies, project/machine names, task instructions, keys, and environment
  values are excluded. Hashes are pseudonymous identifiers, not anonymization guarantees.
- Heartbeats and unknown kinds are skipped. Unknown platforms become `other`.
  Explicit `failed` status reports (including MCP) are marked as errors.
  Missing platform fields use the saved agent platform returned by the existing upsert.
- The transport uses OTLP HTTP/JSON at `/api/public/otel/v1/traces` with the
  `x-langfuse-ingestion-version: 4` header. It does not use the legacy ingestion API.
- Delivery is best effort, with a three-second timeout and no retry or backfill.
  Langfuse failures cannot fail a successful fleet report. Logs contain only coarse
  failure categories; they contain no response body or raw exception.
- There is no persistent delivery ledger. A function crash or failed export can lose
  an observation. Deterministic IDs are correlation, **not** deduplication in Langfuse v4.
  Upstream retries that create a new fleet event create another observation too.

## Completed runs and model usage

The updated dispatcher emits `kind=run_complete` with a strict `mc.run.v2` metadata envelope after each worker/reviewer invocation, including process errors, timeouts and missing CLIs. Claude JSON, Codex JSONL and Grok JSON output are parsed locally. Task result text follows the existing task-result path and is excluded from run telemetry. No prices or cost fields are added to this contract.

- The monotonic process duration maps onto the invocation start timestamp. This is CLI wall time, including startup, tool work and waiting; it is not individual inference latency.
- Claude/Grok final per-model counters take precedence over their aggregate usage. Reported input includes uncached plus available cache read/write; a missing cache category keeps Claude/Grok usage marked partial. Codex already includes cached input; reasoning is a breakdown, not an extra output total. Missing counts are unknown, never invented zeroes. Partial usage remains labeled partial. Codex model attribution remains `unknown` when its protocol does not identify it.
- Resume/continue modes suppress cumulative session counters so they cannot be counted again as fresh per-run usage.
- The server validates and stores only approved metadata in the existing events table. A ReadCommitted transaction takes an advisory lock and checks `(agent_id, run_id)` before insertion, so duplicate delivery of the same invocation schedules no second export. No schema migration or production data migration is needed.
- A run becomes a timed Langfuse `agent` span. Per-model totals become child **span metadata**, with `usage_scope=run_total` and `latency_scope=not_measured`. They are not fabricated model generations. Langfuse's native generation token/latency charts are not populated by this aggregate adapter.
- The local dashboard reads the latest 1,000 stored completed records for 24 hours, clearly labeling a truncated sample. It distinguishes usage availability from complete coverage. Counts include successful and failed completed invocations; individual failures have coarse error classes.

## Fleet coverage and remaining native instrumentation

Updating the server alone does not update a running local dispatcher. Activate the dispatcher changes separately on approved machines, using `mc_dispatcher.py` together with `run_telemetry.py` and `ak_pointers.py`, which it imports. No daemon was installed/restarted by this change. The obsolete Codex `--full-auto` default is replaced with the supported `--sandbox workspace-write`. An explicit old `MC_CODEX_ARGS` override still needs correction during approved activation. Other dispatcher review/autonomy behavior is unchanged.

Interactive sessions outside the dispatcher still have activity telemetry only. Detailed model-request latency, nested tool spans, native Langfuse generation token charts, and evaluations require native runtime instrumentation.

The current Mini Hermes exporter emits `mc.run.v1` records on every session change, including running and reopened sessions. Its token totals are cumulative and its model list does not carry per-model counts. These records remain in the existing fleet/usage feed; this adapter deliberately does not resend them as fresh model generations. The existing Usage and Costs ledger remains the Hermes cumulative source and is not added to dispatcher-run totals.

Claude's native OTel request spans are a supported future source for true request durations, TTFT, models and tokens, but enabling that exporter and a privacy filter requires a separately approved runtime configuration change. No raw transcript extraction is needed.

## Verify after activation

1. Confirm `/observability` says **Event export configured** in the intended deployment.
2. Let an authorized watcher report a fresh session/turn event. Do not replay history.
3. Open the project in Langfuse and confirm the `fleet.*` event, timestamp, platform,
   and hashed session reference. Check that no input/output or free-form text appears.
4. Confirm routine heartbeats do not appear. Check server logs for coarse export failures.
5. After approved dispatcher activation, run one bounded task on each enabled CLI. Confirm the `/observability` run count, role, measured duration, outcome, tokens/coverage, and a single root run span in Langfuse with model totals as metadata.
6. Replay the same `mc.run.v2` run ID to the local/test ingest endpoint and confirm no duplicate stored run or second export. Do not replay real production history.
7. Keep existing Usage and Costs as the source for Hermes cumulative model usage. Do not treat the dispatcher feed as full coverage of interactive runtimes.

Official references: [OTLP transport and attribute mapping](https://langfuse.com/integrations/native/opentelemetry),
[v4 immutable observations and duplicate handling](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4),
[Vercel lifecycle handling](https://langfuse.com/docs/observability/sdk/instrumentation).
