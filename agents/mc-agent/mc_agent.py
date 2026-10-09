#!/usr/bin/env python3
"""
Agent Kontrol unified discovery daemon.

Probes this machine for Claude Code, Codex, Grok, and Hermes state dirs,
posts a heartbeat per found platform, then tails each platform's session
(or log) directory and reports session_start / status / session_end the
same way agents/codex/codex_watcher.py does.

Claude sessions are not tailed — hooks already report those. Missing
directories are logged and skipped; the loop never exits on them.

Usage:
  MC_URL=https://your-deploy.vercel.app MC_TOKEN=secret python3 mc_agent.py

Optional:
  MC_POLL_SECONDS     poll interval (default 30)
  IDLE_AFTER_SECONDS  mark a session done after this much quiet (default 900)
  CODEX_SESSIONS_DIR  override Codex watch dir (default ~/.codex/sessions)
  GROK_SESSIONS_DIR   override Grok watch dir (default ~/.grok/sessions)
  HERMES_HOME         override Hermes state dir (~/.hermes or ~/.local/share/hermes)

Stdlib only. Python 3.9+.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Iterable, List, Optional, Tuple


def load_env_file() -> None:
    """GUI/launchd processes skip the shell rc files, so read env files."""
    for candidate in (
        "~/.mission-control/mc-agent.env",
        "~/.claude/mission-control.env",
        "~/.mission-control/env",
    ):
        p = Path(candidate).expanduser()
        if not p.exists():
            continue
        try:
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except OSError as e:
            print(f"[mc-agent] could not read {p}: {e}", file=sys.stderr)


load_env_file()

MC_URL = os.environ.get("MC_URL", "").rstrip("/")
MC_TOKEN = os.environ.get("MC_TOKEN", "")
POLL = int(os.environ.get("MC_POLL_SECONDS", "30"))
IDLE_AFTER = int(os.environ.get("IDLE_AFTER_SECONDS", "900"))
HOSTNAME = socket.gethostname().split(".")[0].lower()

# Grok writes one directory per session under ~/.grok/sessions/<cwd>/<uuid>/.
# Activity lives in these files; we do not walk the whole tree (tens of
# thousands of terminal/lock files).
GROK_ACTIVITY_FILES = (
    "updates.jsonl",
    "chat_history.jsonl",
    "events.jsonl",
    "summary.json",
    "signals.json",
)

SessionHit = Tuple[str, float, Optional[str]]  # sid, mtime, project


def log(msg: str) -> None:
    print(f"[mc-agent] {msg}", flush=True)


def agent_id_for(platform: str) -> str:
    # Per-platform override only (MC_AGENT_CODEX etc). A shared MC_AGENT would
    # merge every platform this daemon watches into one dashboard entry.
    override = os.environ.get(f"MC_AGENT_{platform.upper().replace('-', '_')}")
    return override or f"{platform}-{HOSTNAME}"


def display_name_for(platform: str) -> str:
    labels = {
        "claude-code": "Claude Code",
        "codex": "Codex",
        "grok": "Grok",
        "hermes": "Hermes",
    }
    label = labels.get(platform, platform)
    return f"{label} ({HOSTNAME})"


def post(body: dict) -> None:
    if not MC_URL:
        return
    req = urllib.request.Request(
        f"{MC_URL}/api/ingest",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {MC_TOKEN}",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"[mc-agent] post failed: {e}", file=sys.stderr)


def report(
    platform: str,
    kind: str,
    title: str,
    session_id: Optional[str] = None,
    project: Optional[str] = None,
) -> None:
    body = {
        "agent_id": agent_id_for(platform),
        "platform": platform,
        "machine": HOSTNAME,
        "display_name": display_name_for(platform),
        "kind": kind,
        "title": title,
    }
    if session_id:
        body["session_id"] = f"{agent_id_for(platform)}-{session_id}"
    if project:
        body["project"] = project
    post(body)


def heartbeat(platform: str) -> None:
    report(platform, "heartbeat", f"{platform} online")


def safe_mtime(path: Path) -> Optional[float]:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def safe_iterdir(path: Path) -> List[Path]:
    try:
        return list(path.iterdir())
    except OSError as e:
        log(f"{path} not readable ({e}) — skipping this pass")
        return []


def project_from_encoded_cwd(name: str) -> Optional[str]:
    """Grok URL-encodes the working directory as the session group name."""
    try:
        decoded = urllib.parse.unquote(name)
    except Exception:
        return None
    if not decoded:
        return None
    base = Path(decoded).name
    return base or None


def scan_jsonl_tree(root: Path) -> Iterable[SessionHit]:
    """Codex-style: one session per *.jsonl, keyed by relative path."""
    try:
        files = list(root.rglob("*.jsonl"))
    except OSError as e:
        log(f"{root} walk failed ({e}) — skipping this pass")
        return
    for f in files:
        if f.name.endswith(".lock") or f.suffix == ".lock":
            continue
        try:
            sid = str(f.relative_to(root)).replace("/", "_")
            if sid.endswith(".jsonl"):
                sid = sid[: -len(".jsonl")]
        except ValueError:
            sid = f.stem
        mtime = safe_mtime(f)
        if mtime is None:
            continue
        yield sid, mtime, None


def scan_grok_sessions(root: Path) -> Iterable[SessionHit]:
    """~/.grok/sessions/<encoded-cwd>/<session-uuid>/ + activity files."""
    for cwd_dir in safe_iterdir(root):
        if not cwd_dir.is_dir():
            continue
        project = project_from_encoded_cwd(cwd_dir.name)
        for sess in safe_iterdir(cwd_dir):
            if not sess.is_dir():
                continue
            latest: Optional[float] = None
            for name in GROK_ACTIVITY_FILES:
                mt = safe_mtime(sess / name)
                if mt is None:
                    continue
                if latest is None or mt > latest:
                    latest = mt
            if latest is None:
                latest = safe_mtime(sess)
            if latest is None:
                continue
            yield sess.name, latest, project


def _scan_session_files(root: Path) -> List[SessionHit]:
    hits: List[SessionHit] = []
    try:
        files = [
            f
            for f in root.rglob("*")
            if f.is_file() and f.suffix in {".jsonl", ".json"} and not f.name.endswith(".lock")
        ]
    except OSError as e:
        log(f"{root} walk failed ({e}) — skipping this pass")
        return hits
    for f in files:
        mtime = safe_mtime(f)
        if mtime is None:
            continue
        try:
            sid = str(f.relative_to(root)).replace("/", "_")
            for suffix in (".jsonl", ".json"):
                if sid.endswith(suffix):
                    sid = sid[: -len(suffix)]
                    break
        except ValueError:
            sid = f.stem
        hits.append((sid, mtime, None))
    return hits


def scan_hermes_state(home: Path) -> Iterable[SessionHit]:
    """Prefer $home/sessions; if empty or absent, fall back to $home/logs."""
    sessions = home / "sessions"
    logs = home / "logs"
    if sessions.exists():
        hits = _scan_session_files(sessions)
        if hits:
            return hits
    if not logs.exists():
        return ()
    hits: List[SessionHit] = []
    for f in safe_iterdir(logs):
        if not f.is_file():
            continue
        if f.suffix != ".log" or f.name.startswith("bootstrap"):
            continue
        mtime = safe_mtime(f)
        if mtime is None:
            continue
        hits.append((f.stem, mtime, None))
    return hits


class PlatformWatch:
    def __init__(
        self,
        platform: str,
        home: Path,
        watch_dir: Optional[Path],
        scanner: Optional[Callable[[Path], Iterable[SessionHit]]],
        note: str,
    ) -> None:
        self.platform = platform
        self.home = home
        self.watch_dir = watch_dir
        self.scanner = scanner
        self.note = note
        self.seen: dict[str, float] = {}
        self.active: set[str] = set()

    def scan(self) -> Iterable[SessionHit]:
        if self.scanner is None or self.watch_dir is None:
            return ()
        if not self.watch_dir.exists():
            return ()
        try:
            return list(self.scanner(self.watch_dir))
        except Exception as e:
            log(f"{self.platform}: scan error ({e}) — continuing")
            return ()


def discover_platforms() -> List[PlatformWatch]:
    found: List[PlatformWatch] = []

    claude_home = Path(os.environ.get("CLAUDE_HOME", "~/.claude")).expanduser()
    if claude_home.exists():
        found.append(
            PlatformWatch(
                "claude-code",
                claude_home,
                None,
                None,
                "hooks already report sessions; heartbeat only",
            )
        )
    else:
        log(f"{claude_home} not found — skipping claude-code")

    codex_home = Path("~/.codex").expanduser()
    if codex_home.exists():
        sessions = Path(os.environ.get("CODEX_SESSIONS_DIR", "~/.codex/sessions")).expanduser()
        found.append(
            PlatformWatch(
                "codex",
                codex_home,
                sessions,
                scan_jsonl_tree,
                f"watching {sessions}",
            )
        )
    else:
        log(f"{codex_home} not found — skipping codex")

    grok_home = Path(os.environ.get("GROK_HOME", "~/.grok")).expanduser()
    if grok_home.exists():
        sessions = Path(os.environ.get("GROK_SESSIONS_DIR", "~/.grok/sessions")).expanduser()
        found.append(
            PlatformWatch(
                "grok",
                grok_home,
                sessions,
                scan_grok_sessions,
                f"watching {sessions} (per-cwd UUID dirs; see README)",
            )
        )
    else:
        log(f"{grok_home} not found — skipping grok")

    hermes_home: Optional[Path] = None
    env_home = os.environ.get("HERMES_HOME")
    candidates = [Path(env_home).expanduser()] if env_home else []
    candidates.extend(
        [
            Path("~/.hermes").expanduser(),
            Path("~/.local/share/hermes").expanduser(),
        ]
    )
    for cand in candidates:
        if cand.exists():
            hermes_home = cand
            break
    if hermes_home is not None:
        sessions = hermes_home / "sessions"
        logs = hermes_home / "logs"
        if sessions.exists() and logs.exists():
            note = f"watching {sessions} (fallback {logs})"
        elif sessions.exists():
            note = f"watching {sessions}"
        elif logs.exists():
            note = f"{sessions} absent; watching {logs}"
        else:
            note = f"{sessions} and {logs} absent — will keep checking"
        found.append(
            PlatformWatch(
                "hermes",
                hermes_home,
                hermes_home,
                scan_hermes_state,
                note,
            )
        )
    else:
        log("~/.hermes and ~/.local/share/hermes not found — skipping hermes")

    return found


def apply_hits(
    watch: PlatformWatch,
    hits: Iterable[SessionHit],
    now: float,
    first_scan: bool,
) -> None:
    for sid, mtime, project in hits:
        prev = watch.seen.get(sid)
        watch.seen[sid] = mtime
        if first_scan:
            # Seed silently so a restart does not reopen sessions MC already closed.
            continue
        label = watch.platform
        if prev is None and now - mtime < IDLE_AFTER:
            watch.active.add(sid)
            report(
                watch.platform,
                "session_start",
                f"{label} session started ({sid})",
                session_id=sid,
                project=project,
            )
        elif prev is not None and mtime > prev:
            if sid not in watch.active:
                # Reopening: Agent Kontrol only reopens a closed session on
                # kind session_start (or explicit status active) — a plain
                # "status" event would leave it marked done.
                watch.active.add(sid)
                report(
                    watch.platform,
                    "session_start",
                    f"{label} session resumed ({sid})",
                    session_id=sid,
                    project=project,
                )
            else:
                report(
                    watch.platform,
                    "status",
                    f"{label} session active",
                    session_id=sid,
                    project=project,
                )

    for sid in list(watch.active):
        if now - watch.seen.get(sid, 0) > IDLE_AFTER:
            watch.active.discard(sid)
            report(
                watch.platform,
                "session_end",
                f"{watch.platform} session idle — marking done",
                session_id=sid,
            )


def main() -> None:
    if not MC_URL or not MC_TOKEN:
        print("Set MC_URL and MC_TOKEN", file=sys.stderr)
        sys.exit(1)
    if not (MC_URL.startswith("http://") or MC_URL.startswith("https://")):
        print("MC_URL must start with http:// or https://", file=sys.stderr)
        sys.exit(1)

    platforms = discover_platforms()
    if not platforms:
        log("no agent platforms found on this machine — heartbeating nothing, still looping")
    for p in platforms:
        log(f"found {p.platform} at {p.home} — {p.note}")
        if p.watch_dir is not None and not p.watch_dir.exists():
            log(f"{p.watch_dir} does not exist yet — will keep checking")
        heartbeat(p.platform)

    first_scan = True
    while True:
        now = time.time()
        if not first_scan:
            for p in platforms:
                heartbeat(p.platform)
        for p in platforms:
            apply_hits(p, p.scan(), now, first_scan)
        first_scan = False
        time.sleep(max(POLL, 1))


if __name__ == "__main__":
    main()
