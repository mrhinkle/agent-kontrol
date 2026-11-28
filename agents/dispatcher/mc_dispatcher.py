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
  MC_CODEX_ARGS          extra args for codex exec (default: --sandbox workspace-write)
  MC_GROK_ARGS           extra args for grok
  MC_EVENT_CONSUMER      optional, explicitly registered event consumer id
  MC_EVENT_TOKEN         optional events:read akc_ credential (never MC_TOKEN)
  MC_TASK_PROJECT        optional exact task lane on every claim (unset claims any project)
  MC_BROKER_SOCKET       optional absolute path of the secret broker's admin socket (#194)
  MC_BROKER_SERVICES     comma list of broker services minted for each task
                         (with a GitHub origin remote the broker may also grant a
                         short-lived repository token through git-credential-ak, #190)
  MC_BROKER_GITHUB       unset, or exactly "required": a supported GitHub remote must get
                         a GitHub grant or the task fails closed (set it on every host
                         whose broker has a github block, #190 I4)
  MC_LANE_USER           optional unprivileged OS user that runs every agent CLI, through
                         sudo and the documented sudoers rule (#193, Linux only). Set and
                         unusable, the task fails closed; it never falls back to this user
  MC_BRIDGE_ENABLED      exactly "1" turns on bridge mode (#212); any other value or unset
                         leaves the claim path above unchanged and reads no bridge file
  MC_BRIDGE_CONFIG       absolute path of the bridge JSON config (read only in bridge mode)

An opt-in outbound SSE listener wakes the normal atomic claim path. While
connected the fallback poll is max(MC_POLL_SECONDS, 60); when unavailable it
keeps MC_POLL_SECONDS. No inbound listener or automatic registration is added.

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
import pwd
import re
import select
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
from collections.abc import Mapping
from datetime import datetime, timezone, timedelta
from pathlib import Path

import ak_pointers
import ak_stop_control as stopctl
import child_env
import dispatch_ready_bridge as drb
from dispatch_ready_bridge import bridge_frame_refusal, frame_untrusted_issue
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


def configure() -> None:
    """Read settings from os.environ. Importing the module reads no file; main() loads the env file first."""
    global MC_URL, MC_TOKEN, WORKDIR, POLL, MAX_CONCURRENT, TASK_TIMEOUT
    MC_URL = os.environ.get("MC_URL", "").rstrip("/")
    MC_TOKEN = os.environ.get("MC_TOKEN", "")
    WORKDIR = Path(os.environ.get("MC_WORKDIR", "~/Code")).expanduser()
    POLL = int(os.environ.get("MC_POLL_SECONDS", "20"))
    if os.environ.get("MC_BRIDGE_ENABLED") == "1":
        # Bridge startup validates the raw value and halts with invalid_concurrency (#212 H12).
        try:
            MAX_CONCURRENT = int(os.environ.get("MC_MAX_CONCURRENT", "2"))
        except ValueError:
            MAX_CONCURRENT = 0
    else:
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
SKILL_RECOVERY_NAME = "ak-skill-recovery.json"  # written by ak_skill_launch; blocks every dispatch until recovered
KILL_GRACE = 5.0  # seconds a CLI's process group gets after SIGTERM, then again after SIGKILL


def detect_platforms() -> list[str]:
    explicit = os.environ.get("MC_PLATFORMS", "").strip()
    if explicit:
        return [p.strip() for p in explicit.split(",") if p.strip()]
    return [p for p, cli in CLI_FOR_PLATFORM.items() if shutil.which(cli)]


def api(path: str, body: dict | None = None, method: str = "POST", max_bytes: int | None = None,
        headers: dict | None = None) -> dict:
    # The task bearer stays on Authorization. Event proof is a separate header
    # and is never copied into the log or the task body.
    merged = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {MC_TOKEN}",
    }
    if headers:
        merged.update(headers)
    req = urllib.request.Request(
        f"{MC_URL}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=merged,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        if max_bytes is None:
            return json.loads(resp.read().decode() or "{}")
        raw = resp.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError(f"response from {path.split('?')[0]} is larger than {max_bytes} bytes")
        return json.loads(raw.decode("utf-8"))


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


def build_prompt(task: dict, pointers: bool = False) -> str:
    framed = frame_untrusted_issue(task)
    if framed is not None:
        # Issue content stays inside the length-delimited object. It is not
        # labeled as dispatcher instructions. Lane and argv are chosen by the
        # dispatcher from the task record's platform and project, not from this text.
        lines = [
            f"You are running as an autonomous worker dispatched by Agent Kontrol (task #{task['id']}).",
            framed,
        ]
    else:
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
    framed = frame_untrusted_issue(task)
    if framed is not None:
        task_block = framed
    else:
        task_block = f"Task: {task['title']}\n{task.get('description') or ''}"
    return (
        f"You are a skeptical senior reviewer. Another AI agent just completed this task:\n"
        f"{task_block}\n\n"
        f"Worker's report:\n{worker_output[-3000:]}\n\n"
        "Review the actual state of the working tree / recent changes in this project. "
        "Do NOT make changes. Verify the work is correct and complete. "
        "End with exactly one line: VERDICT: APPROVE or VERDICT: REQUEST_CHANGES — <one-line reason>"
    )


# The whole final line: VERDICT: APPROVE or VERDICT: REQUEST_CHANGES, optionally " — <reason>".
VERDICT_RE = re.compile(r"VERDICT: (APPROVE|REQUEST_CHANGES)(?:\s+[—–-]\s+\S.*)?")
# A Markdown code fence: up to 3 spaces of indent, then 3+ backticks or tildes.
FENCE_RE = re.compile(r" {0,3}(`{3,}|~{3,})(.*)")


def parse_verdict(output: str) -> tuple[str | None, str]:
    """(decision, line) from the reviewer's final non-blank line; decision None if it is not a valid verdict.

    The final line must be the verdict at column 0: indented, quoted, or inside
    a still-open ``` / ~~~ fence is not a verdict. Earlier lines are not scanned
    for a verdict. An earlier verdict-shaped line (at any indent) that disagrees
    with the final one makes the decision None (contradictory review).
    """
    lines = [l.rstrip() for l in output.splitlines() if l.strip()]
    if not lines:
        return None, "no output"
    final = lines[-1]
    fence = None  # (char, length) of the open fence, if any
    for line in lines[:-1]:
        f = FENCE_RE.fullmatch(line)
        if not f:
            continue
        run, rest = f.group(1), f.group(2)
        if fence is None:
            if not (run[0] == "`" and "`" in rest):
                fence = (run[0], len(run))
        elif run[0] == fence[0] and len(run) >= fence[1] and not rest.strip():
            fence = None
    m = VERDICT_RE.fullmatch(final)
    if not m or fence is not None:
        return None, final.strip()
    for earlier in lines[:-1]:
        e = VERDICT_RE.fullmatch(earlier.strip())
        if e and e.group(1) != m.group(1):
            return None, final
    return m.group(1), final


def review_outcome(r_ok: bool, r_out: str) -> tuple[bool, str]:
    """(approved, note) for a configured reviewer's run. Anything short of a clean APPROVE fails."""
    decision, line = parse_verdict(r_out)
    line = line[:200]
    if not r_ok:
        return False, f"reviewer failed, task not approved: {line}"
    if decision == "APPROVE":
        return True, line
    if decision == "REQUEST_CHANGES":
        return False, line
    return False, f"no valid final verdict line, task not approved (last line: {line})"


class ContainmentError(Exception):
    """A dispatched CLI's process group could not be stopped."""


def stop_group(proc: subprocess.Popen, grace: float) -> bool:
    """SIGTERM, then SIGKILL, the CLI's own process group. True once no member is left.

    The group id is the CLI's pid (start_new_session), never this process's group.
    A process that moved itself to another group or session is outside it.
    """
    return stop_group_id(proc.pid, proc.poll, grace)


def stop_group_id(pgid: int, reap, grace: float) -> bool:
    """stop_group for a process group known only by id. reap() collects the leader if it is our child."""
    if pgid <= 1 or pgid == os.getpgrp():
        raise ValueError(f"refusing to signal process group {pgid}")
    for sig in (signal.SIGTERM, signal.SIGKILL):
        deadline = time.monotonic() + grace
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            reap()
            return True
        except PermissionError:
            pass
        while time.monotonic() < deadline:
            reap()  # reap the leader so its zombie does not keep the group alive
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                pass
            time.sleep(0.05)
    reap()
    return False


def run_contained(cmd: list[str], cwd: Path, timeout: float, *, env: dict[str, str],
                  lane: LaneUser | None = None) -> tuple[int, str, str]:
    """Run cmd in a new session and stop its whole process group before returning.

    Background children left by the CLI are stopped on exit, error, timeout, or
    exception, so none of them outlives the worktree lock. Output goes to temp
    files rather than pipes, so a child holding stdout open does not stall the wait.
    env is the child's whole environment; the parent's environment is not inherited.
    With lane, the CLI runs as that user through sudo and is stopped through sudo (#193).
    """
    if lane is not None:
        return _run_contained_lane(cmd, cwd, timeout, env=env, lane=lane)
    with tempfile.TemporaryFile() as out_f, tempfile.TemporaryFile() as err_f:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=out_f, stderr=err_f,
            start_new_session=True, env=env,
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


# ---------------------------------------------------------------------------
# Lane user (#193). With MC_LANE_USER set, every agent CLI runs as that
# unprivileged user through `sudo -n -u <lane>` and the sudoers rule in the
# README; the lock, pointer files, recovery record and broker client stay with
# this user. An unusable lane user fails the task closed: there is no fallback.

LANE_USER_UNAVAILABLE = "lane user unavailable, no worker started"
LANE_TEST = "/usr/bin/test"  # the sudoers rule names these exact paths (C8)
LANE_KILL = "/bin/kill"
LANE_PREFLIGHT_TIMEOUT = 30.0
LANE_OP_TIMEOUT = 10.0
LANE_POLL = 0.1
_LANE_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9._-]{0,31}")
_LANE_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_LANE_NEVER_PRESERVED = frozenset(("MC_TOKEN", "MC_EVENT_TOKEN"))
# Per-machine CLI args are environment values that would land in the sudo argv (C5), so a
# lane user refuses all three: a task's reviewer may be another platform than its worker.
LANE_REFUSED_ARGS = ("MC_CLAUDE_ARGS", "MC_CODEX_ARGS", "MC_GROK_ARGS")


class LaneUserUnavailable(Exception):
    """The lane user is set and cannot be used. The message is a fixed reason, never an env value."""


class LaneUser:
    """A validated lane user: its name and the passwd values the CLI sees (C6)."""

    def __init__(self, name: str, uid: int, home: str, shell: str) -> None:
        self.name = name
        self.uid = uid
        self.home = home
        self.shell = shell

    def identity(self) -> dict[str, str]:
        return {"HOME": self.home, "USER": self.name, "LOGNAME": self.name, "SHELL": self.shell}


def lane_user(environ: Mapping[str, str] | None = None) -> LaneUser | None:
    """The MC_LANE_USER user, None when unset. Raises LaneUserUnavailable when set and invalid (C6).

    Read from the process environment, which load_env_file only fills with defaults,
    so an exported value wins. The value is never trimmed.
    """
    env = os.environ if environ is None else environ
    if "MC_LANE_USER" not in env:
        return None
    name = env["MC_LANE_USER"]
    if name.strip() == "":
        raise LaneUserUnavailable("MC_LANE_USER is empty")
    if name != name.strip():
        raise LaneUserUnavailable("MC_LANE_USER has leading or trailing whitespace")
    if _LANE_NAME_RE.fullmatch(name) is None:
        raise LaneUserUnavailable("MC_LANE_USER is not a plain user name")
    for var in LANE_REFUSED_ARGS:
        if env.get(var, "").strip():
            raise LaneUserUnavailable(f"{var} is not supported with a lane user")
    try:
        entry = pwd.getpwnam(name)
    except (KeyError, ValueError, TypeError, OSError):
        raise LaneUserUnavailable("MC_LANE_USER names no user on this host") from None
    if entry.pw_uid == 0:
        raise LaneUserUnavailable("MC_LANE_USER is root")
    if entry.pw_uid == os.geteuid():
        raise LaneUserUnavailable("MC_LANE_USER is the dispatcher's own user")
    if not entry.pw_dir or not os.path.isabs(entry.pw_dir):
        raise LaneUserUnavailable("MC_LANE_USER has no home directory")
    if not entry.pw_shell or not os.path.isabs(entry.pw_shell):
        raise LaneUserUnavailable("MC_LANE_USER has no login shell")
    return LaneUser(entry.pw_name, entry.pw_uid, entry.pw_dir, entry.pw_shell)


def _lane_op(lane: LaneUser, *args: str, timeout: float = LANE_OP_TIMEOUT) -> int | None:
    """`sudo -n -u <lane> <args>` for a sudoers-permitted op. Its exit code, or None when it could not run.

    The sudo process gets PATH only, so it never holds this process's secrets.
    """
    try:
        done = subprocess.run(
            ["sudo", "-n", "-u", lane.name, *args],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={"PATH": os.environ.get("PATH", os.defpath)}, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.returncode


def lane_preflight(lane: LaneUser, cwd: Path) -> None:
    """`sudo -n -u <lane> /usr/bin/test -w <cwd>`. Raises LaneUserUnavailable unless it exits 0."""
    code = _lane_op(lane, LANE_TEST, "-w", str(cwd), timeout=LANE_PREFLIGHT_TIMEOUT)
    if code is None:
        raise LaneUserUnavailable("preflight could not run sudo")
    if code != 0:
        raise LaneUserUnavailable(f"preflight failed: the lane user cannot write the worktree (exit {code})")


def lane_argv(lane: LaneUser, cmd: list[str], env: Mapping[str, str]) -> list[str]:
    """The C5 launch argv: sudo, the sorted child env names, then the CLI by absolute path.

    Names only: no environment value is ever placed in the argv.
    """
    names = sorted(env)
    for name in names:
        if name in _LANE_NEVER_PRESERVED:
            raise LaneUserUnavailable(f"{name} may never reach a lane")
        if _LANE_ENV_NAME_RE.fullmatch(name) is None:
            raise LaneUserUnavailable("the child environment has a name sudo cannot preserve")
    exe = shutil.which(cmd[0])
    if exe is None or not os.path.isabs(exe):
        raise LaneUserUnavailable(f"{cmd[0]} not found on the dispatcher's PATH")
    return ["sudo", "-n", "-u", lane.name, "--preserve-env=" + ",".join(names), "--", exe, *cmd[1:]]


def stop_lane_group(proc: subprocess.Popen, pgid: int, lane: LaneUser, grace: float) -> str | None:
    """Stop a lane CLI's process group across the user switch (C9). None once it is confirmed gone.

    SIGTERM, then SIGKILL, go to the group through `sudo -n -u <lane> /bin/kill`;
    `kill -0` through the same rule is polled until it exits non-zero (no lane-owned
    member is left). Only then is the sudo wrapper reaped, so the group id cannot be
    reused during the check. Two checks follow that do not trust sudo: the wrapper
    must exit (it waits for the CLI), and once it is reaped the group must be empty.
    """
    if pgid <= 1 or pgid == os.getpgrp():
        raise ValueError(f"refusing to signal process group {pgid}")
    target = f"-{pgid}"
    gone = False
    for sig in ("-TERM", "-KILL"):
        _lane_op(lane, LANE_KILL, sig, "--", target)
        deadline = time.monotonic() + grace
        while True:
            code = _lane_op(lane, LANE_KILL, "-0", "--", target)
            if code is not None and code != 0:
                gone = True
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(LANE_POLL)
        if gone:
            break
    if not gone:
        return "still had lane-user members after SIGKILL"
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass
        return "the sudo wrapper did not exit after its group was stopped"
    # A member SIGKILL just ended can stay a zombie until init reaps it, so allow it the same grace.
    deadline = time.monotonic() + grace
    while True:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return None
        except PermissionError:
            problem = "members this user cannot signal are still in the group"
        except OSError:
            return "the group could not be checked"
        else:
            problem = "the group still has members"
        if time.monotonic() >= deadline:
            return problem
        time.sleep(LANE_POLL)


def _can_wait_unreaped() -> bool:
    return hasattr(os, "waitid") or hasattr(select, "kqueue")


def _wait_exit_unreaped(pid: int, timeout: float) -> bool:
    """True once child pid has exited, False on timeout. Never reaps it (C9).

    The zombie keeps its pid, and so its group id, from being reused until
    stop_lane_group has confirmed the group gone and reaps it. Linux has
    waitid(WNOWAIT); macOS's Python 3.9 has no waitid, so kqueue NOTE_EXIT.
    """
    deadline = time.monotonic() + timeout
    if hasattr(os, "waitid"):
        delay = 0.01
        while True:
            info = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
            if info is not None and info.si_pid == pid:
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(delay, remaining))
            delay = min(delay * 2, 0.25)
    kq = select.kqueue()
    try:
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC,
                              flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)
        try:
            return bool(kq.control([event], 1, max(0.0, deadline - time.monotonic())))
        except ProcessLookupError:
            return True  # already a zombie: our unreaped child, so it has exited
    finally:
        kq.close()


def _run_contained_lane(cmd: list[str], cwd: Path, timeout: float, *, env: dict[str, str],
                        lane: LaneUser) -> tuple[int, str, str]:
    """run_contained for a lane user. Raises LaneUserUnavailable when sudo cannot be started."""
    argv = lane_argv(lane, cmd, env)
    if not _can_wait_unreaped():
        raise LaneUserUnavailable("this platform cannot wait for the sudo wrapper without reaping it")
    with tempfile.TemporaryFile() as out_f, tempfile.TemporaryFile() as err_f:
        try:
            proc = subprocess.Popen(
                argv, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=out_f, stderr=err_f,
                start_new_session=True, env=env,
            )
        except OSError:
            raise LaneUserUnavailable("sudo could not start") from None
        # start_new_session makes sudo a session leader, so the group id is its pid;
        # with !use_pty sudo runs the lane CLI in that same group (C9).
        pgid = proc.pid
        timed_out = True
        try:
            # Wait without reaping, on every path: the wrapper's zombie pins the
            # group id until stop_lane_group has confirmed the group gone.
            timed_out = not _wait_exit_unreaped(proc.pid, timeout)
        finally:
            problem = stop_lane_group(proc, pgid, lane, KILL_GRACE)
        if problem is not None:
            raise ContainmentError(f"lane process group {pgid}: {problem}")
        if timed_out:
            raise subprocess.TimeoutExpired(cmd, timeout)
        returncode = proc.returncode  # reaped by stop_lane_group, after confirmation
        out_f.seek(0)
        err_f.seek(0)
        return (
            returncode,
            out_f.read().decode("utf-8", errors="replace"),
            err_f.read().decode("utf-8", errors="replace"),
        )


def run_cli(platform: str, prompt: str, cwd: Path, review: bool = False,
            task_id: int | None = None, *,
            env_overlay: Mapping[str, str] | None = None,
            lane: LaneUser | None = None,
            contained=None) -> tuple[bool, str, float | None]:
    """Run one headless agent turn. Returns (ok, output_text, cost_usd).

    env_overlay is written into a fresh copy of build_child_env(platform); no
    shared mapping and not os.environ is changed. Its values are redacted from
    this function's own telemetry. With lane, HOME, USER, LOGNAME and SHELL are
    the lane user's passwd values and the CLI runs as that user (#193).
    contained replaces run_contained; only bridge mode passes one (#212).
    """
    runner = run_contained if contained is None else contained
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
        if lane is not None and extra:
            # Never reached from run_task (lane_user refuses all three); kept for direct callers.
            outcome, error_class = "unavailable", "unavailable"
            return False, f"{LANE_USER_UNAVAILABLE}: MC_{platform.split('-')[0].upper()}_ARGS is not supported with a lane user", None
        try:
            # Returns only once the CLI's whole process group is stopped.
            env = child_env.build_child_env(platform)
            if env_overlay:
                if "GIT_CONFIG_COUNT" in env_overlay:
                    # The GitHub overlay replaces every inherited command-scope git config (#190 G11).
                    for name in list(env):
                        if name == "GIT_CONFIG_PARAMETERS":
                            del env[name]
                            continue
                        match = _GIT_CONFIG_SLOT_RE.fullmatch(name)
                        if match is not None and int(match.group(1)) >= 2:
                            del env[name]
                env.update(env_overlay)
            if lane is None:
                returncode, stdout, stderr = runner(cmd, cwd, TASK_TIMEOUT, env=env)
            else:
                env.update(lane.identity())
                returncode, stdout, stderr = runner(cmd, cwd, TASK_TIMEOUT, env=env, lane=lane)
            finished = time.monotonic()
        except LaneUserUnavailable as e:
            outcome, error_class = "unavailable", "unavailable"
            return False, f"{LANE_USER_UNAVAILABLE}: {e}", None
        except subprocess.TimeoutExpired:
            outcome, error_class = "timeout", "timeout"
            return False, f"timed out after {TASK_TIMEOUT}s", None
        except FileNotFoundError:
            outcome, error_class = "unavailable", "unavailable"
            return False, f"{cmd[0]} not found on PATH", None
        except OSError:
            return False, "CLI process could not start", None

        out = stdout + ("\n" + stderr if returncode != 0 and stderr else "")
        parsed = parse_cli_output(platform, stdout)
        if parsed.output_text:
            out = parsed.output_text
            if platform != "claude-code" and returncode != 0 and stderr:
                out += "\n" + stderr
        cost = None
        if platform == "claude-code":
            try:
                payload = json.loads(stdout)
                cost = payload.get("total_cost_usd")
            except (ValueError, AttributeError):
                pass
        ok = returncode == 0 and not parsed.reported_error and parsed.protocol_ok
        outcome = "completed" if ok else "failed"
        error_class = None if ok else ("process_error" if returncode != 0 or parsed.reported_error else "protocol_error")
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
            if env_overlay:
                detail = redact_broker(detail, _overlay_needles(env_overlay))
            ingest("run_complete", "Agent run complete", f"{platform}-{HOSTNAME}", platform, detail, quiet=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Secret broker (#194). The broker mints per-task placeholders; the CLI never
# receives the real key for a granted service. Fail closed: a configured
# broker that cannot be used stops the task before any worker starts.

BROKER_UNAVAILABLE = "secret broker unavailable, no worker started"
BROKER_REDACTED = "[broker-redacted]"
BROKER_TIMEOUT = 5.0
BROKER_MAX_LINE = 65536
_BROKER_ENV_RE = re.compile(r"[A-Z_][A-Z0-9_]*")
_BROKER_PLACEHOLDER_RE = re.compile(r"akp_[A-Za-z0-9_-]+")
_BROKER_BASE_URL_RE = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/([a-z0-9-]{1,40})")
_BROKER_GRANT_KEYS = frozenset(("service", "placeholder", "env_key", "env_base_url", "base_url"))
# GitHub grant (#190 H10).
_GITHUB_GRANT_KEYS = frozenset(("placeholder", "broker_url"))
_GITHUB_PLACEHOLDER_RE = re.compile(r"akp_[A-Za-z0-9_-]{43}")
_BROKER_ORIGIN_RE = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})")
_GIT_CONFIG_SLOT_RE = re.compile(r"GIT_CONFIG_(?:KEY|VALUE)_([0-9]+)")
GITHUB_NO_GRANT = "[github] no grant: remote.origin.url is not a supported GitHub remote"
GITHUB_HELPER = Path(__file__).resolve().parent.parent / "broker" / "git-credential-ak"
_GITHUB_OWNER_RE = re.compile(r"[A-Za-z0-9-]{1,39}")
_GITHUB_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")
_GITHUB_REMOTE_RES = (
    re.compile(r"https://github\.com/([^/]+)/([^/]+)"),
    re.compile(r"git@github\.com:([^/]+)/([^/]+)"),
    re.compile(r"ssh://git@github\.com/([^/]+)/([^/]+)"),
)
# The helper path goes into git config unquoted, so only these characters are accepted.
_SAFE_HELPER_PATH_RE = re.compile(r"/[A-Za-z0-9/._-]+")
_BROKER_ERROR_CODES = frozenset(("malformed_json", "bad_request", "unknown_op", "unknown_service", "internal"))


class BrokerUnavailable(Exception):
    """The broker path is enabled and cannot be used. The message is a fixed code, never a grant."""


def broker_settings(environ: Mapping[str, str] | None = None) -> tuple[str, list[str]] | None:
    """(socket path, services) when MC_BROKER_SOCKET is set, else None. Raises BrokerUnavailable."""
    env = os.environ if environ is None else environ
    path = env.get("MC_BROKER_SOCKET", "").strip()
    if not path:
        return None
    if not os.path.isabs(path):
        raise BrokerUnavailable("MC_BROKER_SOCKET must be an absolute path")
    raw = env.get("MC_BROKER_SERVICES", "")
    if not raw.strip():
        return path, []
    services: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if not name:
            raise BrokerUnavailable("MC_BROKER_SERVICES has an empty entry")
        if name in services:
            raise BrokerUnavailable("MC_BROKER_SERVICES has a duplicate entry")
        services.append(name)
    return path, services


def broker_github_required(environ: Mapping[str, str] | None = None) -> bool:
    """MC_BROKER_GITHUB: unset or exactly "required" (#190 I4). Raises BrokerUnavailable otherwise."""
    env = os.environ if environ is None else environ
    if "MC_BROKER_GITHUB" not in env:
        return False
    if env["MC_BROKER_GITHUB"] != "required":
        raise BrokerUnavailable("MC_BROKER_GITHUB must be unset or exactly required")
    return True


def _broker_exchange(path: str, request: dict, on_connected=None) -> object:
    """One request line, one response line, over a fresh connection."""
    line = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    except OSError:
        raise BrokerUnavailable("unreachable") from None
    try:
        sock.settimeout(BROKER_TIMEOUT)
        try:
            sock.connect(path)
        except socket.timeout:
            raise BrokerUnavailable("timeout") from None
        except OSError:
            raise BrokerUnavailable("unreachable") from None
        if on_connected is not None:
            on_connected()
        deadline = time.monotonic() + BROKER_TIMEOUT
        buf = b""
        try:
            sock.sendall(line)
            while b"\n" not in buf:
                if len(buf) >= BROKER_MAX_LINE:
                    raise BrokerUnavailable("oversized response")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BrokerUnavailable("timeout")
                sock.settimeout(remaining)
                block = sock.recv(65536)
                if not block:
                    raise BrokerUnavailable("connection closed")
                buf += block
        except socket.timeout:
            raise BrokerUnavailable("timeout") from None
        except OSError:
            raise BrokerUnavailable("unreachable") from None
    finally:
        sock.close()
    raw = buf.split(b"\n", 1)[0]
    if len(raw) + 1 > BROKER_MAX_LINE:
        raise BrokerUnavailable("oversized response")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise BrokerUnavailable("malformed response") from None


def _broker_refusal(resp: object, op: str) -> BrokerUnavailable:
    if isinstance(resp, dict) and resp.get("ok") is False and resp.get("error") in _BROKER_ERROR_CODES:
        return BrokerUnavailable(f"{op} refused ({resp['error']})")
    return BrokerUnavailable(f"malformed {op} response")


def _check_grants(resp: object, services: list[str], github_sent: bool = False) -> list[dict]:
    """Every grant present, in order, with every field a non-empty, well-formed string.

    A ``github`` member is allowed only when the request carried ``github_repo``.
    """
    if not isinstance(resp, dict) or resp.get("ok") is not True:
        raise _broker_refusal(resp, "mint")
    if set(resp) != {"ok", "grants"} and not (github_sent and set(resp) == {"ok", "grants", "github"}):
        raise BrokerUnavailable("malformed mint response")
    grants = resp["grants"]
    if not isinstance(grants, list) or len(grants) != len(services):
        raise BrokerUnavailable("malformed grant")
    env_names: set[str] = set()
    placeholders: set[str] = set()
    for grant, service in zip(grants, services):
        if not isinstance(grant, dict) or set(grant) != _BROKER_GRANT_KEYS:
            raise BrokerUnavailable("malformed grant")
        if any(not isinstance(grant[k], str) or grant[k] == "" for k in _BROKER_GRANT_KEYS):
            raise BrokerUnavailable("malformed grant")
        if grant["service"] != service:
            raise BrokerUnavailable("malformed grant")
        if not _BROKER_PLACEHOLDER_RE.fullmatch(grant["placeholder"]) or grant["placeholder"] in placeholders:
            raise BrokerUnavailable("malformed grant")
        placeholders.add(grant["placeholder"])
        match = _BROKER_BASE_URL_RE.fullmatch(grant["base_url"])
        if match is None or match.group(2) != service or int(match.group(1)) > 65535:
            raise BrokerUnavailable("malformed grant")
        for key in ("env_key", "env_base_url"):
            name = grant[key]
            if not _BROKER_ENV_RE.fullmatch(name) or name.startswith("MC_") or name in env_names:
                raise BrokerUnavailable("malformed grant")
            env_names.add(name)
    return grants


def parse_github_remote(url: object) -> str | None:
    """``<owner>/<name>`` as written for a supported GitHub remote, else None (#190 C8)."""
    if not isinstance(url, str) or url == "" or not url.isascii():
        return None
    if any(ch.isspace() or ord(ch) < 33 or ord(ch) == 127 for ch in url) or any(ch in url for ch in "%?#\\"):
        return None
    for pattern in _GITHUB_REMOTE_RES:
        match = pattern.fullmatch(url)
        if match is None:
            continue
        owner, name = match.group(1), match.group(2)
        if name.endswith(".git"):
            name = name[:-4]
        if (
            _GITHUB_OWNER_RE.fullmatch(owner) is None
            or _GITHUB_NAME_RE.fullmatch(name) is None
            or name in (".", "..")
        ):
            return None
        return f"{owner}/{name}"
    return None


def _git_lines(cwd: Path, *args: str) -> tuple[int, list[str]]:
    out = git(cwd, *args)
    raw = out.stdout if isinstance(out.stdout, str) else ""
    text = raw[:-1] if raw.endswith("\n") else raw
    # An empty configured value is one empty line, not "no value".
    return out.returncode, ([] if raw == "" else text.split("\n"))


def github_remote(cwd: Path) -> str | None:
    """The task's GitHub repository from remote.origin.url, or None when unsupported (C8, D3, G6, H4).

    Only remote.origin.url supplies the repository; push URLs are checked, never used.
    """
    try:
        code, urls = _git_lines(cwd, "config", "--no-includes", "--get-all", "remote.origin.url")
        if code != 0 or len(urls) != 1:
            return None
        repo = parse_github_remote(urls[0])
        if repo is None:
            return None
        # A url.*.insteadOf rewrite (or an included definition) shows up as a mismatch.
        code, resolved = _git_lines(cwd, "remote", "get-url", "origin")
        if code != 0 or resolved != urls:
            return None
        code, pushurls = _git_lines(cwd, "config", "--no-includes", "--get-all", "remote.origin.pushurl")
        if code not in (0, 1) or (code == 1 and pushurls):
            return None
        for pushurl in pushurls:
            pushed = parse_github_remote(pushurl)
            if pushed is None or pushed.lower() != repo.lower():
                return None
        code, effective = _git_lines(cwd, "remote", "get-url", "--push", "origin")
        if code != 0 or not effective:
            return None
        for pushurl in effective:
            pushed = parse_github_remote(pushurl)
            if pushed is None or pushed.lower() != repo.lower():
                return None
        return repo
    except (subprocess.SubprocessError, OSError, ValueError):
        return None


def _github_helper_path() -> str:
    """The helper's absolute path, when it can be trusted. Raises BrokerUnavailable (D2, H15).

    The exact path the overlay names must be a regular file (not a symlink),
    mode exactly 0755, owned by this user or root, in a real directory owned by
    this user or root with no group or other write bit.
    """
    path = str(GITHUB_HELPER)
    if not os.path.isabs(path) or _SAFE_HELPER_PATH_RE.fullmatch(path) is None:
        raise BrokerUnavailable("github helper unavailable")
    trusted = (os.geteuid(), 0)
    try:
        info = os.lstat(path)
        parent = os.lstat(os.path.dirname(path))
    except OSError:
        raise BrokerUnavailable("github helper unavailable") from None
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o755
        or info.st_uid not in trusted
        or not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid not in trusted
        or stat.S_IMODE(parent.st_mode) & 0o022
    ):
        raise BrokerUnavailable("github helper unavailable")
    return path


def _check_github_grant(grant: object, placeholders: set[str]) -> dict:
    if not isinstance(grant, dict) or set(grant) != _GITHUB_GRANT_KEYS:
        raise BrokerUnavailable("malformed github grant")
    placeholder, broker_url = grant["placeholder"], grant["broker_url"]
    if not isinstance(placeholder, str) or not _GITHUB_PLACEHOLDER_RE.fullmatch(placeholder) or placeholder in placeholders:
        raise BrokerUnavailable("malformed github grant")
    match = _BROKER_ORIGIN_RE.fullmatch(broker_url) if isinstance(broker_url, str) else None
    if match is None or int(match.group(1)) > 65535:
        raise BrokerUnavailable("malformed github grant")
    return grant


def github_overlay(grant: dict, repo: str, helper: str) -> dict[str, str]:
    """The exact E1 overlay: the broker helper is the only helper git consults for github.com."""
    return {
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": "",
        "GIT_CONFIG_KEY_1": "credential.https://github.com.helper",
        "GIT_CONFIG_VALUE_1": helper,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "",
        "SSH_ASKPASS": "",
        "AK_GITHUB_PLACEHOLDER": grant["placeholder"],
        "AK_BROKER_URL": grant["broker_url"],
        "AK_GITHUB_REPO": repo,
    }


class BrokerSession:
    """One task's grants. revoke() runs once, and only after a mint was sent."""

    def __init__(self, path: str, services: list[str], task_id: str) -> None:
        self.path = path
        self.services = services
        self.task_id = task_id
        self.github_repo: str | None = None  # set from the C8 remote decision (#190)
        self.github_required = False  # MC_BROKER_GITHUB=required (#190 I4)
        self.mint_sent = False
        self.revoked = False
        self.needles: list[str] = []  # base_urls first, then placeholders (C13)

    def health(self) -> None:
        resp = _broker_exchange(self.path, {"op": "health"})
        if resp != {"ok": True} or not isinstance(resp.get("ok"), bool):
            raise _broker_refusal(resp, "health")

    def mint(self) -> dict[str, str]:
        """The overlay {env_key: placeholder, env_base_url: base_url}. Empty when no services are set."""
        if not self.services and self.github_repo is None:
            return {}

        def sent() -> None:
            # Set before the write: a partly written request still gets its revoke (C8).
            self.mint_sent = True

        request: dict = {"op": "mint", "task_id": self.task_id, "services": list(self.services)}
        if self.github_repo is not None:
            request["github_repo"] = self.github_repo
        resp = _broker_exchange(self.path, request, sent)
        grants = _check_grants(resp, self.services, self.github_repo is not None)
        overlay: dict[str, str] = {}
        for grant in grants:
            overlay[grant["env_key"]] = grant["placeholder"]
            overlay[grant["env_base_url"]] = grant["base_url"]
        needles = _overlay_needles_from(grants)
        # No github member: the broker has no github block, the no-grant path (G1),
        # unless this host requires a grant (I4), when it fails closed.
        if self.github_repo is not None and self.github_required and not (isinstance(resp, dict) and "github" in resp):
            raise BrokerUnavailable("github grant missing")
        if isinstance(resp, dict) and "github" in resp and self.github_repo is not None:
            grant = _check_github_grant(resp["github"], {g["placeholder"] for g in grants})
            overlay.update(github_overlay(grant, self.github_repo, _github_helper_path()))
            urls = [v for v in needles if _BROKER_BASE_URL_RE.fullmatch(v)] + [grant["broker_url"]]
            rest = [v for v in needles if not _BROKER_BASE_URL_RE.fullmatch(v)] + [grant["placeholder"]]
            needles = sorted(set(urls), key=len, reverse=True) + sorted(set(rest), key=len, reverse=True)
        self.needles = needles
        return overlay

    def revoke(self) -> str | None:
        """None on success, else a fixed failure code. Never raises."""
        if self.revoked or not self.mint_sent:
            return None
        self.revoked = True
        try:
            resp = _broker_exchange(self.path, {"op": "revoke_task", "task_id": self.task_id})
        except BrokerUnavailable as e:
            return str(e)
        except Exception:
            return "revoke error"
        if resp != {"ok": True} or not isinstance(resp.get("ok"), bool):
            return str(_broker_refusal(resp, "revoke_task"))
        return None


def _overlay_needles_from(grants: list[dict]) -> list[str]:
    urls = [g["base_url"] for g in grants]
    return sorted(set(urls), key=len, reverse=True) + sorted({g["placeholder"] for g in grants}, key=len, reverse=True)


def _overlay_needles(overlay: Mapping[str, str]) -> list[str]:
    # Only grant values are needles: the GitHub overlay's fixed git settings are not secrets (#190).
    values = [v for v in overlay.values() if isinstance(v, str) and v]
    urls = [v for v in values if _BROKER_BASE_URL_RE.fullmatch(v) or _BROKER_ORIGIN_RE.fullmatch(v)]
    rest = [v for v in values if v not in urls and _BROKER_PLACEHOLDER_RE.fullmatch(v)]
    return sorted(set(urls), key=len, reverse=True) + sorted(set(rest), key=len, reverse=True)


def redact_broker(value: object, needles: list[str]) -> object:
    """Replace every needle in every string, recursively. base_urls are listed first (C13)."""
    if not needles:
        return value
    if isinstance(value, str):
        for needle in needles:
            if needle:
                value = value.replace(needle, BROKER_REDACTED)
        return value
    if isinstance(value, dict):
        return {redact_broker(k, needles): redact_broker(v, needles) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_broker(v, needles) for v in value]
    if isinstance(value, tuple):
        return tuple(redact_broker(v, needles) for v in value)
    return value


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


def refuse_unresolved_recovery(git_dir: Path) -> None:
    """Call with the worktree lock held. An interrupted skills launch may still have a live worker here."""
    path = git_dir / SKILL_RECOVERY_NAME
    if os.path.lexists(path):
        raise DispatchRefused(
            f"{path} records an interrupted skills launch; confirm its worker group is gone, "
            "then run `ak_skill_launch.py recover --cwd <worktree>`"
        )


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
    needles: list[str] = []  # filled by a successful mint; everything sent out is redacted with it

    def scrub(value: object) -> object:
        return redact_broker(value, needles)

    def patch_task(body: dict) -> dict:
        return api(f"/api/tasks/{tid}", scrub(body), "PATCH")

    def failed(reason: str) -> None:
        patch_task({"status": "failed", "agent_id": agent_id, "result": reason})

    def note(kind: str, title: str, detail: dict | None = None) -> None:
        ingest(kind, scrub(title), agent_id, platform, scrub(detail))

    try:
        # Invalid v2 and legacy v1 are not worker instructions. Refuse before
        # the lock, the running status, the work-event ingest, and the child.
        refusal = bridge_frame_refusal(task)
        if refusal is not None:
            fail_task(tid, agent_id, refusal)
            return
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
            git_dir = linked_worktree_git_dir(cwd)
            candidate = WorktreeLock(git_dir)
            candidate.acquire(cwd)
            lock = candidate
        except DispatchRefused as e:
            fail_task(tid, agent_id, str(e))
            return
        # Lane user (#193): after the lock, before the recovery check, the broker,
        # pointers, HEAD, the running patch, ingest and any CLI (C7).
        try:
            lane = lane_user()
            if lane is not None:
                lane_preflight(lane, cwd)
        except LaneUserUnavailable as e:
            fail_task(tid, agent_id, f"{LANE_USER_UNAVAILABLE}: {e}")
            return
        except Exception:
            fail_task(tid, agent_id, f"{LANE_USER_UNAVAILABLE}: lane user check error")
            return
        try:
            refuse_unresolved_recovery(git_dir)
        except DispatchRefused as e:
            fail_task(tid, agent_id, str(e))
            return

        # Secret broker: health, then mint, after the lock and before anything else (#194).
        session: BrokerSession | None = None
        try:
            settings = broker_settings()
            if settings is not None:
                session = BrokerSession(settings[0], settings[1], str(tid))
                session.github_required = broker_github_required()
                session.health()
                # The C8 remote decision, before the mint and before any overlay (#190 D7).
                session.github_repo = github_remote(cwd)
        except BrokerUnavailable as e:
            failed(f"{BROKER_UNAVAILABLE}: {e}")
            return
        except Exception:
            failed(f"{BROKER_UNAVAILABLE}: broker client error")
            return
        try:
            overlay: dict[str, str] | None = None
            if session is not None:
                try:
                    overlay = session.mint()
                except BrokerUnavailable as e:
                    failed(f"{BROKER_UNAVAILABLE}: {e}")
                    return
                except Exception:
                    failed(f"{BROKER_UNAVAILABLE}: broker client error")
                    return
                needles[:] = session.needles
            cli_env: dict = {} if overlay is None else {"env_overlay": overlay}
            if lane is not None:
                cli_env["lane"] = lane
            suffix = GITHUB_NO_GRANT if session is not None and session.github_repo is None else ""
            _run_task_body(task, platform, tid, agent_id, project, runtime, cwd, cli_env,
                           patch_task, failed, note, scrub, result_suffix=suffix)
        finally:
            # Runs once whenever a mint was sent, before the lock is released (C8).
            if session is not None:
                code = session.revoke()
                if code:
                    print(scrub(f"[mc] broker revoke_task failed for task #{tid}: {code}"), file=sys.stderr)
    except Exception as e:
        try:
            patch_task({"status": "failed", "result": f"dispatcher error: {e}", "agent_id": agent_id})
        except Exception:
            pass
    finally:
        try:
            if lock is not None:
                lock.release()
        finally:
            sem.release()


def _run_task_body(task: dict, platform: str, tid: object, agent_id: str, project: str, runtime: str,
                   cwd: Path, cli_env: dict, patch_task, failed, note, scrub, *, result_suffix: str = "") -> None:
    """Steps 3-8 of run_task: pointers, running patch, worker, cleanup, reviewer, result patch."""
    try:
        block = fetch_pointers(project, runtime)
    except Exception as e:
        failed(f"skill pointers unavailable, no worker started: {e}")
        return
    # Read before injection: once the block is written, the next statement must be the cleanup try.
    try:
        head = git(cwd, "rev-parse", "--verify", "-q", "HEAD")
    except (subprocess.SubprocessError, OSError) as e:
        failed(f"could not read HEAD, no worker started: {e}")
        return
    base_head = head.stdout.strip() if head.returncode == 0 else None
    try:
        injection = ak_pointers.inject(cwd, block)
    except (ak_pointers.PointerFileError, OSError) as e:
        failed(f"could not write skill pointers, no worker started: {e}")
        return

    cleanup_error: str | None = None
    try:
        patch_task({"status": "running", "agent_id": agent_id})
        note("status", f"Running task #{tid}: {task['title']}", {"task_id": tid})
        ok, output, cost = run_cli(
            platform, build_prompt(task, injection.changed and block != ""), cwd, task_id=tid, **cli_env
        )
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
    # A configured reviewer is required: unknown, missing, failed, or verdict-less fails the task.
    if ok and reviewer:
        cli = CLI_FOR_PLATFORM.get(reviewer) if isinstance(reviewer, str) else None
        if cli is None:
            ok = False
            result = f"{result}\n\n[review] unknown reviewer platform {reviewer!r}, task not approved"
        elif not shutil.which(cli):
            ok = False
            result = f"{result}\n\n[{reviewer} review] {cli} not found on PATH, task not approved"
        else:
            patch_task({"status": "review", "agent_id": agent_id})
            note("status", f"Task #{tid} in review by {reviewer}", {"task_id": tid})
            r_ok, r_out, r_cost = run_cli(
                reviewer, build_review_prompt(task, scrub(output)), cwd, review=True, task_id=tid, **cli_env
            )
            if r_cost:
                cost = (cost or 0) + r_cost
            ok, note_text = review_outcome(r_ok, r_out)
            result = f"{result}\n\n[{reviewer} review] {note_text}"

    result = result or ("completed" if ok else "run failed with no output")
    if result_suffix:
        result = f"{result}\n\n{result_suffix}"
    body = {
        "status": "done" if ok else "failed",
        "result": result,
        "agent_id": agent_id,
    }
    if cost is not None:
        body["cost_usd"] = round(float(cost), 4)
    patch_task(body)


class DispatchWake:
    """Coalesce notifications without losing a wake that arrives during a claim."""
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._reasons: set[str] = set()

    def signal(self, reason: str) -> None:
        with self._condition:
            self._reasons.add(reason)
            self._condition.notify_all()

    def wait(self, timeout: float) -> set[str]:
        with self._condition:
            self._condition.wait_for(lambda: bool(self._reasons), timeout=timeout)
            out = self._reasons or {"fallback"}
            self._reasons = set()
            return out


_DECIMAL_ID = re.compile(r"^[1-9][0-9]{0,18}$")
_BASELINE_ID = re.compile(r"^(?:0|[1-9][0-9]{0,18})$")
_REASON = re.compile(r"^[a-z0-9_]{1,64}$")
NOTICE_CACHE_LIMIT = 256


def _instant(value: object) -> datetime | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _route_name(value: object) -> bool:
    # Platform is always a name. A pinned machine is a name; an unpinned task is JSON null.
    return isinstance(value, str) and 1 <= len(value) <= 200 and all(ord(ch) >= 32 for ch in value)


def _trusted_notice(notice_id: str, payload: object) -> bool:
    if not _DECIMAL_ID.fullmatch(notice_id) or not isinstance(payload, dict):
        return False
    if set(payload) != {"v", "task_id", "queue_receipt_id", "platform", "machine"}:
        return False
    if payload.get("v") != 1:
        return False
    if not _DECIMAL_ID.fullmatch(str(payload.get("task_id") or "")):
        return False
    if not _DECIMAL_ID.fullmatch(str(payload.get("queue_receipt_id") or "")):
        return False
    machine = payload.get("machine")
    # The central producer writes tasks.machine, which is null when the task is not pinned.
    if not _route_name(payload.get("platform")) or not (machine is None or _route_name(machine)):
        return False
    return True


class ObservationEpoch:
    """Bounded accepted task-ready receipts for one dispatcher process.

    Each observation or invalidation opens a new local epoch, even when the
    server repeats a generation. The eviction boundary survives; accepted
    receipts do not. Process restart is a new instance, so continuity starts empty.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._epoch = 0
        self.generation: str | None = None
        self.baseline: str | None = None
        self.valid = False
        self.evicted_through = 0
        self._order: list[tuple[int, str, str]] = []
        self._items: dict[tuple[int, str, str], tuple[str, str]] = {}

    def _open_epoch(self, baseline: str | None, generation: str | None) -> None:
        # Caller holds _lock. Receipts belong to one local epoch; the eviction boundary does not.
        self._epoch += 1
        self.baseline = baseline
        self.generation = generation
        self.valid = baseline is not None and generation is not None
        self._items.clear()
        self._order.clear()

    def replace(self, baseline: str, generation: str) -> None:
        with self._lock:
            self._open_epoch(baseline, generation)

    def invalidate(self) -> None:
        with self._lock:
            self._open_epoch(None, None)

    def proof(self) -> str | None:
        with self._lock:
            if not self.valid or self.generation is None:
                return None
            return self.generation

    def snapshot(self) -> tuple[int, str, str] | None:
        """Epoch identity for one claim. Do not hold the lock across the HTTP call."""
        with self._lock:
            if not self.valid or self.generation is None or self.baseline is None:
                return None
            return (self._epoch, self.generation, self.baseline)

    def _continuous(self, observed: tuple[int, str, str] | None) -> bool:
        if (not self.valid or self.generation is None or self.baseline is None
                or not isinstance(observed, tuple) or len(observed) != 3):
            return False
        token, generation, baseline = observed
        if isinstance(token, bool) or not isinstance(token, int):
            return False
        return token == self._epoch and generation == self.generation and baseline == self.baseline

    def accept(self, generation: str, notice_id: str, task_id: str, episode: str) -> None:
        with self._lock:
            if not self.valid or self.generation != generation:
                return
            key = (self._epoch, generation, notice_id)
            if key in self._items:
                return
            self._items[key] = (task_id, episode)
            self._order.append(key)
            while len(self._order) > NOTICE_CACHE_LIMIT:
                old = self._order.pop(0)
                self._items.pop(old, None)
                number = int(old[2])
                if number > self.evicted_through:
                    self.evicted_through = number

    def classify_claim(self, trigger: str, reasons: set[str], coverage: object, task_id: object, observed: tuple[int, str, str] | None) -> tuple[str, str]:
        with self._lock:
            if trigger != "fallback" or reasons != {"fallback"}:
                return "unknown", "mixed" if len(reasons) > 1 else trigger
            # The response belongs to the epoch captured when the claim was sent.
            if not self._continuous(observed):
                return "unknown", "missing_baseline" if observed is None else "epoch_changed"
            return self._classify_locked(coverage, task_id, max(POLL, 60))

    def _classify_locked(self, coverage: object, task_id: object, interval: int) -> tuple[str, str]:
        if not self.valid or self.baseline is None or self.generation is None:
            return "unknown", "missing_baseline"
        if not isinstance(coverage, dict):
            return "unknown", "invalid_proof"
        evidence = coverage.get("evidence")
        if evidence != "notified":
            reason = coverage.get("reason")
            if not isinstance(reason, str) or not _REASON.fullmatch(reason):
                reason = "invalid_proof"
            return "unknown", reason
        notice_id = coverage.get("notice_id")
        episode = coverage.get("queue_episode")
        if not isinstance(notice_id, str) or not _DECIMAL_ID.fullmatch(notice_id):
            return "unknown", "invalid_proof"
        if not isinstance(episode, str) or not _DECIMAL_ID.fullmatch(episode):
            return "unknown", "invalid_proof"
        if isinstance(task_id, bool) or not isinstance(task_id, (int, str)) or not _DECIMAL_ID.fullmatch(str(task_id)):
            return "unknown", "invalid_proof"
        found = self._items.get((self._epoch, self.generation, notice_id))
        if found is not None:
            if found == (str(task_id), episode):
                return "received", "exact_notice"
            return "unknown", "invalid_proof"
        if int(notice_id) <= self.evicted_through:
            return "unknown", "evicted"
        if int(notice_id) <= int(self.baseline):
            return "unknown", "before_baseline"
        elapsed = _elapsed_seconds(coverage.get("notice_at"), coverage.get("measured_at"))
        if elapsed is None or elapsed < interval:
            return "unknown", "insufficient_opportunity"
        return "fallback_before_notice", "notice_absent_at_claim"


def _elapsed_seconds(notice_at: object, measured_at: object) -> float | None:
    start = _instant(notice_at)
    end = _instant(measured_at)
    if start is None or end is None:
        return None
    return (end - start).total_seconds()


def configured_task_project() -> str | None:
    """Exact lane for every claim. Unset means unfiltered. Blank or invalid refuses, and the value is not logged."""
    if "MC_TASK_PROJECT" not in os.environ:
        return None
    value = os.environ["MC_TASK_PROJECT"]
    if not isinstance(value, str) or LANE_RE.fullmatch(value) is None:
        raise ValueError(
            "MC_TASK_PROJECT must be an exact task lane: 1-100 characters of letters, digits, and . _ : / -"
        )
    return value


def task_claim_request(platform: str, stream: EventStreamWake | None, *, project: str | None = None,
                       task_id: int | None = None) -> tuple[dict, dict | None, tuple[int, str, str] | None]:
    """The claim body. With task_id (bridge mode, #212 D22) the exact claim; else the existing body.

    The bridge form names the handoff's project and exact task_id, never reads
    MC_TASK_PROJECT, and carries no event coverage. The two-argument form is unchanged.
    """
    body = {"platform": platform, "machine": HOSTNAME, "agent_id": f"{platform}-{HOSTNAME}"}
    if task_id is not None or project is not None:
        if type(task_id) is not int or not 1 <= task_id <= stopctl.MAX_TASK_ID:
            raise ValueError("bridge claim requires a positive safe-integer task_id")
        if not isinstance(project, str) or LANE_RE.fullmatch(project) is None:
            raise ValueError("bridge claim requires the handoff's exact project")
        return {**body, "project": project, "task_id": task_id}, None, None
    project = configured_task_project()
    if project is not None:
        body["project"] = project
    observed = stream.notices.snapshot() if stream is not None else None
    if observed is None:
        return body, None, None
    return {**body, "coverage": True}, {
        "X-AK-Event-Authorization": f"Bearer {stream.token}",
        "X-AK-Event-Consumer": stream.consumer,
        "X-AK-Event-Generation": observed[1],
    }, observed


def coverage_for_disconnected(trigger: str, reasons: set[str]) -> tuple[str, str]:
    if trigger != "fallback" or reasons != {"fallback"}:
        return "unknown", "mixed" if len(reasons) > 1 else trigger
    return "unknown", "missing_baseline"


class NoEventRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a consumer credential to a redirect destination.
        return None


class EventStreamWake:
    """Opt-in notification only. Actual work still uses the atomic claim API."""
    MAX_FRAME = 1_048_576

    def __init__(self, base: str, consumer: str, token: str, wake: DispatchWake) -> None:
        url = urllib.parse.urlsplit(base)
        if (url.scheme not in ("https", "http") or not url.hostname or url.username or url.password
                or url.query or url.fragment or url.path not in ("", "/")
                or (url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"))):
            raise ValueError("event stream requires an HTTPS origin (HTTP is loopback-only)")
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", consumer) or not re.fullmatch(r"akc_[A-Za-z0-9_-]+", token):
            raise ValueError("set an explicit consumer and scoped akc_ event credential")
        self.url = base.rstrip("/") + "/api/events/stream?" + urllib.parse.urlencode({"consumer": consumer})
        self.consumer, self.token, self.wake = consumer, token, wake
        self.cursor: str | None = None
        self.connected = False
        self.notices = ObservationEpoch()
        self._had_progress = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ak-event-wake")
        self._opener = urllib.request.build_opener(NoEventRedirect())

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        # The daemon socket read is independently bounded by its read timeout.
        # Never block shutdown waiting for an unresponsive upstream.
        self._thread.join(timeout=1)

    def _observation(self, data: list[str]) -> None:
        value = None
        try:
            parsed = json.loads("\n".join(data))
            if isinstance(parsed, dict):
                value = parsed
        except Exception:
            value = None
        baseline = value.get("baseline") if isinstance(value, dict) else None
        generation = value.get("generation") if isinstance(value, dict) else None
        if (not isinstance(value, dict) or set(value) != {"baseline", "generation"}
                or not isinstance(baseline, str) or not _BASELINE_ID.fullmatch(baseline)
                or not isinstance(generation, str) or not _BASELINE_ID.fullmatch(generation)):
            self.notices.invalidate()
            return
        self.notices.replace(baseline, generation)

    def _frame(self, event: str, cursor: str | None, data: list[str]) -> bool:
        # Observation is a control frame. It must not advance the cursor or wake a claim.
        if event == "observation":
            self._observation(data)
            return True
        if event == "superseded":
            self.notices.invalidate()
            self.connected = False
            self._stop.set()  # do not compete with the replacement connection
            self.wake.signal("reconcile")
            return False
        if event in ("cursor_expired", "stream_error"):
            self.notices.invalidate()
            if event == "cursor_expired":
                self.cursor = None
            self.wake.signal("reconcile")
            return False
        if event != "github" or not data:
            return True
        value = json.loads("\n".join(data))
        if (not isinstance(value, dict) or not isinstance(value.get("payload"), dict)
                or not isinstance(value.get("event"), str) or not isinstance(cursor, str)
                or value.get("id") != cursor or not cursor.startswith(self.consumer + ":")):
            raise ValueError("invalid event envelope")
        position = cursor[len(self.consumer) + 1:]
        if not re.fullmatch(r"[1-9][0-9]{0,18}", position) or int(position) > 9223372036854775807:
            raise ValueError("invalid event cursor")
        if value.get("event") == "task-ready" and not _trusted_notice(position, value.get("payload")):
            # A task-ready frame that is not the exact notice ends the epoch.
            # The cursor still advances so the stream does not stall on it.
            self.notices.invalidate()
        elif value.get("event") == "task-ready":
            payload = value["payload"]
            self.notices.accept(self.notices.generation or "", position, str(payload["task_id"]), str(payload["queue_receipt_id"]))
        # Advance only after a complete, valid envelope. Replays are harmless:
        # wakeups carry no execution authority and the claim API is atomic.
        self.cursor = cursor
        self._had_progress = True
        self.wake.signal("event")
        return True

    def _consume(self, response) -> None:
        event, cursor, data, size = "message", None, [], 0
        while not self._stop.is_set():
            raw = response.readline(self.MAX_FRAME + 1)
            if not raw:
                return
            size += len(raw)
            if len(raw) > self.MAX_FRAME or size > self.MAX_FRAME:
                raise ValueError("event frame exceeds limit")
            line = raw.decode("utf-8").rstrip("\r\n")
            if not line:
                if not self._frame(event, cursor, data):
                    return
                event, cursor, data, size = "message", None, [], 0
            elif line.startswith(":"):
                self._had_progress = True
                continue
            else:
                field, sep, value = line.partition(":")
                if sep and value.startswith(" "):
                    value = value[1:]
                if field == "event":
                    event = value
                elif field == "id":
                    cursor = value
                elif field == "data":
                    data.append(value)

    def _run(self) -> None:
        backoff = 0.25
        while not self._stop.is_set():
            retry_after = 0.0
            self._had_progress = False
            headers = {"Authorization": f"Bearer {self.token}", "Accept": "text/event-stream"}
            if self.cursor:
                headers["Last-Event-ID"] = self.cursor
            req = urllib.request.Request(self.url, headers=headers)
            try:
                with self._opener.open(req, timeout=40) as response:
                    if response.status != 200 or response.headers.get_content_type() != "text/event-stream":
                        raise ValueError("not an event stream")
                    self.connected = True
                    self._consume(response)
            except Exception as error:
                if isinstance(error, urllib.error.HTTPError) and error.code == 403 and self.cursor:
                    # Registered filters may no longer include the saved cursor.
                    self.cursor = None
                    self.wake.signal("reconcile")
                if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                    raw_retry = error.headers.get("Retry-After", "")
                    if raw_retry.isascii() and raw_retry.isdigit():
                        retry_after = min(86400, int(raw_retry))
                # Do not print headers, credentials, response bodies or payloads.
                print(f"[mc] event stream unavailable ({type(error).__name__}); polling remains active", file=sys.stderr)
            finally:
                was_connected = self.connected
                self.connected = False
                self.notices.invalidate()
                if was_connected:
                    self.wake.signal("reconcile")
            if self._had_progress:
                backoff = 0.25
            if self._stop.wait(max(backoff, retry_after)):
                break
            backoff = min(30.0, backoff * 2)


# ---------------------------------------------------------------------------
# Bridge mode (#212). Off unless MC_BRIDGE_ENABLED is exactly "1"; then main()
# calls bridge_main() and nothing above this section's claim loop runs.
#
# One host, one ledger, one claim window: an `acknowledged` row in the bridge
# ledger's handoff.json names a task id, and the dispatcher claims exactly that
# id on that row's lane. Every stop, launch and cleanup decision goes through
# ak_stop_control.StopController with the concrete ports below. The only code
# in bridge mode that sends a signal is BridgeSignalPort.signal_group. Every
# ambiguous state halts: no child, no done, no requeue, a durable record in
# <ledger_dir>/dispatcher-stop.json and one bounded stderr line with the code.

BRIDGE_CODES = (
    "invalid_config", "invalid_concurrency", "ledger_unreadable", "stop_journal_present",
    "missing_task_id", "conflicting_candidate", "duplicate_candidate", "claim_mismatch",
    "exact_claim_miss", "claim_unknown", "journal_write_failed", "identity_unverifiable",
    "stop_requested",
)
BRIDGE_PLATFORMS = ("claude-code", "codex", "grok")
BRIDGE_JOURNAL = "dispatcher-stop.json"
BRIDGE_LOCK = "dispatcher.lock"  # one bridge dispatcher per ledger, held for the process lifetime
BRIDGE_DONE = "dispatcher-done.json"  # tasks this dispatcher finished; their rows are not candidates (I1)
BRIDGE_DONE_MAX_BYTES = 16 * 1024 * 1024
BRIDGE_CONFIG_MAX_BYTES = 1_048_576
BRIDGE_NET_BUDGET = 30.0  # one deadline for each bridge network call, whatever the socket does
BRIDGE_WAIT_SLICE = 0.2  # how often a running child's wait wakes to look at stop and timeout
BRIDGE_STOP_BUDGET = 3 * KILL_GRACE
_BRIDGE_ROLE_PHASE = {"worker": "worker", "reviewer": "review"}
_BRIDGE_NODE_RE = re.compile(r"[A-Za-z0-9_]{1,200}")
_BRIDGE_PHASE_RE = re.compile(r"[a-z_]{1,40}")
# H5: internal StopController outcomes -> public codes. Anything else is identity_unverifiable.
_BRIDGE_STOP_OUTCOMES = frozenset((
    "stop_before_claim", "stopped_after_claim", "launch_after_stop", "ack_after_stop",
    "stopped_group_absent", "stopped_after_exit", "stopped_before_launch",
))
_BRIDGE_CLAIM_OUTCOMES = frozenset(("claim_unresolved", "claim_unknown"))
_BRIDGE_JOURNAL_OUTCOMES = frozenset(("journal_failed", "journal_clear_failed", "cleanup_unconfirmed"))

# The gate (H1): a direct child that holds the payload until the controller has
# registered it and confirmed the ack. It reads one release message from an
# inherited pipe: b"1" plus the child environment as JSON. EOF or anything else
# exits 125 without exec. exec keeps the pid, so the registered identity is the
# process-group leader, which becomes the CLI, or the sudo wrapper with a lane user.
_BRIDGE_GATE = r"""
import json, os, sys
fd = int(sys.argv[1])
chunks = []
while True:
    try:
        block = os.read(fd, 65536)
    except OSError:
        os._exit(125)
    if not block:
        break
    chunks.append(block)
os.close(fd)
raw = b"".join(chunks)
if raw[:1] != b"1":
    os._exit(125)
try:
    env = json.loads(raw[1:].decode("utf-8"))
    os.execvpe(sys.argv[2], sys.argv[2:], env)
except Exception:
    sys.stderr.write("agent CLI could not start\n")
    os._exit(127)
"""


class BridgeHalt(Exception):
    """An operator-visible halt. code is one of BRIDGE_CODES; nothing else is logged or stored."""

    def __init__(self, code: str, phase: str, *, task_id: object = None, rows: tuple = ()) -> None:
        if code not in BRIDGE_CODES:
            code = "identity_unverifiable"
        super().__init__(code)
        self.code = code
        self.phase = phase if isinstance(phase, str) and _BRIDGE_PHASE_RE.fullmatch(phase) else "unknown"
        self.task_id = task_id if type(task_id) is int and 1 <= task_id <= stopctl.MAX_TASK_ID else None
        self.rows = tuple(r for r in rows if isinstance(r, str) and _BRIDGE_NODE_RE.fullmatch(r))[:8]


def bridge_public_code(internal: object) -> str:
    """Map a StopController decision code to the public code (H5)."""
    if internal in _BRIDGE_STOP_OUTCOMES:
        return "stop_requested"
    if internal in _BRIDGE_CLAIM_OUTCOMES:
        return "claim_unknown"
    if internal in _BRIDGE_JOURNAL_OUTCOMES:
        return "journal_write_failed"
    return "identity_unverifiable"


def bridge_halt_record(halt: BridgeHalt) -> dict:
    return {"code": halt.code, "phase": halt.phase, "machine": HOSTNAME,
            "task_id": halt.task_id, "rows": list(halt.rows)}


def bridge_halt_line(halt: BridgeHalt) -> str:
    """The redacted stderr line: fixed words, a public code, and validated identifiers only."""
    line = f"[mc] bridge halt code={halt.code} phase={halt.phase} machine={HOSTNAME}"
    if halt.task_id is not None:
        line += f" task_id={halt.task_id}"
    if halt.rows:
        line += " rows=" + ",".join(halt.rows)
    return line


def bridge_check_concurrency(environ: Mapping[str, str]) -> None:
    """Bridge mode needs an effective MC_MAX_CONCURRENT of exactly 1. Unset is the default 2 (D1, H12)."""
    raw = environ.get("MC_MAX_CONCURRENT", "2")
    if re.fullmatch(r"[0-9]{1,6}", raw) is None or int(raw) != 1:
        raise BridgeHalt("invalid_concurrency", "startup")


def bridge_check_platforms(platforms: list[str]) -> None:
    if not platforms or any(p not in BRIDGE_PLATFORMS for p in platforms):
        raise BridgeHalt("invalid_config", "startup")


def bridge_check_self() -> None:
    """#211 refuses a controller whose own pid or group is 1 or below (a container's init group)."""
    try:
        stopctl.SelfIdentity(pid=os.getpid(), pgid=os.getpgrp())
    except ValueError:
        raise BridgeHalt("invalid_config", "startup") from None


def bridge_read_config(environ: Mapping[str, str]) -> tuple[dict, int]:
    """(validated config, ledger dir fd). Raises BridgeHalt(invalid_config) before any ledger exists (D12).

    The ledger directory is opened once, without following a final symlink, and
    must be a directory this user owns with no group or other access. Every
    journal file is then reached through that descriptor, never by path again.
    """
    path = environ.get("MC_BRIDGE_CONFIG", "")
    if not path or "\0" in path or not os.path.isabs(path):
        raise BridgeHalt("invalid_config", "startup")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise BridgeHalt("invalid_config", "startup") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > BRIDGE_CONFIG_MAX_BYTES:
            raise BridgeHalt("invalid_config", "startup")
        raw = os.read(fd, BRIDGE_CONFIG_MAX_BYTES + 1)
    except OSError:
        raise BridgeHalt("invalid_config", "startup") from None
    finally:
        os.close(fd)
    if len(raw) > BRIDGE_CONFIG_MAX_BYTES:
        raise BridgeHalt("invalid_config", "startup")
    try:
        config = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError, RecursionError):
        raise BridgeHalt("invalid_config", "startup") from None
    parsed = drb.parse_bridge_config(config)
    if isinstance(parsed, str):
        raise BridgeHalt("invalid_config", "startup")
    try:
        dir_fd = os.open(str(parsed["ledger_dir"]),
                         os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise BridgeHalt("invalid_config", "startup") from None
    try:
        info = os.fstat(dir_fd)
    except OSError:
        os.close(dir_fd)
        raise BridgeHalt("invalid_config", "startup") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(dir_fd)
        raise BridgeHalt("invalid_config", "startup")
    return parsed, dir_fd


def bridge_lock_ledger(dir_fd: int) -> int:
    """An exclusive, non-blocking flock on <ledger_dir>/dispatcher.lock. Raises invalid_config if held.

    Taken before the journal is even looked at and held until exit, so a second
    bridge dispatcher on the same ledger touches nothing.
    """
    try:
        fd = os.open(BRIDGE_LOCK, os.O_RDWR | os.O_CREAT | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0), 0o600,
                     dir_fd=dir_fd)
    except OSError:
        raise BridgeHalt("invalid_config", "startup") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("not a regular file")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise BridgeHalt("invalid_config", "startup") from None
    return fd


def bridge_validate_lanes(parsed: dict, workdir: Path) -> None:
    """D4 and D5, once a validated ledger exists: concrete platforms, and the same workdir."""
    for repo in parsed["repos"]:
        if repo["platform"] not in BRIDGE_PLATFORMS:
            raise BridgeHalt("invalid_config", "startup")
    try:
        same = os.path.realpath(str(parsed["workdir"])) == os.path.realpath(str(workdir))
    except (OSError, ValueError):
        same = False
    if not same:
        raise BridgeHalt("invalid_config", "startup")


class BridgeJournal:
    """The durable stop-control journal port, <ledger_dir>/dispatcher-stop.json (C7).

    persist() writes a temp file, fsyncs it, renames it over the journal and
    fsyncs the directory, or raises. clear() unlinks it or raises with the
    record intact. Every operation goes through the ledger directory fd.
    The file holds the controller's last record and, after a halt, the halt.
    """

    def __init__(self, dir_fd: int) -> None:
        self.dir_fd = dir_fd
        self.controller: dict | None = None
        self.halt: dict | None = None
        self.writes = 0

    def exists(self) -> bool:
        try:
            os.stat(BRIDGE_JOURNAL, dir_fd=self.dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            return False
        except OSError:
            return True  # cannot tell: treat it as present, which refuses to claim
        return True

    def persist(self, record: dict) -> None:
        self.controller = dict(record)
        self._write()

    def record_halt(self, halt: BridgeHalt) -> None:
        self.halt = bridge_halt_record(halt)
        self._write()

    def clear(self) -> None:
        os.unlink(BRIDGE_JOURNAL, dir_fd=self.dir_fd)
        try:
            os.fsync(self.dir_fd)
        except OSError:
            pass  # the record is gone; a replay after a crash only refuses the next start
        self.controller = None
        self.halt = None

    def _write(self) -> None:
        payload = {"version": 1, "unit": "ak-dispatcher-bridge", "machine": HOSTNAME,
                   "controller": self.controller, "halt": self.halt}
        raw = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
        tmp = BRIDGE_JOURNAL + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600,
                     dir_fd=self.dir_fd)
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(raw)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("incomplete journal write")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, BRIDGE_JOURNAL, src_dir_fd=self.dir_fd, dst_dir_fd=self.dir_fd)
        os.fsync(self.dir_fd)
        self.writes += 1


