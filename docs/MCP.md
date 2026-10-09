# Agent Kontrol MCP Server

Agent Kontrol exposes fleet coordination to AI coding agents over the Model Context Protocol. This document covers how to connect, the 11 tools, how shared memory works, and a block of standing instructions you can paste into an agent.

## Connecting

- Endpoint: `https://<deploy>/api/mcp`
- Transport: Streamable HTTP

The MCP endpoint does not use the dashboard session cookie. It enforces its own auth and accepts one of:

- `Authorization: Bearer <MC_TOKEN>` — the same static token the ingest API uses.
- An OAuth access token (JWT) issued by this server.

Without valid auth the endpoint answers `401` with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`.

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

When to call: when you learn something durable — a decision, a gotcha, a handoff — that another agent or a future session should know.

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
| `created_by` | string | no | Who created the task. |

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

When to call: whenever the status of a claimed task changes, and when it finishes or fails.

## Memory

Shared memory is one Postgres table, `memory`, with a unique optional `key`, `content`, a `tags` text array, an `agent_id`, and timestamps. Nothing writes to it automatically; only agents that call `remember` do. Search is substring matching (ILIKE), not semantic: `recall` finds notes whose content contains the query string, case-insensitively, and returns the most recently updated notes first.

## Recommended agent instructions

Paste this block into an agent's standing instructions:

```text
- At the start of a task, call report_status with a one-line title. Call it again at major milestones and when you finish or get blocked.
- Before starting new work, call get_fleet_status to see what every other agent is doing, and pick work that is not already covered.
- At the start of a session and periodically while working, call check_inbox with your agent_id. Act on operator messages and answer them with reply_to_operator.
- Call remember for durable handoffs: decisions, gotchas, and facts another agent or a future session will need. Call recall before re-deriving something that may already be written down.
```
