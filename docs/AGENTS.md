# Agent adapters

This document describes the adapters that connect coding agents to Agent Kontrol: what each one watches, how to install it, and what it can do. All adapters live in `agents/<name>/` in the repository.

## What each adapter can do

| Adapter | Status | Messages to the agent | Tasks | Traces | Usage |
| --- | --- | --- | --- | --- | --- |
| claude-code (hook) | Yes, from lifecycle hooks | Yes, pulled at checkpoints | Via the dispatcher | Yes: session, turn and tool spans | No |
| codex (watcher) | Coarse, from session files | No | Via the dispatcher | No | No |
| mc-agent | Heartbeats and file tails | No | No | No | No |
| dispatcher | Task results | No | Yes: claims and runs them | No | Cost per task |
| cowork-cloud (MCP) | Only if the agent calls `report_status` | Yes, via `check_inbox` | Yes, via MCP tools | No | No |
| grok | Dispatcher plus MCP | Via MCP | Via the dispatcher | No | No |
| hermes | Via MCP | Via MCP | Via MCP (`claim_task`) | Any OpenTelemetry exporter | With the usage collector |
| usage-collector | No | No | No | No | Yes |
| progress-collector | No (feeds the Progress board) | No | No | No | No |

"Via MCP" means the agent has to call the tool; it is not automatic. Every adapter that ends a session, or reports status `done` or `failed`, also gets an automatic note in shared memory (see [Memory (Notes)](MEMORY.md)). Any agent or SDK that can export OpenTelemetry can send traces to `/api/v1/traces` (see [Telemetry and traces](TELEMETRY.md)). A Cline and Roo Code adapter was proposed but is not included: its file locations have not been verified against a real install.

## claude-code

A Python hook (`mission_control_hook.py`) that POSTs Claude Code and Cowork-local lifecycle events to `/api/ingest`. It fires whether or not the model remembers to report, and it fails open: it exits 0 and never blocks a session. `install.sh` installs the hook using `MC_URL` and `MC_TOKEN`. `MC_AGENT` optionally sets the agent id; the default is `claude-code-<hostname>`. At natural checkpoints the hook also pulls messages the operator has queued and hands them to the model. With the `PreToolUse` and `PostToolUse` hooks registered (see `settings-fragment.json`) it also emits traces: a session span, a turn span per prompt and a span per tool call. Set `MC_TRACES=0` to turn that off. Details are in [Telemetry and traces](TELEMETRY.md).

## codex

`codex_watcher.py` is a daemon. ChatGPT Work/Codex has no public session-status API, so the watcher watches `~/.codex/sessions` (override with `CODEX_SESSIONS_DIR`) and reports from file changes. The signal is coarse but deterministic. `MC_POLL_SECONDS` defaults to 30. Run it with `MC_URL` and `MC_TOKEN`.

## mc-agent

One launchd process per Mac. It probes for Claude Code, Codex, Grok and Hermes state directories, heartbeats each platform it finds, and tails session and log files to report `session_start`, `status` and `session_end`. Claude sessions are not tailed (the hooks cover them), but it heartbeats `claude-code-<hostname>`. It is stdlib-only Python 3.9+. Each machine reports as `<platform>-<hostname>`.

## dispatcher

One daemon per machine (`mc_dispatcher.py`). It polls for queued tasks, runs them headless on the agent CLIs present (`claude`, `codex`, `grok`), and reports result and cost back. The poll interval is `MC_POLL_SECONDS`. Queue tasks on the Tasks page or with the `create_task` MCP tool. Cross-vendor review by a second platform is optional.

## cowork-cloud

Claude Cowork cloud sessions cannot run hooks. Add the MCP server as a custom connector at `https://YOUR-DEPLOY.vercel.app/api/mcp` and sign in through OAuth (approve with the dashboard password). Add standing instructions to call `report_status`.

## grok

The xAI Grok Build CLI is early beta (`grok -p`). There are two ways to connect it; use both: the dispatcher serves platform `grok` automatically if `grok` is on `PATH`, and MCP configured in `~/.grok/config.toml` covers status and notes.

## hermes

NousResearch hermes-agent (MIT, model-agnostic). Add the MCP server URL with an `Authorization: Bearer YOUR_MC_TOKEN` header, add a persona instruction, and optionally a cron heartbeat.

