#!/usr/bin/env python3
"""
Agent Kontrol dispatcher — the harness daemon.

Runs on any machine with agent CLIs installed. Polls Agent Kontrol for
queued tasks routed to the platforms available on this machine, runs each
one headless, and reports status + result + cost back. This is what turns
Agent Kontrol from a dashboard into a working agent harness:

  Tasks page / create_task (MCP)
        │
        ▼
  POST /api/tasks/claim  ◄── this daemon (one per machine)
        │
        ├── claude-code → claude -p "<prompt>" --output-format json
        ├── codex       → codex exec "<prompt>"
        └── grok        → grok -p "<prompt>"
        │
        ▼
  optional cross-vendor review (reviewer_platform), then
  PATCH /api/tasks/<id>  status=done|failed, result, cost_usd

Config via environment (or ~/.claude/mission-control.env):
  MC_URL                 e.g. https://your-deploy.vercel.app   (required)
  MC_TOKEN               shared secret                                  (required)
  MC_WORKDIR             where projects live (default ~/Code)
  MC_PLATFORMS           comma list to serve (default: auto-detect from PATH)
  MC_POLL_SECONDS        queue poll interval (default 20)
  MC_MAX_CONCURRENT      parallel tasks across all platforms (default 2)
  MC_TASK_TIMEOUT        seconds per run (default 3600)
  MC_CLAUDE_ARGS         extra args for claude (default: --permission-mode acceptEdits)
  MC_CODEX_ARGS          extra args for codex exec (default: --sandbox workspace-write)
  MC_GROK_ARGS           extra args for grok

Safety model: workers only get autonomy inside MC_WORKDIR project folders.
Anything requiring judgment beyond that should be a Cowork/interactive task,
not a dispatched one. Review tasks always run read-only.

Run it:  nohup python3 mc_dispatcher.py >> ~/.mission-control/dispatcher.log 2>&1 &
Or install the launchd plist — see agents/dispatcher/README.md. Stdlib only.
"""
# PEP 604 annotations (`dict | None`) are used below; this keeps the module
# importable on Python 3.9, which is still the system python3 on macOS.
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

from run_telemetry import ParsedRun, build_detail, parse_cli_output, resumes_session


def load_env_file() -> None:
    for candidate in ("~/.claude/mission-control.env", "~/.mission-control/env"):
        p = Path(candidate).expanduser()
        if not p.exists():
            continue
        try:
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))
        except Exception:
            pass


load_env_file()

MC_URL = os.environ.get("MC_URL", "").rstrip("/")
MC_TOKEN = os.environ.get("MC_TOKEN", "")
WORKDIR = Path(os.environ.get("MC_WORKDIR", "~/Code")).expanduser()
POLL = int(os.environ.get("MC_POLL_SECONDS", "20"))
MAX_CONCURRENT = int(os.environ.get("MC_MAX_CONCURRENT", "2"))
TASK_TIMEOUT = int(os.environ.get("MC_TASK_TIMEOUT", "3600"))
HOSTNAME = socket.gethostname().split(".")[0].lower()

CLI_FOR_PLATFORM = {"claude-code": "claude", "codex": "codex", "grok": "grok"}


def detect_platforms() -> list[str]:
    explicit = os.environ.get("MC_PLATFORMS", "").strip()
    if explicit:
        return [p.strip() for p in explicit.split(",") if p.strip()]
    return [p for p, cli in CLI_FOR_PLATFORM.items() if shutil.which(cli)]


def api(path: str, body: dict | None = None, method: str = "POST") -> dict:
    req = urllib.request.Request(
        f"{MC_URL}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {MC_TOKEN}",
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode() or "{}")


def ingest(kind: str, title: str, agent_id: str, platform: str, detail: dict | None = None,
           quiet: bool = False) -> None:
    try:
        api(
            "/api/ingest",
            {
                "agent_id": agent_id,
                "platform": platform,
                "machine": HOSTNAME,
                "kind": kind,
                "title": title,
                "detail": detail or {},
            },
        )
    except Exception as e:
        if not quiet:
            print(f"[mc] ingest failed: {e}", file=sys.stderr)


