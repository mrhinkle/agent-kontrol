# Architecture

This document describes how Agent Kontrol is built: the stack, the data flow, the database schema, and where each piece of logic lives.

## Stack

- Next.js 15 App Router — the dashboard, REST API and MCP server in one project.
- Postgres — Neon HTTP driver or node-postgres.
- mcp-handler — the MCP server.
- Python stdlib scripts — hooks, watchers and collectors.

## Principle: agents push, nobody polls

No vendor exposes a "what are my agents doing" API, so every agent reports into a store the operator owns. Deterministic adapters (hooks, watchers, dispatchers) are the ground truth for liveness; the MCP server is the semantic layer for summaries, notes, messages and tasks. The dashboard polls the API every 7 seconds.

## Data flow

```
hooks, watchers, dispatchers --> POST /api/ingest          +
MCP clients -------------------> /api/mcp                  +
progress collector ------------> POST /api/progress/ingest +
usage collector ---------------> POST /api/usage/ingest ----+
                                                           |
                                                           v
                                                      Postgres
                                                           |
                                                           v
                                                      REST API
                                                           ^
                                                           |
Fleet, Progress, Usage and Costs, Tasks, History,          |
Memory, Gibson (dashboard pages) ---------------------------+
```

Every ingest path writes Postgres. The dashboard pages read through the REST API.

## Tables

`supabase/schema.sql` is the canonical schema. It is plain Postgres; the folder name is historical.

- `agents`
- `sessions`
- `events` — append-only activity feed
- `memory` — notes: key, content, tags, agent_id
- `messages` — operator to agent and back; direction `inbound`|`outbound`; thread_id; delivered_at, acked_at, read_by_dashboard_at
- `tasks` — queue: platform routing, priority, status `queued`|`claimed`|`running`|`review`|`done`|`failed`|`cancelled`, result, cost
- `oauth_clients`, `oauth_codes` — OAuth 2.1 server for MCP clients; access tokens are stateless signed JWTs
- `repo_snapshots` — one append-only row per repo per collector tick; re-running the same instant updates in place
- `spans` — agent traces: one row per (trace_id, span_id), upserted so an open span can be closed later; pruned after `MC_TRACE_RETENTION_DAYS`
- `model_prices`, `usage_accounts`, `usage_facts`, `account_snapshots` — usage ledger

## Status derivation

Status derivation lives in `src/lib/store.ts`. Event kinds: `session_start`, `turn_start`, `waiting`, `notification`, `session_end`, `milestone`, `status`, `error`, `heartbeat`. An agent with no event for 15 minutes shows offline. The `waiting` and `notification` kinds mark a session waiting.

## Progress board

The page never calls GitHub. The collector owns the API budget and writes snapshots. The headline metric is net backlog: issues opened minus closed in the window. Configuration lives in `progress.config.json`.

## Auth layers

- Data routes: dashboard password cookie (`mc_auth`, 30 days) or `MC_TOKEN` bearer.
- Agent routes and MCP: `MC_TOKEN` bearer or OAuth.

See [API.md](API.md). Demo mode: no `DATABASE_URL` means sample data and nothing stored.

## Code map

- `src/app` — routes and pages
- `src/lib/store.ts` — agents, memory, messages, tasks
- `src/lib/progress-store.ts`
- `src/lib/traces.ts` — OTLP parsing, sanitizing and the waterfall layout (pure)
- `src/lib/trace-store.ts` — span upsert, trace list, prune
- `src/app/api/v1/traces` — OTLP/HTTP JSON ingest; `src/app/traces` — the viewer
- `src/lib/usage-store.ts`
- `src/lib/db.ts` — driver selection
- `src/lib/auth.ts` and `src/middleware.ts` — auth
- `src/lib/oauth.ts` and `src/app/oauth` — OAuth
- `agents/` — adapters
- `scripts/` — collector, migrate, quickstart

## See also

- [DEPLOY.md](DEPLOY.md) — install and deployment targets.
- [AGENTS.md](AGENTS.md) — agent adapters.
- [API.md](API.md) — REST API and auth.
- [MCP.md](MCP.md) — MCP server and tools.
- [DATABASE.md](DATABASE.md) — database drivers.
