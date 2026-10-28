# Agent Kontrol REST API

## Authentication

Three credentials protect Agent Kontrol:

- The dashboard password (env `MC_DASHBOARD_PASSWORD`) gates the UI and the data routes through a session cookie named `mc_auth`. Callers get the cookie by posting the password to `POST /api/login`. The session can do everything an operator can do, including issuing agent credentials.
- `MC_TOKEN` is a static bearer token. It has every scope. Data routes accept `Authorization: Bearer <MC_TOKEN>` as an alternative to the cookie, and the ingest routes require a bearer.
- An agent credential is a token shaped `akc_` plus 32 random bytes, base64url. Settings shows it once. It can call only the MCP tools and REST routes its scopes allow. It cannot call `GET`/`POST`/`DELETE /api/settings/credentials`, and neither can `MC_TOKEN`.

Secrets in query strings (`?key=`) are not supported. Send tokens in the `Authorization` header. Agent credentials are not accepted in the query string.

The `agent_credentials` table stores the label, the first 8 characters of the token, the SHA-256 hex of the full token, the scopes, and timestamps (`created_at`, `expires_at`, `revoked_at`, `last_used_at`). It does not store the token, prompts, or tool input or output. If the `last_used_at` write fails, the request still completes. With no `DATABASE_URL`, the same rules run against an in-memory list that is not shared across processes.

### Auth by route group

| Route group | Accepted credentials |
| --- | --- |
| Dashboard UI and data routes (default) | Session cookie `mc_auth`, or `Authorization: Bearer <MC_TOKEN>` |
| `GET` and `POST /api/decisions` | Session cookie or `MC_TOKEN` only. An agent credential is denied, including one that holds `decisions:write` |
| `PATCH /api/decisions/:id` | Session cookie, `MC_TOKEN`, or an agent credential with `decisions:write` |
| Ingest routes: `POST /api/v1/traces`, `POST /api/ingest`, `POST /api/messages/reply`, `POST /api/progress/ingest`, `POST /api/usage/ingest` | `Authorization: Bearer <MC_TOKEN>`, or an agent credential whose scope covers the route (`status:write` for `POST /api/ingest`, `messages:write` for `POST /api/messages/reply`); the other ingest routes take `MC_TOKEN` only |
| MCP transport: `/api/mcp` | `Authorization: Bearer <MC_TOKEN>`, an agent credential, or an OAuth access token (JWT) issued by this server |
| Credential management: `GET`/`POST`/`DELETE /api/settings/credentials` | Dashboard session only |
| Login, OAuth, and discovery: `/login`, `/api/login`, `/oauth/*`, `/.well-known/*` | No cookie gate; these routes enforce their own auth |
| Public agent docs: `GET /llms.txt`, `GET /docs/mcp.md`, `GET /docs/api.md`, `GET /docs/agents.md` | None. Any other `/docs` name stays behind the dashboard gate |

Ingest routes answer `401 {"error":"unauthorized"}` without a valid bearer token. If `MC_TOKEN` is unset, they are allowed only when `NODE_ENV` is `development` or `test`; in any other environment they are denied. A presented `akc_` token is checked even in those environments. A revoked, expired, or unknown agent credential is `401`. If the credential store is unreachable the answer is `503 {"error":"credential_store_unavailable"}`, which is retryable and is not a revocation. A valid one that lacks the route's scope is `403`:

```json
{ "error": "The credential does not have the tasks:write scope.", "code": "insufficient_scope", "fix": "Use a credential that has the tasks:write scope", "retryable": false }
```

The scope for each agent route is listed in [MCP.md](MCP.md). A route that is not in that table is denied to agent credentials. `MC_TOKEN` and the dashboard session can still call it. OAuth on `/api/mcp` is unchanged: a verified access token can call every mapped tool.

If `MC_DASHBOARD_PASSWORD` is unset, the gate is open in local development and on deploys with no `DATABASE_URL` (demo mode). A production build with `DATABASE_URL` set answers `503` on gated routes until the password is set.

## Routes

Machine-readable contract: [`GET /api/openapi.json`](/api/openapi.json) (OpenAPI 3.1). It covers the routes in this document. Adding a route under `src/app/api` without an entry fails `npm run test:ui`.

