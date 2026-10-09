# Connecting Claude Cowork (cloud sessions)

Cloud Cowork sessions can't run filesystem hooks, so they report in through
the Mission Control MCP server — the semantic layer.

## 1. Add the MCP server as a connector

In the Claude app: Settings → Connectors → Add custom connector

- URL: `https://YOUR-DEPLOY.vercel.app/api/mcp`
- Leave the token fields empty. The connector signs in through OAuth: approve
  the consent screen with your dashboard password. (See "Connecting via OAuth"
  in the top-level README.)

## 2. Add a standing instruction

Append this to your global Cowork instructions (CLAUDE.md):

```
## Mission Control
You are part of a multi-agent fleet tracked at Mission Control.
- At the start of any substantive task, call the mission-control `report_status`
  tool (agent_id: "cowork-cloud", platform: "cowork-cloud") with a one-line summary.
- Report again at major milestones, when blocked, and when done
  (status: "done" or "failed").
- Before starting research or build work, call `get_fleet_status` to check
  whether another agent is already on it.
- Record important decisions and handoffs with `remember`; check `recall`
  for context left by other agents.
```

## Caveat

Instruction-based reporting is probabilistic — the model can forget. Hook and
watcher adapters are the deterministic ground truth; treat MCP self-reports
as the semantic layer on top.