class BridgeDoneRecord:
    """<ledger_dir>/dispatcher-done.json: the task ids this dispatcher completed (#212 I1).

    {"version": 1, "done": [{"task_id": int, "issue": str, "completed_at": str}, ...]}.
    A missing file is an empty record. A file that cannot be read or parsed is
    never treated as empty: load() raises BridgeHalt(invalid_config). append()
    writes the whole record atomically (temp file, fsync, rename, directory
    fsync) through the ledger directory fd, or raises.
    """

    def __init__(self, dir_fd: int) -> None:
        self.dir_fd = dir_fd

    def load(self) -> list[dict]:
        try:
            fd = os.open(BRIDGE_DONE, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0),
                         dir_fd=self.dir_fd)
        except FileNotFoundError:
            return []
        except OSError:
            raise BridgeHalt("invalid_config", "select") from None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > BRIDGE_DONE_MAX_BYTES:
                raise BridgeHalt("invalid_config", "select")
            raw = os.read(fd, BRIDGE_DONE_MAX_BYTES + 1)
        except OSError:
            raise BridgeHalt("invalid_config", "select") from None
        finally:
            os.close(fd)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError, RecursionError):
            raise BridgeHalt("invalid_config", "select") from None
        if not isinstance(data, dict) or set(data) != {"version", "done"} or data["version"] != 1 \
                or not isinstance(data["done"], list):
            raise BridgeHalt("invalid_config", "select")
        for item in data["done"]:
            if (not isinstance(item, dict) or set(item) != {"task_id", "issue", "completed_at"}
                    or type(item["task_id"]) is not int or not 1 <= item["task_id"] <= stopctl.MAX_TASK_ID
                    or not isinstance(item["issue"], str) or not isinstance(item["completed_at"], str)):
                raise BridgeHalt("invalid_config", "select")
        return data["done"]

    def task_ids(self) -> set[int]:
        return {item["task_id"] for item in self.load()}

    def append(self, task_id: int, issue: str) -> None:
        done = self.load()
        done.append({"task_id": task_id, "issue": issue,
                     "completed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
        self._write({"version": 1, "done": done})

    def _write(self, payload: dict) -> None:
        raw = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
        tmp = BRIDGE_DONE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600,
                     dir_fd=self.dir_fd)
        try:
            os.fchmod(fd, 0o600)
            _write_fd_all(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, BRIDGE_DONE, src_dir_fd=self.dir_fd, dst_dir_fd=self.dir_fd)
        os.fsync(self.dir_fd)


class BridgeTableIncomplete(OSError):
    """A process vanished while the table was read: the listing cannot prove a group empty."""


def bridge_process_table() -> dict[int, tuple[int, int, bool]]:
    """{pid: (ppid, pgid, zombie)} for every process. Raises when it cannot be read whole.

    On Linux a /proc entry that vanishes between the directory listing and its
    stat read raises BridgeTableIncomplete: its group is unknown.
    """
    table: dict[int, tuple[int, int, bool]] = {}
    proc_root = Path("/proc")
    if (proc_root / "self" / "stat").exists():
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat", "rb") as f:
                    raw = f.read().decode("ascii", "replace")
            except (FileNotFoundError, ProcessLookupError):
                raise BridgeTableIncomplete("a process exited while the table was read") from None
            fields = raw[raw.rindex(")") + 2:].split()
            table[int(entry)] = (int(fields[1]), int(fields[2]), fields[0] in ("Z", "X"))
        return table
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat="], stdin=subprocess.DEVNULL,
                         capture_output=True, text=True, timeout=KILL_GRACE,
                         env={"PATH": "/bin:/usr/bin"})
    if out.returncode != 0:
        raise OSError("process table unavailable")
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            raise OSError("unexpected process table line")
        table[int(parts[0])] = (int(parts[1]), int(parts[2]), parts[3].startswith("Z"))
    return table