def build_prompt(task: dict) -> str:
    lines = [
        f"You are running as an autonomous worker dispatched by Agent Kontrol (task #{task['id']}).",
        f"Task: {task['title']}",
    ]
    if task.get("description"):
        lines.append(f"Instructions:\n{task['description']}")
    lines.append(
        "Work autonomously — do not wait for human input. When done, print a summary block:\n"
        "RESULT: <3-6 lines: what you did, what changed, anything left>"
    )
    return "\n\n".join(lines)


def build_review_prompt(task: dict, worker_output: str) -> str:
    return (
        f"You are a skeptical senior reviewer. Another AI agent just completed this task:\n"
        f"Task: {task['title']}\n"
        f"{task.get('description') or ''}\n\n"
        f"Worker's report:\n{worker_output[-3000:]}\n\n"
        "Review the actual state of the working tree / recent changes in this project. "
        "Do NOT make changes. Verify the work is correct and complete. "
        "End with exactly one line: VERDICT: APPROVE or VERDICT: REQUEST_CHANGES — <one-line reason>"
    )


def run_cli(platform: str, prompt: str, cwd: Path, review: bool = False,
            task_id: int | None = None) -> tuple[bool, str, float | None]:
    """Run one headless agent turn. Returns (ok, output_text, cost_usd)."""
    extra = os.environ.get(f"MC_{platform.split('-')[0].upper()}_ARGS", "").split()
    if platform == "claude-code":
        cmd = ["claude", "-p", prompt, "--output-format", "json"]
        cmd += ["--permission-mode", "default"] if review else (
            extra or ["--permission-mode", "acceptEdits"]
        )
    elif platform == "codex":
        cmd = ["codex", "exec"]
        cmd += ["-s", "read-only"] if review else (extra or ["--sandbox", "workspace-write"])
        cmd += ["--json", prompt]
    elif platform == "grok":
        cmd = ["grok", "-p", prompt] + ([] if review else extra) + ["--output-format", "json"]
    else:
        cmd = None

    started_at = datetime.now(timezone.utc)
    started = time.monotonic()
    finished = None
    parsed = ParsedRun()
    outcome, error_class = "failed", "process_error"
    try:
        if cmd is None:
            outcome, error_class = "unavailable", "unavailable"
            return False, f"no CLI runner for platform {platform}", None
        try:
            proc = subprocess.run(
                cmd, cwd=str(cwd), capture_output=True, text=True, timeout=TASK_TIMEOUT
            )
            finished = time.monotonic()
        except subprocess.TimeoutExpired:
            outcome, error_class = "timeout", "timeout"
            return False, f"timed out after {TASK_TIMEOUT}s", None
        except FileNotFoundError:
            outcome, error_class = "unavailable", "unavailable"
            return False, f"{cmd[0]} not found on PATH", None
        except OSError:
            return False, "CLI process could not start", None

        out = (proc.stdout or "") + ("\n" + proc.stderr if proc.returncode != 0 and proc.stderr else "")
        parsed = parse_cli_output(platform, proc.stdout or "")
        if parsed.output_text:
            out = parsed.output_text
            if platform != "claude-code" and proc.returncode != 0 and proc.stderr:
                out += "\n" + proc.stderr
        cost = None
        if platform == "claude-code":
            try:
                payload = json.loads(proc.stdout)
                cost = payload.get("total_cost_usd")
            except (ValueError, AttributeError):
                pass
        ok = proc.returncode == 0 and not parsed.reported_error and parsed.protocol_ok
        outcome = "completed" if ok else "failed"
        error_class = None if ok else ("process_error" if proc.returncode != 0 or parsed.reported_error else "protocol_error")
        return ok, out.strip(), cost
    finally:
        # Reporting failures must never affect the existing task/result path.
        try:
            if finished is None:
                finished = time.monotonic()
            duration_ms = max(0, round((finished - started) * 1000))
            # Map monotonic elapsed time onto the start timestamp so clock adjustments
            # cannot produce a negative or misleading run span.
            ended_at = started_at + timedelta(milliseconds=duration_ms)
            detail = build_detail(
                review=review, started_at=started_at, ended_at=ended_at,
                duration_ms=duration_ms,
                outcome=outcome, error_class=error_class, parsed=parsed,
                cumulative=resumes_session(extra if not review else [], platform), task_id=task_id,
            )
            ingest("run_complete", "Agent run complete", f"{platform}-{HOSTNAME}", platform, detail, quiet=True)
        except Exception:
            pass


