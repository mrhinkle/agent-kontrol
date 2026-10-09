#!/usr/bin/env python3
"""
Agent Kontrol hook for Claude Code / Cowork (local).

Reads the hook event JSON from stdin and POSTs a normalized event to the
Agent Kontrol ingest API. Deterministic ground truth: this fires whether
or not the model remembers to report in.

Config via environment (put these in ~/.zshenv or the hook command):
  MC_URL    e.g. https://your-deploy.vercel.app
  MC_TOKEN  shared secret (matches the Vercel env var)
  MC_AGENT  optional agent id override (default: claude-code-<hostname>)

Fail-open by design: any error exits 0 so hooks never block your session.
Stdlib only — no dependencies.
"""
import json
import os
import socket
import sys
import urllib.request
from pathlib import Path


def load_env_file() -> None:
    """GUI-launched apps don't read ~/.zshenv, so fall back to
    ~/.claude/mission-control.env (written by install.sh)."""
    p = Path("~/.claude/mission-control.env").expanduser()
    if not p.exists():
        return
    try:
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))
    except Exception:
        pass


KIND_MAP = {
    "SessionStart": "session_start",
    "UserPromptSubmit": "turn_start",
    "Stop": "waiting",           # Claude finished its turn -> waiting on you
    "Notification": "notification",
    "SessionEnd": "session_end",
    "SubagentStop": "milestone",
    "PreCompact": "milestone",
}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    load_env_file()
    url = os.environ.get("MC_URL", "").rstrip("/")
    if not url:
        return

    hostname = socket.gethostname().split(".")[0].lower()
    event_name = payload.get("hook_event_name", "unknown")
    kind = KIND_MAP.get(event_name, "status")
    cwd = payload.get("cwd") or os.getcwd()
    project = os.path.basename(cwd) if cwd else None

    title = event_name
    if event_name == "SessionStart":
        title = f"Session started in {cwd}"
    elif event_name == "UserPromptSubmit":
        prompt = (payload.get("prompt") or "")[:140]
        title = f"New instruction: {prompt}" if prompt else "New instruction"
    elif event_name == "Stop":
        title = "Turn finished — waiting for input"
    elif event_name == "Notification":
        title = (payload.get("message") or "Needs attention")[:140]
    elif event_name == "SessionEnd":
        title = "Session ended"

    body = {
        "agent_id": os.environ.get("MC_AGENT", f"claude-code-{hostname}"),
        "platform": "claude-code",
        "machine": hostname,
        "display_name": os.environ.get("MC_AGENT_NAME", f"Claude Code ({hostname})"),
        "session_id": payload.get("session_id"),
        "kind": kind,
        "title": title,
        "summary": title,
        "project": project,
        "detail": {"hook_event": event_name},
    }

    req = urllib.request.Request(
        f"{url}/api/ingest",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ.get('MC_TOKEN', '')}",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass

    # Two-way: at natural checkpoints, pull any messages the operator queued for this
    # agent and inject them into the session as additional context.
    if event_name in ("UserPromptSubmit", "SessionStart"):
        try:
            ireq = urllib.request.Request(
                f"{url}/api/messages?agent_id={body['agent_id']}&ack=true",
                headers={"Authorization": f"Bearer {os.environ.get('MC_TOKEN', '')}"},
                method="GET",
            )
            with urllib.request.urlopen(ireq, timeout=3) as resp:
                msgs = json.loads(resp.read().decode()).get("messages", [])
            if msgs:
                lines = "\n".join(f"- {m.get('body', '')}" for m in msgs)
                out = {
                    "hookSpecificOutput": {
                        "hookEventName": event_name,
                        "additionalContext": "\U0001F4EC Messages from the operator via Agent Kontrol:\n" + lines,
                    }
                }
                print(json.dumps(out))
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)