class _BridgeChild:
    def __init__(self, proc: subprocess.Popen, birth: str, role: str, lane: LaneUser | None) -> None:
        self.proc = proc
        self.birth = birth
        self.role = role
        self.phase = _BRIDGE_ROLE_PHASE[role]
        self.lane = lane


class BridgeChildren:
    """Direct children this dispatcher created and has not reaped. Shared by the observer and the port.

    A child stays here, unreaped, until the controller has confirmed its group
    gone. Its zombie pins the pid, so the pid and group id cannot be reused
    while the observer and the port look at them (#193).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[int, _BridgeChild] = {}

    def add(self, proc: subprocess.Popen, role: str, lane: LaneUser | None) -> str:
        birth = f"{proc.pid}:{time.monotonic_ns()}:{os.urandom(8).hex()}"
        with self._lock:
            self._items[proc.pid] = _BridgeChild(proc, birth, role, lane)
        return birth

    def get(self, pid: object) -> _BridgeChild | None:
        with self._lock:
            return self._items.get(pid) if type(pid) is int else None

    def reap(self, proc: subprocess.Popen) -> bool:
        """Reap a child whose group the controller confirmed gone. False if it has not exited."""
        try:
            proc.wait(timeout=KILL_GRACE)
        except subprocess.TimeoutExpired:
            return False
        with self._lock:
            self._items.pop(proc.pid, None)
        return True


class BridgeObserver:
    """The process observer port. It speaks only about registered, unreaped children.

    The registered identity is the process group its unreaped leader pins.
    present: the leader is our unreaped child with our pid as parent and its own
    pid as group, and the group still has a live (non-zombie) member. absent:
    the leader has exited (a zombie we have not reaped) and no live member is
    left, reported with group_status "empty". A child we did not register, one
    already reaped, or a process table that cannot be read is unverifiable.
    """

    def __init__(self, children: BridgeChildren, table=bridge_process_table) -> None:
        self.children = children
        self.table = table

    def observe(self, identity: stopctl.OwnedIdentity) -> stopctl.Observation:
        child = self.children.get(identity.pid)
        if child is None or child.proc.returncode is not None:
            return stopctl.Observation("unverifiable")
        rows = self._listing()
        leader = rows.get(identity.pid)
        if leader is None:
            return stopctl.Observation("unverifiable")
        ppid, pgid, zombie = leader
        live = self._live(rows, identity, zombie)
        if zombie and not live:
            # One listing can miss a member forked during the read. Empty needs a
            # second complete listing that agrees, with the leader still unreaped.
            again = self._listing()
            second = again.get(identity.pid)
            if (second is None or not second[2] or self._live(again, identity, True)
                    or child.proc.returncode is not None):
                return stopctl.Observation("unverifiable")
            # An unreaped zombie cannot change parent or group: echo what it was born with.
            return stopctl.Observation("absent", pid=identity.pid, pgid=identity.pgid, role=child.role,
                                       phase=child.phase, birth=child.birth, ancestry=(os.getpid(),),
                                       group_status="empty")
        return stopctl.Observation("present", pid=identity.pid, pgid=pgid, role=child.role, phase=child.phase,
                                   birth=child.birth, ancestry=(ppid,), group_status="occupied")

    def _listing(self) -> dict[int, tuple[int, int, bool]]:
        """A complete table. Retries a few times while processes elsewhere churn; then raises."""
        for _attempt in range(5):
            try:
                return self.table()
            except BridgeTableIncomplete:
                continue
        raise BridgeTableIncomplete("process table kept changing")

    @staticmethod
    def _live(rows: dict, identity: stopctl.OwnedIdentity, leader_zombie: bool) -> bool:
        return any(pg == identity.pgid and not z for pid, (_pp, pg, z) in rows.items()
                   if not (pid == identity.pid and leader_zombie))


class BridgeSignalPort:
    """The only code in bridge mode that sends a signal (C6). Called by StopController only.

    It signals a group only when that group's leader is a registered, unreaped
    direct child whose pid is its group id, never pid 1 or below and never this
    process's own group (#211 identity contract). With a lane user the group is
    signalled through the #193 path, `sudo -n -u <lane> /bin/kill`, and the
    dispatcher-owned sudo wrapper is signalled directly. Returns exactly
    delivered, absent, or uncertain.
    """

    _SIGNALS = {stopctl.SIGTERM: (signal.SIGTERM, "-TERM"), stopctl.SIGKILL: (signal.SIGKILL, "-KILL")}

    def __init__(self, children: BridgeChildren, table=bridge_process_table) -> None:
        self.children = children
        self.table = table
        self.sent: list[tuple[int, int, bool]] = []  # (pgid, sig, through lane)

    def _group_live(self, pgid: int) -> bool | None:
        for _attempt in range(5):
            try:
                rows = self.table()
            except BridgeTableIncomplete:
                continue
            except Exception:
                return None
            return any(pg == pgid and not z for _pp, pg, z in rows.values())
        return None

    def signal_group(self, pgid: int, sig: int) -> str:
        if type(pgid) is not int or pgid <= 1 or pgid == os.getpgrp() or pgid == os.getpid():
            return "uncertain"
        mapped = self._SIGNALS.get(sig)
        child = self.children.get(pgid)
        if mapped is None or child is None or child.proc.pid != pgid or child.proc.returncode is not None:
            return "uncertain"
        os_sig, kill_arg = mapped
        lane_code = None
        if child.lane is not None:
            self.sent.append((pgid, sig, True))
            lane_code = _lane_op(child.lane, LANE_KILL, kill_arg, "--", f"-{pgid}")
        self.sent.append((pgid, sig, False))
        try:
            os.killpg(pgid, os_sig)
            own = "delivered"
        except ProcessLookupError:
            own = "absent"
        except OSError:
            # macOS refuses to signal a group whose only member is a zombie: look before guessing.
            live = self._group_live(pgid)
            own = "absent" if live is False else "uncertain"
        if own == "delivered" or lane_code == 0:
            return "delivered"
        if own == "absent" and (child.lane is None or lane_code is not None):
            return "absent"
        return "uncertain"


def bridge_bounded(fn, budget: float = BRIDGE_NET_BUDGET):
    """fn() with one overall deadline. A call that does not return in time raises TimeoutError.

    The call keeps running on a daemon thread; its late result is discarded.
    """
    box: dict = {}

    def run() -> None:
        try:
            box["value"] = fn()
        except BaseException as e:  # carried to the caller
            box["error"] = e

    worker = threading.Thread(target=run, daemon=True, name="ak-bridge-net")
    worker.start()
    worker.join(budget)
    if worker.is_alive():
        raise TimeoutError("bridge network deadline")
    if "error" in box:
        raise box["error"]
    return box.get("value")


class BridgeRunner:
    """A controller-aware run_contained for one phase (D7, H1, H2).

    begin_launch -> gated spawn -> register -> confirm_ack -> work event ->
    release -> wait (waking on stop, timeout, exception) -> confirm_phase_exit,
    or request_stop on stop, timeout, exception or members left in the group.
    The leader is reaped only after the controller confirmed its group gone.
    No path here sends a signal; StopController does, through BridgeSignalPort.
    """

    def __init__(self, bridge: BridgeDispatcher, ctl: stopctl.StopController, role: str, on_ack) -> None:
        self.bridge = bridge
        self.ctl = ctl
        self.role = role
        self.on_ack = on_ack
        self.phase_confirmed = False
        self.forced = False  # members outlived the leader and were stopped through the controller

    def __call__(self, cmd: list[str], cwd: Path, timeout: float, *, env: dict[str, str],
                 lane: LaneUser | None = None) -> tuple[int, str, str]:
        role, ctl, bridge = self.role, self.ctl, self.bridge
        # Before begin_launch: a failure here starts no child (D10).
        try:
            if not _can_wait_unreaped():
                raise LaneUserUnavailable("this platform cannot wait for a child without reaping it")
            if lane is not None:
                argv = lane_argv(lane, cmd, env)
            else:
                if shutil.which(cmd[0], path=env.get("PATH", os.defpath)) is None:
                    raise FileNotFoundError(cmd[0])
                argv = list(cmd)
            release = b"1" + json.dumps(env).encode("utf-8")
        except (LaneUserUnavailable, FileNotFoundError, ValueError, TypeError):
            raise BridgeHalt("invalid_config", f"{role}_launch") from None
        decision = ctl.begin_launch(role)
        if not decision.allowed:
            raise BridgeHalt(bridge_public_code(decision.code), f"{role}_launch")
        read_fd, write_fd = os.pipe()
        with tempfile.TemporaryFile() as out_f, tempfile.TemporaryFile() as err_f:
            try:
                proc = subprocess.Popen(
                    [sys.executable, "-I", "-c", _BRIDGE_GATE, str(read_fd), *argv],
                    cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=out_f, stderr=err_f,
                    start_new_session=True, env={"PATH": "/usr/bin:/bin"}, pass_fds=(read_fd,),
                )
            except OSError:
                os.close(read_fd)
                os.close(write_fd)
                # The open ticket is the only record that a child may exist: the
                # controller closes it and keeps recovery.
                ctl.request_stop()
                raise BridgeHalt("identity_unverifiable", f"{role}_launch") from None
            os.close(read_fd)
            birth = bridge.children.add(proc, role, lane)
            identity = stopctl.OwnedIdentity(pid=proc.pid, pgid=proc.pid, role=role,
                                             phase=_BRIDGE_ROLE_PHASE[role], birth=birth,
                                             ancestry=(os.getpid(),))
            bridge.boundary(f"{role}_spawned")
            decision = ctl.register(identity)
            if not decision.allowed:
                self._abandon(proc, write_fd, identity, registered=bool(decision.registered_pgids))
                raise BridgeHalt(bridge_public_code(decision.code), f"{role}_register", task_id=bridge.task_id)
            bridge.boundary(f"{role}_registered")
            decision = ctl.confirm_ack()
            if not decision.allowed:
                self._abandon(proc, write_fd, identity, registered=True)
                raise BridgeHalt(bridge_public_code(decision.code), f"{role}_ack", task_id=bridge.task_id)
            try:
                self.on_ack()  # the authenticated work event, before the payload runs (C8)
            except Exception:
                # No recorded work event: the payload must not run. EOF retires the gate unexecuted.
                self._abandon(proc, write_fd, identity, registered=True)
                raise BridgeHalt("claim_unknown", f"{role}_event", task_id=bridge.task_id) from None
            bridge.boundary(f"{role}_acked")
            if bridge.stop_requested():
                # Stop arrived during the work event: never release the payload.
                self._abandon(proc, write_fd, identity, registered=True)
                ctl.request_stop()
                raise BridgeHalt("stop_requested", f"{role}_release", task_id=bridge.task_id)
            try:
                _write_fd_all(write_fd, release)
            except OSError:
                pass  # the gate is gone; the wait below sees its exit
            finally:
                os.close(write_fd)
            reason = None
            deadline = time.monotonic() + timeout
            try:
                while True:
                    if bridge.stop_requested():
                        reason = "stop"
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        reason = "timeout"
                        break
                    if _wait_exit_unreaped(proc.pid, min(BRIDGE_WAIT_SLICE, remaining)):
                        break
            except Exception:
                reason = "error"
            if reason is None:
                decision = ctl.confirm_phase_exit(role)
                if not decision.allowed and decision.code == "still_running":
                    # The leader exited and left live members in its group: contain them.
                    decision = ctl.request_stop()
                    self.forced = True
                if not decision.allowed and not decision.group_confirmed:
                    raise BridgeHalt(bridge_public_code(decision.code), f"{role}_exit", task_id=bridge.task_id)
            else:
                decision = ctl.request_stop()
                if not decision.group_confirmed:
                    raise BridgeHalt(bridge_public_code(decision.code), f"{role}_stop", task_id=bridge.task_id)
            if not bridge.children.reap(proc):
                raise BridgeHalt("identity_unverifiable", f"{role}_reap", task_id=bridge.task_id)
            self.phase_confirmed = True
            if reason == "stop":
                raise BridgeHalt("stop_requested", role, task_id=bridge.task_id)
            if reason == "timeout":
                raise subprocess.TimeoutExpired(cmd, timeout)
            if reason == "error":
                raise OSError("execution error")
            out_f.seek(0)
            err_f.seek(0)
            return (
                proc.returncode,
                out_f.read().decode("utf-8", errors="replace"),
                err_f.read().decode("utf-8", errors="replace"),
            )

    def _abandon(self, proc: subprocess.Popen, write_fd: int, identity: stopctl.OwnedIdentity, *,
                 registered: bool) -> None:
        """Refused before release: EOF makes the gate exit 125 without exec. Never a signal."""
        try:
            os.close(write_fd)
        except OSError:
            pass
        if not _wait_exit_unreaped(proc.pid, KILL_GRACE):
            return  # left unreaped; recovery is retained by the controller
        if registered:
            decision = self.ctl.confirm_phase_exit(self.role)
            if not decision.group_confirmed:
                return
        else:
            try:
                seen = self.bridge.observer.observe(identity)
            except Exception:
                return
            if seen.status != "absent" or seen.group_status != "empty":
                return
        self.bridge.children.reap(proc)


def _write_fd_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write")
        view = view[written:]


class BridgeDispatcher:
    """One bridge-mode dispatcher: one host, one ledger, one claim window at a time."""

    def __init__(self, parsed: dict, dir_fd: int, *, stop_event: threading.Event | None = None,
                 grace: float = KILL_GRACE, stop_budget: float = BRIDGE_STOP_BUDGET,
                 net_budget: float = BRIDGE_NET_BUDGET, table=bridge_process_table) -> None:
        self.config = parsed
        self.dir_fd = dir_fd
        self.journal = BridgeJournal(dir_fd)
        self.done = BridgeDoneRecord(dir_fd)
        self.issue: str | None = None
        self.stop_event = stop_event if stop_event is not None else threading.Event()
        self.grace = grace
        self.stop_budget = stop_budget
        self.net_budget = net_budget
        self.children = BridgeChildren()
        self.observer = BridgeObserver(self.children, table)
        self.signals = BridgeSignalPort(self.children, table)
        self.halted: BridgeHalt | None = None
        self.held: dict | None = None
        self.task_id: int | None = None
        self.boundary = lambda name: None  # test hook at each named boundary
        # Signal latch (PR #215): a plain flag plus a non-blocking self-pipe. The
        # handler never takes a lock; the main loop sleeps in select() on the pipe.
        self.signalled = False
        self.wake_r, self.wake_w = os.pipe()
        try:
            for fd in (self.wake_r, self.wake_w):
                os.set_blocking(fd, False)
        except OSError:
            self.close()
            raise

    def close(self) -> None:
        """Close the wake pipe. The ledger fd belongs to bridge_main."""
        for name in ("wake_r", "wake_w"):
            fd = getattr(self, name, None)
            if fd is not None:
                setattr(self, name, None)
                try:
                    os.close(fd)
                except OSError:
                    pass

    # -- stop predicate (C12, D13) --------------------------------------------

    def signal_received(self) -> bool:
        return self.signalled or self.stop_event.is_set()

    def sleep(self, timeout: float | None) -> None:
        """Wait for the poll interval or a signal, whichever comes first. Drains the wake pipe."""
        try:
            ready, _w, _x = select.select([self.wake_r], [], [], timeout)
        except InterruptedError:
            return
        if ready:
            try:
                os.read(self.wake_r, 4096)
            except OSError:
                pass

    def stop_requested(self) -> bool:
        if self.signal_received():
            return True
        stop_file = self.config.get("stop_file")
        if stop_file is None:
            return False
        try:
            os.stat(str(stop_file))
        except FileNotFoundError:
            return False
        except Exception:
            return True  # an error reading the stop file is a stop request
        return True

    def new_controller(self) -> stopctl.StopController:
        return stopctl.StopController(
            self_identity=stopctl.SelfIdentity(pid=os.getpid(), pgid=os.getpgrp()),
            predicate=self.stop_requested, observer=self.observer, signals=self.signals,
            journal=self.journal, clock=time, wait=time.sleep,
            grace=self.grace, stop_budget=self.stop_budget,
        )

    def net(self, fn):
        return bridge_bounded(fn, self.net_budget)

    # -- candidate selection (C3, D3, H6, H7) ---------------------------------

    def select(self, platform: str):
        rows = drb.load_handoff_rows(self.config["authority"], dir_fd=self.dir_fd)
        if isinstance(rows, str):
            raise BridgeHalt(rows if rows in BRIDGE_CODES else "ledger_unreadable", "select")
        finished = self.done.task_ids()  # raises invalid_config; never read as empty (I1)
        matching = [r for r in rows if r.state == "acknowledged"
                    and r.body.get("machine") == HOSTNAME and r.body.get("platform") == platform
                    and r.task_id not in finished]
        if not matching:
            return None
        if len(matching) > 1:
            raise BridgeHalt("duplicate_candidate", "select", rows=tuple(r.node for r in matching))
        row = matching[0]
        if row.task_id is None:
            raise BridgeHalt("missing_task_id", "select", rows=(row.node,))
        body = row.body
        entries = [e for e in self.config["repos"]
                   if e["repo"] == row.repository and e["project"] == body.get("project")
                   and e["platform"] == body.get("platform") and e["machine"] == body.get("machine")]
        if (len(entries) != 1 or body.get("reviewer_platform") != entries[0]["reviewer_platform"]
                or body.get("created_by") != drb.CREATED_BY):
            raise BridgeHalt("conflicting_candidate", "select", task_id=row.task_id, rows=(row.node,))
        return row, entries[0]

    def claimed_task_ok(self, task: object, row, platform: str) -> bool:
        """C4, D24, H6: the returned task is the requested id on the requested lane, frozen fields equal."""
        if not isinstance(task, dict):
            return False
        # Postgres returns the bigint id as "101": compare the canonical value (PR #215).
        if drb.canonical_task_id(task.get("id")) != row.task_id:
            return False
        if task.get("project") != row.body["project"] or task.get("platform") != platform:
            return False
        if not isinstance(task.get("machine"), str) or task.get("machine") != HOSTNAME:
            return False
        return drb.task_matches_handoff(task, row.body)

    # -- one poll ---------------------------------------------------------------

    def poll_once(self, platform: str) -> str:
        """idle, done, stop, or halt. A halt is recorded before this returns."""
        if self.halted is not None:
            return "halt"
        if self.stop_requested():
            return "stop"
        if self.journal.exists():
            self.halt(BridgeHalt("stop_journal_present", "poll"), durable=False)
            return "halt"
        try:
            picked = self.select(platform)
        except BridgeHalt as h:
            self.halt(h)
            return "halt"
        except Exception:
            # A ledger the selector cannot classify is unreadable: fail closed.
            self.halt(BridgeHalt("ledger_unreadable", "select"))
            return "halt"
        if picked is None:
            return "idle"
        return self.run_round(platform, *picked)

    def halt(self, h: BridgeHalt, *, durable: bool = True) -> None:
        self.halted = h
        if durable:
            try:
                self.journal.record_halt(h)
            except Exception:
                print(bridge_halt_line(BridgeHalt("journal_write_failed", h.phase, task_id=h.task_id)),
                      file=sys.stderr)
        print(bridge_halt_line(h), file=sys.stderr)

    def run_round(self, platform: str, row, entry: dict) -> str:
        tid = row.task_id
        self.task_id = tid
        self.issue = row.node
        body = row.body
        project = body["project"]
        agent_id = f"{platform}-{HOSTNAME}"
        reviewer = body.get("reviewer_platform")
        state = {"lock": None, "session": None, "injection": None, "ctl": None, "claim_sent": False,
                 "suffix": ""}
        needles: list[str] = []

        def scrub(value: object) -> object:
            return redact_broker(value, needles)

        def note(kind: str, title: str, detail: dict | None = None) -> None:
            """The authenticated work event, strict (C8): raises unless the server recorded it.

            Same body as ingest(), under the bridge's one deadline. A transport
            error, timeout, non-2xx, malformed reply, ok other than true, or a
            demo deployment that dropped the event all raise.
            """
            event = {"agent_id": agent_id, "platform": platform, "machine": HOSTNAME,
                     "kind": kind, "title": scrub(title), "detail": scrub(detail or {})}
            resp = self.net(lambda: api("/api/ingest", event))
            if not isinstance(resp, dict) or resp.get("ok") is not True or resp.get("demo") is True:
                raise RuntimeError("work event not recorded")

        def patch_task(payload: dict) -> dict:
            """A task PATCH that the server provably applied, or raises (CodeRabbit #215, 6 and 7).

            Requires {ok: true, task: {id, status}} with the requested status and no
            demo flag. A timed-out PATCH may still land later, so a caller that sees
            an exception must not send another status for this task.
            """
            resp = self.net(lambda: api(f"/api/tasks/{tid}", scrub(payload), "PATCH"))
            task = resp.get("task") if isinstance(resp, dict) else None
            if (not isinstance(resp, dict) or resp.get("ok") is not True or resp.get("demo") is True
                    or not isinstance(task, dict) or drb.canonical_task_id(task.get("id")) != tid
                    or task.get("status") != payload["status"]):
                raise RuntimeError("task update not recorded")
            return resp

        try:
            prepared = self._prepare(platform, row, state, needles)
            if prepared is None:
                return "idle"
            cwd, cli_env, block, base_head, runtime = prepared
            self.boundary("prepared")
            # -- claim (C4, C5, C19, D15) --
            try:
                ctl = self.new_controller()
            except (TypeError, ValueError):
                raise BridgeHalt("identity_unverifiable", "claim", task_id=tid) from None
            state["ctl"] = ctl
            decision = ctl.before_claim()
            if not decision.allowed:
                raise BridgeHalt(bridge_public_code(decision.code), "claim", task_id=tid, rows=(row.node,))
            request, _headers, _observed = task_claim_request(platform, None, project=project, task_id=tid)
            state["claim_sent"] = True  # from here the server may hold a claim for this id
            self.boundary("claim_sent")
            try:
                resp = self.net(lambda: api("/api/tasks/claim", request))
                readable = isinstance(resp, dict) and "task" in resp
            except Exception:
                resp, readable = None, False
            if not readable:
                ctl.note_claim_unknown()
                raise BridgeHalt("claim_unknown", "claim", task_id=tid, rows=(row.node,))
            task = resp["task"]
            if task is None:
                ctl.note_claim_unknown()
                raise BridgeHalt("exact_claim_miss", "claim", task_id=tid, rows=(row.node,))
            if not self.claimed_task_ok(task, row, platform):
                ctl.note_claim_unknown()
                raise BridgeHalt("claim_mismatch", "claim", task_id=tid, rows=(row.node,))
            decision = ctl.note_claimed(tid, exact_claim=True)
            if not decision.allowed:
                raise BridgeHalt(bridge_public_code(decision.code), "post_claim", task_id=tid)
            if not decision.exact_task_match_proven:
                raise BridgeHalt("journal_write_failed", "post_claim", task_id=tid)
            self.boundary("claimed")
            return self._execute(platform, task, tid, agent_id, reviewer, cwd, cli_env, block, base_head,
                                 ctl, state, scrub, note, patch_task)
        except BridgeHalt as h:
            return "halt" if self._on_halt(h, state) else "stop"
        except Exception:
            # An unexpected error is an ambiguous state: fail closed, keep everything held.
            self._on_halt(BridgeHalt("identity_unverifiable", "internal", task_id=tid), state)
            return "halt"
        finally:
            self.task_id = None

    def _prepare(self, platform: str, row, state: dict, needles: list[str]):
        """Everything that can be checked before the claim. None means: no claim this poll.

        A lane that cannot run here halts as invalid_config. A busy lock, a
        broker, pointer or git failure is retried on the next poll; nothing has
        been claimed or launched, and every step taken here is undone.
        """
        tid = row.task_id
        body = row.body
        project = body["project"]
        runtime = RUNTIME_FOR_PLATFORM.get(platform)
        reviewer = body.get("reviewer_platform")
        if bridge_frame_refusal({**body, "id": tid}) is not None:
            raise BridgeHalt("ledger_unreadable", "prepare", task_id=tid, rows=(row.node,))
        try:
            if runtime is None or not isinstance(project, str) or not LANE_RE.fullmatch(project):
                raise DispatchRefused("lane")
            if shutil.which(CLI_FOR_PLATFORM[platform]) is None:
                raise DispatchRefused("worker cli")
            if reviewer is not None and shutil.which(CLI_FOR_PLATFORM.get(reviewer, "")) is None:
                raise DispatchRefused("reviewer cli")
            cwd = resolve_project(project, WORKDIR)
            git_dir = linked_worktree_git_dir(cwd)
            lane = lane_user()
            if lane is not None:
                lane_preflight(lane, cwd)
        except (DispatchRefused, LaneUserUnavailable):
            raise BridgeHalt("invalid_config", "prepare", task_id=tid, rows=(row.node,)) from None
        why = "lock"
        try:
            lock = WorktreeLock(git_dir)
            lock.acquire(cwd)
            state["lock"] = lock
            why = "recovery"
            refuse_unresolved_recovery(git_dir)
            why = "broker"
            overlay = None
            settings = broker_settings()
            if settings is not None:
                session = BrokerSession(settings[0], settings[1], str(tid))
                session.github_required = broker_github_required()
                session.health()
                session.github_repo = github_remote(cwd)
                state["session"] = session
                overlay = session.mint()
                needles[:] = session.needles
                if session.github_repo is None:
                    state["suffix"] = GITHUB_NO_GRANT
            why = "pointers"
            block = self.net(lambda: fetch_pointers(project, runtime))
            why = "head"
            head = git(cwd, "rev-parse", "--verify", "-q", "HEAD")
            base_head = head.stdout.strip() if head.returncode == 0 else None
            why = "inject"
            state["injection"] = ak_pointers.inject(cwd, block)
        except Exception:
            self._undo_prepare(state)
            print(f"[mc] bridge: no claim for task #{tid} this poll (preparation failed: {why})", file=sys.stderr)
            return None
        cli_env: dict = {} if overlay is None else {"env_overlay": overlay}
        if lane is not None:
            cli_env["lane"] = lane
        return cwd, cli_env, block, base_head, runtime

    def _undo_prepare(self, state: dict) -> None:
        """Nothing was claimed: put the worktree back, revoke, then unlock."""
        injection = state.pop("injection", None)
        if injection is not None:
            try:
                ak_pointers.cleanup(injection)
            except Exception:
                pass
        self._revoke(state)
        lock = state.pop("lock", None)
        if lock is not None:
            lock.release()
        state["injection"] = None
        state["lock"] = None

    def _revoke(self, state: dict) -> None:
        session = state.get("session")
        state["session"] = None
        if session is not None:
            code = session.revoke()
            if code:
                print(f"[mc] broker revoke_task failed for a bridge task: {code}", file=sys.stderr)

    def _check_stop(self, ctl: stopctl.StopController, phase: str) -> None:
        """The phase-exit and cleanup boundaries (C12): a true predicate goes to request_stop."""
        self.boundary(phase)
        if self.stop_requested():
            decision = ctl.request_stop()
            if decision.recovery_retained:
                raise BridgeHalt(bridge_public_code(decision.code), phase, task_id=self.task_id)
            raise BridgeHalt("stop_requested", phase, task_id=self.task_id)

    def _run_phase(self, role: str, platform: str, prompt: str, cwd: Path, cli_env: dict, tid: int,
                   ctl: stopctl.StopController, on_ack) -> tuple[bool, str, float | None]:
        runner = BridgeRunner(self, ctl, role, on_ack)
        ok, out, cost = run_cli(platform, prompt, cwd, review=(role == "reviewer"), task_id=tid,
                                contained=runner, **cli_env)
        if not runner.phase_confirmed:
            # run_cli returned without a confirmed phase: nothing proves the group is gone.
            raise BridgeHalt("identity_unverifiable", f"{role}_exit", task_id=tid)
        if runner.forced:
            ok = False
            out = f"{out}\n\n[dispatch] processes outlived the {role} in its group; they were stopped"
        return ok, out, cost

    def _execute(self, platform, task, tid, agent_id, reviewer, cwd, cli_env, block, base_head,
                 ctl, state, scrub, note, patch_task) -> str:
        injection = state["injection"]

        def worker_ack() -> None:
            # Strict: a PATCH that failed or timed out may still land later and overwrite
            # the terminal status, so the payload is held and the round halts instead.
            patch_task({"status": "running", "agent_id": agent_id})
            note("status", f"Running task #{tid}: {task['title']}", {"task_id": tid})

        ok, output, cost = self._run_phase(
            "worker", platform, build_prompt(task, injection.changed and block != ""), cwd, cli_env, tid,
            ctl, worker_ack)
        result = extract_result(output)
        if injection.changed and block:
            leaked = committed_metadata(cwd, base_head, block)
            if leaked:
                ok = False
                result = (
                    f"{result}\n\n[dispatch] the skill-pointer block is {leaked}. It is dispatch "
                    "metadata: unstage or amend it out before this work lands; review was skipped."
                )
        self._check_stop(ctl, "phase_exit")
        if ok and reviewer:
            cli = CLI_FOR_PLATFORM.get(reviewer) if isinstance(reviewer, str) else None
            if cli is None:
                ok = False
                result = f"{result}\n\n[review] unknown reviewer platform {reviewer!r}, task not approved"
            elif not shutil.which(cli):
                ok = False
                result = f"{result}\n\n[{reviewer} review] {cli} not found on PATH, task not approved"
            else:
                def reviewer_ack() -> None:
                    patch_task({"status": "review", "agent_id": agent_id})
                    note("status", f"Task #{tid} in review by {reviewer}", {"task_id": tid})

                r_ok, r_out, r_cost = self._run_phase(
                    "reviewer", reviewer, build_review_prompt(task, scrub(output)), cwd, cli_env, tid,
                    ctl, reviewer_ack)
                if r_cost:
                    cost = (cost or 0) + r_cost
                ok, note_text = review_outcome(r_ok, r_out)
                result = f"{result}\n\n[{reviewer} review] {note_text}"
                self._check_stop(ctl, "phase_exit")
        # -- finish, then cleanup and lock release, then the one result PATCH (C7, D9) --
        self._check_stop(ctl, "cleanup")
        decision = ctl.finish(phase_completed=True)
        if not (decision.allowed and decision.pointer_cleanup_permitted and decision.lock_release_permitted):
            raise BridgeHalt(bridge_public_code(decision.code), "cleanup", task_id=tid)
        cleaned = self._cleanup(state)
        if not cleaned:
            ctl.confirm_cleanup_durable(stopctl.CleanupConfirmation("failed", "complete", True))
            raise BridgeHalt("journal_write_failed", "cleanup", task_id=tid)
        result = result or ("completed" if ok else "run failed with no output")
        if state.get("suffix"):
            result = f"{result}\n\n{state['suffix']}"
        payload = {"status": "done" if ok else "failed", "result": result, "agent_id": agent_id}
        if cost is not None:
            payload["cost_usd"] = round(float(cost), 4)
        try:
            patch_task(payload)
        except Exception:
            raise BridgeHalt("claim_unknown", "result", task_id=tid) from None
        try:
            # I1: durably record the finished task before #211 clears the journal.
            self.done.append(tid, self.issue)
        except Exception:
            raise BridgeHalt("claim_unknown", "result", task_id=tid) from None
        decision = ctl.confirm_cleanup_durable(stopctl.CleanupConfirmation("complete", "complete", True))
        if not decision.allowed:
            raise BridgeHalt("journal_write_failed", "cleanup", task_id=tid)
        return "done"

    def _cleanup(self, state: dict) -> bool:
        """Pointer cleanup, broker revoke, lock release. Only after finish() permitted both."""
        ok = True
        injection = state.get("injection")
        state["injection"] = None
        if injection is not None:
            try:
                ak_pointers.cleanup(injection)
            except (ak_pointers.PointerFileError, OSError):
                ok = False
        self._revoke(state)
        lock = state.get("lock")
        state["lock"] = None
        if lock is not None:
            lock.release()
        return ok

    def _on_halt(self, h: BridgeHalt, state: dict) -> bool:
        """Record the halt. False only for a stop that #211 fully reconciled before any claim was sent."""
        ctl = state.get("ctl")
        if h.code == "stop_requested" and ctl is not None:
            decision = ctl.finish(phase_completed=False)
            if decision.allowed and decision.pointer_cleanup_permitted and decision.lock_release_permitted:
                cleaned = self._cleanup(state)
                if cleaned and not state.get("claim_sent"):
                    done = ctl.confirm_cleanup_durable(stopctl.CleanupConfirmation("complete", "complete", True))
                    if done.allowed:
                        # No claim left the host and the journal is cleared: a stop, not a failure.
                        print(bridge_halt_line(h), file=sys.stderr)
                        return False
        if ctl is None:
            self._undo_prepare(state)  # no claim window was opened
        else:
            self._revoke(state)  # revoking a grant is always safe; pointers and lock wait for #211
        self.held = state  # the lock and pointers stay held until an operator reconciles
        self.halt(h)
        return True


def bridge_main(platforms: list[str]) -> int:
    """Bridge-mode main loop. Exit 0 on a signal, 2 on a startup halt, 3 after a halt."""
    try:
        bridge_check_concurrency(os.environ)
        bridge_check_platforms(platforms)
        bridge_check_self()
        parsed, dir_fd = bridge_read_config(os.environ)
    except BridgeHalt as h:
        print(bridge_halt_line(h), file=sys.stderr)
        return 2
    try:
        try:
            lock_fd = bridge_lock_ledger(dir_fd)
        except BridgeHalt as h:
            print(bridge_halt_line(h), file=sys.stderr)
            return 2
        try:
            return _bridge_run(parsed, dir_fd, platforms)
        finally:
            os.close(lock_fd)  # only at exit: the lock spans the journal check and any recovery
    finally:
        os.close(dir_fd)


def bridge_signal_handler(bridge: BridgeDispatcher):
    """SIGTERM/SIGINT: set a plain flag and write one byte to the wake pipe. Takes no lock (D13)."""

    def latch(_signum, _frame) -> None:
        bridge.signalled = True
        try:
            os.write(bridge.wake_w, b"x")
        except (OSError, TypeError):
            pass  # the pipe is full: a wake is already pending

    return latch


def _bridge_run(parsed: dict, dir_fd: int, platforms: list[str]) -> int:
    bridge = BridgeDispatcher(parsed, dir_fd)
    try:
        return _bridge_loop(bridge, parsed, platforms)
    finally:
        bridge.close()


def _bridge_loop(bridge: BridgeDispatcher, parsed: dict, platforms: list[str]) -> int:
    if bridge.journal.exists():
        # D6: unresolved recovery from an earlier run. Leave it exactly as it is.
        print(bridge_halt_line(BridgeHalt("stop_journal_present", "startup")), file=sys.stderr)
        return 3
    try:
        bridge_validate_lanes(parsed, WORKDIR)
    except BridgeHalt as h:
        bridge.halt(h)
        return 2

    latch = bridge_signal_handler(bridge)  # latch and wake only; never a signal to a child (D13)
    signal.signal(signal.SIGTERM, latch)
    signal.signal(signal.SIGINT, latch)
    print(f"[mc] dispatcher on {HOSTNAME} serving: {', '.join(platforms)} (workdir {WORKDIR}, bridge mode)")
    heartbeat_at = 0.0
    outcome = "idle"
    while not bridge.signal_received():
        now = time.time()
        if now - heartbeat_at > 300:
            for p in platforms:
                try:
                    bridge.net(lambda p=p: ingest("heartbeat", "dispatcher online", f"{p}-{HOSTNAME}", p))
                except Exception:
                    pass
            heartbeat_at = now
        for platform in platforms:
            outcome = bridge.poll_once(platform)
            if outcome in ("halt", "stop"):
                break
        if outcome == "stop" and bridge.signal_received():
            break
        if bridge.halted is not None:
            # Hold the halt (and any lock or unreaped child it keeps) until an operator stops us.
            while not bridge.signal_received():
                bridge.sleep(None)
            return 3
        bridge.sleep(POLL)
    return 0


def run_task_and_wake(task: dict, platform: str, sem: threading.Semaphore, wake: DispatchWake) -> None:
    try:
        run_task(task, platform, sem)
    finally:
        wake.signal("capacity")


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
    if os.environ.get("MC_BRIDGE_ENABLED") == "1":
        # Bridge mode (#212). Only the exact value "1" gets here; nothing below runs.
        sys.exit(bridge_main(platforms))
    try:
        configured_task_project()
    except ValueError as e:
        print(f"[mc] {e}", file=sys.stderr)
        sys.exit(1)

    print(f"[mc] dispatcher on {HOSTNAME} serving: {', '.join(platforms)} (workdir {WORKDIR})")
    sem = threading.Semaphore(MAX_CONCURRENT)
    heartbeat_at = 0.0
    wake = DispatchWake()
    consumer = os.environ.get("MC_EVENT_CONSUMER", "")
    stream_token = os.environ.get("MC_EVENT_TOKEN", "")
    stream = None
    if consumer or stream_token:
        try:
            stream = EventStreamWake(MC_URL, consumer, stream_token, wake)
            stream.start()
        except ValueError:
            print("[mc] invalid event stream configuration; polling remains active", file=sys.stderr)
    reasons = {"startup"}
    fallback_claims = 0

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
                body, event_headers, observed = task_claim_request(platform, stream)
                resp = api("/api/tasks/claim", body, headers=event_headers)
                task = resp.get("task")
                if task:
                    claimed = True
                    trigger = "event" if "event" in reasons else "capacity" if "capacity" in reasons else "fallback" if "fallback" in reasons else "reconcile"
                    if trigger == "fallback":
                        fallback_claims += 1
                    # A fallback claim alone does not prove an event was missed.
                    # fallback_before_notice is a separate, stricter classification.
                    # `observed` is the epoch from before this HTTP call. A reconnect
                    # during the call, even one that repeats the server generation, is unknown.
                    if stream is not None:
                        label, why = stream.notices.classify_claim(trigger, reasons, resp.get("coverage"), task.get("id"), observed)
                    else:
                        label, why = coverage_for_disconnected(trigger, reasons)
                    print(json.dumps({"kind": "claim-wake", "trigger": trigger,
                        "fallback_claims": fallback_claims, "stream_connected": bool(stream and stream.connected),
                        "coverage": label, "coverage_reason": why}))
                    threading.Thread(
                        target=run_task_and_wake, args=(task, platform, sem, wake), daemon=True
                    ).start()
            except Exception as e:
                print(f"[mc] claim failed ({platform}): {e}", file=sys.stderr)
            finally:
                if not claimed:
                    sem.release()

        # A healthy stream reduces polling frequency. An unavailable stream
        # keeps the original polling interval, including after a 401/429/error.
        fallback = max(POLL, 60) if stream and stream.connected else POLL
        reasons = wake.wait(fallback)


if __name__ == "__main__":
    main()
