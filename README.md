# Mission Control

Command center for the whole agent fleet — Claude Code, Claude Cowork (cloud +
local machines), ChatGPT Work / Codex, xAI Grok, and Hermes — with live
status, history, shared memory, two-way messaging, and a **task queue with
dispatchers** that turns the fleet into a working harness. Doctrine lives in
[PLAYBOOK.md](PLAYBOOK.md).

**The core idea: agents push, nobody polls.** No vendor exposes a
"what are my agents doing" API, so every agent reports into a store you own.
Deterministic adapters (hooks, watchers, dispatchers) are ground truth;
a shared MCP server is the semantic layer for summaries, intent, memory —
and now for queuing and claiming work.

```
Claude Code hooks ──┐
Codex watcher ──────┤  POST /api/ingest          ┌──> Dashboard (Fleet / Tasks / History / Memory)
Grok / dispatcher ──┤──────────────> Neon ───────┤
Cowork cloud ───────┤  MCP /api/mcp              └──> get_fleet_status / recall / claim_task
Hermes ─────────────┘  (report_status, remember,
                        create_task, claim_task)

Tasks page / create_task ──> queue ──> dispatcher (per machine) ──> claude -p │ codex exec │ grok -p
                                              │ optional cross-vendor review (read-only) │
                                              └──> result + cost back to the board ◄─────┘
```

## Stack

- **Next.js (App Router)** on Vercel — dashboard + ingest API + MCP server in one project
- **Neon** (serverless Postgres) — agents, sessions, events, shared memory, tasks, OAuth
- **mcp-handler** — the MCP server at `/api/mcp` (tools: `report_status`,
  `get_fleet_status`, `remember`, `recall`)
- **Python stdlib scripts** — Claude Code hook + Codex session watcher

## Setup (15 minutes)

### 1. Neon

Create a database at [neon.tech](https://neon.tech) (or attach Neon via the
Vercel marketplace — it auto-injects `DATABASE_URL`). Apply the schema:

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

(`supabase/schema.sql` is plain Postgres; the path is historical.)

### 2. Deploy to Vercel

Import this repo into Vercel, add environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon connection string (auto if Vercel-managed Neon) |
| `MC_TOKEN` | shared secret for agents — `openssl rand -hex 24` |
| `MC_DASHBOARD_PASSWORD` | password for the dashboard UI |

Deploy. With no `DATABASE_URL` set, the app runs in **demo mode** with sample
data so you can see the UI first.

With `MC_DASHBOARD_PASSWORD` set, every page (and the data APIs) sits behind
a login screen with a 30-day cookie. Agent endpoints (`/api/ingest`,
`/api/mcp`) are token-authed with `MC_TOKEN` instead, so hooks and MCP
clients are unaffected by the password gate.

### 3. Connect agents

| Agent | How | Docs |
| --- | --- | --- |
| Claude Code / Cowork local (each machine) | lifecycle hooks → `/api/ingest` | [`agents/claude-code/`](agents/claude-code/) |
| Claude Cowork (cloud) | MCP connector + CLAUDE.md instruction | [`agents/cowork-cloud/`](agents/cowork-cloud/) |
| ChatGPT Work / Codex | local session watcher daemon (+ optional connector) | [`agents/codex/`](agents/codex/) |
| Grok (Grok Build CLI) | dispatcher + MCP in `~/.grok/config.toml` | [`agents/grok/`](agents/grok/) |
| Hermes | MCP integration + persona instruction + cron heartbeat | [`agents/hermes/`](agents/hermes/) |
| **Dispatcher** (per machine) | runs queued tasks on claude/codex/grok CLIs | [`agents/dispatcher/`](agents/dispatcher/) |

### 4. Point any MCP-speaking agent at the server

- URL: `https://YOUR-DEPLOY.vercel.app/api/mcp`
- Auth: `Authorization: Bearer <MC_TOKEN>`, or OAuth (next section) for clients
  that can't set headers. Secrets in URLs are not supported: they leak into
  logs and browser history.

### Connecting via OAuth

MCP hosts that speak the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
(Claude, ChatGPT for Work, Claude Code, etc.) can connect without sharing
`MC_TOKEN` by pasting the same MCP URL:

`https://YOUR-DEPLOY.vercel.app/api/mcp`

The host then:

1. Fetches `/.well-known/oauth-protected-resource` (resource + auth server)
2. Discovers the AS at `/.well-known/oauth-authorization-server`
3. Dynamically registers a public PKCE client (`POST /oauth/register`)
4. Runs the auth-code + S256 PKCE flow (`/oauth/authorize` → `/oauth/token`)

Approve the consent screen with the same **dashboard password**
(`MC_DASHBOARD_PASSWORD`). Existing agents that send
`Authorization: Bearer <MC_TOKEN>` keep working unchanged.

**Vercel Deployment Protection** must be off (or bypassed for `/api/mcp`,
`/.well-known/*`, and `/oauth/*`) or external clients cannot complete discovery
or the OAuth handshake. Optional envs: `MC_OAUTH_SECRET` (JWT signing key),
`MC_PUBLIC_URL` (canonical issuer origin).

