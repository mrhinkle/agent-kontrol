# Agent Kontrol MCP Server

Agent Kontrol exposes fleet coordination to AI coding agents over the Model Context Protocol. This document covers how to connect, the 19 tools, how shared memory works, and a block of standing instructions you can paste into an agent.

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

A tool name that is not registered is denied for every caller, including `MC_TOKEN` and OAuth. `list_activity` is registered and is not in the scope table below. An agent credential cannot call it. `MC_TOKEN` and OAuth can.

### Scopes

| Scope | MCP tools | REST routes an agent credential may call |
| --- | --- | --- |
| `status:write` | `report_status` | `POST /api/ingest` |
| `fleet:read` | `get_fleet_status` | `GET /api/fleet` |
| `tasks:read` | `get_task_queue` | `GET /api/tasks` |
| `tasks:write` | `create_task`, `claim_task`, `update_task`, `requeue_task` | `POST /api/tasks`, `POST /api/tasks/claim`, `PATCH /api/tasks/:id` |
| `memory:read` | `recall` | `GET /api/memory` |
| `memory:write` | `remember`, `delete_note` | `POST /api/memory` |
| `messages:read` | `check_inbox` | `GET /api/messages` |
| `messages:write` | `reply_to_operator`, `reply_to_mark`, `send_message` | `POST /api/messages/reply` |
| `progress:read` | `get_progress_digest`, `get_morning_brief` | `GET /api/progress`, `GET /api/progress/digest`, `GET /api/brief` |
| `decisions:write` | — (no MCP tool yet) | `PATCH /api/decisions/:id` |
| `skills:read` | `list_skills`, `get_skill` | `GET /api/skills`, `GET /api/skills/:id` |
| `skills:write` | `run_skill` | — (no REST route; the agent calls `run_skill`) |

`reply_to_mark` is the deprecated alias of `reply_to_operator` and requires the same scope.

`send_message` is the MCP form of operator `POST /api/messages`. That REST route stays off this table, so an agent credential still cannot call it. The tool requires `messages:write`. `delete_note` uses `memory:write`. There is no memory DELETE route. `requeue_task` uses `tasks:write`, the same scope as `PATCH /api/tasks/:id`. `list_activity` and `GET /api/activity` are operator-only, the same boundary as traces. No agent scope grants them, including `fleet:read`. `MC_TOKEN` and an OAuth access token can call `list_activity`. The dashboard session and `MC_TOKEN` can call `GET /api/activity`.

Collector and operator routes are not in this table. An agent credential cannot call them. `MC_TOKEN` and the dashboard session still can. That set is `POST /api/progress/ingest`, `POST /api/usage/ingest`, `GET /api/usage`, `POST /api/v1/traces`, `GET /api/traces`, `GET /api/traces/:traceId`, `GET /api/activity`, `POST /api/messages`, `PATCH /api/messages`, `GET /api/decisions`, `POST /api/decisions`, `PATCH /api/skills/:id`, `POST /api/skills/sync`, `POST /api/skills/drift`, `GET /api/skill-bundles`, `GET`/`PUT`/`PATCH /api/settings/repos`, and `GET`/`PUT /api/settings/owners` plus `POST /api/settings/owners/discover`. `GET`/`POST`/`DELETE /api/settings/credentials` accepts only the dashboard session. `PATCH /api/decisions/:id` is the `decisions:write` row above. There is no MCP tool for decisions yet.

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

The server exposes 19 tools: `report_status`, `get_fleet_status`, `get_progress_digest`, `get_morning_brief`, `remember`, `recall`, `check_inbox`, `reply_to_operator`, `create_task`, `get_task_queue`, `claim_task`, `update_task`, `list_skills`, `get_skill`, `run_skill`, `send_message`, `requeue_task`, `delete_note`, `list_activity`.

A successful write keeps the sentence it already returned and adds one line after it: `receipt: {"id":"<event id>","kind":"<kind>","at":"<iso>"}`. `structuredContent.receipt` is the same object. Callers that read the first line see the same words. `dry_run`, a validation error, `stale_write`, `not_found`, and an empty claim do not add that line and do not write an event. `check_inbox` does not write a receipt. `reply_to_operator` in demo mode stays `Demo mode; reply not stored.` and writes nothing. `run_skill` is not stored.

Tool names are part of the public API and will not change within 1.x.

### Demo mode

With no `DATABASE_URL`, `report_status`, `remember`, `create_task`, `claim_task`, `update_task`, `send_message`, `requeue_task`, and `delete_note` store in memory for the life of the process. `get_fleet_status`, `recall`, `get_task_queue`, and `list_activity` return what those tools wrote. `list_activity` reads the in-memory event log, and so does `GET /api/activity`. A successful result starts with `[demo — in-memory, cleared when this process restarts]`. A `dry_run: true` preview is JSON with `applied: false` and does not start with that banner, and it does not appear in the activity log. The store is cleared when the process restarts. It is not the sample data the dashboard shows. REST writes are still dropped, including `POST /api/messages`. `check_inbox` and `reply_to_operator` are not stored. `get_progress_digest` stays on sample data. `run_skill` still returns `DATABASE_URL not set; skill run not stored.`

`remember` with a `key` upserts that key. Memory is shared across agents, the same as the database. `dry_run: true` previews and writes nothing. A non-boolean `dry_run` is `validation_failed`. `create_task` idempotency matches the database: the same key, actor, and arguments replay the original task; different arguments are `idempotency_conflict`. `claim_task` on a task that is already claimed or done is the same empty result as a database with nothing queued (`No queued tasks for your platform.`). Two claims in one process yield one winner. `update_task` on a missing id is `task_not_found`. The store caps tasks, notes, agents, events, sessions, and idempotency keys. Sessions are capped per agent, and the oldest session for that agent is dropped past the cap. Past the other caps, the oldest row is dropped. Dropping a task at the cap does not drop its idempotency key. That key still returns the original result for 24 hours and does not queue a second task. Actor fields come from the credential, the same way they do with a database.

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

