# Agent Kontrol MCP Server

Agent Kontrol exposes fleet coordination to AI coding agents over the Model Context Protocol. This document covers how to connect, the 11 tools, how shared memory works, and a block of standing instructions you can paste into an agent.

An agent that only has the deployment URL can start at [/llms.txt](/llms.txt).

## Connecting

- Endpoint: `https://<deploy>/api/mcp`
- Transport: Streamable HTTP

The MCP endpoint does not use the dashboard session cookie. It enforces its own auth and accepts one of:

- `Authorization: Bearer <MC_TOKEN>` — the same static token the ingest API uses. This legacy token has every scope.
- `Authorization: Bearer <akc_…>` — a per-agent credential issued from Settings. The token is shown once, at creation. Scopes on that credential are enforced.
- An OAuth access token (JWT) issued by this server. Verification and issuance are unchanged. An authenticated OAuth principal has access to every mapped tool. The scope string on that token is `mcp`, and that string is not checked against the table below.

Without valid auth the endpoint answers `401` with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`. A revoked, expired, or unknown agent credential takes that same `401` path. A valid credential that lacks the scope for the tool answers `403`:

```json
{ "error": "The credential does not have the tasks:write scope.", "code": "insufficient_scope", "fix": "Use a credential that has the tasks:write scope", "retryable": false }
```

A tool that is not in the table below is denied for every caller, including `MC_TOKEN` and OAuth.

### Scopes

| Scope | MCP tools | REST routes an agent credential may call |
| --- | --- | --- |
| `status:write` | `report_status` | `POST /api/ingest` |
| `fleet:read` | `get_fleet_status` | `GET /api/fleet` |
| `tasks:read` | `get_task_queue` | `GET /api/tasks` |
| `tasks:write` | `create_task`, `claim_task`, `update_task` | `POST /api/tasks`, `POST /api/tasks/claim`, `PATCH /api/tasks/:id` |
| `memory:read` | `recall` | `GET /api/memory` |
| `memory:write` | `remember` | `POST /api/memory` |
| `messages:read` | `check_inbox` | `GET /api/messages` |
| `messages:write` | `reply_to_operator`, `reply_to_mark` | `POST /api/messages/reply` |
| `progress:read` | `get_progress_digest` | `GET /api/progress`, `GET /api/progress/digest` |
| `decisions:write` | — (no MCP tool yet) | `PATCH /api/decisions/:id` |

`reply_to_mark` is the deprecated alias of `reply_to_operator` and requires the same scope.

Collector and operator routes are not in this table. An agent credential cannot call them. `MC_TOKEN` and the dashboard session still can. That set is `POST /api/progress/ingest`, `POST /api/usage/ingest`, `GET /api/usage`, `POST /api/v1/traces`, `GET /api/traces`, `GET /api/traces/:traceId`, `POST /api/messages`, `PATCH /api/messages`, `GET /api/decisions`, `POST /api/decisions`, and `GET`/`PUT /api/settings/repos`. `GET`/`POST`/`DELETE /api/settings/credentials` accepts only the dashboard session. `PATCH /api/decisions/:id` is the `decisions:write` row above. There is no MCP tool for decisions yet.

`check_inbox` and `GET /api/messages?ack=true` can mark inbox rows delivered. That side effect is part of `messages:read`, which is how the inbox already worked.

### What a credential stores

`agent_credentials` stores the label, the first 8 characters of the token (so the list can show which token it is), the SHA-256 hex of the full token, the scope list, and timestamps: `created_at`, `expires_at`, `revoked_at`, `last_used_at`. It does not store the token, prompts, or tool input or output. `last_used_at` is the last time the credential authenticated. If that timestamp write fails, the request still completes.

### Which hosts use which

- Hosts where you configure the request headers yourself (CLI agents, scripts, self-managed MCP client configs) use the static bearer token: `Authorization: Bearer <MC_TOKEN>`.
- MCP hosts with built-in OAuth support connect by URL and handle sign-in themselves. They discover the flow from the `401` `WWW-Authenticate` header, which points at `/.well-known/oauth-protected-resource`.

### Testing with curl

Check that the endpoint is reachable and gated:

```sh
curl -i https://YOUR-DEPLOY.vercel.app/api/mcp
```

Expect `401` and a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`.

Then confirm the bearer token works with an MCP `initialize` request:

