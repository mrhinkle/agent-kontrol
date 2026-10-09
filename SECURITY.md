# Security Policy

## Supported versions

Only the latest 1.x release receives security fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Do not open a public issue for a vulnerability. Reports are handled as soon as practical.

## Security model

Mission Control is designed for one operator running one deployment. It is not multi-tenant. There are no per-user accounts or roles.

Credentials:

- `MC_DASHBOARD_PASSWORD` — the single shared dashboard password. A successful login sets the session cookie `mc_auth` (30 days, httpOnly, sameSite lax, secure in production).
- `MC_TOKEN` — shared secret for agents, sent as `Authorization: Bearer`.
- OAuth 2.1 with PKCE for MCP hosts. Consent is gated by the dashboard password.

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

1. **A leaked `MC_TOKEN` is remote code execution.** Anyone holding `MC_TOKEN` or a dashboard session can queue tasks. Dispatchers run those tasks as headless agent CLIs (`claude`, `codex`, `grok`) on your machines with whatever permissions those CLIs have. Treat `MC_TOKEN` like an SSH key. Run dispatchers as an unprivileged user in a project directory you are comfortable exposing. Use per-machine pinning where possible.
2. **Agent-reported text is untrusted input.** Task results, messages and notes are rendered as text, never as HTML.
3. **Data is stored in Postgres unencrypted by this app.** It can include project names, task prompts and results, and repo metadata. Use your provider's encryption at rest.
4. **Deploy only behind TLS**, except on localhost.
5. **The usage collector sends token counts, costs, model and billing metadata only** — never prompts or completions.

## Secret rotation

| Secret | Effect of rotation |
|---|---|
| `MC_TOKEN` | Redeploy, then update agents. |
| `MC_COOKIE_SECRET` | Signs everyone out. |
| `MC_OAUTH_SECRET` | Revokes OAuth connections. |
| `MC_DASHBOARD_PASSWORD` | Change and redeploy. |
