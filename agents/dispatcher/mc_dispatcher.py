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

Config via environment (or ~/.claude/mission-control.env, read by main() only):
  MC_URL                 e.g. https://your-deploy.vercel.app   (required)
  MC_TOKEN               shared secret                                  (required)
  MC_WORKDIR             root that holds the linked git worktrees tasks name (default ~/Code)
  MC_PLATFORMS           comma list to serve (default: auto-detect from PATH)
  MC_POLL_SECONDS        queue poll interval (default 20)
  MC_MAX_CONCURRENT      parallel tasks across all platforms (default 2)
  MC_TASK_TIMEOUT        seconds per run (default 3600)
  MC_CLAUDE_ARGS         extra args for claude (default: --permission-mode acceptEdits)
  MC_CODEX_ARGS          extra args for codex exec (default: --full-auto)
  MC_GROK_ARGS           extra args for grok

Safety model: every task names task.project, a linked git worktree strictly
under MC_WORKDIR (no absolute path, no "..", no symlink below the root). One
dispatched agent per worktree: a lock in the worktree's own git dir is held
from preparation to the end of review, so a second dispatcher on the same
worktree fails the task without launching a CLI. Before the worker starts,
the lane's skill pointers (GET /api/skills/pointers) are written into the
worktree's AGENTS.md; they are taken out again before review, after the
CLI's own process group (it runs in a new session) has been stopped. Anything
requiring judgment beyond that should be a Cowork/interactive task, not a
dispatched one. Review tasks always run read-only.

Run it:  nohup python3 mc_dispatcher.py >> ~/.mission-control/dispatcher.log 2>&1 &
Or install the launchd plist — see agents/dispatcher/README.md. Stdlib only.
"""
# PEP 604 annotations (`dict | None`) are used below; this keeps the module
# importable on Python 3.9, which is still the system python3 on macOS.
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import ak_pointers


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


def configure() -> None:
    """Read settings from os.environ. Importing the module reads no file; main() loads the env file first."""
    global MC_URL, MC_TOKEN, WORKDIR, POLL, MAX_CONCURRENT, TASK_TIMEOUT
    MC_URL = os.environ.get("MC_URL", "").rstrip("/")
    MC_TOKEN = os.environ.get("MC_TOKEN", "")
    WORKDIR = Path(os.environ.get("MC_WORKDIR", "~/Code")).expanduser()
    POLL = int(os.environ.get("MC_POLL_SECONDS", "20"))
    MAX_CONCURRENT = int(os.environ.get("MC_MAX_CONCURRENT", "2"))
    TASK_TIMEOUT = int(os.environ.get("MC_TASK_TIMEOUT", "3600"))


configure()
HOSTNAME = socket.gethostname().split(".")[0].lower()

CLI_FOR_PLATFORM = {"claude-code": "claude", "codex": "codex", "grok": "grok"}
# Skill runtime that reads the worktree's AGENTS.md, per dispatch platform.
RUNTIME_FOR_PLATFORM = {"claude-code": "claude", "codex": "codex", "grok": "grok"}
# Same rule as LANE_RE in src/app/api/skills/pointers/route.ts.
LANE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}")
MAX_POINTER_RESPONSE = 256_000
MAX_POINTER_BLOCK = 64_000
LOCK_NAME = "ak-dispatch.lock"
KILL_GRACE = 5.0  # seconds a CLI's process group gets after SIGTERM, then again after SIGKILL


def detect_platforms() -> list[str]:
    explicit = os.environ.get("MC_PLATFORMS", "").strip()
    if explicit:
        return [p.strip() for p in explicit.split(",") if p.strip()]
    return [p for p, cli in CLI_FOR_PLATFORM.items() if shutil.which(cli)]


def api(path: str, body: dict | None = None, method: str = "POST", max_bytes: int | None = None) -> dict:
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
        if max_bytes is None:
            return json.loads(resp.read().decode() or "{}")
        raw = resp.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError(f"response from {path.split('?')[0]} is larger than {max_bytes} bytes")
        return json.loads(raw.decode("utf-8"))


def ingest(kind: str, title: str, agent_id: str, platform: str, detail: dict | None = None) -> None:
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
        print(f"[mc] ingest failed: {e}", file=sys.stderr)


def build_prompt(task: dict, pointers: bool = False) -> str:
    lines = [
        f"You are running as an autonomous worker dispatched by Agent Kontrol (task #{task['id']}).",
        f"Task: {task['title']}",
    ]
    if task.get("description"):
        lines.append(f"Instructions:\n{task['description']}")
    if pointers:
        lines.append(
            f"AGENTS.md in this worktree holds a temporary skill-pointer block between "
            f"{ak_pointers.POINTERS_BEGIN} and {ak_pointers.POINTERS_END}. It is dispatch metadata: "
            "read it, but do not edit, stage, or commit it. The dispatcher removes it when you finish."
        )
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


class ContainmentError(Exception):
    """A dispatched CLI's process group could not be stopped."""