After pulling this change, re-run [`supabase/schema.sql`](supabase/schema.sql)
so the `oauth_clients` and `oauth_codes` tables exist (idempotent):

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
```

## API sketch

`POST /api/ingest` (Bearer auth) — deterministic telemetry:

```json
{
  "agent_id": "claude-code-macbook-pro",
  "platform": "claude-code",
  "machine": "macbook-pro",
  "session_id": "abc123",
  "kind": "session_start",
  "title": "Session started in ~/code/theaie-net",
  "project": "theaie-net"
}
```

`kind` drives session status: `session_start`/`turn_start`/`heartbeat` → active,
`waiting`/`notification` → waiting, `session_end` → done, `error` → failed.
Agents that go quiet for 15 minutes show as offline.

MCP tools at `/api/mcp`:

- `report_status` — semantic status ("researching sponsors for ATA 2026")
- `get_fleet_status` — what is everyone doing right now
- `remember` / `recall` — shared memory with keys + tags for coordination
- `check_inbox` — pull messages you queued from the dashboard
- `reply_to_operator` — agent replies so they show in the Fleet conversation drawer
- `create_task` / `get_task_queue` / `claim_task` / `update_task` — the work
  queue: any agent can queue work for any other platform, and idle agents can
  pull their next task

Task APIs (cookie or `MC_TOKEN` bearer): `GET|POST /api/tasks`,
`POST /api/tasks/claim` (atomic), `PATCH /api/tasks/:id`.

Progress APIs: `POST /api/progress/ingest` (Bearer, the collector writes here),
`GET /api/progress?window=24h|7d|30d|90d`, and `GET /api/progress/digest` for the
same board as plain text. MCP exposes it as `get_progress_digest`.

## The progress board (`/progress`)

Answers one question the fleet view can't: **is the backlog actually shrinking?**

The headline metric is `net_backlog` — issues opened minus issues closed in the
window. Positive means the queue grew. It leads because merge counts alone lie
by omission: the sweep that motivated this page found a 28-PR day on which all
three repos still ended deeper in the hole.

```
scripts/collect-progress.sh              # one tick (cron, every 15 min)
scripts/collect-progress.sh --backfill 90  # seed history, one time
scripts/collect-progress.sh --dry-run    # print the payload, post nothing
agents/progress-collector/install.sh     # install the tick as a launchd job
```

Install the collector on a machine that stays awake. Queue depth on a past date
is not recoverable from the GitHub API, so a tick that never ran is a permanent
hole in the graph.

Notes that matter when reading the numbers:

- **The page never calls GitHub.** The collector owns the whole API budget and
  writes to `repo_snapshots`; the page reads Postgres. Search allows 30 req/min,
  which a live-querying page would burn through in one open tab.
- **24h is measured directly** by each tick. Longer windows difference two
  cumulative counters, which is exact — summing overlapping rolling counts
  would not be. When history doesn't reach back far enough, the page says so
  instead of quietly reporting a short window as a full one.
- **Blocked work is per-repo.** Each repo spells the label differently and
  a repo with none reads `not tracked` rather than `0%`.
- **Lane attribution is counted, never guessed.** These repos squash-merge, so
  `main` credits every commit to the PR owner; the collector reads the PR's own
  branch commits instead. Where a repo shares one bot identity across lanes the
  work is labelled `unattributed`. Commits carrying an `Agent-Vendor:` trailer
  (a `prepare-commit-msg` hook that appends an `Agent-Vendor:` trailer) attribute exactly.

Repos and thresholds live in [`src/lib/progress-config.ts`](src/lib/progress-config.ts);
adding a fourth repo is one entry there plus one line in the collector.

## Design notes

- **Deterministic vs. probabilistic reporting.** Hooks and watchers always fire;
  "please call report_status" instructions sometimes don't. Both feed the same
  store; trust the hooks for liveness, the MCP reports for meaning.
- **Status derivation** lives server-side in `src/lib/store.ts` — one place to
  tune the state machine.
- **Demo mode** (`src/lib/demo-data.ts`) renders the full UI with no database,
  so the first deploy is never blank.

## Upgrading an existing deploy to v2

Re-run [`supabase/schema.sql`](supabase/schema.sql) against Neon
(`psql "$DATABASE_URL" -f supabase/schema.sql` — idempotent), redeploy,
and start a dispatcher on each machine ([`agents/dispatcher/`](agents/dispatcher/)).

## Roadmap

- Neon/logical realtime or SSE instead of 7s polling; per-agent detail pages
- Daily digest — done for progress (`get_progress_digest`); still to do for tasks
- **Usage and Costs** at `/usage` (Hermes + OpenRouter Phase 1; issue #12) — fleet paid vs Codex shadow ledger; later joins `tasks.cost_usd`
- Git-worktree isolation option in the dispatcher for parallel same-repo tasks
- Kill-switch for running dispatcher tasks

## License

Copyright 2026 Mark Hinkle.

Licensed under the [Apache License, Version 2.0](LICENSE). Third-party dependencies retain their respective licenses.
