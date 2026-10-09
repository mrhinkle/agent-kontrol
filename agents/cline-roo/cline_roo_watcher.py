#!/usr/bin/env python3
"""
Cline / Roo Code local watcher.

Both are VS Code extensions (Roo Code is a Cline fork) with no session
API, so this daemon watches their on-disk task folders under VS Code's (or
a VS Code fork's) globalStorage directory and reports activity the same
way agents/codex/codex_watcher.py does: coarse, deterministic, keyed off
file mtimes.

Paths below are per each project's own docs (docs.cline.bot, Roo Code's
deepwiki) as of 2026-10 — NOT verified against a live install on this
machine (neither extension is installed here). If nothing ever reports,
set VSCODE_GLOBAL_STORAGE_DIRS to the actual globalStorage directory your
editor uses.

Usage:
  MC_URL=https://your-deploy.vercel.app MC_TOKEN=secret python3 cline_roo_watcher.py

Optional:
  VSCODE_GLOBAL_STORAGE_DIRS  comma-separated globalStorage roots to scan,
                              overriding the OS-specific defaults below
                              (set this for Cursor/Windsurf/VS Code
                              Insiders, or a non-default profile dir)
  CLINE_SHARED_DIR    extra root checked directly for a tasks/ folder,
                      default ~/.cline (Cline 4.x's shared data directory
                      per its docs; best-effort, unverified)
  MC_POLL_SECONDS     poll interval (default 30)
  IDLE_AFTER_SECONDS  mark a task done after this much quiet (default 900)
  CLINE_AGENT / ROOCODE_AGENT          override the reported agent_id
  CLINE_AGENT_NAME / ROOCODE_AGENT_NAME  override the reported display name

Run it under launchd/systemd or just `nohup ... &`. Stdlib only.
"""
import hashlib
import json
import os
import socket
import sys
import time
import urllib.request
from pathlib import Path

MC_URL = os.environ.get("MC_URL", "").rstrip("/")
MC_TOKEN = os.environ.get("MC_TOKEN", "")
POLL = int(os.environ.get("MC_POLL_SECONDS", "30"))
IDLE_AFTER = int(os.environ.get("IDLE_AFTER_SECONDS", "900"))
HOSTNAME = socket.gethostname().split(".")[0].lower()

# VS Code extension id -> (platform, display name)
EXTENSIONS = {
    "saoudrizwan.claude-dev": ("cline", "Cline"),
    "rooveterinaryinc.roo-cline": ("roo-code", "Roo Code"),
}
AGENT_ID_ENV = {"cline": "CLINE_AGENT", "roo-code": "ROOCODE_AGENT"}
AGENT_NAME_ENV = {"cline": "CLINE_AGENT_NAME", "roo-code": "ROOCODE_AGENT_NAME"}
AGENT_ID = {
    platform: os.environ.get(AGENT_ID_ENV[platform], f"{platform}-{HOSTNAME}")
    for platform in ("cline", "roo-code")
}

# Editors that can host these extensions. VS Code itself is confirmed by
# the extensions' own docs; the forks are inferred (any VS Code-compatible
# host that supports the same extension API uses the same globalStorage
# layout) and not independently verified.
_EDITOR_DIRS = ["Code", "Code - Insiders", "Cursor", "Windsurf"]


def default_global_storage_dirs() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        return [home / "Library" / "Application Support" / e / "User" / "globalStorage" for e in _EDITOR_DIRS]
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return []
        return [Path(appdata) / e / "User" / "globalStorage" for e in _EDITOR_DIRS]
    # Linux and everything else VS Code supports.
    return [home / ".config" / e / "User" / "globalStorage" for e in _EDITOR_DIRS]


def fingerprint(tasks_dir: Path) -> str:
    """Short, stable id for a tasks_dir, so the same task id under two
    different roots (e.g. Cline's VS Code storage and CLINE_SHARED_DIR)
    never collides in the server's session id."""
    return hashlib.sha1(str(tasks_dir).encode()).hexdigest()[:8]


