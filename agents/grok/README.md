# Connecting Grok (xAI Grok Build CLI)

Grok Build is xAI's terminal coding agent (early beta): headless `grok -p`,
MCP servers + hooks via `~/.grok/config.toml`, AGENTS.md support, subagents.
Auth via SuperGrok / X Premium+ subscription or `XAI_API_KEY`. Docs:
https://docs.x.ai/build/overview

Two ways to wire it into Agent Kontrol — use both:

## 1. Dispatcher (recommended — deterministic)

If `grok` is on PATH, the [dispatcher](../dispatcher/) auto-serves the `grok`
platform: queue a task with `platform: grok` on the Tasks page and it runs
`grok -p "<prompt>"` in the project folder and reports the result. Nothing
else to configure.

Good Grok task shapes: research sweeps, X/Twitter-adjacent work, second
opinions on another agent's plan, fast large-context summarization.

## 2. MCP connector (semantic — lets Grok report in and use shared memory)

Add Agent Kontrol to `~/.grok/config.toml` as an MCP server:

```toml
[mcp_servers.mission-control]
url = "https://YOUR-DEPLOY.vercel.app/api/mcp"
headers = { Authorization = "Bearer YOUR_MC_TOKEN" }
```

(Check `grok inspect` / current docs for the exact table shape — the beta
moves fast.)

Then add to your global `AGENTS.md` so interactive Grok sessions participate:

```
You are part of the operator's agent fleet, tracked at Agent Kontrol.
- At session start: call check_inbox (agent_id "grok-<hostname>") and
  get_fleet_status before starting work another agent might already own.
  If there are messages, act on them and reply_to_operator.
- Report what you're doing with report_status (platform: "grok") at task
  start, milestones, and completion.
- Share durable findings with remember; check recall before re-researching.
- Idle? Call claim_task (platform: "grok") to pull work from the queue.
```

## 3. Optional heartbeat

```bash
curl -s -X POST "$MC_URL/api/ingest" \
  -H "Authorization: Bearer $MC_TOKEN" -H "Content-Type: application/json" \
  -d '{"agent_id":"grok-'$(hostname -s)'","platform":"grok","machine":"'$(hostname -s)'","kind":"heartbeat","title":"Grok online"}'
```