"Cookie or bearer" below means the `mc_auth` session cookie or `Authorization: Bearer <MC_TOKEN>`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/fleet` | Cookie or bearer | Everything the dashboard needs in one call |
| POST | `/api/ingest` | Bearer | Deterministic telemetry from hooks, watchers, and daemons |
| GET | `/api/memory` | Cookie or bearer | Memory browser feed |
| POST | `/api/memory` | Cookie or bearer | Store a note, or preview an overwrite with `dry_run` |
| GET | `/api/messages` | Cookie or bearer | Agent pulls its inbound inbox, or the full conversation |
| POST | `/api/messages` | Cookie or bearer | Operator enqueues an inbound message |
| PATCH | `/api/messages` | Cookie or bearer | Operator marks outbound replies read |
| POST | `/api/messages/reply` | Bearer | Non-MCP agents post replies |
| GET | `/api/progress` | Cookie or bearer | Everything the progress board needs |
| GET | `/api/progress/digest` | Cookie or bearer | The board as plain text, for schedulers and terminals. A failure is the JSON error body, not plain text. |
| GET | `/api/brief` | Cookie, bearer, or `progress:read` | Morning brief. `text/plain` by default; `Accept: application/json` for the object. `window` is `24h` (default) or `72h`. A failure is the JSON error body. |
| POST | `/api/progress/ingest` | Bearer | One collection tick from `scripts/collect-progress.sh` |
| GET | `/api/decisions` | Cookie or bearer | Decision queue, oldest first, each row with `age_days`. `shape=brief` is the morning-brief `.decisions` list |
| POST | `/api/decisions` | Cookie or bearer | Upsert one decision, or reconcile a collector sweep |
| PATCH | `/api/decisions/:id` | Cookie, bearer, or `decisions:write` | Record a decision, a deferral, or a withdrawal |
| GET | `/api/settings/repos` | Cookie or bearer | The repos the progress board watches |
| PUT | `/api/settings/repos` | Cookie or bearer | Replace the watched repos |
| GET | `/api/settings/credentials` | Session only | List agent credentials. No token and no hash |
| POST | `/api/settings/credentials` | Session only | Create one. The response includes `token` once |
| DELETE | `/api/settings/credentials` | Session only | Revoke by `{ "id" }` |
| GET | `/api/tasks` | Cookie or bearer | List tasks |
| POST | `/api/tasks` | Cookie or bearer | Create a task |
| POST | `/api/tasks/claim` | Cookie or bearer | Atomically claim the next queued task |
| PATCH | `/api/tasks/:id` | Cookie or bearer | Dispatchers report progress and completion; the dashboard cancels or requeues |
| POST | `/api/v1/traces` | Bearer | OTLP/HTTP JSON trace export |
| GET | `/api/traces` | Cookie or bearer | Trace summaries, newest first |
| GET | `/api/traces/:traceId` | Cookie or bearer | The spans of one trace |
| GET | `/api/usage` | Cookie or bearer | Usage ledger |
| POST | `/api/usage/ingest` | Bearer | Ingest usage facts |
| POST | `/api/login` | Own (rate-limited) | Dashboard password login |

### OAuth and discovery routes

These routes skip the cookie gate and enforce their own auth:

- `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/api/mcp` — discovery documents.
- `/oauth/register` — dynamic client registration (RFC 7591); public PKCE clients get no secret.
- `/oauth/authorize` — `authorization_code` + PKCE S256; the consent form is gated by the dashboard password; codes are single-use and live at most 5 minutes.
- `/oauth/token` — `authorization_code` and `refresh_token` grants.

The MCP endpoint and its OAuth flow are documented in [docs/MCP.md](MCP.md).

## Request and response details

### Fleet

`GET /api/fleet` returns everything the dashboard needs in one call.

### Ingest

`POST /api/ingest` takes deterministic telemetry from hooks, watchers, and daemons. It records liveness only; usage facts go to `POST /api/usage/ingest`.

Body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Agent id. |
| `kind` | string | yes | `session_start`, `turn_start`, `waiting`, `notification`, `session_end`, `milestone`, `status`, `error`, or `heartbeat`. |
| `platform` | string | no | `claude-code`, `cowork-cloud`, `chatgpt-work`, `codex`, `hermes`, or `other`. |
| `machine` | string | no | Machine the agent runs on. |
| `display_name` | string | no | Name to display for the agent. |
| `session_id` | string | no | Session id. |
| `title` | string | no | Short title for the event. |
| `detail` | object | no | Arbitrary detail object. |
| `project` | string | no | Project name. |
| `summary` | string | no | Summary text. |
| `status` | string | no | Explicit session status override. |

Invalid JSON answers `400`.

### Memory

`GET /api/memory?query=&tag=&limit=` is the memory browser feed. Default limit is 50.

`POST /api/memory` stores a note the same way MCP `remember` does. Body: `content` (required string), optional `key`, `tags` (array of strings), `agent_id`, and `dry_run`. `dry_run: true` returns `{ "dry_run": true, "applied": false, "would_write", "action": "overwrite_memory" | "insert_memory", "changes", "affected" }` and writes nothing. `action` is `overwrite_memory` when the key already exists. A non-boolean `dry_run` is `400` and writes nothing. With no database, a dry run still describes the note and sets `would_write` to false. An agent credential needs `memory:write`.

### Messages

- `GET /api/messages?agent_id=X&ack=true` — the agent pulls its inbound inbox; `ack` marks the messages read.
- `GET /api/messages?agent_id=X&conversation=true` — full history for the agent.
- `POST /api/messages` — body `{agent_id, body, created_by?}` — the operator enqueues an inbound message for the agent. The server sets `actor_type` and `actor_id` from the authenticated credential (`human` / `operator` for a dashboard session). When `MC_DASHBOARD_PASSWORD` is unset and the request presents no credential, both fields are null. `created_by` is stored as a label and does not set those fields. Optional header `Idempotency-Key`. The same key, the same actor, the same route, and the same body return the original message for 24 hours and do not insert a second row during that window. After 24 hours the same key starts a new write. The same key with a different body answers `409` `idempotency_conflict`. A claim still inside its 30 second lease answers `409` with `retryable: true` and `Retry-After`, the same as `POST /api/tasks`. The key is scoped by actor and route. A blank header is the same as omitting it.
- `PATCH /api/messages` — body `{agent_id}` — the operator marks outbound replies read.
- `POST /api/messages/reply` — bearer `MC_TOKEN` or an agent credential with `messages:write` — body `{agent_id, body, in_reply_to?, created_by?}` — non-MCP agents post replies. `in_reply_to` is the id of the inbound message being answered. `actor_type` and `actor_id` are taken from the bearer, not from `created_by`. Optional header `Idempotency-Key`. The same key, the same actor, the same route, and the same body return the original reply for 24 hours and do not insert a second row during that window. After 24 hours the same key starts a new write. The same key with a different body answers `409` `idempotency_conflict`. A claim still inside its 30 second lease answers `409` with `retryable: true` and `Retry-After`, the same as `POST /api/tasks`. The key is scoped by actor and route.

### Tasks

Task statuses: `queued`, `claimed`, `running`, `review`, `done`, `failed`, `cancelled`.

- `GET /api/tasks?status=open|all|<status>&limit=N` — list tasks. `status` is `open`, `all`, or one of the statuses above.
- `POST /api/tasks` — create a task. Body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | yes | Short imperative title. |
| `description` | string | no | Becomes the worker's prompt. |
| `project` | string | no | Repo or folder under the dispatcher's workdir. |
| `platform` | string | no | `claude-code`, `codex`, `grok`, `hermes`, `cowork-cloud`, or `any`. |
| `machine` | string | no | Pin the task to one machine's dispatcher. |
| `priority` | int | no | 1 high, 2 normal (default), 3 low. |
| `reviewer_platform` | string | no | `claude-code`, `codex`, or `grok`. A second platform reviews the work before done. |
| `created_by` | string | no | Free-text label. It is stored and does not set the actor. |
| `actor_type` | string | — | Response only. `human` or `agent`, from the authenticated credential. Null on older rows, and null when the local dashboard is open because `MC_DASHBOARD_PASSWORD` is unset and the request presented no credential. |
| `actor_id` | string | — | Response only. Credential id, `mc-token`, the OAuth client id, or `operator` for a signed-in dashboard session. Null in the same cases as `actor_type`. |

Optional header `Idempotency-Key`. The same key, the same actor, the same route, and the same body fields return the original task for 24 hours and do not insert a second row during that window. After 24 hours the same key starts a new write. The same key with different body fields answers `409` `idempotency_conflict`. While the first request is inside its 30 second lease, the same body answers `409` with `retryable: true`, a `Retry-After` header in seconds, and `retry_after` in the body. After that lease, the same key and the same arguments take over a claim that never stored a result and run the write once. The key is scoped by actor and route. Omit the header, or send it blank, to create a new task on every call. The key is not a body field.

- `POST /api/tasks/claim` — body `{platform, machine?, agent_id}`. `platform` and `agent_id` are required; the request answers `400` otherwise. The claim is atomic: it returns the next queued task routed to the given platform (or to `any`), or `{task: null}` when there is none.
- `PATCH /api/tasks/:id` — body `{status?, result?, cost_usd?, session_id?, assigned_agent?, agent_id?, dry_run?}`. Dispatchers use it to report progress and completion; the dashboard uses it to cancel or requeue tasks. `dry_run: true` returns the affected task and the field diff (`action` is `cancel_task` when status is `cancelled`) and does not update the row or write an activity event. A missing id is still `404`. A non-boolean `dry_run` is `400` and writes nothing.

### Progress

- `GET /api/progress?window=24h|7d|30d|90d` — everything the progress board needs. The data is read entirely from Postgres, never from GitHub.
- `GET /api/progress/digest?window=24h` — the board as plain text, for schedulers and terminals.
- `POST /api/progress/ingest` — bearer `MC_TOKEN` — one collection tick from `scripts/collect-progress.sh`. Body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `collected_at` | string | no | ISO8601 timestamp; set when backfilling. |
| `kind` | string | no | `tick`, `daily`, or `backfill`. |
| `repos` | array | yes | One entry per repo. |

Each entry in `repos`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `repo` | string | yes | Repo. |
| `label` | string | no | Label. |
| `open_issues` | number | no | Open issues. |
| `open_prs` | number | no | Open PRs. |
| `blocked_issues` | number | no | Blocked issues. |
| `merged_prs_24h` | number | no | PRs merged in the last 24 hours. |
| `issues_closed_24h` | number | no | Issues closed in the last 24 hours. |
| `issues_opened_24h` | number | no | Issues opened in the last 24 hours. |
| `total_issues_created` | number | no | Total issues created. |
| `total_issues_closed` | number | no | Total issues closed. |
| `total_prs_merged` | number | no | Total PRs merged. |
| `review_rounds` | number | no | Review rounds. |
| `no_verdict_rate` | number | no | No-verdict rate. |
| `detail` | object | no | `{lane_mix?, stalled_prs?, notes?, stuck_prs?, median_lead_hours?, stale_issues?, stale_ratio?, drafts?, merged_list?, merged?}`. The brief keys are optional. Older ticks omit them. |

### Brief

`GET /api/brief?window=24h` is the morning brief. `window` may be omitted (that means `24h`) or `72h`. `1h`, an empty `window`, a repeated `window`, `window[]`, or any other value is `400` with `code: "validation_failed"`, `fields.window`, and the usual `fix` and `retryable: false`. It is not a 500 and it does not fall through to 24h.

The success body is `text/plain; charset=utf-8` unless `Accept` lists `application/json` with a `q` strictly greater than the effective quality of `text/plain`. That quality is the `text/plain` `q` when it is listed, otherwise `text/*`, otherwise `*/*`. A missing `Accept`, `text/plain`, and `*/*` alone stay text. Equal quality stays text, including `application/json;q=0.5, */*;q=0.5`. `application/json;q=0` stays text. A success response sends `Vary: Accept` with `Cache-Control: private, max-age=0, s-maxage=60`. The JSON body is the brief object (`generated_at`, `window_hours`, `repo_source`, `thresholds`, `coordinator`, `incomplete_repos`, `totals`, `repos`, `stuck_prs`, `decisions`). It is not wrapped in `{demo: true}`.

Auth is the same as the other data routes. With `MC_DASHBOARD_PASSWORD` set, a session cookie or `MC_TOKEN` is required, and an agent credential needs `progress:read`. With the password unset, a caller with no credential is allowed (dev-open). An `akc_` token is still checked: unknown is `401`, and a credential without `progress:read` is `403` `insufficient_scope`. The error body is JSON even when the client asked for text, and it does not contain the brief.

Counts, stuck PRs, stale issues, and lead time come from the latest `repo_snapshots` row. There is no migration: the collector writes `detail.stuck_prs`, a 24h `detail.median_lead_hours`, `detail.stale_issues`, `detail.drafts`, a 24h `detail.merged_list`, and timestamped `detail.merged` for the 72h sweep. A row merged exactly 24 hours ago stays on `merged_list`. An older row stays on `merged` only. A 24h window reads the `*_24h` columns. A 72h window differences the cumulative counters against the snapshot at or before 72h earlier, and falls back to the 24h columns when that delta is null. The 72h median and shipped list are filtered from `detail.merged` by `merged_at`. A stored 24h `median_lead_hours` is not presented as a 72h median. The route does not call GitHub, so it cannot recompute a 72h lead time the way `scripts/morning-brief.sh` does when `detail.merged` is absent. An empty `detail.merged` array is measured and is not replaced by `merged_list`.

Decisions come from `GET /api/decisions?shape=brief` logic in-process. A row joins the watched repo whose `owner/name` equals `repo`. The short name is display only, so two watched repos that share a short name keep distinct sections. A repo listed in `incomplete_repos` (a brief-eligible row is missing `kind`, `labels`, `opened_at`, or `repo_short`) keeps an empty `decisions` array. The script still sweeps GitHub for that repo; this route has no sweep.

No snapshot, or a snapshot whose counts were not measured, is an incomplete section. The text says `DATA INCOMPLETE` and prints `-` for that repo's cells. It does not print the word `undefined` or `null`.

Fleet totals `merged_prs`, `issues_opened`, `issues_closed`, `net_backlog`, `open_issues`, `open_prs`, `stuck_prs`, and `decisions` are null when any watched repo is incomplete, or when a counted repo lacks that field. Zero is a measured empty set on every watched repo. The text then says `DATA INCOMPLETE` for that aggregate. It does not say `none`, `none open`, or a fleet `0`. Known stuck PRs, decisions, and shipped rows from counted repos are still listed. `repos_counted` and `repos_total` stay numbers. The coordinator verdict is its own measurement: an unreachable dashboard says `unknown`, and an incomplete repo does not change it. A null stale ratio or lead time on one repo prints `-` in that cell. It is not a fleet total.

`detail.stuck_prs` is optional. An absent key, or a value that is not an array, was not measured: the repo section stays complete, `repos[].stuck_prs` is null, the stuck column is `-`, and `totals.stuck_prs` is null. The text says `STUCK PRs: DATA INCOMPLETE.` Known stuck PRs from other counted repos are still listed under that line. `STUCK PRs: none.` is only a stored empty array on every watched repo. An incomplete watched repo makes the stuck total null even when every counted repo stored `stuck_prs: []`.

Decisions from an incomplete repo are not counted. When labels are configured and any watched repo is incomplete, or a counted repo lacks `decisions`, the text says `DECISIONS FOR YOU: DATA INCOMPLETE.` Known rows from counted repos are still listed. It does not say `DECISIONS FOR YOU: none open.` `none open` is only a measured empty list on every watched repo. When `brief.decisionLabels` is empty and there are no decision rows, the text says decisions are not tracked.

An empty `detail.merged` array is a measured empty window. The shipped list stays empty and the median is null. The brief does not fall back to `detail.merged_list` or the stored `median_lead_hours`. Those fields are used only when `detail.merged` is absent.

Coordinator liveness uses `brief.coordinator` in `progress.config.json`. `agentId` null omits the COORDINATOR section (`configured: false`). A configured agent is `working` only when the newest work event (`session_end`, `milestone`, or `status`, exact match, plus any other configured kind that is not in the excluded set) is within `maxSilenceHours`. The read is that newest configured work event, every `error` inside the silence window, and the single newest event of any kind. It is not the newest 200 other events. A burst of `turn_start` or `status_update` cannot hide a work event that is still inside the window, and it cannot hide the age of the newest work event once that event is older than the window. `heartbeat`, `telemetry`, `turn_start`, `status_update`, and `error` do not count as work, even when `workKinds` names them and even when `last_seen_at` is seconds old. A list that contains only those kinds falls back to `session_end`, `milestone`, and `status`. The work-event query receives that filtered list, so a configured `error` cannot be the newest work row. `status_update` is not `status`. An `error` in the silence window with no work event is `FAILING`, and the count is every error in that window. The text adds `(telemetry seen Nh ago)` from `last_seen_at` when that timestamp exists, including `0`.

`scripts/morning-brief.sh` remains the fallback. A scheduler should `curl` this route. `repo_source` is `dashboard` when the watched list came from the database and `config` when it came from `progress.config.json`.

### Decisions

The morning brief's decisions list comes from this table when every brief-eligible row for that repo has `kind`, `labels`, `opened_at`, and `repo_short`. Those rows are `source` `github-label`, `status` not `withdrawn`, and `github_present` not `false` (a null `github_present` still counts as present). `repo` is `owner/name`. `repo_short` is the config short name and is display only. The brief joins a row onto a watched repo by `owner/name`, so two repos that share a short name do not both receive the row. `age_hours` drops fractional seconds before `Z`, subtracts the unix times, and divides by 3600. `age_days` is `floor(age_hours / 24)` from `opened_at` (GitHub `createdAt`). GitHub `createdAt` is stored as `opened_at` and, on insert only, as `first_seen_at`.

A row created before those columns existed has them null. `shape=brief` does not treat that row as authoritative: it does not invent `kind: "issue"`, `labels: []`, an age from `first_seen_at`, or a `repo_short` from the repo basename. The response field `incomplete_repos` lists each `owner/name` with at least one such row. `scripts/morning-brief.sh` keeps the GitHub label sweep for those repos and still replaces every other watched repo from `decisions`. The collector's next upsert fills the null `kind`, `labels`, and `repo_short`, and fills a null `opened_at`. After that fill, the table replaces the sweep for that repo.

`GET /api/decisions?status=open&repo=&source=&limit=&shape=row` lists rows oldest-first by `first_seen_at`. `status` defaults to `open`. `open` also includes `deferred` rows whose `defer_until` is at or before now. `all` or one of `open`, `decided`, `deferred`, `withdrawn` is allowed. `limit` defaults to 500 and maxes at 1000. Each row includes `age_days`. `shape` defaults to `row`. `shape=brief` ignores `status` and `source`. `decisions` is the morning-brief list from complete rows only: `source` `github-label`, `status` not `withdrawn`, `github_present` not `false`, `number` set, and `kind`, `labels`, `opened_at`, and `repo_short` all set, oldest first. `incomplete_repos` is the repos with a brief-eligible row missing any of those four. `repo` and `limit` still apply to both. `scripts/morning-brief.sh` calls `GET /api/decisions?shape=brief&limit=1000` when `MC_URL` and `MC_TOKEN` are set. It replaces a watched repo's decisions from `decisions`, including when that repo's list is empty, and leaves a repo in `incomplete_repos` on the GitHub sweep. A failed call keeps the GitHub sweep for every repo. With a database the body is `{ "demo": false, "decisions": [...], "incomplete_repos": [...] }`.

`POST /api/decisions` upserts by `key`. Required: `key`, `source`, `title`. Optional: `repo` (`owner/name`), `repo_short`, `number`, `url`, `why`, `options`, `recommended`, `requested_by`, `kind` (`issue` or `pr`), `labels`, `opened_at`, `first_seen_at`, `github_present`, `force`. A later upsert refreshes `title` and `last_seen_at`. It fills a null `kind`, `labels`, or `repo_short`, and fills a null `opened_at`. It does not overwrite an `opened_at` or `first_seen_at` that is already set, or an existing `requested_by`. A `github-label` upsert that omits `github_present` stores `true`.

Status on that upsert:

- A new key is `open`.
- `decided` and `deferred` stay as they are. The answer text is left in place. The response includes `status_held: true`.
- `force: true` reopens a `decided` or `deferred` row to `open` and clears `decision`, `decided_by`, `decided_at`, and `defer_until`.
- `withdrawn` returns to `open` on an ordinary upsert, without `force`.
- A body field `status` is not how a row becomes `decided`. That is `PATCH`.

The other POST shape is `{ "reconcile": { "repo", "source", "seen_keys" } }`. It is mutually exclusive with `key`. `source` defaults to `github-label`. `seen_keys` may be empty and each key must start with `github:<repo>#`. For that repo and source, keys absent from `seen_keys` are updated and `last_seen_at` is not bumped. An absent key is an issue or PR that closed or lost the label. `open`, `deferred`, and `decided` become `withdrawn`. `defer_until` is cleared on `open` and `deferred`. `decision`, `decided_by`, and `decided_at` stay on a decided row. `github_present` becomes false. A row already `withdrawn` with `github_present` false is left alone. The response is `{ "ok": true, "reconciled", "withdrawn" }`.