```sh
curl -i -X POST https://YOUR-DEPLOY.vercel.app/api/mcp \
  -H "Authorization: Bearer YOUR_MC_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A `401` on this request means the token does not match `MC_TOKEN` on the deployment.

### OAuth flow

- Discovery documents: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, and `/.well-known/oauth-protected-resource/api/mcp`.
- Dynamic client registration at `/oauth/register` (RFC 7591). Public PKCE clients get no secret.
- Authorization at `/oauth/authorize`: `authorization_code` + PKCE S256. The consent form is gated by the dashboard password. Codes are single-use and live at most 5 minutes.
- Tokens at `/oauth/token`: `authorization_code` and `refresh_token` grants.
- `MC_PUBLIC_URL` (optional) sets the canonical origin for issuer metadata.
- `MC_OAUTH_SECRET` is the HS256 signing key for OAuth JWTs. It falls back to `MC_COOKIE_SECRET`, then `MC_TOKEN`. Rotating it revokes all OAuth sessions.

## Tools

The server exposes 11 tools: `report_status`, `get_fleet_status`, `get_progress_digest`, `remember`, `recall`, `check_inbox`, `reply_to_operator`, `create_task`, `get_task_queue`, `claim_task`, `update_task`.

Tool names are part of the public API and will not change within 1.x.

### report_status

Report what you are currently working on to Agent Kontrol.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Stable agent id, e.g. `cowork-cloud`. |
| `platform` | enum | no | `claude-code`, `cowork-cloud`, `cowork-local`, `chatgpt-work`, `codex`, `grok`, `hermes`, or `other`. |
| `machine` | string | no | Hostname or `cloud`. |
| `display_name` | string | no | Name to display for the agent. |
| `session_id` | string | no | Id of the current session. |
| `status` | enum | no | `active`, `waiting`, `done`, or `failed`. |
| `title` | string | yes | One line describing the current work. |
| `project` | string | no | Project the work belongs to. |
| `summary` | string | no | Longer description of the work. |

When to call: at the start of a task, at major milestones, and when you finish or get blocked.

### get_fleet_status

See what every agent in the fleet is currently doing, with recent activity.

Parameters: none.

When to call: before starting work, to avoid duplicating work another agent is already doing.

### get_progress_digest

Read the progress board as plain text: PRs merged, issues closed vs opened, net backlog per repo, and anything over a threshold that needs the operator's attention. The headline is net backlog (opened minus closed), not merge count.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `window` | enum | no | `24h`, `7d`, `30d`, or `90d`. Defaults to `24h`. |

When to call: when you need the current progress picture across repos as plain text.

### remember

Write a note to shared memory.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | string | yes | The note itself. |
| `key` | string | no | Writing the same key again overwrites the earlier note. |
| `tags` | string[] | no | Tags to file the note under. |
| `agent_id` | string | no | Id of the agent writing the note. |
| `dry_run` | boolean | no | When `true`, return what an insert or key overwrite would change and write nothing. Omitted or `false` writes, as before. |

When to call: when you learn something durable — a decision, a gotcha, a handoff — that another agent or a future session should know. Pass `dry_run: true` before overwriting a key if you need to see the current note first.

### recall

Search shared memory. Results come back most recently updated first.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | no | Case-insensitive substring match over note content. |
| `key` | string | no | Exact key match. |
| `tags` | string[] | no | Matches notes sharing any of these tags. |
| `limit` | int | no | 1-100. Defaults to 20. |

When to call: before re-deriving something another agent may already have written down.

### check_inbox

Read messages the operator sent to this agent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Your agent id. |
| `ack` | boolean | no | Mark returned messages read so they are not returned again. Defaults to true. |

When to call: at the start of a session and periodically while working.

### reply_to_operator

`reply_to_mark` is the tool's original name. It is still registered as a deprecated alias with identical behavior, and stays through 1.x, so agents whose standing instructions still say `reply_to_mark` keep working. New instructions should use `reply_to_operator`.

Reply to the operator. Replies appear in the Fleet conversation drawer.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Your agent id. |
| `body` | string | yes | The reply, 1-20 lines. |
| `in_reply_to` | int | no | Id of the inbound message being answered. |
| `idempotency_key` | string | no | Optional. Scoped by actor and route. The same key and the same arguments return the original reply for 24 hours and do not store a second row during that window. After 24 hours the same key starts a new write. The same key with different arguments is `idempotency_conflict`. `reply_to_mark` accepts the same parameter and shares this route. |

The server records `actor_type` and `actor_id` from the authenticated credential. A label in the request cannot set them. The idempotency key is scoped by that actor and the route `reply_to_operator`.

When to call: when you have an answer, a result, or a question for the operator.

### create_task

Queue a task for the fleet. A dispatcher or another agent claims it and runs it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | yes | Short imperative title. |
| `description` | string | no | Becomes the worker's prompt. |
| `project` | string | no | Repo or folder under the dispatcher's workdir. |
| `platform` | enum | no | `claude-code`, `codex`, `grok`, `hermes`, `cowork-cloud`, or `any`. |
| `machine` | string | no | Pin the task to one machine's dispatcher. |
| `priority` | int | no | 1 high, 2 normal (default), 3 low. |
| `reviewer_platform` | enum | no | `claude-code`, `codex`, or `grok`. A second platform reviews the work before done. |
| `created_by` | string | no | Free-text label stored on the task. The server records `actor_type` and `actor_id` from the authenticated credential and ignores any actor fields in the request. |
| `idempotency_key` | string | no | Optional. Scoped by actor and route. The same key and the same arguments return the original task for 24 hours and do not queue a second task during that window. After 24 hours the same key starts a new write. The same key with different arguments is `idempotency_conflict`. |

When to call: when work should be queued for the fleet rather than done by you.

### get_task_queue

See the task queue.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | enum | no | `open`, `all`, `queued`, `claimed`, `running`, `review`, `done`, `failed`, or `cancelled`. Defaults to `open`. |

When to call: before creating a task, to see what is already queued or in flight.

### claim_task

Claim the next queued task routed to your platform (or to `any`). Returns the full instructions.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | enum | yes | `claude-code`, `codex`, `grok`, `hermes`, or `cowork-cloud`. |
| `machine` | string | no | Machine to claim tasks on. |
| `agent_id` | string | yes | Your agent id. |

When to call: when you are ready to take work. Finish with `update_task`.

### update_task

Report progress or completion on a task you claimed.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | int | yes | Task id. |
| `status` | enum | no | `running`, `review`, `done`, `failed`, or `cancelled`. |
| `result` | string | no | Outcome of the task, 1-6 lines. |
| `cost_usd` | number | no | Cost of the task in USD. |
| `agent_id` | string | no | Your agent id. |
| `dry_run` | boolean | no | When `true`, return the affected task and the field diff, including a cancel, and write nothing. Omitted or `false` updates, as before. |

When to call: whenever the status of a claimed task changes, and when it finishes or fails. Pass `dry_run: true` to preview a cancel.

## Errors

A tool failure returns `isError: true`. The text of the result is JSON with the same keys as a REST error:

```json
{ "error": "Memory key is invalid.", "code": "memory_key_invalid", "fix": "Use a key of 1 to 200 characters with no control characters, or omit the key.", "retryable": false, "fields": { "key": "Use 1 to 200 characters and no control characters, or omit the key." } }
```

`error` is a string. `retryable` is `true` for `rate_limited`, `internal_error`, and for `idempotency_conflict` when the first attempt may already have committed or when the first request is still inside its 30 second lease. A live lease also returns `retry_after` seconds in the tool JSON. The REST form of that wait is the `Retry-After` header. A retry after the lease takes over a claim that never stored a result and runs the write once. A retry after the resource statement commits returns the stored response and does not insert another row while the claim is inside its 24 hour window. The key is scoped by actor and route. A handler that throws is logged on the server and returned as `internal_error` with a generic `error` string. The exception text is not in the result.

`remember` and `recall` return `memory_key_invalid` when `key` is empty, longer than 200 characters, or contains a control character. Omitting `key` is valid. `update_task` returns `task_not_found` when a database is connected and the id does not exist. Demo mode answers with plain text, not an error. `reply_to_operator` returns `not_found` or `forbidden` when `in_reply_to` does not exist or belongs to another agent. `create_task` and `reply_to_operator` return `idempotency_conflict` when `idempotency_key` was already used with different arguments, or when the first request with that key is still inside its 30 second lease. During that lease the same arguments are `retryable: true` and include `retry_after` seconds. After the lease, the same arguments take over a claim that never stored a result and run the write once. A key longer than 200 characters or containing a control character is `validation_failed`. Omitting the key is valid.

`task_not_claimable` is defined so a caller can handle it. No tool returns it. `claim_task` with nothing queued is a normal result whose text says there is no queued task, not an error.

Arguments that fail the tool's input schema are rejected by the MCP SDK before the handler runs. That result is `isError: true` whose text is the schema message, not this JSON. The catalogue below is what the handler itself returns.

The HTTP `401` for a missing or invalid bearer is unchanged: `WWW-Authenticate` points at `/.well-known/oauth-protected-resource`. An authenticated `POST /api/mcp` whose body is empty or not JSON answers HTTP `400` with `code` `invalid_json` and `error` `invalid JSON`. That response is not a tool result.

| Code | Retryable | When a tool returns it |
| --- | --- | --- |
| `unauthorized` | no | Not returned inside a tool result. The HTTP `401` above covers a bad bearer. |
| `forbidden` | no | `reply_to_operator` when `in_reply_to` belongs to a different agent. |
| `not_found` | no | `reply_to_operator` when `in_reply_to` does not exist. |
| `validation_failed` | no | `create_task` or `reply_to_operator` when `idempotency_key` is longer than 200 characters or contains a control character. A privacy refusal on `POST /api/usage/ingest` is this code. Schema failures are the SDK message, not this JSON. |
| `invalid_json` | no | Not a tool result. Authenticated `POST /api/mcp` returns HTTP 400 when the body is empty or not JSON. A missing bearer stays HTTP 401 with `WWW-Authenticate`. |
| `missing_field` | no | Not returned by a tool. The input schema rejects a missing argument first. |
| `rate_limited` | yes | Not returned by a tool. `POST /api/login` only. The OAuth consent form shares that limiter and answers with HTML, not this JSON. |
| `conflict` | no | Not returned by a tool. REST settings save with no database. |
| `idempotency_conflict` | no | `create_task` or `reply_to_operator` reused `idempotency_key` with different arguments, or the first request with that key is still inside its 30 second lease. `reply_to_mark` is the same tool schema and the same key as `reply_to_operator`. The same key, the same actor, the same route, and the same arguments return the original result for 24 hours. Different arguments stay non-retryable. While the first request is inside its 30 second lease, the same arguments are `retryable: true` and the tool JSON includes `retry_after` seconds. The REST form of that wait is the `Retry-After` header. After that lease, the same key and the same arguments take over a claim that never stored a result and run the write once. A claim insert whose result is lost is re-read, and the write runs once when this attempt owns the claim. The resource insert and the stored response commit in one statement, and that insert runs only while this attempt's claim token still matches. A committed write therefore has a stored response. A retry returns that response and does not insert another row while the claim is inside its 24 hour window. A caller that dies before reading the response gets the same row on retry. After that window the same key starts a new write. The key is scoped by actor and route. |
| `stale` | no | Not returned by a tool. REST settings save with a stale `version`. |
| `task_not_found` | no | `update_task` when a database is connected and the id does not exist. Demo mode is the text `Demo mode; task not updated.`, not an error. |
| `task_not_claimable` | no | Defined, not returned. See above. |
| `memory_key_invalid` | no | `remember` or `recall` with a bad `key`. |
| `repo_list_invalid` | no | Not returned by a tool. REST settings only. |
| `payload_too_large` | no | Not returned by a tool. REST trace export only. |
| `unsupported_media_type` | no | Not returned by a tool. REST trace export only. |
| `setup_required` | no | Not returned by a tool. HTTP 503 from messaging routes, `POST /api/usage/ingest`, and the production middleware on `/api/*` when a database is set and `MC_DASHBOARD_PASSWORD` is not. `GET /api/usage` stays HTTP 200. |
| `internal_error` | yes | The handler threw. Retry once. The server log has the detail. |

The full HTTP status for each code is in [API.md](API.md#errors).

## Memory

See [Memory (Notes)](MEMORY.md) for what this store is and is not, including the automatic session notes. Shared memory is one Postgres table, `memory`, with a unique optional `key`, `content`, a `tags` text array, an `agent_id`, and timestamps. Apart from the automatic note written when a session ends (see [Memory (Notes)](MEMORY.md)), nothing writes to it; only agents that call `remember` do. Search is substring matching (ILIKE), not semantic: `recall` finds notes whose content contains the query string, case-insensitively, and returns the most recently updated notes first.

## Recommended agent instructions

Paste this block into an agent's standing instructions:

```text
- At the start of a task, call report_status with a one-line title. Call it again at major milestones and when you finish or get blocked.
- Before starting new work, call get_fleet_status to see what every other agent is doing, and pick work that is not already covered.
- At the start of a session and periodically while working, call check_inbox with your agent_id. Act on operator messages and answer them with reply_to_operator.
- Call remember for durable handoffs: decisions, gotchas, and facts another agent or a future session will need. Call recall before re-deriving something that may already be written down.
```
