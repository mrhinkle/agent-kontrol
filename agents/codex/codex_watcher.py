#!/usr/bin/env python3
"""
Codex / ChatGPT Work local watcher.

ChatGPT Work has no public session-status API, so this daemon watches the
Codex CLI's local session logs (~/.codex/sessions by default) and reports
activity to Agent Kontrol based on file changes. Coarse but deterministic.

Usage:
  MC_URL=https://your-deploy.vercel.app MC_TOKEN=secret python3 codex_watcher.py

Optional:
  CODEX_SESSIONS_DIR  override the watched directory
  MC_POLL_SECONDS     poll interval (default 30)
  IDLE_AFTER_SECONDS  mark a session done after this much quiet (default 900)

Run it under launchd/systemd or just `nohup ... &`. Stdlib only.
"""
import json
import os
import socket
import sys
import time
import urllib.request
from pathlib import Path

MC_URL = os.environ.get("MC_URL", "").rstrip("/")
MC_TOKEN = os.environ.get("MC_TOKEN", "")
SESSIONS_DIR = Path(os.environ.get("CODEX_SESSIONS_DIR", "~/.codex/sessions")).expanduser()
POLL = int(os.environ.get("MC_POLL_SECONDS", "30"))
IDLE_AFTER = int(os.environ.get("IDLE_AFTER_SECONDS", "900"))
HOSTNAME = socket.gethostname().split(".")[0].lower()
AGENT_ID = os.environ.get("MC_AGENT", f"codex-{HOSTNAME}")


def post(body: dict) -> None:
    req = urllib.request.Request(
        f"{MC_URL}/api/ingest",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {MC_TOKEN}"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[mc] post failed: {e}", file=sys.stderr)


def report(session_id: str, kind: str, title: str) -> None:
    post(
        {
            "agent_id": AGENT_ID,
            "platform": "codex",
            "machine": HOSTNAME,
            "display_name": os.environ.get("MC_AGENT_NAME", f"Codex ({HOSTNAME})"),
            "session_id": f"{AGENT_ID}-{session_id}",
            "kind": kind,
            "title": title,
        }
    )


def main() -> None:
    if not MC_URL:
        print("Set MC_URL and MC_TOKEN", file=sys.stderr)
        sys.exit(1)
    if not SESSIONS_DIR.exists():
        print(f"Watching {SESSIONS_DIR} (does not exist yet — will keep checking)")

    seen: dict[str, float] = {}   # session key -> last mtime
    active: set[str] = set()
    first_scan = True

    while True:
        now = time.time()
        try:
            files = list(SESSIONS_DIR.rglob("*.jsonl")) if SESSIONS_DIR.exists() else []
        except Exception:
            files = []

        for f in files:
            # Key by relative path: Codex nests sessions in dated
            # subdirectories, and bare stems can collide across them.
            try:
                sid = str(f.relative_to(SESSIONS_DIR)).replace("/", "_").removesuffix(".jsonl")
            except ValueError:
                sid = f.stem
            try:
                mtime = f.stat().st_mtime
            except OSError:
                continue
            prev = seen.get(sid)
            seen[sid] = mtime
            if first_scan:
                # Seed silently on startup so a daemon restart doesn't
                # re-announce (and reopen) sessions the server already closed.
                continue
            if prev is None and now - mtime < IDLE_AFTER:
                active.add(sid)
                report(sid, "session_start", f"Codex session started ({f.name})")
            elif prev is not None and mtime > prev:
                if sid not in active:
                    active.add(sid)
                report(sid, "heartbeat", "Codex session active")
        first_scan = False

        # idle sessions -> done
        for sid in list(active):
            if now - seen.get(sid, 0) > IDLE_AFTER:
                active.discard(sid)
                report(sid, "session_end", "Codex session idle — marking done")

        time.sleep(POLL)


if __name__ == "__main__":
    main()