### get_morning_brief

Read the morning brief as plain text: merges, issue flow, stuck pull requests, decisions waiting on the owner, and whether the coordinator's last event is real work. A heartbeat or a telemetry event does not count as working. This is the same text as `GET /api/brief`. The tool is read-only.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `window` | enum | no | `24h` or `72h`. Defaults to `24h`. Anything else is rejected. |

When to call: for the daily brief, or when asked whether the coordinator is working rather than merely alive.

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
| `limit` | int | no | 1-200. Defaults to 20. Passing `limit` or `cursor` adds a final `next_cursor:` line (`null` on the last page). Omitting both leaves the text as before. |
| `cursor` | string | no | Opaque cursor from a previous `next_cursor` line. A bad cursor is `validation_failed`, not the first page. |
| `fields` | string | no | Comma-separated allowlisted names (`id`, `key`, `content`, `tags`, `agent_id`, `source`, `facts_at`, `created_at`, `updated_at`). `id` is always included. One JSON object per line. An unknown name is `validation_failed`. |

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
| `limit` | int | no | 1-200. Defaults to 40. Passing `limit` or `cursor` adds a final `next_cursor:` line. Omitting both leaves the text as before, still capped at 40. |
| `cursor` | string | no | Opaque cursor from a previous `next_cursor` line. A bad cursor is `validation_failed`, not the first page. |
| `fields` | string | no | Comma-separated allowlisted task fields. `id` is always included. One JSON object per line. An unknown name is `validation_failed`. |

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

### list_skills

List skills the caller is allowed to see. Trigger `off` is omitted. There is no separate tool that lists disabled skills.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `runtime` | enum | no | `claude`, `codex`, `grok`, `hermes`, `mini`, or `nemoclaw`. When omitted, the result says the runtime filter is off and does not hide incompatible skills. The server cannot infer a runtime from `agent_id`. |
| `lane` | string | no | When omitted, skills whose scope is `selected` are hidden. `all` admits every lane. |
| `query` | string | no | Case-insensitive match on the skill id and the description. |
| `category` | string | no | Exact category, compared case-insensitively after trimming. The value `uncategorized` matches a skill whose category is null, and a skill whose category is that word. Any other value does not match a null category. The master-skills taxonomy is not enforced. |

The text lists id, description, version, the first 7 hex characters of the content SHA, the trigger, the category (`uncategorized` when null), and the tags (`none` when the list is empty).

### get_skill

Return the mirrored SKILL.md, or one reference file. The header states the content SHA the bytes were synced at. This tool does not fetch the upstream repository.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Skill id, the directory slug. |
| `path` | string | no | Reference path. Omit it for SKILL.md. |
| `runtime` | enum | no | When set, a skill that is not compatible with it is `forbidden`. |
| `lane` | string | no | Required when the skill's scope is `selected`. |

A missing skill, a removed skill, and a skill whose trigger is `off` are the same `not_found` result: `Skill is not available.`

When `runtime` is `hermes`, the instruction text includes a Hermes `SKILL.md`. The frontmatter is `name`, `description`, and `version`, plus `author`, `license`, `platforms`, `metadata.hermes.tags`, `metadata.hermes.related_skills`, and `prerequisites` when the stored skill has them. `version` is the stored version, or the content SHA when the skill has none. Tags are the store's tags, written at `metadata.hermes.tags`. A field the store does not have is omitted. `runtime` `claude`, `mini`, or omitted keeps the previous text: the preamble and the body, with no Hermes frontmatter. `runtime` `codex` or `grok` puts an Agent Skills `SKILL.md` (`name`, `description`, and `license`, `compatibility`, `metadata`, or `allowed-tools` only when the stored frontmatter already has them) in that same preamble. `runtime` `nemoclaw` puts a NemoClaw `SKILL.md` in that preamble: `name`, `description`, and `license`, `user_invocable`, `metadata.author`, or `metadata.tags` only when the stored frontmatter already has them. Store tags are not copied into `metadata.tags`. `run_skill` uses the same document on start.

### run_skill

Start a skill run, or finish one. This is one tool on purpose. A second `report_skill_done` tool would write the same row under a second name and a second chance to get the actor check wrong. The agent executes the instructions. Agent Kontrol stores the start, the end, and an optional note. It does not run the skill.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes on start | Skill id. Required on start. Omit it on completion. If you pass it then, it must match the skill on the run. |
| `agent_id` | string | no | Optional. The recorded agent id is the authenticated principal, not this field. Omit it. An agent credential or an OAuth client may pass only its own id. A different id is `identity_mismatch` and writes nothing. `MC_TOKEN` and a dashboard session cannot authenticate this field. |
| `runtime` | enum | yes on start | Caller hint. The runtime the instructions are rendered for. It is not an identity. |
| `lane` | string | no | Caller hint. Required when the skill's scope is `selected`. It is not an identity. |
| `run_id` | string | yes on completion | The id returned by the start call. A value that is not a canonical UUID is `not_found`. |
| `complete` | boolean | yes on completion | Must be `true` to finish. `run_id` without `complete: true` is `validation_failed`. `complete: true` without `run_id` is `validation_failed`. |
| `status` | enum | no | `done` or `failed`. Omitted means `done`. |
| `note` | string | no | At most 500 characters. Not a prompt and not tool input or output. |