`scripts/collect-progress.sh` POSTs one row per open issue or PR that carries a label in `brief.decisionLabels` (`key` `github:<repo>#<n>`, `source` `github-label`, `why` the matching labels joined with `", "`, `kind` `pr` when `gh` returned `isDraft`, `labels` the matching names, `opened_at` GitHub `createdAt`, `repo_short` the config short name). That POST is what backfills a legacy null `kind`, `labels`, `opened_at`, or `repo_short`. It then reconciles. It does not reconcile when `decisionLabels` is empty, when `gh` fails, when the issue list is longer than 2000 or the PR list is longer than 500, or when any upsert failed. `--backfill` does not sync decisions. `--dry-run` prints the decision JSON to stderr and does not POST, so stdout stays the progress payload.

`PATCH /api/decisions/:id` body is `{ "status"?, "decision"?, "decided_by"?, "defer_until"? }` with at least one of those fields. `id` is a positive integer. `status` is one of the four. `decided` requires non-empty `decision` text and sets `decided_at` to now. `deferred` requires `defer_until` as an ISO timestamp. `open` clears `decision`, `decided_by`, `decided_at`, and `defer_until`. `withdrawn` sets `github_present` false. `decided_by` is a body field. The route does not take it from the credential. An unknown id, when a database is connected, is `404` `not_found` with `error` `Decision not found`. This PATCH only records the row. Commenting on the GitHub issue and removing the label is issue #65, not this route.

