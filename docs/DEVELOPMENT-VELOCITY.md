# Development-velocity benchmarks

`/velocity` records delivery measurements separately from the Progress board's queue snapshots. Settings owner discovery retains every eligible repository, including inactive and never-pushed repositories. The existing activity window continues to control active views. Forks and archives follow the owner's inclusion policy.

## Measurements

- CI: distinct PR-head revisions submitted to attributable `pull_request` Actions runs, through first observed green. Parallel workflows share a revision. The conservative workflow union is not proof of historical required checks. Report successful samples, CI-covered PRs, no observed green, and no PR CI together.
- First pass: one revision with no repeat execution before green, divided by all CI-covered PRs. GitHub reruns and new same-SHA/workflow execution IDs are separate counters across the full created cohort.
- Throughput: PRs created and merged within the half-open reporting window. Dense daily counts come from dated PR evidence. Merged cohorts include PRs opened before the window.
- Merge time: individual creation-to-merge duration samples for PRs merged in the window. Current open PRs are a retrieval snapshot, not a reconstructed historical backlog.
- CD: GitHub deployment records until observed success, grouped by repository, SHA and exact environment. Production, preview and other environments stay separate. Provider-internal retries and missing records remain outside the measure.

Fleet means and quantiles pool individual samples. Median uses the midpoint; p90 uses nearest rank. Empty measured samples yield null statistics. Unavailable streams are null with explicit coverage flags, never zero. UI rounding is two decimal places; raw samples retain source precision.

## Capture format and conversion

The shared validator in `src/lib/velocity.ts` defines schema version 1 and method `observed-development-velocity-v1.0`. It runs both in the browser's local preview and at server ingest. A capture contains scope, complete calendar-day window, reporting timezone, capture timestamp/kind, source hashes, inventory completeness and repository measurements. Daily buckets must reconcile with period totals. CI coverage and success samples must reconcile with the created-PR count. Invalid counts, duplicate repositories, unsupported methods, future captures, partial-day windows and out-of-scope repositories are rejected.

Convert a private versioned evidence artifact without uploading it:

```sh
python3 scripts/convert-velocity.py /private/evidence.json /private/capture.json --receipt /private/parity.json
```

The converter verifies source summaries against individual PR/deployment observations and hashes the input bytes and evidence manifest. It does not fetch evidence files or verify their contents against the manifest; retain the original evidence alongside its receipt. The compact payload omits PR titles, authors and workflow logs. Do not commit real captures or inventories to a public repository.

On the Velocity page, **Preview capture** reads the file into page memory only. It does not upload it, use localStorage, or save a draft. **Save to dashboard** performs the authenticated import. Closing the preview discards the local state. The page's filter controls affect only the repository table, not fleet totals.

## API and history

`GET /api/velocity` and `POST /api/velocity/ingest` accept the existing trusted collector bearer or authenticated operator session. Agents, OAuth and dev-open callers are denied. Session writes require an Origin exactly matching the request origin. All responses are private/no-store. Bodies are bounded by actual streamed bytes at 2 MB; inventory is capped at 1000 repositories.

The ingest response contains `id`, `scopeKey`, `duplicate`, and server `recordedAt`. A canonical payload hash is the primary key. `INSERT ... ON CONFLICT DO NOTHING`, followed by receipt lookup, makes simultaneous exact duplicates safe. There is no application update/delete endpoint. Changed evidence for the same interval appends a row. This is application immutability, not a restriction on a database administrator.

Compatible series share method, sorted owners, fork/archive policy, cohort, reporting timezone and calendar-day window length. For each interval, history picks the latest server-recorded revision. It keeps the first server-recorded capture as the baseline, even if older reconstructed periods arrive later. History returns at most 120 periods, with the original baseline separately retained. The series selector returns at most 50 series. The latest snapshot includes inventory; other history points contain summaries only.

Coverage fingerprints include the sorted repository identities, stream coverage and inventory-complete flag. A coverage change breaks chart lines and suppresses the baseline delta. A single capture is displayed as a single baseline, never a fabricated trend. Daily PR throughput is a separate chart derived from actual dates. Never add overlapping rolling captures to produce weekly totals.

## Storage and release

The draft requires one additive `velocity_benchmarks` table and a trend index. Until the schema is explicitly approved, the proposal stays outside `supabase/schema.sql`; no migration is applied by this feature. Missing storage returns 503, and import never reports a successful dropped capture. After approval, incorporate the reviewed SQL into the idempotent schema and a dated migration, verify against disposable Postgres, and release through the normal review/deployment gates.

Build-only checks while approval is pending:

```sh
MC_SKIP_MIGRATE=1 npm run build
```

The ordinary build otherwise invokes the existing schema applicator. Do not use a production database for tests. A skipped database test is not database validation.

## Daily capture and weekly summary

The dashboard does not schedule GitHub collection or spend GitHub API quota. An authorized external collector produces immutable daily artifacts and publishes each compact capture after successful validation. Reuse its existing authentication; no new credential is needed. Preserve the same source artifact and retry the same file after a delivery failure so ingest remains idempotent. Verify the returned receipt and read the saved capture back before claiming delivery.

The delivery helper uses the existing `MC_URL` and `MC_TOKEN` environment values, or parses those two literal values from an explicitly supplied existing collector configuration. It never executes the file, changes credentials, follows redirects, or prints request headers. `--url` asserts the expected origin; it cannot redirect an existing credential to a different destination.

```sh
python3 scripts/import-velocity.py /private/capture.json --config /private/existing-collector.env --url https://dashboard.example
```

It makes one bounded request and prints only a validated receipt. A failure is not delivery confirmation; retain the capture for an identical retry. The server remains the authority for full measurement validation.

Weekly summaries should recompute complete-week cohorts from source evidence, compare like-for-like windows and identify coverage changes. They must not sum overlapping 30-day captures. Reconstructed earlier periods must be labeled `captureKind: reconstructed` and must use historical cutoff evidence, not today's final workflow state.