A start checks trigger, runtime, and lane, inserts `skill_runs`, and writes a `spans` row (`trace_id` is the run id without hyphens, `kind` is `tool`, `name` is `skill:<id>`). The text includes the instructions, the `run_id`, and the lines `Call run_skill again with this run_id and complete:true when you finish.` and `Omit id. The run already names the skill. If you pass id, it must match.` Completing twice returns the first completion unchanged. An unknown `run_id`, including one that is not a canonical UUID, is `not_found`. Passing `id` on completion when it does not match the skill on the run is `validation_failed`. Only the actor that started the run can finish it. Passing another actor's `agent_id` does not transfer the run. A request with no actor cannot start a run. The fleet event feed is not written: `events.agent_id` references `agents`, and a skill run does not create an agent row. The span is the record that carries the agent id.

The agent id on `skill_runs.agent_id`, on the span's `agent_id`, and on everything read from those rows (triggers, `lastRun.agent`, and the progress digest) is the authenticated principal. An agent credential records that credential's id. An OAuth access token records the client id, or the subject when the client id is empty. `MC_TOKEN` records `mc-token`. A dashboard session records `operator`. The request does not choose this id.

Omit `agent_id` and the start uses that authenticated id. Passing the same id is accepted. Passing a different id from an agent credential or an OAuth client is `identity_mismatch`. The message names the authenticated id and says `agent_id` must match that id or be omitted. The call writes no run and no span. The server does not replace the supplied id and continue.

`MC_TOKEN` and the dashboard session are one shared secret used by many agents. A supplied `agent_id` on those two principals cannot be checked, so it is not authenticated. The run's `agent_id` and the span's `agent_id` stay `mc-token` or `operator`. The supplied value is copied to the span attribute `reported_agent_id` and nowhere else. It is not the run's agent id, and it is not used to allow the start, to allow the completion, or to attribute the trigger. A caller that needs a per-agent identity has to use an agent credential or OAuth.

`runtime` and `lane` stay caller-supplied hints. `runtime` chooses the preamble and rejects a skill that does not list it. `lane` is how a selected scope admits the call. Neither one is authenticated, and neither one is the agent id.

Demo mode, with no database, still applies the trigger, runtime, and lane gates on a start. A start that passes them returns exactly `DATABASE_URL not set; skill run not stored.` and does not invent a run id. A completion in demo mode is `not_found`, because no run row exists.

### send_message

Send an inbound message to an agent that has already reported. Requires `messages:write`. This is the MCP form of operator `POST /api/messages`. That REST route stays off the agent scope table.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_id` | string | yes | Recipient. Slugified the same way a report stores the agent id. An unknown agent, or a value that slugifies to nothing, is `not_found` with `error` `Agent not found`. Nothing is stored. |
| `body` | string | yes | 1 to 8000 characters. Not trimmed. Empty is `validation_failed`. Longer than 8000 is `validation_failed`. Nothing is stored. |
| `created_by` | string | no | Free-text label. It does not set `actor_type` or `actor_id`. |
| `idempotency_key` | string | no | Same rule as `create_task`, on the `enqueue_message` route. The same key, the same actor, and the same arguments return the original message for 24 hours and do not insert a second row. Different arguments are `idempotency_conflict`. A bad key is `validation_failed` and stores nothing. |

The server records the authenticated actor on the message row. A successful result is `Message #<id> sent to <agent>.` In demo mode that text starts with the demo banner. `POST /api/messages` with no database still drops the message and does not store it.

### requeue_task

Put a finished task back on the queue. Requires `tasks:write`. Only `done`, `failed`, and `cancelled` can be requeued. There is no separate stuck status. `queued`, `claimed`, `running`, and `review` are refused with `conflict` and `error` `Task cannot be requeued from status <status>.` A `claimed`, `running`, or `review` task whose `assigned_agent` is set and is not the caller is `forbidden` with `error` `Task is running under another agent.` The caller is `agent_id` when that argument is passed, otherwise the authenticated actor id. The comparison is the raw string and the slug. Nothing is written on a refusal.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | integer | yes | Task id. A missing id is `task_not_found` and `error` stays `Task not found`, including when `expected_revision` is sent. |
| `agent_id` | string | no | Who is asking, for the other-agent check only. It does not change `assigned_agent`. |
| `dry_run` | boolean | no | `true` returns the diff and the current `expected_revision` and writes nothing. The preview does not start with the demo banner. A non-boolean is `validation_failed` and writes nothing. A stale token on a preview is not an error. The preview returns the current revision. |
| `expected_revision` | string | no | The token from the preview. When it is present on a confirm, the update matches `md5` of the task row and a mismatch is `stale_write` with `current_revision`. Nothing is written. Omit it and the confirm is unconditional. An empty string, a non-string, or a value longer than 200 characters is `validation_failed` and writes nothing. |

The write sets `status` to `queued` and records the authenticated actor on `actor_type` and `actor_id`. `assigned_agent` and `completed_at` stay as they were. A successful result is `Task #<id> requeued.`

### delete_note

Delete one shared memory note by key. Requires `memory:write`. There is no REST delete. The memory table has no actor columns. The result text names the authenticated actor.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | string | yes | 1 to 200 characters, no control characters. A bad key is `memory_key_invalid` and deletes nothing. A valid key with no row is `not_found` with `error` `Memory not found`, including when `expected_revision` is a hash or `absent`. |
| `dry_run` | boolean | no | `true` returns the diff and the current `expected_revision` and writes nothing. The preview does not start with the demo banner. A non-boolean is `validation_failed`. |
| `expected_revision` | string | no | The token from the preview. When it is present on a confirm, the delete matches `md5` of the memory row and a mismatch is `stale_write` with `current_revision`. Nothing is written. Omit it and the delete is unconditional. A bad token is `validation_failed` and writes nothing. |

A successful result is `Deleted memory key "<key>".`

### list_activity

List write receipts and other events, newest first.

