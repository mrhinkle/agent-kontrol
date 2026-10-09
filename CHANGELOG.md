# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - Unreleased

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
