# Security Policy

## Supported versions

Only the latest 1.x release receives security fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Do not open a public issue for a vulnerability. Reports are handled as soon as practical.

## Security model

Agent Kontrol is designed for one operator running one deployment. It is not multi-tenant. There are no per-user accounts. Agent credentials carry scopes; they are not user accounts.

Credentials:

- `MC_DASHBOARD_PASSWORD` — the single shared dashboard password. A successful login sets the session cookie `mc_auth` (30 days, httpOnly, sameSite lax, secure in production). The session is the only credential that can issue or revoke agent credentials.
- `MC_TOKEN` — shared secret for agents, sent as `Authorization: Bearer`. It has every scope.
- Agent credentials — one revocable `akc_…` token per agent, with scopes enforced on MCP tools and the agent REST routes. The token is shown once. The row stores a SHA-256 hash, not the token.
- OAuth 2.1 with PKCE for MCP hosts. Consent is gated by the dashboard password. A verified access token keeps full access to mapped tools. Issuance is unchanged.

Where each credential goes:

- The MCP server (`/api/mcp`) runs inside the app. It reads its secrets from the deployment's environment. Callers authenticate to it; it never forwards `MC_TOKEN` or a caller's credential to another host.
- `MC_TOKEN` leaves a machine in one case: the agent-side collectors and hooks under `agents/` and `scripts/` send it as a bearer token to your own `MC_URL`. Point `MC_URL` at your own deployment over https.
- Those collectors read `MC_URL` and `MC_TOKEN` from the environment or from `~/.claude/mission-control.env` (`chmod 600`, written by `agents/claude-code/install.sh`). The path keeps the pre-rename name so existing installs work. They read nothing else from `~/.claude`. The usage collector and `scripts/collect-progress.sh` also honor `MC_ENV_FILE` to use another path; the Claude Code hook always reads the fixed path, and the dispatcher and `mc-agent` also check `~/.mission-control/env`.
- `MC_COOKIE_SECRET`, `MC_DASHBOARD_PASSWORD`, `MC_OAUTH_SECRET` and the OpenRouter management keys are read only by the server, for the dashboard, OAuth and usage features. Agents never need them.
- `MC_TRACE_CAPTURE_CONTENT` controls whether trace capture stores message content. Leave it unset unless you want that.
- Dispatcher-launched CLIs (`agents/dispatcher/mc_dispatcher.py`) and direct-mode CLIs (`agents/dispatcher/ak_skill_launch.py` `direct`) do not inherit the launcher's environment. The child environment is built at launch and contains only: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `TZ`, `SSH_AUTH_SOCK`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and their lower-case forms, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, every name starting with `LC_` or `XDG_`, the non-secret settings `MC_URL`, `MC_AGENT`, `MC_AGENT_NAME`, `MC_TRACES` and `MC_TRACE_CAPTURE_CONTENT`, the platform prefix (`ANTHROPIC_` and `CLAUDE_` for Claude, `OPENAI_` and `CODEX_` for Codex, `XAI_` and `GROK_` for Grok), and any name matched by `MC_CHILD_ENV_ALLOW`. `MC_TOKEN` and `MC_EVENT_TOKEN` are never passed. The same refusal applies to `MC_DASHBOARD_PASSWORD`, `MC_COOKIE_SECRET`, `MC_OAUTH_SECRET`, `CRON_SECRET`, `MC_CHILD_ENV_ALLOW`, and any other `MC_` name.
- `MC_CHILD_ENV_ALLOW` is a comma-separated list of extra names to copy. Whitespace around entries is ignored. An entry may be an exact name or a prefix ending in one `*`: `FLEET_*` passes `FLEET_DISPATCH_TOKEN` and does not pass `FLEET`. A bare `*` or a `*` anywhere but the end is ignored. A name on the never-pass list is still omitted when the allow list matches it.
- `main_worker_exec` is deny-only. Before it execs the worker it removes the never-pass names above and leaves the wrapper's other variables, including ones this repository does not know. The fleet-mode controller is unchanged and still receives the dispatcher's environment.
- A child running as the same OS user can still read `~/.claude/mission-control.env` and `~/.mission-control/env` on disk.

## Controls

- A production build with a database refuses to serve (503) when `MC_DASHBOARD_PASSWORD` is unset.
- Agent routes fail closed in any environment other than development or test when `MC_TOKEN` is unset.
- Secrets are compared with a timing-safe check.
- Secrets in URL query strings are not accepted.
- Login and the OAuth consent form share one limit of 5 failed attempts per 10 minutes per client IP. The limiter is in-memory, per serverless instance, best effort, and not distributed. The client IP is taken from `x-vercel-forwarded-for`, then `x-real-ip`, then `x-forwarded-for`; a proxy that does not overwrite client-supplied forwarding headers lets an attacker rotate the value.
- The markdown renderer never injects HTML.
- CI runs on every PR.
- Dependabot is enabled.
- `npm audit` reports 0 known vulnerabilities at release time.

## Important risks

Read these before deploying.

1. **A leaked `MC_TOKEN` is remote code execution.** Anyone holding `MC_TOKEN` or a dashboard session can queue tasks. Dispatchers run those tasks as headless agent CLIs (`claude`, `codex`, `grok`) on your machines with whatever permissions those CLIs have. Treat `MC_TOKEN` like an SSH key. An agent credential can queue a task only when it has `tasks:write`, and it cannot mint another credential. A credential that has `tasks:write` is still remote code execution for the tasks it can queue. Run dispatchers as an unprivileged user in a project directory you are comfortable exposing. Use per-machine pinning where possible.
2. **Agent-reported text is untrusted input.** Task results, messages and notes are rendered as text, never as HTML.
3. **Data is stored in Postgres unencrypted by this app.** It can include project names, task prompts and results, and repo metadata. Use your provider's encryption at rest.
4. **Deploy only behind TLS**, except on localhost.
5. **The usage collector sends token counts, costs, model and billing metadata only** — never prompts or completions.
6. **Traces record what agents did.** By default they hold tool names, timing, status and counts, never prompts or tool input and output; credential-looking attributes are always dropped. Setting `MC_TRACE_CAPTURE_CONTENT=1` stores prompt and tool content too, so a leaked database or token would expose it. Spans are deleted after `MC_TRACE_RETENTION_DAYS` (default 30). See [docs/TELEMETRY.md](docs/TELEMETRY.md).

## Secret rotation

| Secret | Effect of rotation |
|---|---|
| `MC_TOKEN` | Redeploy, then update agents. |
| `MC_COOKIE_SECRET` | Signs everyone out. |
| `MC_OAUTH_SECRET` | Revokes OAuth connections. |
| `MC_DASHBOARD_PASSWORD` | Change and redeploy. |