Operator only, the same boundary as `GET /api/traces`. An agent credential is denied, including one with `fleet:read`. `MC_TOKEN` and an OAuth access token can call it. `actor` is an exact actor id. `kind` is an exact event kind (`create_task`, `task_claimed`, `task_updated`, `task_requeued`, `remember`, `delete_note`, `send_message`, `reply_to_operator`, `status`, and the other event kinds already stored). `since` and `until` are inclusive ISO timestamps. A `since` later than `until`, a timestamp that is not ISO, an `actor` longer than 200 characters, or a `kind` outside 1 to 64 letters, digits, or `_ . : -` is `validation_failed` and reads nothing. `limit` is 1 to 200 and defaults to 50. `cursor` is the opaque `next_cursor` from the previous page. `fields` is a comma-separated allowlist; `id` is always included. Omitting `limit` and `cursor` omits the `next_cursor` line. A cursor for another list is `validation_failed`.

With no database this reads the in-memory demo log and the text starts with the demo banner. There is no static sample. `GET /api/activity` returns the same rows.

Task status changes (`update_task`, `claim_task`, `requeue_task`) record the receipt in the same statement as the write. A statement that changes no row writes no event. `report_status` writes the agent, the session, and the event in one statement. If that statement fails, none of those rows change. `update_task` still returns its own receipt when a later status report fails. The result then adds `note: the status event was not recorded` and the task row stays as written. `create_task`, `reply_to_operator`, and `send_message` record the receipt after the idempotent write commits, and a replay returns the original receipt instead of inserting a second row. `remember` and `delete_note` record a new event on every successful write, including an overwrite of the same memory key.

## Errors

A tool failure returns `isError: true`. The text of the result is JSON with the same keys as a REST error:

```json
{ "error": "Memory key is invalid.", "code": "memory_key_invalid", "fix": "Use a key of 1 to 200 characters with no control characters, or omit the key.", "retryable": false, "fields": { "key": "Use 1 to 200 characters and no control characters, or omit the key." } }
```

`error` is a string. `retryable` is `true` for `rate_limited`, `internal_error`, and for `idempotency_conflict` when the first attempt may already have committed or when the first request is still inside its 30 second lease. A live lease also returns `retry_after` seconds in the tool JSON. The REST form of that wait is the `Retry-After` header. A retry after the lease takes over a claim that never stored a result and runs the write once. A retry after the resource statement commits returns the stored response and does not insert another row while the claim is inside its 24 hour window. The key is scoped by actor and route. A handler that throws is logged on the server and returned as `internal_error` with a generic `error` string. The exception text is not in the result.

`remember` and `recall` return `memory_key_invalid` when `key` is empty, longer than 200 characters, or contains a control character. Omitting `key` is valid. `update_task` returns `task_not_found` when the id does not exist. With a database that is the tasks table. In demo mode that is the in-memory store. `error` stays `Task not found`. `reply_to_operator` returns `not_found` or `forbidden` when `in_reply_to` does not exist or belongs to another agent. `create_task` and `reply_to_operator` return `idempotency_conflict` when `idempotency_key` was already used with different arguments, or when the first request with that key is still inside its 30 second lease. During that lease the same arguments are `retryable: true` and include `retry_after` seconds. After the lease, the same arguments take over a claim that never stored a result and run the write once. A key longer than 200 characters or containing a control character is `validation_failed`. Omitting the key is valid.

`task_not_claimable` is defined so a caller can handle it. No tool returns it. `claim_task` with nothing queued is a normal result whose text says there is no queued task, not an error.

Arguments that fail the tool's input schema are rejected by the MCP SDK before the handler runs. That result is `isError: true` whose text is the schema message, not this JSON. The catalogue below is what the handler itself returns.

The HTTP `401` for a missing or invalid bearer is unchanged: `WWW-Authenticate` points at `/.well-known/oauth-protected-resource`. An authenticated `POST /api/mcp` whose body is empty or not JSON answers HTTP `400` with `code` `invalid_json` and `error` `invalid JSON`. That response is not a tool result.