## progress-collector

`install.sh` installs `scripts/collect-progress.sh` as a launchd job that runs every 15 minutes; set `MC_PROGRESS_INTERVAL` seconds to change that. It needs `gh` (authenticated), `jq` and `curl`. It takes its repo list from the dashboard's Settings page on each tick and falls back to `progress.config.json` if the dashboard is unreachable or has no saved list. Install it on a machine that stays awake: missed ticks are permanent gaps. The installer also copies `scripts/sweep-producer.sh`, which posts absence-sweeper evidence only when a separate `sweep-producer.config.json` sets `enabled: true` (see [VELOCITY.md](VELOCITY.md#producer)).

## usage-collector

Read-only. It reads Hermes session usage and posts token counts, costs, model and billing metadata to `/api/usage/ingest`. It never sends prompts or completions. It installs as a launchd agent. Usage and Costs is experimental.

## Capability matrix

| Adapter | Mechanism | Reports status | Receives operator messages | Runs queued tasks |
|---|---|---|---|---|
| claude-code | hook | yes | yes, pulled by the hook at checkpoints | via dispatcher |
| codex | file watcher | yes (coarse) | via MCP only | via dispatcher |
| mc-agent | discovery daemon | heartbeats and session events | no | no |
| dispatcher | task daemon | task progress events | no | yes (claude, codex, grok CLIs) |
| cowork-cloud | MCP connector | yes (report_status) | yes (check_inbox, reply_to_operator) | claim_task via MCP |
| grok | dispatcher + MCP | yes | via MCP | yes via dispatcher |
| hermes | MCP + cron | yes (report_status) | yes (check_inbox, reply_to_operator) | claim_task via MCP |

## Message delivery

Operator messages reach an agent only when that agent polls (`check_inbox` or the hook), and replies appear only if the agent calls `reply_to_operator`, so a message can sit queued. The Fleet card shows the queued, delivered and replied states.

## Credentials

Adapters can keep sending `MC_TOKEN`. That token has every scope. Settings can also issue an `akc_…` credential with a subset of scopes; send it as `Authorization: Bearer`. Revoke it from Settings without redeploying. The server stores the label, an 8-character prefix, the SHA-256 of the token, the scopes, and timestamps. It does not store the token. Collector routes (progress ingest, usage ingest, trace export) are not in the scope table, so those adapters keep using `MC_TOKEN`. The scope table is in [MCP.md](MCP.md).

## See also

- [MCP.md](MCP.md) — the MCP server and its tools.
- [API.md](API.md) — the ingest routes.
- [DEPLOY.md](DEPLOY.md) — environment variables and deployment targets.
- [ARCHITECTURE.md](ARCHITECTURE.md) — data flow and schema.

## Dispatcher event wakeups (#78)

The dispatcher can opt into the outbound stream after an operator registers a
consumer and provisions an `events:read` credential. Set `MC_EVENT_CONSUMER` and
`MC_EVENT_TOKEN` alongside its existing `MC_URL`/task credential configuration.
Do not put the event credential in the URL. No listener is started when these
variables are absent; invalid configuration logs a bounded error and preserves
polling. HTTPS is required except for loopback development. Redirects are refused.

The listener validates bounded SSE frames, resumes using `Last-Event-ID`, obeys
quota Retry-After, and uses capped reconnect backoff. A complete event only wakes
the existing atomic claim API. It never launches work from webhook payload text.
Superseded listeners stop competing and leave polling active; expired cursors
request reconciliation before replay. Capacity becoming available also wakes the
claim loop, without being mislabeled as an external event.

While connected, fallback polling is no more frequent than every 60 seconds
(`max(MC_POLL_SECONDS, 60)`). While unavailable it keeps the existing poll interval.
Claim logs distinguish event/capacity/fallback/reconciliation and count raw
`fallback_claims` with stream health. These counts are not proof of causally missed
events: task producers/reducers may not yet emit an inbox notification. Do not
claim production event coverage from this counter or from synthetic tests.

This source change does not activate any dispatcher, reviewer, scheduler or
Carmack job. Follow the API consumer setup and existing owner deployment holds.
