# Agent Kontrol REST API

## Authentication

Three credentials protect Agent Kontrol:

- The dashboard password (env `MC_DASHBOARD_PASSWORD`) gates the UI and the data routes through a session cookie named `mc_auth`. Callers get the cookie by posting the password to `POST /api/login`. The session can do everything an operator can do, including issuing agent credentials.
- `MC_TOKEN` is a static bearer token. It has every scope. Data routes accept `Authorization: Bearer <MC_TOKEN>` as an alternative to the cookie, and the ingest routes require a bearer.
- An agent credential is a token shaped `akc_` plus 32 random bytes, base64url. Settings shows it once. It can call only the MCP tools and REST routes its scopes allow. It cannot call `GET`/`POST`/`PATCH`/`DELETE /api/settings/credentials`, and neither can `MC_TOKEN`.

Secrets in query strings (`?key=`) are not supported. Send tokens in the `Authorization` header. Agent credentials are not accepted in the query string.

The `agent_credentials` table stores the label, the first 8 characters of the token, the SHA-256 hex of the full token, the scopes, and timestamps (`created_at`, `expires_at`, `revoked_at`, `last_used_at`). It does not store the token, prompts, or tool input or output. If the `last_used_at` write fails, the request still completes. With no `DATABASE_URL`, the same rules run against an in-memory list that is not shared across processes.

### Auth by route group

| Route group | Accepted credentials |
| --- | --- |
| Dashboard UI and data routes (default) | Session cookie `mc_auth`, or `Authorization: Bearer <MC_TOKEN>` |
| `GET` and `POST /api/decisions` | Session cookie or `MC_TOKEN` only. An agent credential is denied, including one that holds `decisions:write` |
| `GET /api/activity` | Session cookie or `MC_TOKEN` only. An agent credential is denied, including one that holds `fleet:read`. Same boundary as `GET /api/traces` |
| `PATCH /api/decisions/:id` | Session cookie, `MC_TOKEN`, or an agent credential with `decisions:write` |
| `POST /api/decisions/:id/writeback` | Session cookie, `MC_TOKEN`, or an agent credential with `decisions:write` |
| Ingest routes: `POST /api/v1/traces`, `POST /api/ingest`, `POST /api/messages/reply`, `POST /api/progress/ingest`, `POST /api/usage/ingest`, `POST /api/brief/alerts/evaluate` | `Authorization: Bearer <MC_TOKEN>`, or an agent credential whose scope covers the route (`status:write` for `POST /api/ingest`, `messages:write` for `POST /api/messages/reply`); the other ingest routes, including alert evaluate, take `MC_TOKEN` only |
| MCP transport: `/api/mcp` | `Authorization: Bearer <MC_TOKEN>`, an agent credential, or an OAuth access token (JWT) issued by this server |
| `GET /api/skill-bundles` | Session cookie or `MC_TOKEN` only. An agent credential is denied, including one that holds `skills:read` or `skills:write` |
| Credential management: `GET`/`POST`/`PATCH`/`DELETE /api/settings/credentials` | Dashboard session only |
| `POST /api/watch/beat`, `GET /api/watch/beats` | Verified `akc_` credential only. `watch:write` for the POST, `watch:read` for the GET. `MC_TOKEN`, the dashboard session, an OAuth access token, and a caller allowed only because the dashboard password is unset are `401` |
| `POST /api/sweep`, `POST /api/sweep/consumers` | `Authorization: Bearer <MC_TOKEN>`, or the dashboard session cookie when `MC_DASHBOARD_PASSWORD` is set. An agent credential, an OAuth token, and a caller allowed only because the password is unset are refused (`403` `trusted_writer_required`, `403` `insufficient_scope`, or `401`) |
| `GET /api/sweep` | Session cookie, `MC_TOKEN`, or an agent credential with `progress:read`. Read-only |
| Sweeper observations on `POST /api/ingest` (`kind` `sweep.scheduler_job`, `sweep.queue`, `sweep.pr_snapshot`) | `Authorization: Bearer <MC_TOKEN>` only. An agent credential with `status:write`, an OAuth token, and a dev-open caller are `403` `trusted_writer_required` and nothing is written |
| `POST /api/webhooks/github` (exact path) | A valid `X-Hub-Signature-256` HMAC under `MC_GITHUB_WEBHOOK_SECRET`, and nothing else. A session cookie, `MC_TOKEN`, an agent credential, or an OAuth token does not stand in for it. Neighboring paths stay behind the dashboard gate |
| Login, OAuth, and discovery: `/login`, `/api/login`, `/oauth/*`, `/.well-known/*` | No cookie gate; these routes enforce their own auth |
| Public agent docs: `GET /llms.txt`, `GET /docs/mcp.md`, `GET /docs/api.md`, `GET /docs/agents.md` | None. Any other `/docs` name stays behind the dashboard gate |

Ingest routes answer `401 {"error":"unauthorized"}` without a valid bearer token. If `MC_TOKEN` is unset, they are allowed only when `NODE_ENV` is `development` or `test`; in any other environment they are denied. A presented `akc_` token is checked even in those environments. A revoked, expired, or unknown agent credential is `401`. If the credential store is unreachable the answer is `503 {"error":"credential_store_unavailable"}`, which is retryable and is not a revocation. A valid one that lacks the route's scope is `403`:

```json
{ "error": "The credential does not have the tasks:write scope.", "code": "insufficient_scope", "fix": "Use a credential that has the tasks:write scope", "retryable": false }
```

### Request limits for agent credentials

Each agent credential has two request limits: requests per minute and requests per day. The defaults are 60 per minute and 10,000 per day. Each limit is a whole number from 1 to 1,000,000; there is no unlimited setting. Credentials created before this feature get the defaults. These are request quotas, not spend or billing limits.

- One unit is one HTTP request that passed authentication and the scope check. A `401` or `403` costs nothing. On `/api/mcp`, an `initialize`, a notification, a POST batch, a `GET` that opens the stream, and a `DELETE` are each one request; tool calls inside a request are not counted separately. A held stream does not count again. A reconnect is a new request.
- The minute window is the clock minute. The day window is the UTC calendar day and resets at 00:00 UTC. Both are fixed windows, counted by the database clock.
- A request is allowed only when both windows have room. An allowed request counts against both. A refused request counts against neither.
- Over a limit, the answer is `429` with a `Retry-After` header in whole seconds (at least 1) and a body of `{ "error", "code": "rate_limited", "fix", "retryable": true, "retry_after", "window": "minute" | "day", "limit" }`. When both windows are full, `Retry-After` waits for the later reset. The same answer comes back from the REST routes, `/api/mcp`, and the watch routes.
- If the quota cannot be read or written, the answer is `503 {"error":"credential_store_unavailable"}`. There is no in-process fallback when a database is configured.
- `MC_TOKEN`, the dashboard session, OAuth access tokens, and callers allowed only because the dashboard password is unset are not metered. An `akc_` bearer is checked before the session cookie, so a request that sends both is metered.
- Change the limits in Settings, or with `PATCH /api/settings/credentials`. Requests already counted in the current minute and day still count after a change.

The scope for each agent route is listed in [MCP.md](MCP.md). A route that is not in that table is denied to agent credentials. `MC_TOKEN` and the dashboard session can still call it, except `POST /api/watch/beat` and `GET /api/watch/beats`: those two accept only a verified `akc_` credential, and the other principals are `401`. OAuth on `/api/mcp` is unchanged: a verified access token can call every mapped tool.

If `MC_DASHBOARD_PASSWORD` is unset, the gate is open in local development and on deploys with no `DATABASE_URL` (demo mode). A production build with `DATABASE_URL` set answers `503` on gated routes until the password is set.

## Routes

Machine-readable contract: [`GET /api/openapi.json`](/api/openapi.json) (OpenAPI 3.1). It covers the routes in this document. Adding a route under `src/app/api` without an entry fails `npm run test:ui`.