Demo mode (no `DATABASE_URL`), after the body validates: `GET` returns `{ "demo": true, "decisions": [] }`. `POST` returns `{ "ok": true, "demo": true, "note": "DATABASE_URL not set; decision dropped" }`. `PATCH` returns `{ "ok": true, "demo": true }`.

### Settings

- `GET /api/settings/repos` returns `{ "source": "database" | "file", "writable": true, "max": 25, "version": "...", "repos": [{ "repo", "label", "short", "color", "blockedLabel" }] }`. `source` is `file` when no list has been saved yet, or when there is no database; `repos` is then the default from `progress.config.json`. The collector calls this on every tick.
- `PUT /api/settings/repos` with `{ "repos": [...], "version": "...", "dry_run": true }` replaces the whole list, in order, and returns the stored list in the same shape. `version` is optional; send the one from your last GET and the save is refused with `409 { "code": "stale" }` if someone changed the list since, so two open tabs cannot overwrite each other. The replace is a single SQL statement, so a failed save leaves the old list intact. It answers `400` with `errors: [{ "index", "field", "message" }]` when invalid (`index` is `-1` for an error about the whole list), and `409` with `code` `conflict` when no database is connected. Those bodies also include `error` (a string), `fix`, `retryable`, and `fields`. The `errors` array and `code: "stale"` stay. A list needs 1 to 25 repos, each `owner/name`, with a unique short name and a `#rrggbb` color. `dry_run: true` returns the diff against the list GET would show (`changes` for adds, removes, updates, and reorders) and writes nothing. A stale `version` is still `409`. With no database, a dry run returns that diff with `would_write: false` instead of `409`. A non-boolean `dry_run` is `400` and writes nothing.

