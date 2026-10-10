<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/logo/agent-kontrol-wordmark-byaie-white.svg">
    <img src="public/logo/agent-kontrol-wordmark-byaie-navy.svg" alt="Agent Kontrol by the AIE" width="520">
  </picture>
</p>

# Agent Kontrol

*Agent Kontrol™ by [The AIE Network™](https://theaie.net)*

One dashboard for the AI coding agents you run: Claude Code, Codex, Grok, Hermes and anything that speaks MCP. See what each is doing, queue work for them, and check whether the backlog is actually shrinking.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmrhinkle%2Fagent-kontrol&project-name=agent-kontrol&repository-name=agent-kontrol&env=MC_TOKEN%2CMC_DASHBOARD_PASSWORD&envDescription=MC_TOKEN%20is%20the%20shared%20secret%20agents%20use.%20MC_DASHBOARD_PASSWORD%20protects%20the%20dashboard.%20Generate%20each%20with%20openssl%20rand%20-hex%2024.&envLink=https%3A%2F%2Fgithub.com%2Fmrhinkle%2Fagent-kontrol%2Fblob%2Fmain%2Fdocs%2FDEPLOY.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

```bash
curl -fsSL https://raw.githubusercontent.com/mrhinkle/agent-kontrol/main/scripts/quickstart.sh | bash
```

That starts Agent Kontrol with Docker Compose (or in demo mode on Node 20+ if you have no Docker). Other targets: Vercel with Neon or any Postgres, Fly.io, any Node host. See [docs/DEPLOY.md](docs/DEPLOY.md).

## What it does

- **Fleet view.** Live status and history for every agent, from deterministic hooks and watchers, not from the agents remembering to report.
- **Task queue.** Queue work for any platform; a per-machine dispatcher runs it headless and reports result and cost. Optional cross-vendor review by a second platform.
- **Progress board.** Net backlog (issues opened minus closed) per repo over time, because a day with many merges can still leave the backlog deeper. Choose the repos in Settings; no redeploy.
- **MCP server.** Any MCP host can report status, read the fleet, check messages from you and claim tasks. OAuth 2.1 for hosts that support it, or a bearer token.
- **Messaging.** Send an agent a message from the dashboard; it sees it when it polls and can reply.
- **Traces.** Step-by-step spans for each agent session, shown as a waterfall. OpenTelemetry-compatible, so any exporter can send to it; the Claude Code hook emits them automatically.
- **Usage and Costs** (experimental). Paid and included-token cost per account.
- **Notes.** A small shared table agents can write to and search (substring search, no automatic writers).

```
Claude Code hooks ──┐
Codex watcher ──────┤  POST /api/ingest          ┌──> Dashboard (Fleet / Tasks / Progress / History / Memory)
Grok / dispatcher ──┤──────────────> Postgres ───┤
Cowork cloud ───────┤  MCP /api/mcp              └──> get_fleet_status / recall / claim_task
Hermes ─────────────┘

Tasks page / create_task ──> queue ──> dispatcher (per machine) ──> claude -p | codex exec | grok -p
```

Agents push; nothing polls vendors. No vendor exposes a "what are my agents doing" API, so every agent reports into a store you own.

## Connect your agents

| Agent | How | Guide |
| --- | --- | --- |
| Claude Code / Cowork (local) | lifecycle hooks | [agents/claude-code](agents/claude-code/) |
| Claude Cowork (cloud) | MCP connector with OAuth | [agents/cowork-cloud](agents/cowork-cloud/) |
| Codex / ChatGPT Work | session watcher | [agents/codex](agents/codex/) |
| Grok | dispatcher and MCP | [agents/grok](agents/grok/) |
| Hermes | MCP and cron heartbeat | [agents/hermes](agents/hermes/) |
| Any machine | dispatcher (runs queued tasks) | [agents/dispatcher](agents/dispatcher/) |

Full matrix: [docs/AGENTS.md](docs/AGENTS.md).

## Status

Agent Kontrol is in **1.0 beta** ([release notes](https://github.com/mrhinkle/agent-kontrol/releases)). The API, MCP tool surface and schema are meant to stay stable through 1.0; please report anything that breaks them. Experimental: Usage and Costs, and the Notes store (a pluggable memory backend is planned for 1.1). Not yet built: forwarding traces to other OpenTelemetry backends, and Cline and Roo Code support.

## Documentation

| | |
| --- | --- |
| [Deploy](docs/DEPLOY.md) | One-line install, targets, environment variables, operations |
| [Agents](docs/AGENTS.md) | Adapters and what each can do |
| [MCP](docs/MCP.md) | The 11 tools and how to connect |
| [API](docs/API.md) | REST routes and authentication |
| [Database](docs/DATABASE.md) | Neon or any Postgres, driver selection |
| [Architecture](docs/ARCHITECTURE.md) | Data flow, tables, code map |
| [Progress board](docs/PROGRESS-BOARD.md) | How the net-backlog board works |
| [Telemetry and traces](docs/TELEMETRY.md) | Spans, OpenTelemetry ingest, retention, privacy |
| [Memory (Notes)](docs/MEMORY.md) | What the notes store does and does not do |
| [Usage and Costs](docs/USAGE.md) | The experimental cost ledger |
| [Playbook](PLAYBOOK.md) | How to run a multi-vendor agent fleet |
| [Security](SECURITY.md) | Threat model and reporting |

The same docs are available inside the app under **Help**.

## Develop

```bash
npm ci
npm run dev        # demo mode, no database needed
npm run typecheck && npm run test:ui && npm test && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE). Copyright 2026 Mark Hinkle.

## Trademarks

Agent Kontrol™ and The AIE Network™ are trademarks of Peripety Labs LLC. The Apache License covers the code and, under its section 6, does not grant permission to use these names or the logo. You may use the name factually, for example to say your deployment runs Agent Kontrol. If you fork or sell a modified version, please give it your own name and logo.