"Cookie or bearer" below means the `mc_auth` session cookie or `Authorization: Bearer <MC_TOKEN>`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/fleet` | Cookie or bearer | Everything the dashboard needs in one call |
| GET | `/api/activity` | Session or MC_TOKEN | Write receipts and other events, newest first. An agent credential is denied, including `fleet:read`. Filters: `actor`, `kind`, `since`, `until`. Same `limit`, `cursor`, and `fields` rules as the other lists. Default limit 50. |
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
| GET | `/api/brief/alerts` | Cookie, bearer, or `progress:read` | Threshold conditions and whether each was sent. Does not send. |
| POST | `/api/brief/alerts/evaluate` | Bearer `MC_TOKEN` only | Compute the same conditions. Sends only when `brief.alerts.enabled` is true. |
| POST | `/api/progress/ingest` | Bearer | One collection tick from `scripts/collect-progress.sh` |
| GET | `/api/decisions` | Cookie or bearer | Decision queue, oldest first, each row with `age_days`. `shape=brief` is the morning-brief `.decisions` list |
| POST | `/api/decisions` | Cookie or bearer | Upsert one decision, or reconcile a collector sweep |
| PATCH | `/api/decisions/:id` | Cookie, bearer, or `decisions:write` | Record a decision, a deferral, or a withdrawal, and write a decision back to GitHub |
| POST | `/api/decisions/:id/writeback` | Cookie, bearer, or `decisions:write` | Retry the GitHub comment without deciding the row again |
| GET | `/api/settings/repos` | Cookie or bearer | The repos the progress board watches |
| PUT | `/api/settings/repos` | Cookie or bearer | Replace the watched repos. Auto-discovered rows omitted from the body stay |
| PATCH | `/api/settings/repos` | Cookie or bearer | Pin or hide one watched repo |
| GET | `/api/settings/owners` | Cookie or bearer | GitHub owners whose repos are discovered |
| PUT | `/api/settings/owners` | Cookie or bearer | Replace the watched owners. Does not delete tracked repos |
| POST | `/api/settings/owners/discover` | Cookie or bearer | Apply one collector tick of `gh repo list` results |
| GET | `/api/settings/credentials` | Session only | List agent credentials. No token and no hash |
| POST | `/api/settings/credentials` | Session only | Create one. The response includes `token` once. Optional `rate_limit_per_minute` and `rate_limit_per_day` (whole numbers from 1 to 1,000,000; omitted or `null` is 60 and 10,000) |
| PATCH | `/api/settings/credentials` | Session only | Change limits: `{ "id", "rate_limit_per_minute"?, "rate_limit_per_day"? }` with at least one limit. A limit left out keeps its value. Unknown fields, `null`, strings, fractions, zero, negatives, and values over 1,000,000 are `400`. Unknown id is `404`. Counted requests are kept |
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
| GET | `/api/skill-bundles` | Session or MC_TOKEN | Download a gzip tar of the skill tree for one runtime. Operator only |
| POST | `/api/login` | Own (rate-limited) | Dashboard password login |
| POST | `/api/watch/beat` | `akc_` `watch:write` | Store one host liveness beat. The credential must be bound to `source` |
| GET | `/api/watch/beats` | `akc_` `watch:read` | Every host beat, with `age_s` from the database clock. `Cache-Control: no-store` |
| POST | `/api/webhooks/github` | GitHub HMAC signature | Store one signed GitHub delivery in `gh_events`, once per `X-GitHub-Delivery`. See [EVENTS.md](EVENTS.md) |

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

Each stored event records who sent it in `events.principal_kind` and `events.principal_id`, taken from the verified credential: `legacy`/`mc-token`, `agent`/the credential id, `oauth`/the client id (MCP), or `session`/`operator`. Fields with those names in the body are ignored. A caller allowed only because `MC_TOKEN` is unset in development stores null, and so does every event written before this column existed: those rows are unmeasured for the sweeper's consumer liveness. Nothing else about ordinary telemetry changes.

#### Sweeper observations

Three reserved kinds carry trusted evidence for the absence sweeper (see [VELOCITY.md](VELOCITY.md#absence-sweeper)). Only `MC_TOKEN` may send them; `/api/ingest` has no credential bound to a collector yet. The body is `{ "agent_id": "<reporter label>", "kind": "<kind>", "observation": { ... } }`. `agent_id` is an audit label, not provenance.

| `kind` | `observation` |
| --- | --- |
| `sweep.scheduler_job` | `source`, `job_id`, `state` (`active` or `paused`), `transition` (the source's monotonic transition id for the job), `observed_at`, and for a pause `paused_at`, `paused_reason` (500 max), `until`; `decision` is the citation for this transition. Optional `stale_after_minutes` (5 to 1440): default 30 on a new transition; omitted on a refresh of the same transition, the stored window is kept. |
| `sweep.queue` | `source`, `queue` (stored lowercase), `classification` (`issue_dispatch` or `pr_review`), `repo`, `seq`, `observed_at`, `complete`, `error`, `ready {count, refs}`, `raw {count, refs}` (50 refs max). A complete observation needs both counts. |
| `sweep.pr_snapshot` | `source`, `repo`, `seq`, `observed_at`, `complete`, `error`, and `prs`: every open PR (200 max) with `number`, `draft`, `opened_at`, `mergeable` (`mergeable`, `conflicting`, `unknown`), `head_sha`, `required_checks {state, head_sha}`, `review {started, head_sha}`, and optional `title`, `url`. |

Every field is validated before any write and unknown fields are `400` `validation_failed`. A citation is `decision:<id>`, `owner/name#<n>`, an `https` URL, or `doc:<path>`, at most 300 characters; the syntax check does not prove an approval. The audit row (`sweep_observations`) and the projection commit in one transaction, stamped with the database receipt time. The answer names the outcome:

- `applied`: newer than what is stored.
- `refreshed`: the same scheduler transition with a later `observed_at` than the stored one. A non-null field adds or replaces; an omitted or null field keeps the stored value, so a refresh cannot drop a citation. Only a refresh renews the job's freshness. A different `state` on the same transition is `409` `conflict` and writes nothing.
- `older` or `replay`: a lower or equal `transition`/`seq`, or for a scheduler job the same transition with an earlier (`older`) or equal (`replay`) `observed_at`. Audited; the projection keeps the newer state, including a newer failure, a corrected `until`, and its freshness. Retrying after a lost response is a `replay`. Two reports of one transition at the same `observed_at` whose non-null fields differ are `409` `conflict`; a correction needs a later `observed_at`.

`complete: false` is stored as unknown, never as zero, and an older success does not replace it. Any other kind starting with `sweep.`, or named after a synthetic sweeper event (`consumer-silent`, `pr-stuck-cleared`, ...), is reserved: `403` for those callers and `400` for `MC_TOKEN`.

### Sweeper

`POST /api/sweep` runs the absence sweeper once and returns `{ ok, checks, retention }`. The body is ignored; there is no caller clock. Each entry in `checks` has `check`, `state` (`firing`, `clear`, `held`, `unknown`, `not_configured`), `evaluated_at` (the database instant), `counts`, `emitted` (delivery ids written), `entities` (100 max), `complete`, `unvisited`, and `error`. A check that failed is `unknown` with an error and does not stop the others. The status is `200` whenever the run finished; read each check. `retention` reports `deleted`, `batches`, `complete`, and `error`.

`POST /api/sweep/consumers` registers or updates one consumer: `id`, `agent_ids`, `reporters` (`[{ "kind": "agent", "id": "<credential id>" }]`), `queue` (`{ "type": "tasks", "platform": "codex" }` or `{ "type": "collector", "queue": "issues:owner/name" }`), optional `scheduler { source, job_id }`, `enabled`, `max_silence_hours` (default 3). There are no implicit registrations. `registered_at` is set once.