Anyone with a dashboard session or `MC_TOKEN` can change this list, which matches the rest of the trust model (see [SECURITY.md](../SECURITY.md)). An agent credential cannot.

### Agent credentials

`GET /api/settings/credentials` returns `{ "credentials": [{ "id", "label", "token_prefix", "scopes", "created_at", "expires_at", "revoked_at", "last_used_at" }] }`. There is no `token` and no `token_hash`.

`POST /api/settings/credentials` with `{ "label", "scopes": ["tasks:read"], "expires_at": null }` creates one. `scopes` must be a non-empty subset of the scopes in [MCP.md](MCP.md). `expires_at` is optional and must be an ISO timestamp in the future. The response is `{ "credential": { ... , "token" } }`. `token` is only in this response. A bad body is `400 { "error" }`.

`DELETE /api/settings/credentials` with `{ "id" }` sets `revoked_at`. Unknown ids are `404`. Revoking again returns the same row.

A request that sends `Authorization`, including a valid `MC_TOKEN` or a valid agent credential, is `401`. With no dashboard password (local demo) a request that sends no `Authorization` header is allowed, the same way the rest of the dashboard is open. With a password set, the `mc_auth` cookie is required.

### Usage

Usage and Costs is experimental.

- `GET /api/usage?window=24h|7d|30d`, or `?since=ISO&until=ISO` — the usage ledger. The default window is a rolling 7 days.
- `POST /api/usage/ingest` — bearer `MC_TOKEN` — body `{collected_at?, kind?, facts: UsageFact[], snapshot?}`. This route is separate from `POST /api/ingest`, which is liveness only.