| Code | Retryable | When a tool returns it |
| --- | --- | --- |
| `unauthorized` | no | Not returned inside a tool result. The HTTP `401` above covers a bad bearer. |
| `forbidden` | no | `reply_to_operator` when `in_reply_to` belongs to a different agent. `get_skill` or `run_skill` when the runtime is incompatible or the lane is outside the skill's scope. `run_skill` when a different actor finishes a run, or when the caller has no actor. `requeue_task` when a claimed, running, or review task is held by another agent. `error` is `Task is running under another agent.` |
| `identity_mismatch` | no | `run_skill` when an agent credential or an OAuth client passes an `agent_id` other than the authenticated id. The message names that id. Omit `agent_id`, or pass the same id. The call writes no run and no span. `MC_TOKEN` and a dashboard session do not return this code: a supplied `agent_id` there is the span attribute `reported_agent_id` only. |
| `not_found` | no | `reply_to_operator` when `in_reply_to` does not exist. `get_skill` or `run_skill` when the skill is missing, removed, or trigger `off`. `run_skill` when `run_id` does not exist or is not a canonical UUID. `send_message` when the agent does not exist (`error` is `Agent not found`). `delete_note` when the key does not exist (`error` is `Memory not found`). |
| `validation_failed` | no | `create_task`, `reply_to_operator`, or `send_message` when `idempotency_key` is longer than 200 characters or contains a control character. `send_message` when `body` is empty or longer than 8000 characters. `requeue_task` or `delete_note` when `dry_run` is not a boolean or `expected_revision` is empty, non-string, or longer than 200 characters. `list_activity` when `since`, `until`, `actor`, `kind`, `limit`, `cursor`, or `fields` is not usable. `run_skill` when a start omits `id` or `runtime`, when `complete` is true without `run_id`, when `run_id` is set without `complete: true`, when `id` on completion does not match the skill on the run, or when `note` is longer than 500 characters. A privacy refusal on `POST /api/usage/ingest` is this code. Schema failures are the SDK message, not this JSON. |
| `invalid_json` | no | Not a tool result. Authenticated `POST /api/mcp` returns HTTP 400 when the body is empty or not JSON. A missing bearer stays HTTP 401 with `WWW-Authenticate`. |
| `missing_field` | no | Not returned by a tool. The input schema rejects a missing argument first. |
| `rate_limited` | yes | Not returned by a tool. `POST /api/login` only. The OAuth consent form shares that limiter and answers with HTML, not this JSON. |
| `conflict` | no | `requeue_task` when the status is not `done`, `failed`, or `cancelled`, and the other-agent refusal does not apply. `error` is `Task cannot be requeued from status <status>.` REST settings save with no database also uses this code. |
| `idempotency_conflict` | no | `create_task`, `send_message`, or `reply_to_operator` reused `idempotency_key` with different arguments, or the first request with that key is still inside its 30 second lease. `reply_to_mark` is the same tool schema and the same key as `reply_to_operator`. `send_message` uses the `enqueue_message` route, the same route as `POST /api/messages`. The same key, the same actor, the same route, and the same arguments return the original result for 24 hours. Different arguments stay non-retryable. While the first request is inside its 30 second lease, the same arguments are `retryable: true` and the tool JSON includes `retry_after` seconds. The REST form of that wait is the `Retry-After` header. After that lease, the same key and the same arguments take over a claim that never stored a result and run the write once. A claim insert whose result is lost is re-read, and the write runs once when this attempt owns the claim. The resource insert and the stored response commit in one statement, and that insert runs only while this attempt's claim token still matches. A committed write therefore has a stored response. A retry returns that response and does not insert another row while the claim is inside its 24 hour window. A caller that dies before reading the response gets the same row on retry. After that window the same key starts a new write. The key is scoped by actor and route. |
| `stale` | no | Not returned by a tool. REST settings save with a stale `version`. |
| `stale_write` | no | `requeue_task` or `delete_note` when `expected_revision` does not match the current row. The result includes `current_revision`. Nothing is written. REST `POST /api/memory` and `PATCH /api/tasks/:id` return the same code. |
| `task_not_found` | no | `update_task` or `requeue_task` when the id does not exist in the database, or in the in-memory store when `DATABASE_URL` is unset. `error` stays `Task not found`. |
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
- Call list_skills, then get_skill, then run_skill. Finish with the same run_id and complete true, and omit id. A skill read from disk is not a run Agent Kontrol can see.
```

## Skills mirror

Fleet skills live in git. The default sources are `mrhinkle/master-skills` at `skills/*` and `The-AIE/the-gibson` at `skills/*` and `.agents/skills/*`. Agent Kontrol copies them. It does not edit them. The connected agent executes a skill. Agent Kontrol serves the instructions and records a start and an end. A start with no end shows as `stalled`.

### What is stored

`skill_runs` stores the run id, the skill id, the content SHA, the agent id (the authenticated principal, not a request field), the lane, the runtime, the start, the end, the status (`running`, `done`, or `failed`), an optional note of at most 500 characters, and the actor. It does not store prompts or tool input or output. A self-reported `agent_id` from `MC_TOKEN` or a dashboard session is not a column on this row. It is the span attribute `reported_agent_id`. The displayed status is `done` when the run has ended (`outcome` is `done` or `failed`), `running` while it is inside the stall window, and `stalled` after that. The stored status stays `running` until the end is recorded.

The content SHA is SHA-256 hex over the raw SKILL.md bytes, UTF-8, with no newline normalisation. A collector hashes the file as stored, including the frontmatter. Lists and the AGENTS.md pointer use the first 7 hex characters. That is not the git commit.

`sha` on a skill row is that content hash. `commit_sha` is the upstream commit at which the content last changed. `upstream.sha` and `upstream.syncedAt` come from the latest finished sync that recorded a non-empty source commit, of any status. A failed sync that still recorded the commit it fetched, including one failed by a parse problem, is the source of that sha. A failed fetch that recorded no commit does not replace an older one. That sha can be newer than a skill's `commit_sha` when a sync found nothing to write.

Reference files are text only. A file over 256 KB, or a file that would push the skill's references over 1 MB, is skipped. A binary file is skipped. Those skips are listed in the sync `errors` and do not by themselves mark the sync failed. A SKILL.md over 1 MB, or a SKILL.md that is not UTF-8 text, marks the sync failed and keeps the stored row. A failed fetch does the same for that source: the rows stay, and they are not reported as removed.

### REST

`GET /api/skills` and `GET /api/skills/:id` require `skills:read` for an agent credential. `PATCH /api/skills/:id`, `POST /api/skills/sync`, `POST /api/skills/drift`, and `GET /api/skill-bundles` are not in the agent scope table. A dashboard session or `MC_TOKEN` can call them. An agent credential cannot, including one that holds `skills:write`. `GET /api/skills/:id` stays on `skills:read` when the id is `export`.

`GET /api/skill-bundles?runtime=hermes&lane=` downloads a gzip tar of the tree for that runtime. The filter is the `list_skills` visibility check: trigger `off` is omitted, a trigger outside `off`, `on_request`, `auto_inject`, and `scheduled` is listed as `invalid trigger`, and a selected scope is omitted unless `lane` admits it. The directory is the skill id, the upstream directory slug. The frontmatter name may differ. The folder is the id. Category is a Hermes folder only (`<category>/<id>/SKILL.md`, or `uncategorized` when the category is blank). Claude, Codex, Grok, mini, and NemoClaw do not put category in the path. Codex, Grok, and NemoClaw use `.agents/skills/<id>/SKILL.md`. A Hermes category or an id outside `^[a-z0-9][a-z0-9-_]*$` is omitted and listed. The stored text is left as it is. Two skills that would share an archive path are both omitted. A reference that is unsafe, that collides case-insensitively, or that does not fit ustar is listed, and the skill is still exported. `manifest.json` holds the full skip list. `x-ak-skipped` carries the count, the first 20 entries, and `see manifest.json`, and is at most 4 KB. See [API.md](API.md#skill-bundles).

`GET /api/skills?runtime=&q=&category=` returns `{ demo, upstream, skills }`. Each skill's `runtimes` is an array of names. Each skill also has `category` (string or null) and `tags` (array of strings), copied from SKILL.md frontmatter. `category` is one trimmed string. `tags` is a list of trimmed strings. A scalar string tag is kept as a one-element list. A missing key, a blank string, or any other shape is null or `[]`. Declared text is stored as written. It is not checked against the 16-value list in master-skills `TAXONOMY.md`. `category` on the query string is an exact case-insensitive match. The value `uncategorized` matches a null category. `GET /api/skills/:id` returns that same skill with `runtimes` as an object of booleans, plus `body`, `references` (paths only), `schedule`, and `triggers` (newest first, at most 50). An unknown runtime is HTTP 400. An unknown id is HTTP 404.

### How a skill's runtimes are chosen

`runtimes` is optional in SKILL.md. Of the 161 skills in the default sources, 3 declare `runtimes`. Inference is the common path.

An explicit `runtimes` list in the SKILL.md frontmatter wins. The same key in `skill.json` or `manifest.json` is used only when the frontmatter has no `runtimes` key. The names are `claude`, `codex`, `grok`, `hermes`, `mini`, and `nemoclaw`. An unknown name is ignored and does not add the other runtimes. A value that is not a list of names is stored as Claude-only. That is a failure of evaluation. It is not a decision that the skill runs on every runtime. Frontmatter that cannot be parsed is not stored. An existing skill row and its settings stay. A skill that was not stored yet is skipped. The sync is failed.

With no list, a skill is Claude-only when the frontmatter has `allowed-tools`, or when the body contains `mcp__`, `AskUserQuestion`, `TodoWrite`, `Skill tool`, `Agent tool`, or `ExitPlanMode`. Anything else is compatible with all six runtimes. A stored row that has no `nemoclaw` boolean stays false for that flag until a sync rewrites it. That is the same rule a row stored before `hermes` existed already uses.

`PATCH` accepts `trigger`, `scope`, and `schedule`. Unknown keys are HTTP 400. `trigger` is `off`, `on_request`, `auto_inject`, or `scheduled`. `scope.mode` `all` stores `lanes` as `[]`. `selected` requires at least one lane. `scheduled` requires a five-field cron (`*`, numbers, ranges, lists, and steps; no names). Any other trigger clears `schedule`. A present non-null `schedule` that is not a five-field cron is HTTP 400. `dry_run` is rejected. The task dry-run helper does not apply to skill settings. Saving a skill whose runtimes are all false is allowed and adds `warnings`.

With no database, GET returns `demo: true` and a fixture list. PATCH, sync, and drift return `{ ok: true, demo: true, note }` and do not claim the write happened. PATCH does not look the id up in that mode. GET of an unknown id is still 404.

### Sync

`POST /api/skills/sync` with an empty body, or `{"trigger":"manual"}`, runs a manual sync. A scheduler uses the same route. This repository does not register a Vercel cron for it. Scheduled skills have their own tick; see Scheduled skills below.

```sh
curl -s -X POST https://YOUR-DEPLOY.vercel.app/api/skills/sync \
  -H "Authorization: Bearer YOUR_MC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trigger":"scheduled"}'
```

The GitHub token is `GH_TOKEN`, otherwise `GITHUB_TOKEN`. Those are the names the `gh` CLI already uses. A public repository can be read with no token. HTTP 401, 403, 404, a truncated tree, or any other fetch failure keeps that source's rows. The body `status` is `failed`. It is not a removal.

One sync at a time. The lease is a `skill_sync_runs` row with `status` `running`, guarded by a partial unique index. A second sync returns `status: "busy"` and does not fetch. A running row older than 10 minutes is marked failed so a crashed sync does not wedge the mirror. The old process can still be alive. Every skill write and the finish update run only while that sync's row is still `status` `running`. If a newer sync has taken the lease, the old one stops, returns `status: "busy"` with error `sync lease lost`, and its writes do not land. When nothing changed, `added`, `changed`, and `removed` are empty and no skill row is written. The sync run still records the commit that was fetched.

An id that appears in more than one source is kept by the earlier source (`position` ascending). The other is listed in `conflicts` and is not stored. The same source producing the same id twice keeps the first path.

`status: "failed"` means a source was not fetched, a SKILL.md could not be parsed, or a SKILL.md could not be read. Rows that were written are still listed in `added` and `changed`. A parse problem is not a written row: the existing skill stays out of `added`, `changed`, and `removed`, and a new skill is absent. A conflict, a skipped reference, or an ignored runtime name does not by itself fail the run. Unreadable frontmatter is not stored and is not treated as compatible with every runtime.

### Scheduled skills

`trigger: "scheduled"` stores a five-field cron, read in UTC. Agent Kontrol does not run the skill. It queues a task, and a connected agent claims that task and calls `run_skill` as usual.

`POST /api/skills/schedule/tick` is the tick. It is an operator route: `MC_TOKEN` or the dashboard session, never an agent credential, and `skills:write` does not help. The body is ignored. This repository deploys on Fly and registers no Vercel cron, so an external scheduler calls the route every minute, the same way it calls the sync route:

```bash
curl -s -X POST https://YOUR-DEPLOY.example/api/skills/schedule/tick \
  -H "Authorization: Bearer $MC_TOKEN"
```

On each tick, for every skill whose trigger is `scheduled`, whose skill row is not removed, and whose cron has a due minute in the last `AK_SKILL_SCHEDULE_CATCHUP_MINUTES` minutes (default 10, allowed 1 to 1440), it queues one task:

- Title `Run scheduled skill <id>`. The description names the skill, the scope (all lanes, or the selected lanes), the due slot (`Scheduled slot: 2026-10-27T12:10Z`), the compatible runtimes, and the three `run_skill` steps. The task is created by the actor `skill-scheduler`, not by the caller of the route.
- Routing follows the skill's runtime flags. A skill compatible with exactly one of `claude`, `codex`, `grok`, or `hermes` gets that platform (`claude-code`, `codex`, `grok`, `hermes`). Any other skill gets platform `any`, and the description lists the runtimes so a worker that is not listed leaves it. A skill compatible with only `mini` is also platform `any`, and is pinned to the machine in `AK_SKILL_MINI_MACHINE` when that is set. A skill compatible with only `nemoclaw` is platform `any` and is not pinned to a machine. A skill with no compatible runtime is skipped as `no_runtime`.
- The task carries the idempotency key `skill-schedule:<id>:<slot>`, so two ticks for the same minute, from any caller, make one task.

A tick queues nothing for a skill when:

- `previous_open`: its previous scheduled task is still `queued`, `claimed`, `running`, or `review`. A task that never finishes blocks the skill until someone cancels or completes it.
- `already_scheduled`: the newest scheduled task is for this slot or a later one, whatever its status.
- `duplicate`: a concurrent tick holds the key for this slot, or queued a task for the same skill at a different slot first. The unique index `tasks_skill_schedule_one_open_idx` allows one open scheduler task per skill, so a racing insert fails and nothing is queued twice.

Due minutes since the skill's previous scheduled task that no task covers are not queued one by one. A skill's first task has no previous task, so it reports none. The next task covers them, says how many there were, and the tick reports the count as `missed`. `missed` counts at most the last 7 days. A due minute older than the catch-up window is not replayed. There is no table for this: the slot in the task description is the record, and the scheduler matches only tasks written by the `skill-scheduler` actor, so an agent cannot block or fake a slot by creating a task with the same title.

The response is `{ ok, now, scheduled, queued, skipped, items }`. `scheduled` counts skills with a valid cron. Each item is `{ skill_id, slot, outcome: "queued" | "skipped", reason?, task_id?, missed? }`. A skill that is not due has no item. With no database the response is `{ ok: true, demo: true, note }` and nothing is queued.

`GET /api/skills` and `GET /api/skills/:id` carry two additional fields on each skill, both ISO strings or `null`: `lastScheduledAt`, the newest slot the scheduler queued, and `nextDueAt`, the next due minute for a scheduled skill (null if the cron never matches, such as `0 0 31 2 *`; the search looks 8 years ahead). Existing fields are unchanged. Run history stays in `lastRun` and `triggers`; a scheduled run appears there only after an agent calls `run_skill`.

### Drift

The server cannot read the operator's machine. A collector posts:

```json
{ "host": "lane-host", "dir": "~/.codex/skills", "skills": [{ "name": "verify-gibson", "sha": "<64 hex chars>" }] }
```

`name` is the skill id. `sha` is the content SHA above. The directories a collector may report are `~/.codex/skills` and `~/.agents/skills`. `AK_SKILL_DRIFT_DIRS` replaces that list, comma-separated. Any other `dir` is HTTP 400. The server does not open those paths. An empty `skills` array means the directory was read and was empty. A collector that failed to read the directory must not post an empty list. That would look like every mirrored skill was missing.

#### The drift collector

`scripts/collect-skills-drift.mjs` is that collector. It is one file, needs Node 18 or newer, and has no dependencies, so it runs on a machine with no checkout of this repository.

```sh
# Copy it to a machine (laptop or the Mac Mini)
mkdir -p ~/.mission-control && cp scripts/collect-skills-drift.mjs ~/.mission-control/   # or: scp scripts/collect-skills-drift.mjs mac-mini:.mission-control/

# See what it would post. Needs no token and sends nothing.
node ~/.mission-control/collect-skills-drift.mjs --dry-run

# Post for real
MC_URL=https://YOUR-DEPLOY.vercel.app MC_TOKEN=... node ~/.mission-control/collect-skills-drift.mjs
```

It reads `<dir>/<name>/SKILL.md` for each directory, follows one level of symlink to a directory, skips names that start with `.` (such as `.system`), hashes the raw bytes with SHA-256, and posts one report per directory. `MC_URL` and `MC_TOKEN` come from the environment only. The script does not read the token from arguments or from a file, and it never prints it or any server response text. `MC_URL` must be https, except for localhost. The `host` it reports is `--machine NAME`, then `AK_MACHINE`, then the hostname. The directories are `AK_SKILL_DRIFT_DIRS` (the same variable the server reads), otherwise the two defaults. Each is posted as written (spaces around the commas are trimmed), so it must match the server's list.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every existing directory was read and posted (with `--dry-run`, read and printed). A directory that does not exist is skipped with a notice. |
| 1 | A post failed (network error or non-2xx). |
| 2 | A directory exists but could not be read or enumerated, including one unreadable or dangling `SKILL.md`. Nothing is posted for that directory. The other directories are still posted. |
| 3 | Configuration error, or every configured directory is missing, so nothing was reported. |

A directory that exists and is readable but holds no skills posts an empty list. A skill whose name the server would reject (not `[A-Za-z0-9][A-Za-z0-9._-]{0,80}`) is skipped with a warning. Running it twice posts identical bodies.

On macOS, `scripts/install-skills-drift.sh` sets up the schedule. It copies the collector to `~/.mission-control/`, adds `MC_URL` and `MC_TOKEN` to `~/.claude/mission-control.env` if they are missing (created mode 600, other lines kept), writes `~/.mission-control/run-skills-drift.sh`, and loads an hourly launchd job at `~/Library/LaunchAgents/com.missioncontrol.skills-drift.plist`. The wrapper reads `MC_URL` and `MC_TOKEN` from the env file as literal `KEY=value` lines (nothing in the file is executed), then runs the collector. The plist holds no secret. `AK_MACHINE` and `AK_SKILL_DRIFT_DIRS` set when you run the installer go into the plist. `MC_SKILLS_DRIFT_INTERVAL` sets the seconds between runs. Run it from a checkout, or copy `install-skills-drift.sh` and `collect-skills-drift.mjs` together to the machine. `--uninstall` removes the job and leaves the files.

```sh
MC_URL=https://YOUR-DEPLOY.vercel.app MC_TOKEN=... ./scripts/install-skills-drift.sh
tail ~/Library/Logs/mc-skills-drift.log   # a non-zero exit is logged here
```

From cron, call the same wrapper: `17 * * * * $HOME/.mission-control/run-skills-drift.sh >> $HOME/Library/Logs/mc-skills-drift.log 2>&1`. A token or URL must be a single line.

`missing` is in the mirror and not in the report. `extra` is in the report and not in the mirror. `differs` is both, with different content SHAs. The POST response is `{ ok, host, dir, missing, extra, differs, driftCount }`. `driftCount` there is the number of rows in those three lists for this report. `upstream.driftCount` on `GET /api/skills` is the number of distinct skill names that disagree in any stored report. The same name on two hosts counts once.

### Runs, the brief, and pointers

`triggerCount7d` and `lastRun` come from `skill_runs` in one grouped query. The progress digest's optional `skills` field counts runs whose start is inside the digest window. `stalled` lists every current stalled run, including one that started before the window. `enabled_never_used` is an enabled skill with no run inside the window. The note on that object is the limit: only triggers routed through `run_skill` are counted. An agent that reads a skill from disk is invisible.

Limits:

- The agent id on a run is the authenticated principal. A request field cannot name a different agent. See `run_skill` above.
- `MC_TOKEN` and the dashboard session share one secret. A supplied `agent_id` is only the span attribute `reported_agent_id`. It is not the run's agent and it authorizes nothing.
- `runtime` and `lane` are advisory caller hints. They are not an identity.

`AK_SKILL_STALL_MINUTES` is the stall window. The default is 60. A non-integer, a value below 1, or a value above 10080 falls back to 60, so a bad setting does not hide stalls. More than three stalled runs roll into one `skillStalled` alert. The id starts with `skill-stalled:`.

`renderLaneSkillPointers` builds the AGENTS.md block for skills whose trigger is `auto_inject`, which match the runtime, and whose scope admits the lane. The block is ordered by id and wrapped in `<!-- ak-skills:begin -->` and `<!-- ak-skills:end -->`. No matching skill returns an empty string, with no markers.

#### Dispatch and AGENTS.md

What is wired: two read routes and a pure helper. What is not: no Agent Kontrol process opens a repo or writes an AGENTS.md. `agents/dispatcher/mc_dispatcher.py` does not call these routes. The Grok and Codex lane dispatcher lives outside this repo, so it has to make the call.

- `GET /api/skills/pointers?lane=&runtime=&format=json|text` returns the block. `lane` and `runtime` are required. JSON is `{ demo, lane, runtime, empty, block }`. `format=text` returns the block as `text/plain`, or an empty body when nothing matches. Agent credentials need `skills:read`.
- `POST /api/skills/pointers` takes `{ lane, runtime, agents_md }` and returns `{ demo, lane, runtime, empty, changed, content }`. `content` is the file text with the block inserted at the end, replaced in place, or removed when `empty` is true. Text outside the markers is untouched, CRLF files stay CRLF, and a second run reports `changed: false`. Duplicate blocks collapse into one. `agents_md` omitted or null means the file does not exist: `content` is null when there is nothing to write. A begin marker without an end, an end without a begin, or a nested begin is HTTP 400. The route stores nothing and writes no file. The same needs `skills:read`.
- `applyPointerBlock(content, block)` in `src/lib/skills/agents-md.ts` is the helper behind POST.

A dispatcher runs this in the target repo before the lane starts. It needs `jq`, `curl`, and `MC_URL`/`MC_TOKEN`. Use the lane name the skill scopes use and the runtime that will read the file. It stops without touching the file if the file exists and cannot be read, if the call fails, or if the server answers with an error:

```bash
f=AGENTS.md
if [ -L "$f" ]; then f=$(readlink -f -- "$f") || exit 1; fi
if [ -e "$f" ]; then req=$(jq -Rs --arg l "$LANE" --arg r "$RUNTIME" '{lane:$l,runtime:$r,agents_md:.}' "$f") || exit 1
else req=$(jq -n --arg l "$LANE" --arg r "$RUNTIME" '{lane:$l,runtime:$r}'); fi
res=$(curl -fsS -X POST "$MC_URL/api/skills/pointers" -H "Authorization: Bearer $MC_TOKEN" -H 'Content-Type: application/json' -d "$req") || exit 1
if [ "$(jq -r '.changed' <<<"$res")" = true ]; then
  tmp=$(mktemp "$(dirname "$f")/.agents-md.XXXXXX") || exit 1
  jq -j '.content // empty' <<<"$res" > "$tmp" && cat "$tmp" > "$f" || { rm -f "$tmp"; exit 1; }
  rm -f "$tmp"
fi
```

The file is written only when `changed` is true, and it is built in a `mktemp` file first and then copied over the target, so a symlink and the file mode are kept. If the call fails the file is left as it was, so a lane still starts without pointers. Do not commit the result: the block is per-lane and belongs in the working tree.