`GET /api/sweep` is read-only status: `consumers` (200 max), active `latches` (500 max), and `paused` (the brief's Paused section, by database time), plus `errors` for any part that could not be read. `consumers_truncated` and `latches_truncated` say when a list is partial. More than 1,000 scheduler jobs makes `paused` unmeasured (DATA INCOMPLETE), never a partial count.

### Memory

`GET /api/memory?query=&tag=&limit=&cursor=&fields=` is the memory browser feed. Default limit is 50. `limit` is an integer from 1 to 200. `cursor` is the opaque `next_cursor` from the previous page. `fields` is a comma-separated allowlist (`id`, `key`, `content`, `tags`, `agent_id`, `source`, `facts_at`, `created_at`, `updated_at`); `id` is always returned. See [List pages](#list-pages).

`POST /api/memory` stores a note the same way MCP `remember` does. Body: `content` (required string), optional `key`, `tags` (array of strings), `agent_id`, `dry_run`, and `expected_revision`. `dry_run: true` returns `{ "dry_run": true, "applied": false, "would_write", "action": "overwrite_memory" | "insert_memory", "changes", "affected", "expected_revision" }` and writes nothing. `action` is `overwrite_memory` when the key already exists. `expected_revision` is the md5 of the memory row from the same read as the preview, or the literal `absent` when the key has no row. Send that token on the confirm. When it no longer matches, the route answers `409` with `error` and `code` `stale_write`, plus `current_revision`, and writes nothing. Omit `expected_revision` and the write stays unconditional, with the same response shape as before. An empty string, a non-string, or a value longer than 200 characters is `400` and writes nothing. A non-boolean `dry_run` is `400` and writes nothing. With no database, a dry run still describes the note and sets `would_write` to false. A confirm that omits `expected_revision` still answers `{ "ok": true, "demo": true, "applied": false, "note": "DATABASE_URL not set; note not stored." }` and does not store the note. An agent credential needs `memory:write`.

### Messages

- `GET /api/messages?agent_id=X&ack=true` — the agent pulls its inbound inbox; `ack` marks the messages read.
- `GET /api/messages?agent_id=X&conversation=true` — full history for the agent.
- `POST /api/messages` — body `{agent_id, body, created_by?}` — the operator enqueues an inbound message for the agent. `body` is at most 8000 characters. A longer body is `400` `validation_failed` and stores nothing. The server sets `actor_type` and `actor_id` from the authenticated credential (`human` / `operator` for a dashboard session). When `MC_DASHBOARD_PASSWORD` is unset and the request presents no credential, both fields are null. `created_by` is stored as a label and does not set those fields. Optional header `Idempotency-Key`. The same key, the same actor, the same route, and the same body return the original message for 24 hours and do not insert a second row during that window. After 24 hours the same key starts a new write. The same key with a different body answers `409` `idempotency_conflict`. A claim still inside its 30 second lease answers `409` with `retryable: true` and `Retry-After`, the same as `POST /api/tasks`. The key is scoped by actor and route. A blank header is the same as omitting it.
- `PATCH /api/messages` — body `{agent_id}` — the operator marks outbound replies read.
- `POST /api/messages/reply` — bearer `MC_TOKEN` or an agent credential with `messages:write` — body `{agent_id, body, in_reply_to?, created_by?}` — non-MCP agents post replies. `in_reply_to` is the id of the inbound message being answered. `actor_type` and `actor_id` are taken from the bearer, not from `created_by`. Optional header `Idempotency-Key`. The same key, the same actor, the same route, and the same body return the original reply for 24 hours and do not insert a second row during that window. After 24 hours the same key starts a new write. The same key with a different body answers `409` `idempotency_conflict`. A claim still inside its 30 second lease answers `409` with `retryable: true` and `Retry-After`, the same as `POST /api/tasks`. The key is scoped by actor and route.

### Tasks

Task statuses: `queued`, `claimed`, `running`, `review`, `done`, `failed`, `cancelled`.

- `GET /api/tasks?status=open|all|<status>&limit=N&cursor=&fields=` — list tasks. `status` is `open`, `all`, or one of the statuses above. Default limit is 100. `limit` is an integer from 1 to 200. Sort is status ascending, priority ascending, `updated_at` descending, then `id` ascending when a page was requested. `fields` may name `id`, `title`, `description`, `project`, `platform`, `machine`, `priority`, `status`, `reviewer_platform`, `assigned_agent`, `session_id`, `result`, `cost_usd`, `created_by`, `actor_type`, `actor_id`, `created_at`, `claimed_at`, `updated_at`, `completed_at`. `id` is always returned. See [List pages](#list-pages).
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
- `PATCH /api/tasks/:id` — body `{status?, result?, cost_usd?, session_id?, assigned_agent?, agent_id?, dry_run?, expected_revision?}`. Dispatchers use it to report progress and completion; the dashboard uses it to cancel or requeue tasks. `dry_run: true` returns the affected task, the field diff (`action` is `cancel_task` when status is `cancelled`), and `expected_revision`. It does not update the row or write an activity event. `expected_revision` is the md5 of the task row from the same read as the preview. Send that token on the confirm. When it no longer matches, the route answers `409` with `error` and `code` `stale_write`, plus `current_revision`, and writes nothing. Omit `expected_revision` and the update stays unconditional, with the same response shape as before. A missing id is still `404`, including when `expected_revision` names a task that is already gone. An empty string, a non-string, or a value longer than 200 characters is `400` and writes nothing. A non-boolean `dry_run` is `400` and writes nothing. With no database, a dry run returns `would_write` false. A confirm that omits `expected_revision` still answers `{ "ok": true, "demo": true }` and does not update a task.

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

Counts, stuck PRs, stale issues, and lead time come from the latest `repo_snapshots` row. There is no migration: the collector writes `detail.stuck_prs`, a 24h `detail.median_lead_hours`, `detail.stale_issues`, `detail.drafts`, a 24h `detail.merged_list`, and timestamped `detail.merged` for the 72h sweep. A row merged exactly 24 hours ago stays on `merged_list`. An older row stays on `merged` only. A 24h window reads the `*_24h` columns. A 72h window differences the cumulative counters against the snapshot at or before 72h earlier, and falls back to the 24h columns when a baseline counter is missing. A cumulative counter that is lower than its baseline is a reset or rollback: that window's delta is null, the 24h column is not substituted, and the brief does not clamp the delta to 0. The repo section is incomplete, `errors` includes `cumulative counter decreased`, and the text says `DATA INCOMPLETE`. The 72h median and shipped list are filtered from `detail.merged` by `merged_at`. A stored 24h `median_lead_hours` is not presented as a 72h median. The route does not call GitHub, so it cannot recompute a 72h lead time the way `scripts/morning-brief.sh` does when `detail.merged` is absent. An empty `detail.merged` array is measured and is not replaced by `merged_list`. When `detail.merged` is absent, a 72h `merged_list` is null. A positive merge delta then does not print an empty `SHIPPED — <label>:` heading. The text says `SHIPPED: DATA INCOMPLETE — <label>`. `scripts/morning-brief.sh` prints that same line when it renders a repo whose `merged_prs` is positive and whose `merged_list` is not an array. An empty array still prints no heading.

Decisions come from `GET /api/decisions?shape=brief` logic in-process, read with `limit` 1000. A result whose length is that limit can hide another row, so the read is incomplete: every counted repo's `decisions` stays null, `errors` includes `decisions incomplete`, `totals.decisions` is null, and the text says `DECISIONS FOR YOU: DATA INCOMPLETE.` The partial page is not published as the list and is not a count. A shorter result is measured. A row joins the watched repo whose `owner/name` equals `repo`. The short name is display only, so two watched repos that share a short name keep distinct sections. A repo listed in the decisions `incomplete_repos` (a brief-eligible row is missing `kind`, `labels`, `opened_at`, or `repo_short`) is not a measured empty list on this route: the snapshot does not carry decisions, so that section's `decisions` stays null, `errors` includes `decisions incomplete`, and the brief's `incomplete_repos` names the repo. Its snapshot counts stay measured. The script still sweeps GitHub for that repo and keeps the sweep; this route has no sweep. A missing `decisions` relation, or any failed decisions query, is the same kind of hole on every counted repo (`decisions unavailable`), not an empty list.

No snapshot, or a snapshot whose counts were not measured, is an incomplete section. The text says `DATA INCOMPLETE` and prints `-` for that repo's cells. It does not print the word `undefined` or `null`.

Fleet totals `merged_prs`, `issues_opened`, `issues_closed`, `net_backlog`, `open_issues`, `open_prs`, `stuck_prs`, and `decisions` are null when any watched repo is incomplete, or when a counted repo lacks that field. Zero is a measured empty set on every watched repo. The text then says `DATA INCOMPLETE` for that aggregate. It does not say `none`, `none open`, or a fleet `0`. Known stuck PRs, decisions, and shipped rows from counted repos are still listed. `repos_counted` and `repos_total` stay numbers. The coordinator verdict is its own measurement: an unreachable dashboard says `unknown`, and an incomplete repo does not change it. A null stale ratio or lead time on one repo prints `-` in that cell. It is not a fleet total.

`detail.stuck_prs` is optional. An absent key, or a value that is not an array, was not measured: the repo section stays complete, `repos[].stuck_prs` is null, the stuck column is `-`, and `totals.stuck_prs` is null. The text says `STUCK PRs: DATA INCOMPLETE.` Known stuck PRs from other counted repos are still listed under that line. `STUCK PRs: none.` is only a stored empty array on every watched repo. An incomplete watched repo makes the stuck total null even when every counted repo stored `stuck_prs: []`.

Decisions from an incomplete repo are not counted. When labels are configured and any watched repo is incomplete, or a counted repo lacks `decisions`, the text says `DECISIONS FOR YOU: DATA INCOMPLETE.` Known rows from counted repos are still listed. It does not say `DECISIONS FOR YOU: none open.` `none open` is only a measured empty list on every watched repo: a successful decisions read with no rows for that repo. A held legacy row, a missing `decisions` relation, and a failed decisions query are not that list. When `brief.decisionLabels` is empty and there are no decision rows, the text says decisions are not tracked. A decision hole on a repo whose snapshot is complete does not blank the other fleet totals. The text does not say fleet totals are unknown for that hole alone. The repo is still named in `incomplete_repos`.

An empty `detail.merged` array is a measured empty window. The shipped list stays empty and the median is null. The brief does not fall back to `detail.merged_list` or the stored `median_lead_hours`. Those fields are used only when `detail.merged` is absent.

Coordinator liveness uses `brief.coordinator` in `progress.config.json`. `agentId` null omits the COORDINATOR section (`configured: false`). A configured agent is `working` only when the newest work event (`session_end`, `milestone`, or `status`, exact match, plus any other configured kind that is not in the excluded set) is within `maxSilenceHours`. The read is that newest configured work event, every `error` inside the silence window, and the single newest event of any kind. It is not the newest 200 other events. A burst of `turn_start` or `status_update` cannot hide a work event that is still inside the window, and it cannot hide the age of the newest work event once that event is older than the window. `workKinds` may be a pipe-delimited string or an array of strings. `scripts/morning-brief.sh` accepts both. `heartbeat`, `telemetry`, `turn_start`, `status_update`, and `error` do not count as work, even when `workKinds` names them and even when `last_seen_at` is seconds old. A list that contains only those kinds falls back to `session_end`, `milestone`, and `status`. The work-event query receives that filtered list, so a configured `error` cannot be the newest work row. `status_update` is not `status`. An `error` in the silence window with no work event is `FAILING`, and the count is every error in that window. The text adds `(telemetry seen Nh ago)` from `last_seen_at` when that timestamp exists, including `0`.

`scripts/morning-brief.sh` remains the fallback. A scheduler should `curl` this route. `repo_source` is `dashboard` when the watched list came from the database and `config` when it came from `progress.config.json`.

With no `DATABASE_URL` the brief is database-only. It does not serve the synthetic progress board. Every configured repo is incomplete (`no snapshot`), the fleet totals are null, and the text says `DATA INCOMPLETE`. The JSON body has no `demo` field.

### Threshold alerts

`GET /api/brief/alerts` reports the between-brief conditions. It does not insert a message. Auth matches `GET /api/brief` (`progress:read` for an agent credential). `POST /api/brief/alerts/evaluate` is the only sender. Auth matches `POST /api/progress/ingest`: `MC_TOKEN` bearer. An agent credential is `403`, including one that holds `progress:read`. The POST body is ignored.

`brief.alerts` in `progress.config.json` holds the thresholds. `enabled` defaults to `false`. Only a boolean `true` turns delivery on. A missing block, `0`, or the string `"true"` stays off. While delivery is off, evaluate still computes the conditions, `sent_count` is `0`, `delivery` is `disabled`, and no `brief_alerts` row is claimed or cleared. The owner turns the switch on after the first decision-backlog clear. Until then the channel stays quiet.

The three conditions, and no others:

- Coordinator work-event silence past `brief.coordinator.maxSilenceHours`. The work kinds are the brief's: `heartbeat`, `telemetry`, `turn_start`, `status_update`, and `error` never count. The alert re-sends every `coordinatorRepeatHours` (default 12) while the silence holds, then clears when a work event arrives.
- A watched repo the brief shows (not hidden, gone, or outside its owner's activity window) with at least one merge in the prior `zeroMergeLookbackDays` (default 7) and no merge for `zeroMergeHours` (default 72). A merge at exactly 72h counts as quiet. A merge one minute newer does not. A repo with no merges in the prior 7 days does not alert. The alert fires once per quiet episode and re-arms only after the episode clears. Firing requires the snapshots to cover `[now - zeroMergeHours, now]`. The newest snapshot may lag now by the collector cadence (15 minutes). An older gap is `unknown`. A merge timestamp inside that window is `clear` even when the tail is unmeasured. A snapshot whose `detail.merged` does not cover the lookback is `unknown`, not clear.
- An open decision whose `opened_at` (else `first_seen_at`) is strictly older than `decisionAgeDays` (default 14). One message per decision row, ever. A resolved, withdrawn, or deferred row does not alert. Exactly 14 days has not crossed the line.

`condition` is `firing`, `clear`, or `unknown`. A failed read, a missing timestamp, or incomplete merge coverage is `unknown`. Unknown never sends and never clears a latch that is already sent. `sent` is true when `brief_alerts.cleared_at` is null for that key, false when the latch table was read and that key is not latched, and null when the table could not be read. That read sets `latches` to `unknown`. Each send is one inbound row from `enqueueMessage` (`created_by` `brief-alerts`, actor fields from the caller) on the coordinator conversation, or `operator` when no coordinator is configured. Evaluate adds `failures` when a latch read, claim, clear, message, or restore throws.

The claim is one `INSERT ... ON CONFLICT ... RETURNING` statement. It stores a random `claim_token` and the evaluation's compute instant. Episode and repeat claims re-arm a cleared latch only when `cleared_at` is null or older than that instant. A clear sets `cleared_at` to its own compute instant only when `cleared_at` is null and `last_sent_at` is older than that instant, so a delayed clear cannot overwrite a newer claim. A decision claim is `INSERT ... SELECT ... WHERE EXISTS` an open decision still old enough at the compute instant, `ON CONFLICT DO NOTHING`, so a decision resolved after compute is not alerted. An event that lands between compute and claim, with no concurrent evaluation, can still produce one alert; the next evaluation clears it. A failed message insert restores the previous row only where that token still matches and `cleared_at` is still the null the claim wrote, so a concurrent clear stays cleared. Two concurrent evaluates insert one message per alert. The progress collector does not call this route. The scheduler that curls the brief POSTs evaluate on its own tick. No other pushes.

### Watch beats

`POST /api/watch/beat` stores one row per host. The body is `{ "source", "status", "detail", "beat_at" }`. `source` is `mini`, `macbook`, or `watcher`. `status` is `ok`, `held`, `paused`, `stale`, `failing`, or `unknown`. `detail` is a string of at most 500 Unicode code points. `beat_at` is a finite RFC 3339 timestamp with an explicit `Z` or `±HH:MM` offset. An old or future `beat_at` is stored as sent. It does not make the beat stale or fresh.

`received_at` is the database clock at the last successful insert or conflict update. The client must not send `received_at` or `age_s`. A body that includes either is `400` and writes nothing. Any other unexpected field is `400`. A body that is not a JSON object, a missing field, an unknown `source` or `status`, a `detail` over 500 code points, or a `beat_at` without an explicit offset is `400`. `Content-Type` must be the single media type `application/json`, optionally followed by `;` parameters (`415` for a missing value, an empty value, a comma, or any other type). The server counts the bytes it reads and answers `413` above 8 KiB. It does not trust `Content-Length` by itself. Every rejection leaves the table unchanged.

The caller is a verified `akc_` credential with `watch:write`. `MC_TOKEN`, the `mc_auth` cookie, an OAuth access token, and a dev-open caller are `401` even when that credential would be allowed on another route. A valid credential without `watch:write` is `403` `insufficient_scope`. An unknown, expired, or revoked credential is `401`. If the credential store cannot be read, the answer is `503` `{ "error": "credential_store_unavailable" }`.

`WATCH_SOURCE_CREDENTIAL_IDS_JSON` maps `mini`, `macbook`, and `watcher` to arrays of credential row UUIDs (the `id` from Settings, not the label and not an agent id). Several UUIDs per source are how a credential is rotated. A UUID listed under two sources, an unknown name, an empty array, an object that names no source, a value that is not a UUID, or a document that is missing or not valid JSON makes every POST `503`. A credential that is not in the requested source's list is `403` and the row is not changed. A valid dashboard cookie sent on the same request does not widen that list.

A successful POST is `200` `{ "ok": true }`.

`GET /api/watch/beats` needs `watch:read` and no source binding. The body is `{ "beats": [{ "source", "status", "detail", "beat_at", "received_at", "age_s" }] }`. `age_s` is `max(0, floor(database_now - received_at))` in whole seconds. The response sends `Cache-Control: no-store` and the route is dynamic. With no `DATABASE_URL`, or when the query fails, the answer is `503`. It is not `{ "beats": [] }` and it is not demo data. `{ "beats": [] }` means the table was read and had no rows.

`scripts/watch-beat.sh` reads one JSON object from stdin and POSTs it. Set `WATCH_API_URL` to the full `https://` URL (loopback `http://` is only for `localhost`, `127.0.0.1`, and `::1`) and `WATCH_CREDENTIAL` to the `akc_` token. The script always exits 0. A missing setting, bad stdin, DNS or TLS failure, timeout, refused connection, non-2xx response, or a 2xx body that is not `{ "ok": true }` prints one short line and does not print the credential, the Authorization header, the response body, or the curl command. It does not queue or replay.

### GitHub webhooks

`POST /api/webhooks/github` receives GitHub App or repository webhook deliveries and stores the accepted ones in `gh_events`. The full contract, the stored columns, and the per-event field map are in [EVENTS.md](EVENTS.md).

The signature is the credential. The route checks, in this order, and stops at the first failure:

1. `MC_GITHUB_WEBHOOK_SECRET` unset or blank: `503` `not_configured`. An unsigned delivery is never accepted.
2. `X-Hub-Signature-256` missing, or not `sha256=` plus 64 lowercase hex: `401` `unauthorized`.
3. The body is read from the stream and counted. Above 1,048,576 bytes it is `413` `payload_too_large`. `Content-Length` is not trusted. Exactly 1,048,576 bytes is accepted.
4. HMAC SHA-256 of the raw body bytes, compared in constant time. A mismatch, including a valid signature over a different body, is `401`.
5. `X-GitHub-Event` must be 1 to 64 lowercase letters or underscores, and `X-GitHub-Delivery` 1 to 128 letters, digits, or hyphens. Otherwise `400` `validation_failed`. Ids starting with `sweep:` are reserved for synthetic rows and are rejected.
6. A body that is not UTF-8 JSON is `400` `invalid_json` (a webhook set to `application/x-www-form-urlencoded` lands here).

None of these steps runs SQL. After them, `ping` is `200` `{ "ok": true, "event": "ping", "delivery_id" }`. An event outside `pull_request`, `check_suite`, `status`, `issue_comment`, `issues`, `push`, `pull_request_review`, `workflow_run` is `202` `{ "ok": true, "ignored": true, "event", "delivery_id" }` and is not stored. For an accepted event, a payload that is not a JSON object or lacks the fields GitHub always sends for it is `400` `validation_failed` with `fields`.

A new delivery is `200` `{ "ok": true, "stored": true, "duplicate": false, "id", "delivery_id" }`. A delivery id already stored is `200` `{ "ok": true, "duplicate": true, "delivery_id" }` and the stored row, including `received_at`, is not changed. That covers GitHub redelivering after an insert committed and the response was lost. With no `DATABASE_URL` the answer is `503` `setup_required`; a failed insert is `503` `internal_error`. Both are `retryable: true`, and neither is a stored receipt. Every response sends `Cache-Control: no-store`.

### Decisions

The morning brief's decisions list comes from this table when every brief-eligible row for that repo has `kind`, `labels`, `opened_at`, and `repo_short`. Those rows are `source` `github-label`, `status` not `withdrawn`, and `github_present` not `false` (a null `github_present` still counts as present). `repo` is `owner/name`. `repo_short` is the config short name and is display only. The brief joins a row onto a watched repo by `owner/name`, so two repos that share a short name do not both receive the row. `age_hours` drops fractional seconds before `Z`, subtracts the unix times, and divides by 3600. `age_days` is `floor(age_hours / 24)` from `opened_at` (GitHub `createdAt`). GitHub `createdAt` is stored as `opened_at` and, on insert only, as `first_seen_at`.

A row created before those columns existed has them null. `shape=brief` does not treat that row as authoritative: it does not invent `kind: "issue"`, `labels: []`, an age from `first_seen_at`, or a `repo_short` from the repo basename. The response field `incomplete_repos` lists each `owner/name` with at least one such row. `scripts/morning-brief.sh` keeps the GitHub label sweep for those repos and still replaces every other watched repo from `decisions`. The collector's next upsert fills the null `kind`, `labels`, and `repo_short`, and fills a null `opened_at`. After that fill, the table replaces the sweep for that repo.

`GET /api/decisions?status=open&repo=&source=&limit=&shape=row` lists rows oldest-first by `first_seen_at`. `status` defaults to `open`. `open` also includes `deferred` rows whose `defer_until` is at or before now. `all` or one of `open`, `decided`, `deferred`, `withdrawn` is allowed. `writeback=written` keeps only written rows. `writeback=not_written` keeps rows stamped `not_written` and a decided row whose `writeback` is still null, whose write-back claim is absent or older than the 180 second write-back lease, and whose `writeback_lock_at`, else `decided_at`, else `updated_at`, is older than that lease. Both are ignored when `shape=brief`. `limit` defaults to 500 and maxes at 1000. Each row includes `age_days` and `revision`. `shape` defaults to `row`. `shape=brief` ignores `status` and `source`. `decisions` is the morning-brief list from complete rows only: `source` `github-label`, `status` not `withdrawn`, `github_present` not `false`, `number` set, and `kind`, `labels`, `opened_at`, and `repo_short` all set, oldest first. `incomplete_repos` is the repos with a brief-eligible row missing any of those four. `repo` and `limit` still apply to both. `scripts/morning-brief.sh` calls `GET /api/decisions?shape=brief&limit=1000` when `MC_URL` and `MC_TOKEN` are set. It replaces a watched repo's decisions from `decisions`, including when that repo's list is empty, and leaves a repo in `incomplete_repos` on the GitHub sweep. A failed call keeps the GitHub sweep for every repo. With a database the body is `{ "demo": false, "decisions": [...], "incomplete_repos": [...] }`.

`POST /api/decisions` upserts by `key`. Required: `key`, `source`, `title`. Optional: `repo` (`owner/name`), `repo_short`, `number`, `url`, `why`, `options`, `recommended`, `requested_by`, `kind` (`issue` or `pr`), `labels`, `opened_at`, `first_seen_at`, `github_present`, `force`. A later upsert refreshes `title` and `last_seen_at`. It fills a null `kind`, `labels`, or `repo_short`, and fills a null `opened_at`. It does not overwrite an `opened_at` or `first_seen_at` that is already set, or an existing `requested_by`. A `github-label` upsert that omits `github_present` stores `true`.

Status on that upsert:

- A new key is `open`.
- `decided` and `deferred` stay as they are. The answer text is left in place. The response includes `status_held: true`.
- `force: true` reopens a `decided` or `deferred` row to `open` and clears `decision`, `decided_by`, `decided_at`, `defer_until`, `actor_type`, `actor_id`, `chosen_option`, `writeback`, `writeback_lock`, and `writeback_lock_at`. While an unexpired write-back claim holds that row, the same call is `409` `writeback_in_progress` and changes nothing. A `withdrawn` row returning to `open` clears those columns and `defer_until`. It leaves `decision` and `decided_by` in place.
- `withdrawn` returns to `open` on an ordinary upsert, without `force`.
- A body field `status` is not how a row becomes `decided`. That is `PATCH`.

The other POST shape is `{ "reconcile": { "repo", "source", "seen_keys" } }`. It is mutually exclusive with `key`. `source` defaults to `github-label`. `seen_keys` may be empty and each key must start with `github:<repo>#`. For that repo and source, keys absent from `seen_keys` are updated and `last_seen_at` is not bumped. An absent key is an issue or PR that closed or lost the label. `open`, `deferred`, and `decided` become `withdrawn`. `defer_until` is cleared on `open` and `deferred`. `decision`, `decided_by`, and `decided_at` stay on a decided row. `github_present` becomes false. A row already `withdrawn` with `github_present` false is left alone. The response is `{ "ok": true, "reconciled", "withdrawn" }`.

`scripts/collect-progress.sh` POSTs one row per open issue or PR that carries a label in `brief.decisionLabels` (`key` `github:<repo>#<n>`, `source` `github-label`, `why` the matching labels joined with `", "`, `kind` `pr` when `gh` returned `isDraft`, `labels` the matching names, `opened_at` GitHub `createdAt`, `repo_short` the config short name). That POST is what backfills a legacy null `kind`, `labels`, `opened_at`, or `repo_short`. It then reconciles. It does not reconcile when `decisionLabels` is empty, when `gh` fails, when the issue list is longer than 2000 or the PR list is longer than 500, or when any upsert failed. `--backfill` does not sync decisions. `--dry-run` prints the decision JSON to stderr and does not POST, so stdout stays the progress payload.

`PATCH /api/decisions/:id` body is `{ "status"?, "decision"?, "decided_by"?, "defer_until"?, "option_id"?, "expected_revision"?, "expected_updated_at"? }` with at least one of `status`, `decision`, `decided_by`, or `defer_until`. `id` is a positive integer. `status` is one of the four. `decided` requires non-empty `decision` text, or an `option_id` that matches one of the row's options (the option label is stored when the text is empty). It sets `decided_at` to now. `deferred` requires `defer_until`. A `YYYY-MM-DD` value is the end of that UTC day, so today is still in the future during the evening. A past instant, or a date that is not a real calendar day, is `400` `validation_failed`. `open` clears `decision`, `decided_by`, `decided_at`, `defer_until`, and the actor, chosen option, and write-back columns. `withdrawn` sets `github_present` false. `decided_by` in the body is ignored. The stored `decided_by`, `actor_type`, and `actor_id` come from the authenticated principal. Dev-open, when the dashboard password is unset and the request has no credential, stores those fields as null. `expected_revision` must be the row's integer `revision`. A mismatch is `409` `stale`, checked before the status conflict. `expected_updated_at` is still accepted and is not compared. A `decided` or `withdrawn` row rejects every change except `status` `open`, which reopens it and clears the answer. `status` `open` while an unexpired write-back claim holds the row is `409` `writeback_in_progress`. Omitting `status` and sending only `decision` text is that `409` `conflict`. Deferred is not terminal. An unknown id, when a database is connected, is `404` `not_found` with `error` `Decision not found`.

On `decided`, the route then writes back to GitHub. The target is parsed only from the row key `github:<owner/repo>#<n>`. `repo` and `number` on the row, and any repo or number in the request, are not the target. The comment is `<!-- agent-kontrol-decision:v1 --> Decision (by &lt;who&gt;, &lt;date&gt;): &lt;text&gt;` with `who`, the date, and the text HTML-escaped. The marker itself is not escaped. Decision labels from `brief.decisionLabels` are removed. Issues and pull requests both use the issues API. The token is `GH_TOKEN`, else `GITHUB_TOKEN`. No token, a GitHub 403 or 404, a network error, or an already-closed issue still leaves the row decided and sets `writeback` to `not_written`. The page shows `not written back`. A key that is not a GitHub issue leaves `writeback` null. A later retry posts again unless an existing comment contains the full canonical decision text. A comment that only contains the marker does not count. When the token's GitHub login is known, a matching comment by a different author does not count either. Concurrent retries claim `writeback_lock` on the row for the lookup and the create, so only one comment is posted. The claim lasts 180 seconds, which is longer than the 60 second MCP handler, and each GitHub request aborts after 15 seconds. The writer checks the claim token and the post-claim `revision` before each GitHub mutation. The stamp matches that token, that revision, and `status` `decided`, then clears the lock. A claim that cannot be acquired stamps `writeback` `not_written` so the row stays on the retry queue.

`POST /api/decisions/:id/writeback` retries that comment and the label removal. It does not decide the row again. The canonical-comment check is what stops a second comment when the first attempt posted and then failed while removing labels. The marker alone does not. `expected_revision` is the same guard as PATCH. `expected_updated_at` is accepted and is not compared. A row that is not `decided` is `409` `conflict`. Auth is the same as PATCH: dashboard session, `MC_TOKEN`, or `decisions:write`.

`actor_type`, `actor_id`, `chosen_option`, and `writeback` are nullable columns (`supabase/migrations/20261027_decisions_resolve.sql`).

MCP `request_decision` (scope `decisions:request`) upserts `key` `agent:<actor id>:<slug>` with `force` false. `list_decisions` (`decisions:read`) reads the queue and does not change it. `resolve_decision` is `decisions:write`. An agent credential with only the request and read scopes cannot resolve and cannot call PATCH or the write-back retry.

Demo mode (no `DATABASE_URL`), after the body validates: `GET` returns `{ "demo": true, "decisions": [] }`. `POST` returns `{ "ok": true, "demo": true, "note": "DATABASE_URL not set; decision dropped" }`. `PATCH` and `POST /api/decisions/:id/writeback` return `{ "ok": true, "demo": true }`.

### Settings

- `GET /api/settings/repos` returns `{ "source": "database" | "file", "writable": true, "max": 25, "version": "...", "repos": [{ "repo", "label", "short", "color", "blockedLabel", "origin", "pinned", "hidden", "gone", "shown", "lastActivityAt", "isFork", "isArchived", "fieldsOverridden" }] }`. `source` is `database` with an empty `repos` list when at least one owner is configured, even if discovery has stored no repos yet. `source` is `file` only when no owners are configured and no repo rows exist, or when there is no database; `repos` is then the default from `progress.config.json` and those objects are unchanged (they omit the new fields). When a database is connected, `version` is always the fingerprint of the stored `watched_repos` rows. When `source` is `file` that fingerprint is the empty list, not the file list, so the first save can send the `version` from this GET. With no database, `version` is the fingerprint of the file list. `shown` is false when the repo should drop off the brief and the board. A missing `shown` still means show, so an old client and the file fallback keep working. The collector calls this on every tick and skips a repo only when `gone` is true. Hidden and quiet repos stay in this list so they are still collected. Hide wins over pin. A repo marked gone is not shown, including when it is pinned.
- `PUT /api/settings/repos` with `{ "repos": [...], "version": "...", "dry_run": true }` replaces the hand-added rows, in order, and returns the stored list in the same shape. `acme/App` and `acme/app` are the same repo. When a row already exists under any casing, the save updates that row and keeps the casing already stored. A new repo is stored with the casing in the payload. Two entries in one body that differ only by case are `400`. Rows with `origin: "auto"` that the body omits are kept, not deleted and not hidden. When that omitted row has `fields_overridden` true, the save resets label, short, color, and blocked label to the discovery defaults, sets `fields_overridden` false, and keeps origin, pin, hide, gone, and discovery metadata. The dry run reports that reset as an update. A null or false flag is not reset. Saving the row in the hand-added list sets `fields_overridden` true and does not change `origin`. A body that is exactly `{ "repos": [] }` is allowed only when an auto row is already stored; otherwise an empty list is still `400`. `version` is optional; send the one from your last GET and the save is refused with `409 { "code": "stale" }` if someone changed the list since, so two open tabs cannot overwrite each other. The save reads that version again inside the replace, while holding the same advisory lock as discovery. A pin or hide that commits after the first read is `409` `stale` and is kept. The replace of a non-empty list is a single SQL statement, so a failed save leaves the old list intact. It answers `400` with `errors: [{ "index", "field", "message" }]` when invalid (`index` is `-1` for an error about the whole list), and `409` with `code` `conflict` when no database is connected. Those bodies also include `error` (a string), `fix`, `retryable`, and `fields`. The `errors` array and `code: "stale"` stay. A list needs 1 to 25 hand-added repos, each `owner/name`, with a unique short name and a `#rrggbb` color. Optional `pinned` and `hidden` must be booleans when present. Omitting them on a row that is in the body stores false. `origin` is ignored on conflict for auto rows; a new hand-added row defaults to `manual`. `dry_run: true` returns the diff against the stored rows the save would replace (`changes` for adds, removes, updates, and reorders) and writes nothing. The preview includes `source`. When a database is connected and `source` is `file`, that baseline is the empty stored list, not the file fallback. With no database, the diff stays against the file list. An omitted auto row is not a remove. A stale `version` is still `409`. With no database, a dry run returns that diff with `would_write: false` instead of `409`. A non-boolean `dry_run` is `400` and writes nothing.
- `PATCH /api/settings/repos` with `{ "repo": "owner/name", "pinned": true, "hidden": false }` sets those flags on the stored row whose `owner/name` matches case-insensitively, and does not change `origin` or the stored casing. `ACME/APP` finds `acme/app`. The update takes the same advisory lock as discovery and repo replacement. Changing pin or hide changes the list version. Send at least one of `pinned` or `hidden`. Both may be sent. Hide wins over pin. A missing repo is `404` `not_found`. No database is `409` `conflict`. `dry_run: true` returns `before` and `after` and writes nothing; with no database that preview has `would_write: false`. The no-database preview resolves the repo against the file fallback. An unknown repo is `404` `not_found` with the same message as database mode. A known file repo has no pin or hide, so `before` is `{ "pinned": false, "hidden": false }` and `after` is the proposed flags.

- `GET /api/settings/owners` returns `{ "writable", "max": 20, "version", "owners": [{ "owner", "activity_days", "include_forks", "include_archived", "last_error", "last_error_at", "last_discovered_at", "actor_type", "actor_id" }] }`. With no database, or before the table exists, this is `{ "writable": false, "owners": [] }` and not a 500. `writable` is false in both of those cases.
- `PUT /api/settings/owners` with `{ "owners": [{ "owner", "activity_days", "include_forks", "include_archived" }], "version", "dry_run" }` replaces the owner list. An empty list is allowed and does not delete repos. `owner` is a GitHub login: 1 to 39 characters, letters, digits, and single hyphens, no leading or trailing hyphen, no `--`, no whitespace, and not a path (`/`, `\`, `..`, `%2e`). It is stored lowercase. Empty, whitespace, a slash, a path, and a name longer than 39 characters are `400` `validation_failed` with `errors`. `activity_days` is a whole number from 1 to 3650 and defaults to 30. Sending both `activity_days` and `activityDays` is `400`. `include_forks` and `include_archived` default to false and must be booleans. At most 20 owners. Duplicate owners, compared case-insensitively, are `400`. The actor stored on each row is the principal: a dashboard session is `human` / `operator`, `MC_TOKEN` is `agent` / `mc-token`, and dev-open stores null. Discovery does not overwrite that actor. `dry_run: true` returns `action: "replace_owners"` and writes nothing. A stale `version` is `409`. The save reads the version again inside one transaction, while holding a lock, so two requests that loaded the same version cannot both write. Before `watched_owners` exists, PUT is `409` `conflict` and writes nothing, and a dry run has `would_write` false. Removing an owner does not delete that owner's repos.
- `POST /api/settings/owners/discover` with `{ "results": [{ "owner", "ok", "swept_at", "error", "repos", "truncated" }] }` applies one `gh repo list` per owner. `repos` entries are `{ "name", "pushedAt", "isFork", "isArchived" }`. `ok: false`, a rate-limit error, or a zero-length list records `last_error` and does not insert, update, hide, or delete tracked repos. A list of 1000 (the cap) updates the repos it saw, does not mark the others gone, stores a warning on `last_error`, and still sets `last_discovered_at`. A repo that leaves a successful, non-empty, non-truncated list is marked `gone`. It is not deleted. A name that is not safe to store fails that owner's sweep and writes no repo changes. An owner that is not in the saved list is an error on that result only. Two results for the same owner in one request are `400` and write nothing. The response is `{ "results": [{ "owner", "ok", "error", "added", "updated", "marked_gone" }] }`. No database is `409` `conflict` and the body includes `results`, plus `added`, `updated`, and `marked_gone` as empty arrays on the response and on each result. Before `watched_owners` exists, discovery is the same `409` `conflict`, includes those same empty arrays and `results`, and writes nothing. Every result must include `swept_at`, an RFC 3339 timestamp of the collector's clock just before `gh repo list`. A missing `swept_at`, a value that is not RFC 3339, or a value more than 5 minutes ahead of the server is `400` and writes nothing. `pushedAt` is an RFC 3339 timestamp or null; any other value is `400` and writes nothing. Two repo names in one result that differ only by case are `400` and write nothing. A new repo is eligible when its `pushedAt` is inside the owner's activity window measured from `swept_at`, not from the server clock. The boundary day is included. Discovery matches an existing repo case-insensitively, updates that row, and keeps the casing already stored. A new repo is stored as `owner/name` with the owner lowercased and the name casing GitHub sent. Discovery takes one global transaction advisory lock around the reload, the plan, and the write, shared by every owner, and never around `gh`. A sweep whose `swept_at` is not newer than `last_discovered_at` returns `200` with `ok: true` and `skipped: "stale"` for that owner, writes nothing, and does not move `last_discovered_at`. `scripts/collect-progress.sh` logs that as a skip, not an error. `owner_removed` and `rule_changed` stay `ok: false`. One owner's metadata update and repo changes commit in one transaction, so a failed repo write does not keep a new discovery timestamp. A unique short-name violation replans once under that lock and then is `409` `conflict` with the same body as the other discovery conflicts: `results`, plus empty `added`, `updated`, and `marked_gone` on the response and on each result. Two owners can both have a repo named `app`; the generated short names stay distinct.

Anyone with a dashboard session or `MC_TOKEN` can change owners and repos, which matches the rest of the trust model (see [SECURITY.md](../SECURITY.md)). An agent credential cannot. Joins use `owner/name`, never the short name. Two owners can both have a repo named `app`.

MCP `get_settings` returns the repo GET body and the owner GET body. MCP `set_watched_repos` is the same replace as `PUT /api/settings/repos`, including case-insensitive identity. Both tools are operator-only, the same boundary as `list_activity`: no agent scope grants them, and `MC_TOKEN` or an OAuth access token can call them. `set_watched_repos` requires `expected_version` (the repo `version` from `get_settings`) unless `dry_run` is true. REST `version` stays optional. A mismatch is `409` `stale` and writes nothing. `dry_run: true` returns the diff against the stored rows the save would replace (`added`, `removed`, `changed`, plus the REST dry-run fields and `source`) and the current version and writes nothing. When `source` is `file` and a database is connected, that baseline is the empty stored list. A successful write records one activity receipt in the same transaction as the replace. The receipt's version is the fingerprint of the rows just written. If that insert fails, the replace rolls back. `watched_repos` has no actor columns; the actor is on that event. `dry_run`, a validation error, and `stale` do not record a receipt. With no database the tools match these GETs and this PUT: a preview has `would_write: false`, and a real write is `409` `conflict`.

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
- `GET /api/traces?agent=&errors=1&before=&limit=&cursor=&fields=` — `{ demo, traces: TraceSummary[] }`. Default limit is 50, maximum 200. Sort is `started_at` descending, then `trace_id` ascending when a page was requested. `fields` may name `trace_id`, `agent_id`, `root_name`, `started_at`, `ended_at`, `span_count`, `error_count`, `open_count`, `input_tokens`, `output_tokens`, `cost_usd`. `trace_id` is always returned. See [List pages](#list-pages).
- `GET /api/traces/:traceId` — `{ demo, spans: Span[] }`. With a database, an unknown or pruned trace is `404` `not_found`. Demo mode returns `200` and an empty `spans` list.

### Skill bundles

`GET /api/skill-bundles?runtime=hermes&lane=` returns a gzip-compressed tar (`application/gzip`, `content-disposition` attachment). The caller is a dashboard session or `MC_TOKEN`. An agent credential is `403`, including one with `skills:read` or `skills:write`. `GET /api/skills/:id` is unchanged, including when the id is `export`.

`runtime` is required: `claude`, `codex`, `grok`, `hermes`, `mini`, or `nemoclaw`. `lane`, `category`, and `q` are optional. The set of skills is the same set `list_skills` would show. Export calls that same visibility check. Trigger `off` is omitted. A trigger other than `off`, `on_request`, `auto_inject`, or `scheduled` is treated as off and listed with reason `invalid trigger`. A selected scope is omitted unless `lane` admits it, and the skill has to list that runtime. `category` is an exact case-insensitive match. `uncategorized` matches a null category. `q` matches the skill id and the description.

The archive directory is the skill id. That id is the upstream directory slug, and it is the canonical folder name. The frontmatter `name` is a display string and may differ from the id. It is written into the document. The folder is the id. Category is a Hermes folder only: Hermes paths are `<category>/<id>/SKILL.md`, and a null or blank category is the folder `uncategorized`. Claude and mini use `skills/<id>/SKILL.md`. Codex, Grok, and NemoClaw use `.agents/skills/<id>/SKILL.md`. Those layouts leave category out of the path, so a category value does not omit the skill there. A NemoClaw `SKILL.md` writes `name` and `description`, plus `license`, `user_invocable`, and `metadata.author` or `metadata.tags` only when the stored frontmatter already has them. Reference files sit next to `SKILL.md`.

A Hermes category or a skill id that does not already match `^[a-z0-9][a-z0-9-_]*$` is omitted. The stored value is left as it is. A path with `..` or an absolute path is omitted. When more than one skill would write the same archive path, every one of those skills is omitted. A reference that is unsafe, that collides with another reference in the same skill under a case-insensitive comparison, or that does not fit a ustar name and prefix is omitted, and the skill is still exported. A skill whose `SKILL.md` cannot be written is omitted as a whole.

Every omission is one entry `{skill, path?, reason}`. `path` is set for a reference. When the list is not empty, `manifest.json` at the archive root contains every entry. The `x-ak-skipped` header carries `count`, the first 20 entries, and the text `see manifest.json`. The header is at most 4 KB. A longer list keeps the count and drops header entries until it fits. Each archive path appears once.

With no database the archive is the demo fixture and the response sets `x-ak-demo: true`. A missing or unknown `runtime`, or a repeated `runtime`, `lane`, `category`, or `q`, is `400`.

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
| `not_found` | 404 | no | Unknown trace id on `GET /api/traces/:traceId` when a database is connected (demo mode returns 200 and an empty `spans` list), `POST /api/messages/reply` when `in_reply_to` names a message that does not exist, `PATCH /api/decisions/:id` when a database is connected and that id does not exist (`error` stays `Decision not found`), or `POST /api/memory` when `expected_revision` is present and that key does not exist (`error` is `not found`). A missing key with no `expected_revision` still inserts. Demo mode does not look the decision id up. |
| `validation_failed` | 400 | no | A field is present but not usable: a bad `before` on `GET /api/traces`, a bad `limit`, `cursor`, or `fields` on `GET /api/tasks`, `GET /api/memory`, `GET /api/traces`, or `GET /api/activity` (and on MCP `recall`, `get_task_queue`, and `list_activity`), a bad `since`, `until`, `actor`, or `kind` on `GET /api/activity` (a `since` later than `until` is rejected; a bad timestamp is rejected), a bad `since` and `until` pair on `GET /api/usage` (a `since` without `until` is ignored), a bad `collected_at` on usage or progress ingest, a bad task, trace, or decision id, a decision body or `status` the parser rejected, a privacy refusal, an OTLP body the parser rejected, an idempotency key longer than 200 characters or containing a control character, or MCP `set_watched_repos` when `expected_version` is missing on a real write or `dry_run` is not a boolean. |
| `invalid_json` | 400 | no | The body is not JSON. On `POST /api/login` the `error` string stays `invalid request`. On `POST /api/mcp` an empty or non-JSON body uses this code and `error` `invalid JSON`. A missing bearer on that route is still `401` with `WWW-Authenticate`. |
| `missing_field` | 400 | no | A required field is absent. `fields` names it. |
| `rate_limited` | 429 | yes | More than 5 `POST /api/login` attempts in 10 minutes from one client IP. `Retry-After` is seconds. The OAuth consent form shares this limiter and answers with HTML, not this JSON. Also an agent credential over its per-minute or per-day request limit, on any route it can call (see Request limits for agent credentials). That body adds `retry_after` seconds, `window` (`minute` or `day`), and `limit`. |
| `conflict` | 409 | no | `PUT /api/settings/repos` and MCP `set_watched_repos` when no database is connected. A short name that is already used is the same code. Also a `sweep.scheduler_job` observation that changes `state` without a higher `transition`. |
| `idempotency_conflict` | 409 | no | `POST /api/tasks`, `POST /api/messages`, or `POST /api/messages/reply` reused an `Idempotency-Key` with different arguments, or the first request with that key is still inside its 30 second lease. MCP `create_task` and `reply_to_operator` (and its `reply_to_mark` alias) return the same code. The same key, the same actor, the same route, and the same arguments return the original result for 24 hours. Different arguments stay `retryable: false`. While the first request is inside its 30 second lease, the same arguments are `retryable: true` and the response carries `Retry-After` in seconds plus `retry_after` in the body. After that lease, the same key and the same arguments take over a claim that never stored a result and run the write once. A claim insert whose result is lost is re-read, and the write runs once when this attempt owns the claim. The resource insert and the stored response commit in one statement, and that insert runs only while this attempt's claim token still matches. A committed write therefore has a stored response. A retry returns that response and does not insert another row while the claim is inside its 24 hour window. A caller that dies before reading the response gets the same row on retry. After that window the same key starts a new write. The key is scoped by actor and route. |
| `stale` | 409 | no | `PUT /api/settings/repos` when `version` does not match the list currently stored, and MCP `set_watched_repos` when `expected_version` does not match. Also `PATCH /api/decisions/:id` and `POST /api/decisions/:id/writeback` when `expected_revision` does not match the row. |
| `writeback_in_progress` | 409 | yes | `PATCH /api/decisions/:id` with `status` `open`, or `POST /api/decisions` with `force: true`, while an unexpired write-back claim holds the row. The claim expires after 180 seconds. |
| `stale_write` | 409 | no | `POST /api/memory` or `PATCH /api/tasks/:id` when `expected_revision` is present and does not match the current row. `error` is `stale_write`. `current_revision` is the token a new preview would return. Nothing is written. |
| `task_not_found` | 404 | no | `PATCH /api/tasks/:id` when a database is connected and that id does not exist, or MCP `update_task` when the id does not exist in the database or, in demo mode, in the in-memory store. `error` stays `Task not found`. REST demo mode does not look the id up when `expected_revision` is omitted and answers `{ "ok": true, "demo": true }`. When `expected_revision` is present and the id is missing from the in-memory store, the answer is `task_not_found`. |
| `task_not_claimable` | 409 | no | Defined, not returned. See above. |
| `memory_key_invalid` | 400 | no | MCP `remember` or `recall` when `key` is empty, longer than 200 characters, or contains a control character. |
| `repo_list_invalid` | 400 | no | `PUT /api/settings/repos` and MCP `set_watched_repos` when the list fails validation. `errors` is unchanged. |
| `payload_too_large` | 413 | no | `POST /api/v1/traces` over 2 MB, `POST /api/watch/beat` over 8 KiB, or `POST /api/webhooks/github` over 1 MiB. |
| `unsupported_media_type` | 415 | no | `POST /api/v1/traces` or `POST /api/watch/beat` when the body is not `application/json`. |
| `setup_required` | 503 | no | Messaging routes or `POST /api/usage/ingest` when those tables are missing, or a production `/api/*` request when a database is set and `MC_DASHBOARD_PASSWORD` is not (other pages are `text/plain`). `GET /api/usage` stays HTTP 200 with `setup_required: true` and no `code`. Messaging and usage-ingest bodies keep `setup_required` and `message`. |
| `trusted_writer_required` | 403 | no | A sweeper write from a caller that is not `MC_TOKEN` (or, for `POST /api/sweep` and `POST /api/sweep/consumers`, the signed-in dashboard): an agent credential with `status:write` sending a reserved `sweep.` kind to `POST /api/ingest`, or an OAuth or dev-open caller. Nothing is written. |
| `not_configured` | 503 | no | `POST /api/webhooks/github` when `MC_GITHUB_WEBHOOK_SECRET` is unset or blank. Nothing is read or stored. Set the secret, redeploy, then redeliver from GitHub. |
| `internal_error` | 500 | yes | Anything else that failed while handling the request. `GET /api/progress/digest` uses this JSON body too. Success from that route stays `text/plain`. |

`fix` tells the caller what to change. It is a sentence, specific to the code, and overridable per response when the default would be the wrong instruction (a wrong dashboard password does not ask for `MC_TOKEN`).

## List pages

`GET /api/tasks`, `GET /api/memory`, `GET /api/traces`, and `GET /api/activity` take three optional parameters. Omitting all three leaves the JSON body as it was: no `next_cursor` field. `fields` by itself narrows each row and still omits `next_cursor`.

- `limit` — integer from 1 to 200. The default stays the route default (tasks 100, memory 50, traces 50, activity 50) when it is omitted. `0`, a negative, a non-integer (`1.5`, `1e2`, `01`, `+10`), or a value above 200 is `400` `validation_failed`. The error text does not echo the value.
- `cursor` — opaque token. It is the base64url of the sort key and id of the last row on the previous page. The next page is the rows strictly after that point, so a row inserted ahead of the cursor does not shift the rest of the walk and does not repeat a row. Rows that share a timestamp are ordered by id ascending (`trace_id` ascending for traces). A garbage token, a token for a different list, or a token whose id is not the id shape for that list is `400`, not the first page and not `500`. A well-formed cursor past the last row is `200` with an empty list and `next_cursor: null`.
- `fields` — comma-separated names from that route's allowlist. `id` (or `trace_id`) is always included and is first. An unknown name, an empty entry, or any text that is not an allowlisted name rejects the whole request with `400`. Columns outside the allowlist, including credential hashes, are not returned. Names are copied in the server after the query. They are not placed into SQL.
- `next_cursor` — string or null. Present only when the request passed `limit` or `cursor`.

`before` on traces still means "started before this instant". It does not by itself add `next_cursor`.

With no database, tasks, memory, and traces keep returning the static sample, and they keep ignoring `status`, `query`, `tag`, `agent`, `errors`, and `before` (including a `before` that is not a timestamp), until the request passes `limit`, `cursor`, or `fields`. After that, the sample is filtered, ordered, and paged with the same rules as the database. That sample is not the in-memory store MCP writes use.

`GET /api/activity` is the exception. With no database it reads the in-memory demo event log, not a static sample, and it applies `actor`, `kind`, `since`, and `until` even when `limit`, `cursor`, and `fields` are omitted. An empty log is `{ "demo": true, "activity": [] }`. Rows are newest `created_at` first, and rows that share a millisecond are ordered by `id` ascending. `since` is inclusive. `until` includes that whole millisecond. The actor filter matches `detail.actor_id`. The kind filter is an exact `events.kind`.

MCP `recall`, `get_task_queue`, and `list_activity` take the same three paging parameters. Omitting them keeps the previous text for recall and the task queue, including the demo banner and the defaults (recall 20, task queue 40, activity 50). Passing `limit` or `cursor` adds a final `next_cursor:` line. Passing `fields` returns one JSON object per line. The maximum is 200. The tool names are unchanged. `list_activity` reads the in-memory demo log when no database is set, and its text starts with the demo banner.

## Demo mode

With no `DATABASE_URL` set (demo mode):

- The auth gate is open.
- GET routes return demo data, usually with `demo: true` in the response. `GET /api/decisions` returns `{ "demo": true, "decisions": [] }`. `GET /api/brief` does not. The brief is database-only: with no `DATABASE_URL` every configured repo is incomplete and the text says `DATA INCOMPLETE`. In the JSON, a fleet total that is unmeasured is `null`, and the top-level `stuck_prs` / `decisions` lists are `null` (not `[]`) when that total is unmeasured and no row is known; known rows are still listed when some were measured. See [Brief](#brief).
- Ingest routes answer `{"ok": true, "demo": true}` and drop the data. `POST /api/decisions` does the same and adds `note`. `PATCH /api/decisions/:id` answers `{ "ok": true, "demo": true }` and does not look the id up.
- MCP `report_status`, `remember`, `create_task`, `claim_task`, and `update_task` store in memory for this process. `get_fleet_status`, `recall`, `get_task_queue`, and `list_activity` read that store. `GET /api/activity` reads the same in-memory event log. Successful text starts with `[demo — in-memory, cleared when this process restarts]`. The store is cleared when the process restarts. Those rows are not mixed into the sample data on the other GET routes. `get_settings` and `set_watched_repos` do not use that store.
- REST `POST` and `PATCH` in demo mode still answer `{ "ok": true, "demo": true }` (memory adds `note`) and do not write the in-memory store.
- `POST /api/watch/beat` and `GET /api/watch/beats` do not. With no `DATABASE_URL` they answer `503` and do not acknowledge a beat. An empty `beats` array is only a successful read of a table with no rows.

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