### Traces

See [Telemetry and traces](TELEMETRY.md) for the full contract.

- `POST /api/v1/traces` — bearer `MC_TOKEN` — an OTLP/HTTP JSON export. Answers `200 { partialSuccess: { rejectedSpans?, errorMessage? } }`. `415` for protobuf, `413` over 2 MB, `401` for a bad token.
- `GET /api/traces?agent=&errors=1&before=&limit=` — `{ demo, traces: TraceSummary[] }`.
- `GET /api/traces/:traceId` — `{ demo, spans: Span[] }`. With a database, an unknown or pruned trace is `404` `not_found`. Demo mode returns `200` and an empty `spans` list.

### Login

`POST /api/login` takes body `{password}` and, on success, establishes the `mc_auth` session cookie. A wrong password answers `401` with `"error": "wrong password"` and `code` `unauthorized`. The route allows 5 attempts per 10 minutes per client IP, shared with the OAuth consent form; past that it answers `429` with a `Retry-After` header in seconds and `code` `rate_limited`. The limiter is in memory and per serverless instance.

## Errors

REST JSON errors use one flat shape. `error` stays a string. The other fields are added beside it:

```json
{ "error": "title is required", "code": "missing_field", "fix": "Add the fields listed in fields and send the request again.", "retryable": false, "fields": { "title": "title is required" } }
```

