# Dispatcher — the harness daemon

One process per machine. It polls Mission Control for queued tasks, runs them
headless on whichever agent CLIs the machine has (`claude`, `codex`, `grok`),
and reports results + cost back. Queue a task on the Tasks page (or via the
`create_task` MCP tool from any agent) and it gets picked up within
`MC_POLL_SECONDS`.

## Quick start

```bash
mkdir -p ~/.mission-control
MC_URL=https://your-deploy.vercel.app MC_TOKEN=secret \
  nohup python3 mc_dispatcher.py >> ~/.mission-control/dispatcher.log 2>&1 &
```

It auto-detects which CLIs are installed. Override with
`MC_PLATFORMS=claude-code,codex`.

## How a task runs

1. Claim: `POST /api/tasks/claim` — atomic, so two machines never grab the same task.
2. Run: headless CLI in `MC_WORKDIR/<project>` (default `~/Code/<project>`):
   - `claude -p "<prompt>" --output-format json --permission-mode acceptEdits`
     (cost captured from `total_cost_usd`)
   - `codex exec --full-auto "<prompt>"`
   - `grok -p "<prompt>"`
3. Review (optional): if the task has `reviewer_platform`, the reviewer runs
   **read-only** with a skeptical-reviewer prompt and must end with
   `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`. The verdict is appended
   to the result; REQUEST_CHANGES marks the task failed so you triage it.
4. Report: `PATCH /api/tasks/<id>` with status, result summary, and cost.

## launchd (run at login on macOS)

Save as `~/Library/LaunchAgents/com.mission-control.dispatcher.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mission-control.dispatcher</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>/Users/YOU/Code/mission-control/agents/dispatcher/mc_dispatcher.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mc-dispatcher.log</string>
  <key>StandardErrorPath</key><string>/tmp/mc-dispatcher.log</string>
</dict></plist>
```

Put `MC_URL`/`MC_TOKEN` in `~/.claude/mission-control.env` (the dispatcher
reads it, same as the Claude Code hook) so secrets stay out of the plist.

## Safety model

- Workers only run inside `MC_WORKDIR` project folders — the dispatcher
  refuses tasks whose project folder doesn't exist.
- Reviewers always run read-only.
- `MC_TASK_TIMEOUT` (default 1h) kills runaway runs.
- Autonomy flags are conservative defaults (`acceptEdits`, `--full-auto`
  sandboxed). Raise them per-machine via `MC_CLAUDE_ARGS` / `MC_CODEX_ARGS`
  only if you accept the blast radius.
- Anything requiring judgment or credentials beyond the repo should be an
  interactive Cowork/Claude session, not a dispatched task.
