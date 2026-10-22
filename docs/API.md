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
| Ingest routes: `POST /api/v1/traces`, `POST /api/ingest`, `POST /api/messages/reply`, `POST /api/progress/ingest`, `POST /api/usage/ingest` | `Authorization: Bearer <MC_TOKEN>` only |
| MCP transport: `/api/mcp` | `Authorization: Bearer <MC_TOKEN>`, an agent credential, or an OAuth access token (JWT) issued by this server |
| Credential management: `GET`/`POST`/`DELETE /api/settings/credentials` | Dashboard session only |
| Login, OAuth, and discovery: `/login`, `/api/login`, `/oauth/*`, `/.well-known/*` | No cookie gate; these routes enforce their own auth |
| Public agent docs: `GET /llms.txt`, `GET /docs/mcp.md`, `GET /docs/api.md`, `GET /docs/agents.md` | None. Any other `/docs` name stays behind the dashboard gate |

Ingest routes answer `401 {"error":"unauthorized"}` without a valid bearer token. If `MC_TOKEN` is unset, they are allowed only when `NODE_ENV` is `development` or `test`; in any other environment they are denied. A presented `akc_` token is checked even in those environments. A revoked, expired, or unknown agent credential is `401`. A valid one that lacks the route's scope is `403`:

```json
{ "error": "The credential does not have the tasks:write scope.", "code": "insufficient_scope", "fix": "Use a credential that has the tasks:write scope", "retryable": false }
```

The scope for each agent route is listed in [MCP.md](MCP.md). A route that is not in that table is denied to agent credentials. `MC_TOKEN` and the dashboard session can still call it. OAuth on `/api/mcp` is unchanged: a verified access token can call every mapped tool.

If `MC_DASHBOARD_PASSWORD` is unset, the gate is open in local development and on deploys with no `DATABASE_URL` (demo mode). A production build with `DATABASE_URL` set answers `503` on gated routes until the password is set.

## Routes

"Cookie or bearer" below means the `mc_auth` session cookie or `Authorization: Bearer <MC_TOKEN>`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/fleet` | Cookie or bearer | Everything the dashboard needs in one call |
| POST | `/api/ingest` | Bearer | Deterministic telemetry from hooks, watchers, and daemons |
| GET | `/api/memory` | Cookie or bearer | Memory browser feed |
| GET | `/api/messages` | Cookie or bearer | Agent pulls its inbound inbox, or the full conversation |
| POST | `/api/messages` | Cookie or bearer | Operator enqueues an inbound message |
| PATCH | `/api/messages` | Cookie or bearer | Operator marks outbound replies read |
| POST | `/api/messages/reply` | Bearer | Non-MCP agents post replies |
| GET | `/api/progress` | Cookie or bearer | Everything the progress board needs |
| GET | `/api/progress/digest` | Cookie or bearer | The board as plain text, for schedulers and terminals |
| POST | `/api/progress/ingest` | Bearer | One collection tick from `scripts/collect-progress.sh` |
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

### Messages

- `GET /api/messages?agent_id=X&ack=true` — the agent pulls its inbound inbox; `ack` marks the messages read.
- `GET /api/messages?agent_id=X&conversation=true` — full history for the agent.
- `POST /api/messages` — body `{agent_id, body, created_by?}` — the operator enqueues an inbound message for the agent.
- `PATCH /api/messages` — body `{agent_id}` — the operator marks outbound replies read.
- `POST /api/messages/reply` — bearer `MC_TOKEN` only — body `{agent_id, body, in_reply_to?, created_by?}` — non-MCP agents post replies. `in_reply_to` is the id of the inbound message being answered.

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
| `created_by` | string | no | Who created the task. |

- `POST /api/tasks/claim` — body `{platform, machine?, agent_id}`. `platform` and `agent_id` are required; the request answers `400` otherwise. The claim is atomic: it returns the next queued task routed to the given platform (or to `any`), or `{task: null}` when there is none.
- `PATCH /api/tasks/:id` — body `{status?, result?, cost_usd?, session_id?, assigned_agent?, agent_id?}`. Dispatchers use it to report progress and completion; the dashboard uses it to cancel or requeue tasks.

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
| `detail` | object | no | `{lane_mix?, stalled_prs?, notes?}`. |

### Settings

- `GET /api/settings/repos` returns `{ "source": "database" | "file", "writable": true, "max": 25, "version": "...", "repos": [{ "repo", "label", "short", "color", "blockedLabel" }] }`. `source` is `file` when no list has been saved yet, or when there is no database; `repos` is then the default from `progress.config.json`. The collector calls this on every tick.
- `PUT /api/settings/repos` with `{ "repos": [...], "version": "..." }` replaces the whole list, in order, and returns the stored list in the same shape. `version` is optional; send the one from your last GET and the save is refused with `409 { "code": "stale" }` if someone changed the list since, so two open tabs cannot overwrite each other. The replace is a single SQL statement, so a failed save leaves the old list intact. It answers `400 { "errors": [{ "index", "field", "message" }] }` when invalid (`index` is `-1` for an error about the whole list), and `409` when no database is connected. A list needs 1 to 25 repos, each `owner/name`, with a unique short name and a `#rrggbb` color.

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
- `GET /api/traces/:traceId` — `{ demo, spans: Span[] }`; `404` when the trace is unknown or pruned.

### Login

`POST /api/login` takes body `{password}` and, on success, establishes the `mc_auth` session cookie. A wrong password answers `401 {"error":"wrong password"}`. The route allows 5 attempts per 10 minutes per client IP, shared with the OAuth consent form; past that it answers `429` with a `Retry-After` header in seconds. The limiter is in memory and per serverless instance.

## Errors

- `401 {"error":"unauthorized"}` — missing or invalid bearer token on `POST /api/ingest`, `POST /api/messages/reply`, `POST /api/progress/ingest`, or `POST /api/usage/ingest`, and on any route when an agent credential is revoked, expired, or unknown.
- `403 {"error","code":"insufficient_scope","fix","retryable":false}` — the agent credential is valid and does not have the scope for that tool or route.
- `401 {"error":"wrong password"}` — wrong password on `POST /api/login`.
- `401` with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource` — missing or invalid credentials on `/api/mcp`.
- `400` — invalid JSON on `POST /api/ingest`; missing `platform` or `agent_id` on `POST /api/tasks/claim`.
- `429` with a `Retry-After` header (seconds) — more than 5 attempts in 10 minutes from one client IP on `POST /api/login`, shared with the OAuth consent form.
- `503` — gated routes on a production build with `DATABASE_URL` set and `MC_DASHBOARD_PASSWORD` unset.

## Demo mode

With no `DATABASE_URL` set (demo mode):

- The auth gate is open.
- GET routes return demo data, usually with `demo: true` in the response.
- Ingest routes answer `{"ok": true, "demo": true}` and drop the data.

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