def extract_result(output: str) -> str:
    marker = "RESULT:"
    idx = output.rfind(marker)
    text = output[idx + len(marker):].strip() if idx >= 0 else output
    return text[-1500:] if len(text) > 1500 else text


def run_task(task: dict, platform: str, sem: threading.Semaphore) -> None:
    agent_id = f"{platform}-{HOSTNAME}"
    tid = task["id"]
    try:
        cwd = WORKDIR / task["project"] if task.get("project") else WORKDIR
        if not cwd.is_dir():
            api(f"/api/tasks/{tid}", {
                "status": "failed", "agent_id": agent_id,
                "result": f"project folder not found on {HOSTNAME}: {cwd}",
            }, "PATCH")
            return

        api(f"/api/tasks/{tid}", {"status": "running", "agent_id": agent_id}, "PATCH")
        ingest("status", f"Running task #{tid}: {task['title']}", agent_id, platform, {"task_id": tid})

        ok, output, cost = run_cli(platform, build_prompt(task), cwd, task_id=tid)
        result = extract_result(output)

        reviewer = task.get("reviewer_platform")
        if ok and reviewer and shutil.which(CLI_FOR_PLATFORM.get(reviewer, "")):
            api(f"/api/tasks/{tid}", {"status": "review", "agent_id": agent_id}, "PATCH")
            ingest("status", f"Task #{tid} in review by {reviewer}", agent_id, platform, {"task_id": tid})
            r_ok, r_out, r_cost = run_cli(reviewer, build_review_prompt(task, output), cwd, review=True, task_id=tid)
            if r_cost:
                cost = (cost or 0) + r_cost
            verdict_line = next(
                (l for l in reversed(r_out.splitlines()) if "VERDICT:" in l), "VERDICT: (no verdict)"
            )
            approved = "APPROVE" in verdict_line and "REQUEST_CHANGES" not in verdict_line
            result = f"{result}\n\n[{reviewer} review] {verdict_line.strip()}"
            ok = ok and (approved or not r_ok)  # a broken reviewer doesn't fail good work

        body = {
            "status": "done" if ok else "failed",
            "result": result or ("completed" if ok else "run failed with no output"),
            "agent_id": agent_id,
        }
        if cost is not None:
            body["cost_usd"] = round(float(cost), 4)
        api(f"/api/tasks/{tid}", body, "PATCH")
    except Exception as e:
        try:
            api(f"/api/tasks/{tid}", {
                "status": "failed", "result": f"dispatcher error: {e}", "agent_id": agent_id,
            }, "PATCH")
        except Exception:
            pass
    finally:
        sem.release()


def main() -> None:
    if not MC_URL or not MC_TOKEN:
        print("Set MC_URL and MC_TOKEN (env or ~/.claude/mission-control.env)", file=sys.stderr)
        sys.exit(1)
    platforms = detect_platforms()
    if not platforms:
        print("No agent CLIs found (claude / codex / grok). Set MC_PLATFORMS or install one.", file=sys.stderr)
        sys.exit(1)

    print(f"[mc] dispatcher on {HOSTNAME} serving: {', '.join(platforms)} (workdir {WORKDIR})")
    sem = threading.Semaphore(MAX_CONCURRENT)
    heartbeat_at = 0.0

    while True:
        now = time.time()
        if now - heartbeat_at > 300:
            for p in platforms:
                ingest("heartbeat", "dispatcher online", f"{p}-{HOSTNAME}", p)
            heartbeat_at = now

        for platform in platforms:
            if not sem.acquire(blocking=False):
                break
            claimed = False
            try:
                resp = api("/api/tasks/claim", {
                    "platform": platform,
                    "machine": HOSTNAME,
                    "agent_id": f"{platform}-{HOSTNAME}",
                })
                task = resp.get("task")
                if task:
                    claimed = True
                    threading.Thread(
                        target=run_task, args=(task, platform, sem), daemon=True
                    ).start()
            except Exception as e:
                print(f"[mc] claim failed ({platform}): {e}", file=sys.stderr)
            finally:
                if not claimed:
                    sem.release()

        time.sleep(POLL)


if __name__ == "__main__":
    main()
