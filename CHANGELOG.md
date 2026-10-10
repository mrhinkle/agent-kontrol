# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Traces: step-by-step spans for agent sessions. `POST /api/v1/traces` accepts OTLP/HTTP JSON from any OpenTelemetry exporter, `/traces` shows a waterfall, and the Claude Code hook emits session, turn and tool spans (register the new `PreToolUse` and `PostToolUse` hooks). Prompt and tool content is not stored unless `MC_TRACE_CAPTURE_CONTENT=1`; spans are pruned after `MC_TRACE_RETENTION_DAYS` (default 30). Docs: `docs/TELEMETRY.md`.

### Changed

- The progress board's blocked alert now names the repo's own blocked label and links to a search for it. It always said "dependency-blocked" and linked to that label, whatever the repo used.

### Documentation

- What "blocked" means (a label you choose, not something detected), the release-branch workflow on Vercel, an adapter capability table, a Status section in the README, and release and dependency policy in CONTRIBUTING.

## [1.0.0-beta.1] - 2026-10-09

First public beta. Feature-complete for 1.0; the API, MCP tool surface and schema are stable unless beta feedback shows a defect. Please report issues on GitHub.

### Added

- Settings page (`/settings`) to add, edit, reorder and remove the repos the progress board watches, stored in a new `watched_repos` table. The collector reads the list from `GET /api/settings/repos` each tick and falls back to its local file. Design: `docs/design/settings-repos.md`.
- `NEXT_PUBLIC_MC_PROGRESS_CONFIG` replaces the progress board's repos from the environment, so a deployment does not need to fork `progress.config.json`.
- `reply_to_mark` stays registered as a deprecated alias of `reply_to_operator` for the 1.x line, so existing agent instructions keep working.
- In-app Help menu (`/help`) that renders the project docs.
- Dashboard: Fleet, Progress, Usage and Costs, Tasks, History, Memory, and Gibson 3D view.
- Ingest API.
- MCP server with 11 tools and OAuth 2.1.
- Task queue with dispatchers and optional cross-vendor review.
- Two-way operator messaging.
- Progress board driven by `progress.config.json`.
- Usage ledger (experimental).
- Neon or any Postgres 13+ via `MC_DB_DRIVER` auto-detection.
- Automatic idempotent schema step on build and container start.
- One-line quickstart.
- Docker Compose.
- Deploy to Vercel button.
- Deploy to Fly.io: `fly.toml` with a release-command schema step, plus a DEPLOY.md walkthrough.
- CI builds the Docker image and checks that the container serves `/login`.
- Docs: MCP, API, DATABASE, DEPLOY, AGENTS, ARCHITECTURE.

### Changed

- Branding: the product is Agent Kontrol by The AIE. The byline appears in the app header and footer only under the default app name, so deployments that set `NEXT_PUBLIC_MC_NAME` are not labelled as The AIE's. README, logo files and notices updated; trademark notice names Peripety Labs LLC as owner.
- Renamed from Mission Control to Agent Kontrol: repository (old URLs redirect), package, app name, docs and logo. Internal names are unchanged so existing installs keep working: the `MC_` environment prefix, `~/.mission-control`, `~/.claude/mission-control.env`, and the `com.missioncontrol.*` launchd labels.
- New logo and wordmark in `public/logo/`; the wordmark letters are outlined from Montserrat ExtraBold (SIL Open Font License).
- Operator name is configurable (`NEXT_PUBLIC_MC_OPERATOR`).
- MCP tool renamed to `reply_to_operator`.

### Fixed

- None yet.

### Security

- Fail-closed auth in production.
- Dashboard refuses to serve real data without a password.
- Login and OAuth consent are rate limited.
- Secrets in query strings removed.
- All known dependency vulnerabilities fixed.

### Known limitations

- Shared notes (`remember`/`recall`) are a plain table with substring search; nothing writes to it automatically.
- Usage and Costs is Phase 1 and experimental.
- No dispatcher kill switch yet.
- Dashboard polls every 7 seconds.
- Single shared password; no per-user accounts.
- Rate limiter is per instance.
- Collectors install only as macOS launchd agents (on Linux, run from cron or systemd yourself).
- Docker images and generic Node hosts are less exercised than Vercel + Neon.