def stop_group(proc: subprocess.Popen, grace: float) -> bool:
    """SIGTERM, then SIGKILL, the CLI's own process group. True once no member is left.

    The group id is the CLI's pid (start_new_session), never this process's group.
    A process that moved itself to another group or session is outside it.
    """
    pgid = proc.pid
    for sig in (signal.SIGTERM, signal.SIGKILL):
        deadline = time.monotonic() + grace
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            proc.poll()
            return True
        except PermissionError:
            pass
        while time.monotonic() < deadline:
            proc.poll()  # reap the leader so its zombie does not keep the group alive
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                pass
            time.sleep(0.05)
    proc.poll()
    return False


def run_contained(cmd: list[str], cwd: Path, timeout: float) -> tuple[int, str, str]:
    """Run cmd in a new session and stop its whole process group before returning.

    Background children left by the CLI are stopped on exit, error, timeout, or
    exception, so none of them outlives the worktree lock. Output goes to temp
    files rather than pipes, so a child holding stdout open does not stall the wait.
    """
    with tempfile.TemporaryFile() as out_f, tempfile.TemporaryFile() as err_f:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=out_f, stderr=err_f,
            start_new_session=True,
        )
        timed_out = False
        try:
            returncode = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            stopped = stop_group(proc, KILL_GRACE)
        if not stopped:
            raise ContainmentError(f"process group {proc.pid} still had members after SIGKILL")
        if timed_out:
            raise subprocess.TimeoutExpired(cmd, timeout)
        out_f.seek(0)
        err_f.seek(0)
        return (
            returncode,
            out_f.read().decode("utf-8", errors="replace"),
            err_f.read().decode("utf-8", errors="replace"),
        )


def run_cli(platform: str, prompt: str, cwd: Path, review: bool = False) -> tuple[bool, str, float | None]:
    """Run one headless agent turn. Returns (ok, output_text, cost_usd)."""
    extra = os.environ.get(f"MC_{platform.split('-')[0].upper()}_ARGS", "").split()
    if platform == "claude-code":
        cmd = ["claude", "-p", prompt, "--output-format", "json"]
        cmd += ["--permission-mode", "default"] if review else (
            extra or ["--permission-mode", "acceptEdits"]
        )
    elif platform == "codex":
        cmd = ["codex", "exec"]
        cmd += ["-s", "read-only"] if review else (extra or ["--full-auto"])
        cmd += [prompt]
    elif platform == "grok":
        cmd = ["grok", "-p", prompt] + ([] if review else extra)
    else:
        return False, f"no CLI runner for platform {platform}", None

    try:
        returncode, stdout, stderr = run_contained(cmd, cwd, TASK_TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, f"timed out after {TASK_TIMEOUT}s", None
    except FileNotFoundError:
        return False, f"{cmd[0]} not found on PATH", None

    out = stdout + ("\n" + stderr if returncode != 0 and stderr else "")
    cost = None
    if platform == "claude-code":
        try:
            payload = json.loads(stdout)
            cost = payload.get("total_cost_usd")
            out = payload.get("result") or out
        except Exception:
            pass
    return returncode == 0, out.strip(), cost


def extract_result(output: str) -> str:
    marker = "RESULT:"
    idx = output.rfind(marker)
    text = output[idx + len(marker):].strip() if idx >= 0 else output
    return text[-1500:] if len(text) > 1500 else text


class DispatchRefused(Exception):
    """The task cannot run here. Nothing was written and no CLI was launched."""


def resolve_project(project: object, workdir: Path) -> Path:
    """task.project as a real directory strictly below workdir, or DispatchRefused."""
    if not isinstance(project, str) or project == "":
        raise DispatchRefused("task.project is required: the linked git worktree folder under MC_WORKDIR")
    if "\0" in project or "\\" in project or os.path.isabs(project):
        raise DispatchRefused(f"task.project must be a relative path under MC_WORKDIR: {project!r}")
    parts = project.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise DispatchRefused(f"task.project may not contain empty, '.' or '..' parts: {project!r}")
    try:
        root = workdir.resolve(strict=True)
    except (OSError, RuntimeError) as e:
        raise DispatchRefused(f"MC_WORKDIR {workdir} is not usable on {HOSTNAME}: {e}") from e
    if not root.is_dir():
        raise DispatchRefused(f"MC_WORKDIR {workdir} is not a directory on {HOSTNAME}")
    cur = root
    for part in parts:
        cur = cur / part
        try:
            st = os.lstat(cur)
        except FileNotFoundError:
            raise DispatchRefused(f"project folder not found on {HOSTNAME}: {root / project}") from None
        except OSError as e:
            raise DispatchRefused(f"cannot inspect {cur}: {e.strerror}") from e
        if stat.S_ISLNK(st.st_mode):
            raise DispatchRefused(f"task.project goes through a symlink: {cur}")
        if not stat.S_ISDIR(st.st_mode):
            raise DispatchRefused(f"task.project is not a directory: {cur}")
    real = cur.resolve(strict=True)
    try:
        rel = real.relative_to(root)
    except ValueError:
        raise DispatchRefused(f"task.project escapes MC_WORKDIR: {project!r}") from None
    if not rel.parts:
        raise DispatchRefused("task.project may not be MC_WORKDIR itself")
    return real


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=60
    )