`fields` is omitted when there is nothing to correct field by field. A route that already returned extra keys still returns them. `PUT /api/settings/repos` still returns `errors` and, when the list is stale, `code` `stale`.

HTTP status stays the status in the table. A 500 logs the exception on the server and answers `internal_error` with `retryable: true` and a generic `error` string. The exception text is not in the body.

OAuth routes (`/oauth/*`) keep the OAuth RFC error format. They are not this shape. `/api/mcp` still answers `401` with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource` when the bearer is missing or invalid. That 401 is the MCP SDK's response, not this body.

`task_not_claimable` is defined so a caller can handle it. No route returns it. An empty claim is HTTP 200 `{ "task": null }`.

| Code | Status | Retryable | When |
| --- | --- | --- | --- |
| `unauthorized` | 401 | no | Missing or invalid bearer on an ingest route, or a wrong dashboard password (`error` is `wrong password` on `POST /api/login`, and `unauthorized` on the ingest routes). |
| `insufficient_scope` | 403 | no | An agent credential is valid but lacks the scope for the tool or route. |
| `credential_store_unavailable` | 503 | yes | An `akc_` credential was presented and the credential store could not be read. Not a revocation; retry. Its body is `{ "error": "credential_store_unavailable" }` only. |
| `forbidden` | 403 | no | `POST /api/messages/reply` when `in_reply_to` names a message that belongs to a different agent. |
| `identity_mismatch` | 403 | no | MCP `run_skill` when an agent credential or an OAuth client passes an `agent_id` other than the authenticated id. The call writes no run. Omit `agent_id`, or pass that id. |
| `not_found` | 404 | no | Unknown trace id on `GET /api/traces/:traceId` when a database is connected (demo mode returns 200 and an empty `spans` list), `POST /api/messages/reply` when `in_reply_to` names a message that does not exist, or `PATCH /api/decisions/:id` when a database is connected and that id does not exist (`error` stays `Decision not found`). Demo mode does not look the decision id up. |
| `validation_failed` | 400 | no | A field is present but not usable: a bad `before` on `GET /api/traces`, a bad `since` and `until` pair on `GET /api/usage` (a `since` without `until` is ignored), a bad `collected_at` on usage or progress ingest, a bad task, trace, or decision id, a decision body or `status` the parser rejected, a privacy refusal, an OTLP body the parser rejected, or an idempotency key longer than 200 characters or containing a control character. |
| `invalid_json` | 400 | no | The body is not JSON. On `POST /api/login` the `error` string stays `invalid request`. On `POST /api/mcp` an empty or non-JSON body uses this code and `error` `invalid JSON`. A missing bearer on that route is still `401` with `WWW-Authenticate`. |
| `missing_field` | 400 | no | A required field is absent. `fields` names it. |
| `rate_limited` | 429 | yes | More than 5 `POST /api/login` attempts in 10 minutes from one client IP. `Retry-After` is seconds. The OAuth consent form shares this limiter and answers with HTML, not this JSON. |
| `conflict` | 409 | no | `PUT /api/settings/repos` when no database is connected. |
| `idempotency_conflict` | 409 | no | `POST /api/tasks`, `POST /api/messages`, or `POST /api/messages/reply` reused an `Idempotency-Key` with different arguments, or the first request with that key is still inside its 30 second lease. MCP `create_task` and `reply_to_operator` (and its `reply_to_mark` alias) return the same code. The same key, the same actor, the same route, and the same arguments return the original result for 24 hours. Different arguments stay `retryable: false`. While the first request is inside its 30 second lease, the same arguments are `retryable: true` and the response carries `Retry-After` in seconds plus `retry_after` in the body. After that lease, the same key and the same arguments take over a claim that never stored a result and run the write once. A claim insert whose result is lost is re-read, and the write runs once when this attempt owns the claim. The resource insert and the stored response commit in one statement, and that insert runs only while this attempt's claim token still matches. A committed write therefore has a stored response. A retry returns that response and does not insert another row while the claim is inside its 24 hour window. A caller that dies before reading the response gets the same row on retry. After that window the same key starts a new write. The key is scoped by actor and route. |
| `stale` | 409 | no | `PUT /api/settings/repos` when `version` does not match the list currently stored. |
| `task_not_found` | 404 | no | `PATCH /api/tasks/:id` when a database is connected and that id does not exist, or MCP `update_task` when the id does not exist in the database or, in demo mode, in the in-memory store. `error` stays `Task not found`. REST demo mode does not look the id up and answers `{ "ok": true, "demo": true }`. |
| `task_not_claimable` | 409 | no | Defined, not returned. See above. |
| `memory_key_invalid` | 400 | no | MCP `remember` or `recall` when `key` is empty, longer than 200 characters, or contains a control character. |
| `repo_list_invalid` | 400 | no | `PUT /api/settings/repos` when the list fails validation. `errors` is unchanged. |
| `payload_too_large` | 413 | no | `POST /api/v1/traces` over 2 MB. |
| `unsupported_media_type` | 415 | no | `POST /api/v1/traces` when the body is not JSON. |
| `setup_required` | 503 | no | Messaging routes or `POST /api/usage/ingest` when those tables are missing, or a production `/api/*` request when a database is set and `MC_DASHBOARD_PASSWORD` is not (other pages are `text/plain`). `GET /api/usage` stays HTTP 200 with `setup_required: true` and no `code`. Messaging and usage-ingest bodies keep `setup_required` and `message`. |
| `internal_error` | 500 | yes | Anything else that failed while handling the request. `GET /api/progress/digest` uses this JSON body too. Success from that route stays `text/plain`. |

`fix` tells the caller what to change. It is a sentence, specific to the code, and overridable per response when the default would be the wrong instruction (a wrong dashboard password does not ask for `MC_TOKEN`).

## Demo mode

With no `DATABASE_URL` set (demo mode):

- The auth gate is open.
- GET routes return demo data, usually with `demo: true` in the response. `GET /api/decisions` returns `{ "demo": true, "decisions": [] }`.
- Ingest routes answer `{"ok": true, "demo": true}` and drop the data. `POST /api/decisions` does the same and adds `note`. `PATCH /api/decisions/:id` answers `{ "ok": true, "demo": true }` and does not look the id up.
- MCP `report_status`, `remember`, `create_task`, `claim_task`, and `update_task` store in memory for this process. `get_fleet_status`, `recall`, and `get_task_queue` read that store. Successful text starts with `[demo — in-memory, cleared when this process restarts]`. The store is cleared when the process restarts. Those rows are not mixed into the sample data on GET routes.
- REST `POST` and `PATCH` in demo mode still answer `{ "ok": true, "demo": true }` (memory adds `note`) and do not write the in-memory store.

## Versioning

REST routes except the OAuth routes are versioned with the app and follow semver from 1.0.

## Examples

Replace `https://YOUR-DEPLOY.vercel.app` and `YOUR_MC_TOKEN` with your values.

### Ingest

```sh
curl -X POST https://YOUR-DEPLOY.vercel.app/api/ingest \
  -H "Authorization: Bearer YOUR_MC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "cowork-cloud",
    "kind": "session_start",
    "title": "Starting shift",
    "platform": "cowork-cloud",
    "machine": "cloud"
  }'
```

### Create a task

```sh
curl -X POST https://YOUR-DEPLOY.vercel.app/api/tasks \
  -H "Authorization: Bearer YOUR_MC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix the flaky login test",
    "description": "Run the test suite, find the flake, and fix it.",
    "project": "web",
    "platform": "claude-code",
    "priority": 2
  }'
```

### Claim a task

```sh
curl -X POST https://YOUR-DEPLOY.vercel.app/api/tasks/claim \
  -H "Authorization: Bearer YOUR_MC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform": "claude-code", "agent_id": "cowork-cloud"}'
```

Returns `{task: null}` when the queue is empty.
