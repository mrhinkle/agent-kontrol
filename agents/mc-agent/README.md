# mc-agent — unified discovery daemon

One launchd process per Mac. On start it probes for Claude Code, Codex, Grok,
and Hermes state directories, POSTs a `heartbeat` to Agent Kontrol for each
platform it finds, then tails session (or log) files and reports
`session_start` / `status` / `session_end` the same way
[`codex_watcher.py`](../codex/codex_watcher.py) does.

Claude sessions are **not** tailed — the [Claude Code hooks](../claude-code/)
already report those. This daemon only heartbeats `claude-code-<hostname>` so
the machine still shows as online if hooks have been quiet.

Stdlib-only Python 3.9+. Missing directories are logged and skipped; the
process does not exit because a platform is absent.

## Grok session layout (discovered on this Mac)

Grok's home is `~/.grok` (`GROK_HOME` overrides). Two relevant trees:

| Path | What it is |
| --- | --- |
| `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/` | **Per-session store.** This is what the daemon watches. |
| `~/.grok/logs/unified.jsonl` | Process log (plus `hooks.log`). Not per-session; not tailed. |

Each session directory holds `updates.jsonl` (authoritative conversation
stream), `chat_history.jsonl`, `events.jsonl`, `summary.json`, and
`signals.json`. The daemon stats those files only — it does not walk
`terminal/` or the tens of thousands of lock files under `sessions/`.

`~/.grok/active_sessions.json` is a live list of open session IDs; it is
often `[]` even while history exists on disk, so the watcher keys off file
mtimes, not that file.

## Hermes state dirs

Probed in order: `$HERMES_HOME`, `~/.hermes`, `~/.local/share/hermes`.
If none exist, Hermes is skipped. Sessions are preferred
(`$home/sessions`); if that directory is missing or empty the daemon falls
back to `$home/logs` (`agent.log`, etc., excluding `bootstrap*`).

## Install on this Mac

From the repo (or this directory):

```bash
cd agents/mc-agent
./install.sh
```

The script prompts for `MC_URL` and `MC_TOKEN` unless they are already in
the environment or in `~/.mission-control/mc-agent.env` /
`~/.claude/mission-control.env`. Credentials are never hardcoded in the
repo. It then:

1. Copies `mc_agent.py` to `~/.mission-control/mc_agent.py`
2. Writes `~/.mission-control/mc-agent.env` (mode `600`)
3. Writes `~/Library/LaunchAgents/com.missioncontrol.mc-agent.plist` (mode `600`)
4. Loads the agent with `launchctl` (`bootstrap`, falling back to `load`)

Re-running is safe: the old agent is unloaded, the plist and script are
replaced, and the new one is loaded.

Non-interactive (CI, or you already have the values). Prefer sourcing the
token from a file so it never lands in shell history or `ps` output — the
interactive prompt is the safest path:

```bash
set -a; source ~/.claude/mission-control.env; set +a
./install.sh
```

> If mc-agent watches codex on a machine that also runs the standalone
> `codex_watcher.py` launchd job (`com.missioncontrol.codexwatcher`), unload
> that job first — otherwise every Codex session is double-reported.

Logs: `~/Library/Logs/mc-agent.log`

```bash
launchctl print "gui/$(id -u)/com.missioncontrol.mc-agent"
tail -f ~/Library/Logs/mc-agent.log
```

## Install over SSH on a second machine

Any always-on Mac (a Mac mini is the usual choice) can run its own copy. The
examples below use `user@second-mac.local`; substitute your own host and the
directory where you keep repos there.

Copy just this directory, then run the installer on the remote machine. Prefer
passing `MC_URL` / `MC_TOKEN` on the SSH command so you are not prompted over a
remote TTY:

```bash
# from the agent-kontrol checkout on this Mac
ssh user@second-mac.local 'mkdir -p ~/Code/agent-kontrol/agents/mc-agent'

scp agents/mc-agent/mc_agent.py agents/mc-agent/install.sh agents/mc-agent/README.md \
  user@second-mac.local:~/Code/agent-kontrol/agents/mc-agent/

scp ~/.claude/mission-control.env user@second-mac.local:~/.claude/
ssh user@second-mac.local \
  'set -a; source ~/.claude/mission-control.env; set +a; \
   bash ~/Code/agent-kontrol/agents/mc-agent/install.sh'
```

To prompt on the remote machine instead, allocate a TTY:

```bash
ssh -t user@second-mac.local \
  'bash ~/Code/agent-kontrol/agents/mc-agent/install.sh'
```

Each machine reports as `<platform>-<hostname>`, so each machine
shows up as a separate agent.

## What it POSTs

`POST $MC_URL/api/ingest` with `Authorization: Bearer $MC_TOKEN`:

```json
{
  "agent_id": "grok-macbook-pro",
  "platform": "grok",
  "machine": "macbook-pro",
  "display_name": "Grok (macbook-pro)",
  "kind": "heartbeat",
  "title": "grok online"
}
```

Session events add `session_id` (`<agent_id>-<sid>`) and, for Grok, `project`
decoded from the URL-encoded cwd directory. Mid-session file changes use
`kind: "status"`. After `IDLE_AFTER_SECONDS` (default 900) of quiet, the
daemon sends `session_end`.

A restart seeds existing files silently so it does not reopen sessions the
server already closed.

## Environment

| Variable | Default | Role |
| --- | --- | --- |
| `MC_URL` | (required) | Agent Kontrol origin, no trailing slash needed |
| `MC_TOKEN` | (required) | Bearer token for `/api/ingest` |
| `MC_POLL_SECONDS` | `30` | Directory poll interval |
| `IDLE_AFTER_SECONDS` | `900` | Idle → `session_end` |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex watch root |
| `GROK_SESSIONS_DIR` | `~/.grok/sessions` | Grok watch root |
| `GROK_HOME` | `~/.grok` | Grok probe path |
| `HERMES_HOME` | `~/.hermes` then `~/.local/share/hermes` | Hermes probe path |
| `CLAUDE_HOME` | `~/.claude` | Claude probe path (heartbeat only) |

Foreground (no launchd):

```bash
MC_URL=https://your-deploy.vercel.app MC_TOKEN=secret python3 mc_agent.py
```

## Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.missioncontrol.mc-agent" 2>/dev/null \
  || launchctl unload ~/Library/LaunchAgents/com.missioncontrol.mc-agent.plist
rm -f ~/Library/LaunchAgents/com.missioncontrol.mc-agent.plist
rm -f ~/.mission-control/mc_agent.py ~/.mission-control/mc-agent.env
```