def linked_worktree_git_dir(path: Path) -> Path:
    """The per-worktree git dir when path is the top of a linked worktree, else DispatchRefused."""
    try:
        dot_git = os.lstat(path / ".git")
    except FileNotFoundError:
        raise DispatchRefused(f"{path} is not a git worktree (no .git)") from None
    if not stat.S_ISREG(dot_git.st_mode):
        raise DispatchRefused(
            f"{path} is a main checkout, not a linked worktree; create one with `git worktree add` "
            "and point task.project at it"
        )
    top = git(path, "rev-parse", "--show-toplevel")
    git_dir = git(path, "rev-parse", "--absolute-git-dir")
    common = git(path, "rev-parse", "--git-common-dir")
    if top.returncode or git_dir.returncode or common.returncode:
        raise DispatchRefused(f"{path} is not a usable git worktree: {(top.stderr or git_dir.stderr).strip()}")
    if Path(top.stdout.strip()).resolve() != path:
        raise DispatchRefused(f"{path} is inside a worktree, not its top folder")
    own = Path(git_dir.stdout.strip()).resolve()
    shared = Path(common.stdout.strip())
    shared = (shared if shared.is_absolute() else path / shared).resolve()
    if own == shared:
        raise DispatchRefused(f"{path} is a main checkout, not a linked worktree")
    return own


class WorktreeLock:
    """flock on <worktree git dir>/ak-dispatch.lock. Coordinates dispatchers on this host only."""

    def __init__(self, git_dir: Path) -> None:
        self.path = git_dir / LOCK_NAME
        self.fd: int | None = None

    def acquire(self, worktree: Path) -> None:
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise DispatchRefused(
                f"another dispatched task is already running in {worktree}; one agent per worktree"
            ) from None
        self.fd = fd

    def release(self) -> None:
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
                self.fd = None


def fetch_pointers(lane: str, runtime: str) -> str:
    """The lane's pointer block from GET /api/skills/pointers. Only lane and runtime are sent."""
    query = urllib.parse.urlencode({"lane": lane, "runtime": runtime})
    resp = api(f"/api/skills/pointers?{query}", None, "GET", max_bytes=MAX_POINTER_RESPONSE)
    if not isinstance(resp, dict):
        raise ValueError("pointer response is not a JSON object")
    demo, empty, block = resp.get("demo"), resp.get("empty"), resp.get("block")
    if type(demo) is not bool or type(empty) is not bool or not isinstance(block, str):
        raise ValueError("pointer response is missing demo, empty, or block")
    if demo:
        raise ValueError("pointer response came from a demo deployment (no database); refusing to dispatch on it")
    if resp.get("lane") != lane or resp.get("runtime") != runtime:
        raise ValueError("pointer response is for a different lane or runtime")
    if len(block) > MAX_POINTER_BLOCK:
        raise ValueError(f"pointer block is larger than {MAX_POINTER_BLOCK} characters")
    if empty != (block == ""):
        raise ValueError("pointer response empty flag does not match its block")
    if block and ("\r" in block or "\0" in block or not ak_pointers.is_rendered_block(block)):
        raise ValueError("pointer block is not a single ak-skills begin/end block")
    return block


