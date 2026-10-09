# Agent adapters

This document describes the adapters that connect coding agents to Agent Kontrol: what each one watches, how to install it, and what it can do. All adapters live in `agents/<name>/` in the repository.

## claude-code

A Python hook (`mission_control_hook.py`) that POSTs Claude Code and Cowork-local lifecycle events to `/api/ingest`. It fires whether or not the model remembers to report, and it fails open: it exits 0 and never blocks a session. `install.sh` installs the hook using `MC_URL` and `MC_TOKEN`. `MC_AGENT` optionally sets the agent id; the default is `claude-code-<hostname>`. At natural checkpoints the hook also pulls messages the operator has queued and hands them to the model.

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

`install.sh` installs `scripts/collect-progress.sh` as a launchd job that runs every 15 minutes; set `MC_PROGRESS_INTERVAL` seconds to change that. It needs `gh` (authenticated), `jq` and `curl`. It takes its repo list from the dashboard's Settings page on each tick and falls back to `progress.config.json` if the dashboard is unreachable or has no saved list. Install it on a machine that stays awake: missed ticks are permanent gaps.

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

## See also

- [MCP.md](MCP.md) — the MCP server and its tools.
- [API.md](API.md) — the ingest routes.
- [DEPLOY.md](DEPLOY.md) — environment variables and deployment targets.
- [ARCHITECTURE.md](ARCHITECTURE.md) — data flow and schema.