def task_roots() -> list[tuple[str, str, str, Path]]:
    """(platform, display_name, root_fingerprint, tasks_dir) for every
    candidate that might exist."""
    override = os.environ.get("VSCODE_GLOBAL_STORAGE_DIRS", "")
    storage_dirs = (
        [Path(p.strip()).expanduser() for p in override.split(",") if p.strip()]
        if override
        else default_global_storage_dirs()
    )
    roots = [
        (platform, name, storage_dir / ext_id / "tasks")
        for storage_dir in storage_dirs
        for ext_id, (platform, name) in EXTENSIONS.items()
    ]
    shared = Path(os.environ.get("CLINE_SHARED_DIR", "~/.cline")).expanduser()
    roots.append(("cline", "Cline", shared / "tasks"))
    return [(platform, name, fingerprint(tasks_dir), tasks_dir) for platform, name, tasks_dir in roots]


def post(body: dict) -> None:
    req = urllib.request.Request(
        f"{MC_URL}/api/ingest",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {MC_TOKEN}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except Exception as e:
        print(f"[mc] post failed: {e}", file=sys.stderr)


def report(platform: str, display_name: str, root_fp: str, task_id: str, kind: str, title: str) -> None:
    agent_id = AGENT_ID[platform]
    post(
        {
            "agent_id": agent_id,
            "platform": platform,
            "machine": HOSTNAME,
            "display_name": os.environ.get(AGENT_NAME_ENV[platform], f"{display_name} ({HOSTNAME})"),
            "session_id": f"{agent_id}-{root_fp}-{task_id}",
            "kind": kind,
            "title": title,
        }
    )


def main() -> None:
    if not MC_URL or not MC_TOKEN:
        print("Set MC_URL and MC_TOKEN", file=sys.stderr)
        sys.exit(1)

    roots = task_roots()
    for _, _, _, tasks_dir in roots:
        if not tasks_dir.exists():
            print(f"Watching {tasks_dir} (does not exist yet — will keep checking)")

    seen: dict[str, float] = {}  # "{root-fingerprint}:{task-id}" -> last mtime
    active: dict[str, tuple[str, str]] = {}  # same key -> (platform, display_name)
    first_scan = True

    while True:
        now = time.time()
        for platform, name, root_fp, tasks_dir in roots:
            try:
                task_dirs = [d for d in tasks_dir.iterdir() if d.is_dir()] if tasks_dir.exists() else []
            except OSError:
                task_dirs = []

            for d in task_dirs:
                key = f"{root_fp}:{d.name}"
                try:
                    mtime = max(
                        (f.stat().st_mtime for f in d.iterdir() if f.is_file()),
                        default=d.stat().st_mtime,
                    )
                except OSError:
                    continue
                prev = seen.get(key)
                seen[key] = mtime
                if first_scan:
                    # Seed silently on startup so a daemon restart doesn't
                    # re-announce tasks the server already closed.
                    continue
                if prev is None:
                    # First time this task dir has been seen. Only announce
                    # it if it looks recent — an old, already-idle task
                    # shouldn't be reported as freshly started just because
                    # the daemon restarted.
                    if now - mtime < IDLE_AFTER:
                        active[key] = (platform, name)
                        report(platform, name, root_fp, d.name, "session_start", f"{name} task started ({d.name})")
                elif mtime > prev:
                    # A task the daemon already marked done (removed from
                    # `active` below) getting touched again is a resume, not
                    # a heartbeat — the server refuses to reopen a closed
                    # session on anything but an explicit session_start.
                    was_active = key in active
                    active[key] = (platform, name)
                    if was_active:
                        report(platform, name, root_fp, d.name, "heartbeat", f"{name} task active")
                    else:
                        report(platform, name, root_fp, d.name, "session_start", f"{name} task resumed ({d.name})")
        first_scan = False

        for key in list(active):
            if now - seen.get(key, 0) > IDLE_AFTER:
                platform, name = active.pop(key)
                root_fp, task_id = key.split(":", 1)
                report(platform, name, root_fp, task_id, "session_end", f"{name} task idle — marking done")

        time.sleep(POLL)


if __name__ == "__main__":
    main()