def committed_metadata(cwd: Path, base_head: str | None, block: str) -> str | None:
    """Name where the injected block reached git (index or HEAD), or None. Only these two are checked."""
    def blob(spec: str) -> str:
        out = git(cwd, "show", spec)
        return out.stdout.replace("\r\n", "\n") if out.returncode == 0 else ""

    before = blob(f"{base_head}:{ak_pointers.AGENTS_MD}") if base_head else ""
    if block in before:
        return None
    if block in blob(f":{ak_pointers.AGENTS_MD}"):
        return "staged in the git index"
    if block in blob(f"HEAD:{ak_pointers.AGENTS_MD}"):
        return "committed at HEAD"
    return None


def fail_task(tid: object, agent_id: str, reason: str) -> None:
    api(f"/api/tasks/{tid}", {"status": "failed", "agent_id": agent_id, "result": reason}, "PATCH")


def run_task(task: dict, platform: str, sem: threading.Semaphore) -> None:
    agent_id = f"{platform}-{HOSTNAME}"
    tid = task["id"]
    lock: WorktreeLock | None = None
    try:
        project = task.get("project")
        runtime = RUNTIME_FOR_PLATFORM.get(platform)
        try:
            if runtime is None:
                raise DispatchRefused(f"no skill runtime for platform {platform}")
            if not isinstance(project, str) or not LANE_RE.fullmatch(project):
                raise DispatchRefused(
                    "task.project is required and is the skill lane: 1-100 characters of letters, "
                    f"digits, and . _ : / - starting with a letter or digit (got {project!r})"
                )
            cwd = resolve_project(project, WORKDIR)
            candidate = WorktreeLock(linked_worktree_git_dir(cwd))
            candidate.acquire(cwd)
            lock = candidate
        except DispatchRefused as e:
            fail_task(tid, agent_id, str(e))
            return
        try:
            block = fetch_pointers(project, runtime)
        except Exception as e:
            fail_task(tid, agent_id, f"skill pointers unavailable, no worker started: {e}")
            return
        # Read before injection: once the block is written, the next statement must be the cleanup try.
        try:
            head = git(cwd, "rev-parse", "--verify", "-q", "HEAD")
        except (subprocess.SubprocessError, OSError) as e:
            fail_task(tid, agent_id, f"could not read HEAD, no worker started: {e}")
            return
        base_head = head.stdout.strip() if head.returncode == 0 else None
        try:
            injection = ak_pointers.inject(cwd, block)
        except (ak_pointers.PointerFileError, OSError) as e:
            fail_task(tid, agent_id, f"could not write skill pointers, no worker started: {e}")
            return

        cleanup_error: str | None = None
        try:
            api(f"/api/tasks/{tid}", {"status": "running", "agent_id": agent_id}, "PATCH")
            ingest("status", f"Running task #{tid}: {task['title']}", agent_id, platform, {"task_id": tid})
            ok, output, cost = run_cli(platform, build_prompt(task, injection.changed and block != ""), cwd)
        finally:
            try:
                ak_pointers.cleanup(injection)
            except (ak_pointers.PointerFileError, OSError) as e:
                cleanup_error = str(e)
        result = extract_result(output)

        if cleanup_error:
            ok = False
            result = (
                f"{result}\n\n[dispatch] AGENTS.md cleanup failed: {cleanup_error}. "
                "Remove the ak-skills block by hand before committing; review was skipped."
            )
        elif injection.changed and block:
            leaked = committed_metadata(cwd, base_head, block)
            if leaked:
                ok = False
                result = (
                    f"{result}\n\n[dispatch] the skill-pointer block is {leaked}. It is dispatch "
                    "metadata: unstage or amend it out before this work lands; review was skipped."
                )

        reviewer = task.get("reviewer_platform")
        if ok and reviewer and shutil.which(CLI_FOR_PLATFORM.get(reviewer, "")):
            api(f"/api/tasks/{tid}", {"status": "review", "agent_id": agent_id}, "PATCH")
            ingest("status", f"Task #{tid} in review by {reviewer}", agent_id, platform, {"task_id": tid})
            r_ok, r_out, r_cost = run_cli(reviewer, build_review_prompt(task, output), cwd, review=True)
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
        try:
            if lock is not None:
                lock.release()
        finally:
            sem.release()


def main() -> None:
    load_env_file()
    configure()
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
