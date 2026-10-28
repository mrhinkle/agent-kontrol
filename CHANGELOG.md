# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Morning brief API (#64): `GET /api/brief?window=24h|72h` returns the brief as `text/plain` (or the `scripts/morning-brief.sh --json` object when `Accept: application/json`). MCP tool `get_morning_brief` (`progress:read`, read-only) returns the same text. Counts, stuck PRs, and lead time come from `repo_snapshots.detail`. Decisions join on `owner/name`. Coordinator liveness is a work event, never a heartbeat. The script stays the fallback. `scripts/collect-progress.sh` writes the brief detail keys and still posts the tick if that extra sweep fails.
- `GET /api/openapi.json` serves an OpenAPI 3.1 description of the REST routes. `docs/API.md` links to it. `npm run test:ui` fails when a route under `src/app/api` has no spec entry. No SDK is generated.
- `docs/GIBSON.md`: how Agent Kontrol (development manager) complements the Gibson (deterministic gates), what belongs in each, and how the dashboard's Gibson page differs from the harness.
- `docs/ROLES.md`: job descriptions for the four fleet roles (Spec Writer, Implementer, Reviewer, Dispatcher) and the Owner. Each card states mission, accountabilities, inputs, output artifact, may/never, quality bar, cadence and cost shape, the brief signals that show it working or failing, a dated failure seen in this fleet, and the Gibson playbook it maps to. Non-normative: binding rules stay in each repo's `AGENTS.md`.
- Optional `dry_run: true` on `PUT /api/settings/repos`, `PATCH /api/tasks/:id` (including cancel), `POST /api/memory`, and the MCP tools `remember` and `update_task`. The response describes the diff or the affected row and writes nothing. A non-boolean `dry_run` is rejected. The dashboard confirm dialogs for replacing repos, cancelling a task, and overwriting a memory key show that same preview.
- Velocity layer, part 1: `scripts/morning-brief.sh` prints one screen a day — PRs merged, issues opened/closed and net backlog per repo, median open-to-merge lead time, stale-issue share, every stuck PR with its age and the check or conflict it is stuck on, the decisions waiting on the owner (issues carrying a configured label, oldest first), and whether the coordinator is working or only posting telemetry (a work event within `brief.coordinator.maxSilenceHours`, never a heartbeat). Repos come from the dashboard's Settings list when `MC_URL`/`MC_TOKEN` are set, else `progress.config.json`. `--json` emits the same facts for `/api/brief`. New `decisions` table (`supabase/migrations/20261025_decisions.sql`) and `brief` block in `progress.config.json`. Spec and rollout order: `docs/VELOCITY.md`.
- Decisions API (#63): `GET` and `POST /api/decisions` for the dashboard session or `MC_TOKEN`, and `PATCH /api/decisions/:id` for those callers or an agent credential with `decisions:write`. The collector upserts GitHub-label rows and withdraws ones whose issue closed or lost the label, including decided rows. The stored decision text and `decided_by` stay. `GET /api/decisions?shape=brief` is the morning brief's `.decisions` list (`repo` is `owner/name`; `repo_short` is display only), and `scripts/morning-brief.sh` joins that list onto each watched repo by `owner/name`. GitHub write-back stays on #65.

### Fixed

- Morning brief liveness reads the newest configured work event and every error inside the silence window, so a burst of `turn_start` or `status_update` cannot hide a `milestone` that is still inside `maxSilenceHours` (#64). `error` is not a work kind, even when `workKinds` names it. `GET /api/brief` sends `Vary: Accept`. The collector's `detail.merged_list` and `median_lead_hours` are the 24h window; `detail.merged` keeps the 72h rows. An empty `detail.merged` array is a measured empty window and is not replaced by `merged_list`. When any watched repo is incomplete, or a counted repo lacks a field, that fleet total is null and the text says `DATA INCOMPLETE`, not `none` or `0`. Known stuck PRs, decisions, and shipped rows from counted repos are still listed.
- A `github-label` decisions row from before `kind`, `labels`, `opened_at`, and `repo_short` existed is not authoritative for `GET /api/decisions?shape=brief`. The response lists that repo in `incomplete_repos`, and `scripts/morning-brief.sh` keeps the GitHub sweep for it (kind, labels, age from `createdAt`, configured short name). The collector's next upsert fills the null columns.
- `agents/grok/README.md`: the MCP server key in the config example is now `agent-kontrol` (was `mission-control`).

- `POST /api/mcp` returns HTTP 400 `invalid_json` for an empty or non-JSON body. The handler no longer throws `SyntaxError`. A missing bearer is still `401` with `WWW-Authenticate`.
- The error tables in `docs/API.md` and `docs/MCP.md` match the handlers. `PATCH /api/tasks/:id` and MCP `update_task` return `task_not_found` for a missing id, and `error` stays `Task not found`. OAuth consent rate limiting stays HTML. `GET /api/usage` stays HTTP 200 when its table is missing. An unknown trace is `404` only when a database is connected. No current MCP tool returns `validation_failed`.

### Added

- Per-agent credentials. Settings issues a revocable `akc_…` token with scopes enforced on every MCP tool and on the agent REST routes. The token is shown once. The database stores the label, an 8-character prefix, the SHA-256 of the token, the scopes, and timestamps (`created_at`, `expires_at`, `revoked_at`, `last_used_at`). It does not store the token, prompts, or tool input. `MC_TOKEN` and a verified OAuth access token keep the access they already had. A missing scope returns `403` with `code: "insufficient_scope"`. Revoked and expired credentials return `401`.
- `npm run test:mcp` starts the app in demo mode and drives `/api/mcp` with the official MCP client (`@modelcontextprotocol/sdk` 1.32.1). An unauthenticated call must be `401` with `WWW-Authenticate`, and `tools/list` must be the 11 documented tools plus the `reply_to_mark` alias. CI runs this check. Demo mode does not store tool writes.

- REST and MCP errors include `code`, `fix`, and `retryable` next to the existing `error` string (`src/lib/api-error.ts`). A 500 logs the exception and returns `internal_error` with a generic message. `PUT /api/settings/repos` keeps `errors` and `code: "stale"`. Docs: `docs/API.md`, `docs/MCP.md`.
- Public agent index at `GET /llms.txt` (`text/plain`) and the MCP, API and agent guides as Markdown at `GET /docs/mcp.md`, `/docs/api.md` and `/docs/agents.md`. No dashboard session. The route returns 404 for any other name. With the dashboard password set, those other names stay behind the gate with the rest of the dashboard, and data routes are unchanged.
- Traces: step-by-step spans for agent sessions. `POST /api/v1/traces` accepts OTLP/HTTP JSON from any OpenTelemetry exporter, `/traces` shows a waterfall, and the Claude Code hook emits session, turn and tool spans (register the new `PreToolUse` and `PostToolUse` hooks). Prompt and tool content is not stored unless `MC_TRACE_CAPTURE_CONTENT=1`; spans are pruned after `MC_TRACE_RETENTION_DAYS` (default 30). Docs: `docs/TELEMETRY.md`.

### Changed

- Demo mode (no `DATABASE_URL`) keeps MCP `report_status`, `remember`, `create_task`, `claim_task`, and `update_task` in an in-memory store for the life of the process. `get_fleet_status`, `recall`, and `get_task_queue` read it. Successful responses are labeled demo. The store is cleared when the process restarts. Dashboard sample data and dropped REST writes are unchanged (#56).
- The OpenAPI document includes `POST /api/memory`, optional `dry_run` on that route and on `PATCH /api/tasks/:id` and `PUT /api/settings/repos`, and `actor_type` / `actor_id` on the Task and Message schemas. The route-parity check is unchanged.
- The OpenAPI document includes `GET` and `POST /api/decisions` and `PATCH /api/decisions/{id}`: `status` and `shape` query parameters, the `decisions:write` scope on the patch, and the error codes from `src/lib/api-error.ts`. It also documents the optional `Idempotency-Key` header and `409` `idempotency_conflict` on `POST /api/tasks`, `POST /api/messages`, and `POST /api/messages/reply`. The route-parity check is unchanged.
- Hardening of the trace library and session notes: the trace viewer's layout no longer recurses (a 30,000-deep parent chain overflowed the stack) and tolerates non-array input and non-span entries; `sanitizeAttributes` and `formatDuration` tolerate bad input; span merging compares start times as instants; sibling order is stable; and the day settings `MC_TRACE_RETENTION_DAYS` and `MC_MEMORY_WRITEBACK_DAYS` now accept only whole numbers (a value such as `1.5` or `14d` used to be truncated, and now falls back to 30). Counts in session notes are clamped to non-negative whole numbers. The code change was written by Kimi K3 and reviewed here.
- When a session ends, or an agent reports status done or failed, the server writes one short note to shared memory (key `session/<id>`, tag `session-summary`), for every platform. By default it holds structured facts only (who, project, duration, outcome, event and error counts, tool counts, a milestone count). Reported text is opt-in with `MC_MEMORY_WRITEBACK_TEXT=1` and redacted; prompt-derived text also needs `MC_MEMORY_WRITEBACK_PROMPTS=1`. `MC_MEMORY_WRITEBACK=0` turns it off and notes expire after `MC_MEMORY_WRITEBACK_DAYS` (default 30). The `memory` table gains `source` and `facts_at` columns and two indexes (schema step applies them); an agent's own `remember` on the same key always wins.
- The progress board's blocked alert now names the repo's own blocked label and links to a search for it. It always said "dependency-blocked" and linked to that label, whatever the repo used.

### Documentation

- What "blocked" means (a label you choose, not something detected), the release-branch workflow on Vercel, an adapter capability table, a Status section in the README, and release and dependency policy in CONTRIBUTING.

## [1.0.0-beta.1] - 2026-10-09

First public beta. Feature-complete for 1.0; the API, MCP tool surface and schema are stable unless beta feedback shows a defect. Please report issues on GitHub.

### Added

- Settings page (`/settings`) to add, edit, reorder and remove the repos the progress board watches, stored in a new `watched_repos` table. The collector reads the list from `GET /api/settings/repos` each tick and falls back to its local file. Design: `docs/design/settings-repos.md`.
- `NEXT_PUBLIC_MC_PROGRESS_CONFIG` replaces the progress board's repos from the environment, so a deployment does not need to fork `progress.config.json`.
- `reply_to_mark` stays registered as a deprecated alias of `reply_to_operator` for the 1.x line, so existing agent instructions keep working.
- In-app Help menu (`/help`) that renders the project docs.
- Dashboard: Fleet, Progress, Usage and Costs, Tasks, History, Memory, and Gibson 3D view.
- Ingest API.
- MCP server with 11 tools and OAuth 2.1.
- Task queue with dispatchers and optional cross-vendor review.
- Two-way operator messaging.
- Progress board driven by `progress.config.json`.
- Usage ledger (experimental).
- Neon or any Postgres 13+ via `MC_DB_DRIVER` auto-detection.
- Automatic idempotent schema step on build and container start.
- One-line quickstart.
- Docker Compose.
- Deploy to Vercel button.
- Deploy to Fly.io: `fly.toml` with a release-command schema step, plus a DEPLOY.md walkthrough.
- CI builds the Docker image and checks that the container serves `/login`.
- Docs: MCP, API, DATABASE, DEPLOY, AGENTS, ARCHITECTURE.

### Changed

- Branding: the product is Agent Kontrol by The AIE. The byline appears in the app header and footer only under the default app name, so deployments that set `NEXT_PUBLIC_MC_NAME` are not labelled as The AIE's. README, logo files and notices updated; trademark notice names Peripety Labs LLC as owner.
- Renamed from Mission Control to Agent Kontrol: repository (old URLs redirect), package, app name, docs and logo. Internal names are unchanged so existing installs keep working: the `MC_` environment prefix, `~/.mission-control`, `~/.claude/mission-control.env`, and the `com.missioncontrol.*` launchd labels.
- New logo and wordmark in `public/logo/`; the wordmark letters are outlined from Montserrat ExtraBold (SIL Open Font License).
- Operator name is configurable (`NEXT_PUBLIC_MC_OPERATOR`).
- MCP tool renamed to `reply_to_operator`.

### Fixed

- None yet.

### Security

- Fail-closed auth in production.
- Dashboard refuses to serve real data without a password.
- Login and OAuth consent are rate limited.
- Secrets in query strings removed.
- All known dependency vulnerabilities fixed.

### Known limitations

- Shared notes (`remember`/`recall`) are a plain table with substring search; nothing writes to it automatically.
- Usage and Costs is Phase 1 and experimental.
- No dispatcher kill switch yet.
- Dashboard polls every 7 seconds.
- Single shared password; no per-user accounts.
- Rate limiter is per instance.
- Collectors install only as macOS launchd agents (on Linux, run from cron or systemd yourself).
- Docker images and generic Node hosts are less exercised than Vercel + Neon.
