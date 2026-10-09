# Deploy

This document explains how to install and run Agent Kontrol: the one-line quickstart, the deployment targets, the environment variables, and day-to-day operations.

## Quickstart

One-line install (Docker if Docker Compose is available, otherwise local demo mode on Node >= 20):

```bash
curl -fsSL https://raw.githubusercontent.com/mrhinkle/agent-kontrol/main/scripts/quickstart.sh | bash
```

The script:

- Clones the repo to `./agent-kontrol`, or reuses a clone that is already there.
- Creates `.env` with a random `MC_TOKEN` and `MC_DASHBOARD_PASSWORD` (mode 600, never overwritten).
- In Docker mode, runs `docker compose up -d --build`, waits for http://localhost:3000/login, and tells you the password and token are in `.env`.

Flags:

- `--local` — no Docker; runs `npm ci` then `npm run dev` in demo mode with no database.
- `--dir <path>` — clone location.
- `--no-start` — prepare but do not start.

The same thing without piping to a shell:

```bash
git clone https://github.com/mrhinkle/agent-kontrol.git
cd agent-kontrol
./scripts/quickstart.sh
```

## Deploy to Vercel

[![Deploy to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmrhinkle%2Fagent-kontrol&project-name=agent-kontrol&repository-name=agent-kontrol&env=MC_TOKEN%2CMC_DASHBOARD_PASSWORD&envDescription=MC_TOKEN%20is%20the%20shared%20secret%20agents%20use.%20MC_DASHBOARD_PASSWORD%20protects%20the%20dashboard.%20Generate%20each%20with%20openssl%20rand%20-hex%2024.&envLink=https%3A%2F%2Fgithub.com%2Fmrhinkle%2Fagent-kontrol%2Fblob%2Fmain%2Fdocs%2FDEPLOY.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

The Neon integration injects `DATABASE_URL`. `npm run build` applies the schema automatically when `DATABASE_URL` is present (script `scripts/apply-schema.mjs`; idempotent), so a new deploy works on first load. This is the path the author runs in production.

## Targets

| Target | Database | Effort | Status |
|---|---|---|---|
| Vercel + Neon | Neon Postgres | One click | Used in the author's production |
| Vercel + another Postgres | Any Postgres 13+ | Set `DATABASE_URL` | Supported |
| Docker Compose (self-hosted) | Postgres 16, included | Two env vars in `.env` | Same code, less exercised |
| Any Node host | Any Postgres | `npm ci && npm run build && npm start` | Same code, less exercised |
| Local demo | None | `npm ci && npm run dev` | Sample data, nothing stored |

Only Vercel + Neon is used in the author's production. CI runs the data layer tests against Postgres 16 (schema applied twice). The Docker and generic-Node paths follow the same code but are less exercised. Not supported: serverless platforms that cannot run Node 22, and plain HTTP without TLS for anything but localhost.

### Vercel + Neon

Use the Deploy button above. The Neon integration injects `DATABASE_URL`; set `MC_TOKEN` and `MC_DASHBOARD_PASSWORD` when prompted (generate each with `openssl rand -hex 24`). `npm run build` applies the schema automatically when `DATABASE_URL` is present (`scripts/apply-schema.mjs`; idempotent), so a new deploy works on first load.

### Vercel + another Postgres

Set `DATABASE_URL` to any Postgres 13+ connection string. The driver is detected automatically (see [DATABASE.md](DATABASE.md)). Use a pooled connection string on serverless.

### Docker Compose (self-hosted)

Put `MC_TOKEN` and `MC_DASHBOARD_PASSWORD` in `.env`; compose refuses to start without them. Then:

```bash
docker compose up -d --build
```

Files:

- `Dockerfile` — node:22-slim, multi-stage, runs as the non-root `node` user, healthcheck on `/login`, applies the schema on every container start.
- `docker-compose.yml` — db and app; the db port is not published; data lives in the named volume `db-data`; the app listens on `${MC_PORT:-3000}`; `POSTGRES_PASSWORD` defaults to `mc` and should be changed for anything beyond local use.

### Any Node host (VM, Fly, Railway, Render, etc.)

Requirements: Node 22 and a Postgres.

```bash
npm ci && npm run build && npm start
```

`npm run migrate` applies the schema on demand. The app listens on `PORT` (default 3000) via `next start`. Put TLS in front of it.

### Local demo

```bash
npm ci && npm run dev
```

With no `DATABASE_URL`, the app runs with sample data and stores nothing.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | In production | Postgres connection string. Unset means demo mode: sample data, nothing stored. |
| `MC_TOKEN` | Yes | Shared secret for agents: the ingest routes and the MCP endpoint. |
| `MC_DASHBOARD_PASSWORD` | In production | Dashboard password. Required in production when `DATABASE_URL` is set; otherwise the app answers 503. |
| `MC_COOKIE_SECRET` | No | HMAC key for the dashboard cookie. Falls back to `MC_TOKEN`. Rotating it signs everyone out. |
| `MC_OAUTH_SECRET` | No | HS256 key for OAuth JWTs. Falls back to `MC_COOKIE_SECRET`, then `MC_TOKEN`. Rotating it revokes all OAuth connections. |
| `MC_PUBLIC_URL` | No | Canonical origin for OAuth metadata. Otherwise derived from request headers. |
| `NEXT_PUBLIC_MC_NAME` | No | Header name. Default `Agent Kontrol`. |
| `NEXT_PUBLIC_MC_PROGRESS_CONFIG` | No | JSON object whose top-level keys replace `progress.config.json`, for example `{"repos":[...]}`. This is only the starting list: once you save one in Settings, the database list wins. Build-time. |
| `MC_REPOS_FROM_DASHBOARD` | No | Collector only. Set to `0` to ignore the dashboard's repo list and use the local `progress.config.json`. Default `1`. |
| `NEXT_PUBLIC_MC_OPERATOR` | No | Your name, shown as the sender of dashboard messages. Default `Operator`. |
| `NEXT_PUBLIC_HERMES_VITALS_URL` | No | Link shown on the progress board. |
| `MC_DB_DRIVER` | No | Driver override: `neon` or `pg`. |
| `MC_DB_POOL_MAX` | No | pg pool size. Default 5. |
| `MC_SKIP_MIGRATE` | No | Set to 1 to skip the automatic schema step. |
| `MC_PROGRESS_CONFIG` | No | Path to `progress.config.json` for the collector. |
| `MC_OPENROUTER_MANAGEMENT_KEY` | No | Key for the usage ledger. |

`NEXT_PUBLIC_*` values are baked in at build time. Generate secrets with:

```bash
openssl rand -hex 24
```

## Operations

### Upgrade

Pull and redeploy on Vercel, or:

```bash
git pull && docker compose up -d --build
```

The schema step runs again and is safe to repeat.

### Backups

Use your database provider (Neon branches/PITR), or:

```bash
pg_dump "$DATABASE_URL"
```

### Rotate MC_TOKEN

Change the env var, redeploy, then update every agent and collector with the new token.

### Collectors on Linux

The progress collector and usage collector install as macOS launchd agents. On Linux, run `scripts/collect-progress.sh` and `agents/usage-collector/collect_usage.py` from cron or a systemd timer yourself; no installer is provided.

## Moving an existing Mission Control deployment

Use this if you already run the earlier Mission Control code on Vercel and want to move it to this repository. Nothing about your data or domain changes, and agents keep working.

1. In the Vercel project, open Settings, then Git. Disconnect the old repository and connect `mrhinkle/agent-kontrol` (or your fork) with `main` as the production branch. The project, its domains, its environment variables and its database stay as they are.
2. Choose your repos. Either open Settings after the deploy and add them there, or set `NEXT_PUBLIC_MC_PROGRESS_CONFIG` before the build, for example `{"repos":[{"repo":"your-org/your-repo","label":"Your repo","short":"repo","color":"#2563eb","blockedLabel":"blocked"}]}`. Until you do one of these, the progress board shows the example repos from `progress.config.json`.
3. If you want to keep your old header name, set `NEXT_PUBLIC_MC_NAME`. The "by The AIE" byline and trademark footer appear only under the default name.
4. Leave `DATABASE_URL`, `MC_TOKEN`, `MC_DASHBOARD_PASSWORD` and any OAuth secrets exactly as they are. Do not rotate them, or agents and MCP connectors will need re-authorizing.
5. Deploy. The build applies the schema, which only adds what is missing and never drops data. If the build cannot reach the database it fails, and the previous deployment keeps serving.
6. Check `/login`, then the Fleet page, the Progress board, and an MCP call.

If something is wrong, promote the previous deployment in Vercel (Deployments, then Promote). That switches traffic back immediately.

Agents need no changes. The `reply_to_mark` tool still works as an alias of `reply_to_operator`. Collectors you installed earlier keep posting. To get the shared repo list, reinstall them from this repository.

## Vercel Deployment Protection

If Vercel Deployment Protection is on for the project, external MCP hosts cannot reach `/api/mcp`, `/.well-known/*`, or `/oauth/*`, so discovery and the OAuth sign-in fail. Turn protection off for the production deployment, or bypass those paths. Agents using `Authorization: Bearer <MC_TOKEN>` are also blocked by protection, because the request never reaches the app.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 503 on every page | `MC_DASHBOARD_PASSWORD` is missing. |
| 401 from agents | Token mismatch. |
| Build fails with `migrate: failed` | Database unreachable or credentials wrong. The message never prints the connection string. |
| 429 on login | 5 failed attempts in 10 minutes from that IP. |
| Dashboard empty with a `Demo mode` banner | `DATABASE_URL` is not set. |

## First steps after deploy

Open the URL, log in with `MC_DASHBOARD_PASSWORD`, then connect agents — see [AGENTS.md](AGENTS.md).

## See also

- [AGENTS.md](AGENTS.md) — connect agent adapters.
- [API.md](API.md) — REST API and auth.
- [MCP.md](MCP.md) — MCP server and tools.
- [DATABASE.md](DATABASE.md) — database drivers and schema.
- [ARCHITECTURE.md](ARCHITECTURE.md) — stack, data flow and code map.
