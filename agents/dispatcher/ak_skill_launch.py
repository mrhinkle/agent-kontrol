#!/usr/bin/env python3
"""
One-shot skill-pointer launcher for an explicitly selected lane. Stdlib only.

The queue dispatcher's prepare/cleanup lifecycle (mc_dispatcher + ak_pointers),
usable by a single launch:

  prepare_context(cwd, lane, runtime) -> SkillContext
      confine cwd to a linked worktree under MC_WORKDIR, refuse an unresolved
      recovery record, take ak-dispatch.lock, read HEAD, GET the lane's pointers,
      journal the planned AGENTS.md change in the worktree git dir, then apply it.
  finish_context(ctx, containment_confirmed=True) -> CleanupReceipt
      take the block out again and check the index/HEAD for it. Runs at most once.
      Without confirmed containment it writes nothing and keeps the recovery record;
      a later call with containment confirmed may then finish the cleanup.

Modes (argv[1]):
  fleet        parent supervisor for fleet-dispatch.sh --skills-lane. Prepares the
               context, runs the same wrapper again as a controller in its own
               session, and serves a private AF_UNIX control socket:
                 hello     controller confirms it is supervised; gets the derived spec
                 register  worker-exec registers PID=PGID; no ACK, no exec
                 finish    controller reports its rc; the worker group is confirmed
                           gone, AGENTS.md cleaned and checked, then ACK
               The wrapper keeps its own wall/stall/turn caps, exit codes and the
               one completion event. The supervisor never kills its own group.
  ctl          hello | finish <rc>: the wrapper's side of the socket.
  worker-exec  -- argv: new session, register, wait for ACK, exec argv.
  direct       Claude/Codex: prepare, run one contained CLI, finish. --purpose pilot
               (default) keeps Claude's default permission mode and Codex read-only;
               --purpose coding is Claude acceptEdits and Codex workspace-write.
  recover      clear an interrupted launch once its worker group is gone.

Exit codes: 69 unavailable (config, pointer lookup), 73 invalid or busy context,
74 cleanup/leakage failure after the worker, 70 supervisor failure (controller
ended without finishing). Importing reads no file and makes no request; the
entrypoints load the env file and configure explicitly.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import ak_pointers
import mc_dispatcher as md

EX_SOFTWARE, EX_UNAVAILABLE, EX_CANTCREAT, EX_IOERR = 70, 69, 73, 74
RUNTIMES = ("claude", "codex", "grok")
RECOVERY_NAME = md.SKILL_RECOVERY_NAME
CONTROL_ENV = "AK_SKILL_CONTROL"
NONCE_ENV = "AK_SKILL_NONCE"
MAX_MESSAGE = 4096
REGISTER_TIMEOUT = 10.0
FINISH_TIMEOUT = 60.0
WORKER_GRACE = 2.0
CONTROLLER_GRACE = 5.0


class ContextError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- shared context ------------------------------------------------------------

class CleanupReceipt:
    def __init__(self, ok: bool, contained: bool, note: str, leaked: str | None = None) -> None:
        self.ok = ok
        self.contained = contained
        self.note = note
        self.leaked = leaked

    def as_dict(self) -> dict:
        return {"ok": self.ok, "contained": self.contained, "note": self.note, "leaked": self.leaked}


class SkillContext:
    def __init__(self, cwd: Path, lane: str, runtime: str, git_dir: Path, lock: md.WorktreeLock) -> None:
        self.cwd = cwd
        self.lane = lane
        self.runtime = runtime
        self.git_dir = git_dir
        self.lock = lock
        self.base_head: str | None = None
        self.block = ""
        self.injection: ak_pointers.Injection | None = None
        self.worker_pgid: int | None = None
        self.receipt: CleanupReceipt | None = None
        self._mutex = threading.Lock()

    @property
    def recovery_path(self) -> Path:
        return self.git_dir / RECOVERY_NAME

    @property
    def pointers_written(self) -> bool:
        return self.injection is not None and self.injection.changed and self.block != ""

    def record(self, state: str) -> None:
        inj = self.injection
        orig = inj.original if inj else None
        write_private_json(self.recovery_path, {
            "version": 1, "state": state, "cwd": str(self.cwd), "lane": self.lane, "runtime": self.runtime,
            "supervisor_pid": os.getpid(), "base_head": self.base_head, "block": self.block,
            "original_b64": None if orig is None else base64.b64encode(orig.encode("utf-8")).decode(),
            "injected": inj.injected if inj else None, "worker_pgid": self.worker_pgid,
        })

    def register_worker(self, pgid: int) -> None:
        """Persist the worker group before it may exec. Raises OSError if the record cannot be written."""
        self.worker_pgid = pgid
        self.record("running")


def write_private_json(path: Path, payload: dict) -> None:
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def confine(cwd: str) -> tuple[Path, Path]:
    """(real worktree top, its git dir): an absolute linked worktree strictly below MC_WORKDIR, no symlinks."""
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or os.path.normpath(cwd) != cwd:
        raise ContextError(EX_CANTCREAT, f"--cwd must be an absolute, normalised path: {cwd!r}")
    root = md.WORKDIR.expanduser()
    rel = None
    for base in (root.absolute(), root.resolve()):
        try:
            rel = Path(cwd).relative_to(base)
            break
        except ValueError:
            continue
    if rel is None or not rel.parts:
        raise ContextError(EX_CANTCREAT, f"--cwd {cwd} is not below MC_WORKDIR {root}")
    try:
        real = md.resolve_project(str(rel), root)
        return real, md.linked_worktree_git_dir(real)
    except md.DispatchRefused as e:
        raise ContextError(EX_CANTCREAT, str(e)) from None


def prepare_context(cwd: str, lane: str, runtime: str) -> SkillContext:
    """Lock, look up and inject. On any failure nothing is left written and the lock is released."""
    if runtime not in RUNTIMES:
        raise ContextError(EX_CANTCREAT, f"runtime must be one of {', '.join(RUNTIMES)}")
    if not isinstance(lane, str) or not md.LANE_RE.fullmatch(lane):
        raise ContextError(EX_CANTCREAT, f"invalid lane {lane!r}")
    real, git_dir = confine(cwd)
    lock = md.WorktreeLock(git_dir)
    try:
        lock.acquire(real)
    except md.DispatchRefused as e:
        raise ContextError(EX_CANTCREAT, str(e)) from None
    ctx = SkillContext(real, lane, runtime, git_dir, lock)
    try:
        try:
            md.refuse_unresolved_recovery(git_dir)
        except md.DispatchRefused as e:
            raise ContextError(EX_CANTCREAT, str(e)) from None
        if not md.MC_URL or not md.MC_TOKEN:
            raise ContextError(EX_UNAVAILABLE, "MC_URL and MC_TOKEN are not configured")
        try:
            ctx.block = md.fetch_pointers(lane, runtime)
        except Exception as e:
            raise ContextError(EX_UNAVAILABLE, f"skill pointers unavailable, no worker started: {e}") from None
        head = md.git(real, "rev-parse", "--verify", "-q", "HEAD")
        ctx.base_head = head.stdout.strip() if head.returncode == 0 else None
        # ak_pointers.inject, split so the planned text is journaled before the file changes.
        path = real / ak_pointers.AGENTS_MD
        snap = ak_pointers.read_snapshot(path)
        try:
            planned, changed = ak_pointers.apply_pointer_block(snap.text, ctx.block)
        except ak_pointers.MalformedBlockError as e:
            raise ak_pointers.PointerFileError(f"{ak_pointers.AGENTS_MD}: {e}; fix or remove the marker by hand") from e
        ctx.injection = ak_pointers.Injection(path, snap.text, planned, ctx.block)
        ctx.record("preparing")
        try:
            if changed:
                ak_pointers.write_replacing(path, snap, planned, snap.mode)
        except BaseException:
            discard_journal_if_unchanged(ctx)  # write_replacing swaps atomically or not at all
            raise
        try:
            ctx.record("prepared")
        except BaseException as e:
            undo_preparation(ctx, e)
            raise
        return ctx
    except (ak_pointers.PointerFileError, OSError, subprocess.SubprocessError) as e:
        lock.release()
        raise ContextError(EX_CANTCREAT, f"could not prepare {real}, no worker started: {e}") from None
    except BaseException:
        lock.release()
        raise


def discard_journal_if_unchanged(ctx: SkillContext) -> None:
    """After a failed write: drop the journal only if AGENTS.md still holds the original bytes."""
    try:
        same = ak_pointers.read_snapshot(ctx.injection.path).text == ctx.injection.original
    except (ak_pointers.PointerFileError, OSError):
        same = False
    if same:
        try:
            os.unlink(ctx.recovery_path)
        except OSError:
            pass  # a "preparing" journal over an unchanged file recovers cleanly


def undo_preparation(ctx: SkillContext, cause: BaseException) -> None:
    """The block is written but the journal could not say so: restore, then drop the "preparing" journal.

    If the restore fails the journal stays; it holds the original and the planned text, so recover can
    still put the file back. Raises ContextError(74) in that case instead of the original error."""
    try:
        ak_pointers.cleanup(ctx.injection)
    except (ak_pointers.PointerFileError, OSError) as e:
        raise ContextError(EX_IOERR, (
            f"could not record the prepared launch ({cause}) nor remove the pointer block ({e}); no worker "
            f"started; {ctx.recovery_path} kept: run `ak_skill_launch.py recover --cwd {ctx.cwd}`")) from None
    discard_journal_if_unchanged(ctx)


def finish_context(ctx: SkillContext, containment_confirmed: bool = True) -> CleanupReceipt:
    """Clean up once. Never unstages, amends or discards worker edits. Keeps the lock (release_context does)."""
    with ctx._mutex:
        if ctx.receipt is not None and (ctx.receipt.contained or not containment_confirmed):
            return ctx.receipt
        if not containment_confirmed:
            ctx.receipt = CleanupReceipt(False, False, (
                f"worker group {ctx.worker_pgid} could not be confirmed stopped; AGENTS.md left as it is and "
                f"{ctx.recovery_path} kept for recovery"))
            return ctx.receipt
        try:
            note = ak_pointers.cleanup(ctx.injection) if ctx.injection else "nothing was written"
        except (ak_pointers.PointerFileError, OSError) as e:
            ctx.receipt = CleanupReceipt(False, True, (
                f"AGENTS.md cleanup failed: {e}. Remove the ak-skills block by hand; {ctx.recovery_path} kept"))
            return ctx.receipt
        try:
            os.unlink(ctx.recovery_path)
        except FileNotFoundError:
            pass
        except OSError as e:
            ctx.receipt = CleanupReceipt(False, True, f"{note}; could not remove {ctx.recovery_path}: {e}")
            return ctx.receipt
        leaked = md.committed_metadata(ctx.cwd, ctx.base_head, ctx.block) if ctx.pointers_written else None
        if leaked:
            ctx.receipt = CleanupReceipt(False, True, (
                f"{note}; the skill-pointer block is {leaked}: unstage or amend it out before this work lands"),
                leaked)
        else:
            ctx.receipt = CleanupReceipt(True, True, note)
        return ctx.receipt


def release_context(ctx: SkillContext) -> None:
    ctx.lock.release()


def worker_instruction(runtime: str, lane: str) -> str:
    return (
        f"AGENTS.md in this worktree holds a temporary skill-pointer block between {ak_pointers.POINTERS_BEGIN} "
        f"and {ak_pointers.POINTERS_END}. Read it. Call the skill tools with runtime={runtime} and "
        f"lane={lane} exactly. The block is dispatch metadata: do not edit, stage or commit it; it is removed "
        "when you finish.\n\n"
    )


def derived_spec(spec: Path, ctx: SkillContext, directory: Path) -> Path:
    text = spec.read_text(encoding="utf-8")
    prefix = worker_instruction(ctx.runtime, ctx.lane) if ctx.pointers_written else ""
    out = directory / "worker-spec.md"
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(prefix + text)
    return out


def group_gone(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


# --- control channel --------------------------------------------------------------

def send_message(path: str, msg: dict, timeout: float) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect(path)
        s.sendall(json.dumps(msg).encode() + b"\n")
        return json.loads(read_line(s))


def read_line(conn: socket.socket) -> bytes:
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = conn.recv(MAX_MESSAGE)
        if not chunk:
            break
        buf += chunk
        if len(buf) > MAX_MESSAGE:
            raise ValueError("control message too large")
    if not buf:
        raise ConnectionError("control channel closed without a reply")
    return buf


class Supervisor:
    """fleet mode: owns the context and the control socket; the wrapper below it owns the caps and the event."""

    def __init__(self, ctx: SkillContext, wrapper: str, args: list[str], worker_spec: Path, sock_dir: Path) -> None:
        self.ctx = ctx
        self.wrapper = wrapper
        self.args = args
        self.worker_spec = worker_spec
        self.sock_path = str(sock_dir / "ctl")
        self.nonce = secrets.token_hex(16)
        # starting -> running (hello) -> finishing (finish received) -> finished (cleanup done, ACK sent)
        #                                           \-> aborting (controller gone or signal before finished)
        self.state = "starting"
        self.state_lock = threading.Lock()
        self.contain_lock = threading.Lock()  # one containment operation at a time; run() waits for finish's
        self.controller: subprocess.Popen | None = None
        self.finish_rc: int | None = None
        self.abort_signal: int | None = None
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.sock_path)
        os.chmod(self.sock_path, 0o600)
        self.server.listen(8)

    def serve(self) -> None:
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    def handle(self, conn: socket.socket) -> None:
        with conn:
            try:
                conn.settimeout(5)
                msg = json.loads(read_line(conn))
                if not isinstance(msg, dict) or msg.get("nonce") != self.nonce:
                    raise ValueError("unexpected control message")
                reply = self.dispatch(msg)
            except Exception as e:  # any malformed or refused request is a plain refusal
                reply = {"ok": False, "error": str(e)[:300]}
            try:
                conn.sendall(json.dumps(reply).encode() + b"\n")
            except OSError:
                pass

    def dispatch(self, msg: dict) -> dict:
        op, pid = msg.get("op"), msg.get("pid")
        if type(pid) is not int or pid <= 1:
            raise ValueError("pid missing")
        with self.state_lock:
            ctl_pid = self.controller.pid if self.controller else None
            if op == "hello":
                if self.state != "starting" or pid != ctl_pid:
                    raise ValueError("hello refused")
                self.state = "running"
                return {"ok": True, "worker_spec": str(self.worker_spec)}
            if op == "register":
                if self.state != "running" or self.ctx.worker_pgid is not None:
                    raise ValueError("registration refused")
                if os.getpgid(pid) != pid:
                    raise ValueError("worker is not its own process group leader")
                self.ctx.register_worker(pid)
                return {"ok": True}
            if op == "finish":
                if self.state != "running" or pid != ctl_pid:
                    raise ValueError("finish refused")
                rc = msg.get("rc")
                if type(rc) is not int:
                    raise ValueError("rc missing")
                self.state = "finishing"
                self.finish_rc = rc
        if op != "finish":
            raise ValueError(f"unknown op {op!r}")
        receipt = self.contain_and_clean(stop_controller=False)
        with self.state_lock:
            if self.state == "finishing":  # run() may have moved to aborting meanwhile; it then cleans up itself
                self.state = "finished"
        return {"ok": receipt.ok, **receipt.as_dict()}

    def contain_and_clean(self, stop_controller: bool) -> CleanupReceipt:
        with self.contain_lock:
            pgid = self.ctx.worker_pgid
            contained = True
            if pgid is not None:
                contained = md.stop_group_id(pgid, lambda: None, WORKER_GRACE)
            if stop_controller and self.controller is not None:
                c_ok = md.stop_group_id(self.controller.pid, self.controller.poll, CONTROLLER_GRACE)
                if pgid is not None and not contained:  # the worker's zombie leader is reaped once its parent is gone
                    contained = md.stop_group_id(pgid, lambda: None, WORKER_GRACE)
                contained = contained and c_ok
            return finish_context(self.ctx, containment_confirmed=contained)

    def on_signal(self, signum, _frame) -> None:
        if self.abort_signal is None:
            self.abort_signal = signum

    def run(self) -> int:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, self.on_signal)
        threading.Thread(target=self.serve, daemon=True).start()
        env = dict(os.environ, **{CONTROL_ENV: self.sock_path, NONCE_ENV: self.nonce})
        with self.state_lock:
            if self.abort_signal is None:
                self.controller = subprocess.Popen([self.wrapper, *self.args], env=env, start_new_session=True)
        while self.controller is not None and self.abort_signal is None and self.controller.poll() is None:
            time.sleep(0.05)
        with self.state_lock:
            finished = self.state == "finished"
            was_finishing = self.state == "finishing"
            if not finished:
                self.state = "aborting"  # no hello, register or finish is accepted from here on
        if finished and self.abort_signal is None:
            rc = self.controller.wait()
            return rc
        receipt = self.contain_and_clean(stop_controller=True)  # waits for an in-progress finish containment
        why = (f"signal {self.abort_signal}" if self.abort_signal is not None
               else f"controller exited {self.controller.returncode if self.controller else 'unstarted'} "
                    + ("while its finish cleanup ran" if was_finishing else "without finishing"))
        print(f"ak-skill-launch: supervisor-failure ({why}); cleanup: {receipt.note}", file=sys.stderr)
        if not receipt.ok:
            return EX_IOERR
        if self.abort_signal is not None:
            return 128 + self.abort_signal
        rc = self.controller.returncode if self.controller else None
        return rc if rc and rc > 0 else EX_SOFTWARE  # never report success for a run that did not finish

    def close(self) -> None:
        try:
            self.server.close()
        except OSError:
            pass


def parse_wrapper_args(args: list[str]) -> dict:
    """The few wrapper options the supervisor needs. The wrapper itself validated the full vector."""
    out = {}
    i = 0
    while i < len(args):
        if args[i] in ("--cwd", "--spec", "--skills-lane", "--log") and i + 1 < len(args):
            out[args[i]] = args[i + 1]
            i += 2
        else:
            i += 1
    return out


def main_fleet(ns: argparse.Namespace) -> int:
    args = ns.args[1:] if ns.args[:1] == ["--"] else ns.args
    opts = parse_wrapper_args(args)
    cwd, spec, lane = opts.get("--cwd", ""), opts.get("--spec", ""), opts.get("--skills-lane", "")
    try:
        ctx = prepare_context(cwd, lane, "grok")
    except ContextError as e:
        print(f"fleet-dispatch: skills-prepare-failed exit={e.code}: {e}", file=sys.stderr)
        return e.code
    sock_dir = Path(tempfile.mkdtemp(prefix="aksk-"))
    sup = None
    try:
        try:
            worker_spec = derived_spec(Path(spec), ctx, sock_dir)
            sup = Supervisor(ctx, ns.wrapper, args, worker_spec, sock_dir)
        except (OSError, UnicodeDecodeError) as e:
            receipt = finish_context(ctx)
            print(f"fleet-dispatch: skills-prepare-failed exit={EX_CANTCREAT}: {e}; cleanup: {receipt.note}",
                  file=sys.stderr)
            return EX_CANTCREAT if receipt.ok else EX_IOERR
        return sup.run()
    finally:
        if sup is not None:
            sup.close()
        if ctx.receipt is None:  # an unexpected exception: clean up only if no worker was ever registered
            finish_context(ctx, containment_confirmed=ctx.worker_pgid is None or group_gone(ctx.worker_pgid))
        release_context(ctx)
        shutil.rmtree(sock_dir, ignore_errors=True)


# --- the wrapper's side ---------------------------------------------------------------

def main_ctl(ns: argparse.Namespace) -> int:
    path, nonce = os.environ.get(CONTROL_ENV, ""), os.environ.get(NONCE_ENV, "")
    if not path or not nonce:
        print("ak-skill-launch: no supervisor control channel", file=sys.stderr)
        return EX_UNAVAILABLE
    msg = {"op": ns.op, "nonce": nonce, "pid": ns.pid}
    if ns.op == "finish":
        msg["rc"] = ns.rc
    try:
        reply = send_message(path, msg, FINISH_TIMEOUT if ns.op == "finish" else REGISTER_TIMEOUT)
    except (OSError, ValueError) as e:
        print(f"ak-skill-launch: {ns.op} failed: {e}", file=sys.stderr)
        return EX_UNAVAILABLE if ns.op == "hello" else EX_IOERR
    if ns.op == "hello":
        if reply.get("ok") is not True or not isinstance(reply.get("worker_spec"), str):
            print(f"ak-skill-launch: hello refused: {reply.get('error')}", file=sys.stderr)
            return EX_UNAVAILABLE
        print(reply["worker_spec"])
        return 0
    print(f"ak-skills: cleanup {'ok' if reply.get('ok') is True else 'FAILED'}: {reply.get('note') or reply.get('error')}")
    return 0 if reply.get("ok") is True else EX_IOERR


def main_worker_exec(ns: argparse.Namespace) -> int:
    argv = ns.args[1:] if ns.args[:1] == ["--"] else ns.args
    mark = os.environ.get("FLEET_LAUNCH_MARK", "")

    def launch_failed(why: str) -> int:
        if mark:
            with open(mark, "w") as fh:
                fh.write(f"{why}\n")
        return 127

    if not argv:
        return launch_failed("worker-exec: no command")
    os.setsid()
    path, nonce = os.environ.get(CONTROL_ENV, ""), os.environ.get(NONCE_ENV, "")
    try:
        reply = send_message(path, {"op": "register", "nonce": nonce, "pid": os.getpid()}, REGISTER_TIMEOUT)
    except (OSError, ValueError) as e:
        return launch_failed(f"skills worker registration failed: {e}")
    if reply.get("ok") is not True:
        return launch_failed(f"skills worker registration refused: {reply.get('error')}")
    for k in (CONTROL_ENV, NONCE_ENV):
        os.environ.pop(k, None)
    try:
        os.execvp(argv[0], argv)
    except OSError as e:
        return launch_failed(f"exec failed: {e.strerror}")
    return 127


# --- direct mode (Claude / Codex) --------------------------------------------------------

def direct_argv(runtime: str, prompt: str, purpose: str = "pilot") -> list[str]:
    """The fixed CLI argv per runtime and purpose. Nothing from the caller reaches it but the prompt."""
    coding = purpose == "coding"
    if purpose not in ("pilot", "coding"):
        raise ContextError(EX_CANTCREAT, "direct mode purpose is pilot or coding")
    if runtime == "claude":
        return ["claude", "-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits" if coding else "default"]
    if runtime == "codex":
        return ["codex", "exec", "--sandbox", "workspace-write", prompt] if coding else ["codex", "exec", "-s", "read-only", prompt]
    raise ContextError(EX_CANTCREAT, "direct mode serves claude and codex; grok goes through fleet-dispatch.sh")


def main_direct(ns: argparse.Namespace) -> int:
    if ns.timeout <= 0 or ns.timeout > 14400:
        print("ak-skill-launch: --timeout must be 1..14400", file=sys.stderr)
        return 64
    try:
        spec_text = Path(ns.spec).read_text(encoding="utf-8")
        direct_argv(ns.runtime, "", ns.purpose)
        ctx = prepare_context(ns.cwd, ns.lane, ns.runtime)
    except ContextError as e:
        print(f"ak-skill-launch: skills-prepare-failed exit={e.code}: {e}", file=sys.stderr)
        return e.code
    except (OSError, UnicodeDecodeError) as e:
        print(f"ak-skill-launch: cannot read --spec: {e}", file=sys.stderr)
        return 64
    abort: list[int] = []

    def on_signal(signum, _frame):
        abort.append(signum)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, on_signal)
    rc, outcome, proc = EX_SOFTWARE, "supervisor-failure", None
    start = time.monotonic()
    try:
        prompt = (worker_instruction(ns.runtime, ns.lane) if ctx.pointers_written else "") + spec_text
        with open(ns.log, "ab") as log:
            try:
                proc = subprocess.Popen(direct_argv(ns.runtime, prompt, ns.purpose), cwd=str(ctx.cwd), stdin=subprocess.DEVNULL,
                                        stdout=log, stderr=log, start_new_session=True)
                ctx.register_worker(proc.pid)
                deadline = start + ns.timeout
                while proc.poll() is None and not abort and time.monotonic() < deadline:
                    time.sleep(0.05)
                if abort:
                    rc, outcome = 128 + abort[0], "aborted"
                elif proc.returncode is None:
                    rc, outcome = 124, "wall-timeout"
                else:
                    rc = proc.returncode
                    outcome = "finished" if rc == 0 else "exited-nonzero"
            except FileNotFoundError as e:
                rc, outcome = 126, f"launch-failed ({e.filename})"
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)  # cleanup must not be interrupted half way
        contained = proc is None or md.stop_group(proc, md.KILL_GRACE)
        receipt = finish_context(ctx, containment_confirmed=contained)
        release_context(ctx)
    if not receipt.ok:
        if rc == 0:
            rc, outcome = EX_IOERR, "skills-cleanup-failed"
        else:
            outcome += " skills-cleanup-failed"
    line = f"ak-skill-launch: {outcome} exit={rc} elapsed={int(time.monotonic() - start)}s; cleanup: {receipt.note}"
    with open(ns.log, "a") as log:
        log.write(line + "\n")
    print(line)
    return rc


# --- explicit recovery -------------------------------------------------------------------

def main_recover(ns: argparse.Namespace) -> int:
    try:
        real, git_dir = confine(ns.cwd)
    except ContextError as e:
        print(f"ak-skill-launch: {e}", file=sys.stderr)
        return e.code
    lock = md.WorktreeLock(git_dir)
    try:
        lock.acquire(real)
    except md.DispatchRefused as e:
        print(f"ak-skill-launch: {e}", file=sys.stderr)
        return EX_CANTCREAT
    try:
        path = git_dir / RECOVERY_NAME
        try:
            rec = json.loads(path.read_text())
        except FileNotFoundError:
            print("ak-skill-launch: no recovery record")
            return 0
        pgid = rec.get("worker_pgid")
        if isinstance(pgid, int) and not group_gone(pgid):
            # Never signal it: the id may have been reused. The operator establishes what it is.
            print(f"ak-skill-launch: process group {pgid} still exists; stop it (after checking what it is) first",
                  file=sys.stderr)
            return EX_CANTCREAT
        orig = rec.get("original_b64")
        original = None if orig is None else base64.b64decode(orig).decode("utf-8")
        if rec.get("state") == "preparing":
            try:
                note = recover_preparing(real / ak_pointers.AGENTS_MD, original, rec)
            except (ak_pointers.PointerFileError, OSError, ValueError) as e:
                print(f"ak-skill-launch: cannot recover an interrupted preparation, record kept: {e}", file=sys.stderr)
                return EX_IOERR
        elif rec.get("injected") is not None:
            inj = ak_pointers.Injection(real / ak_pointers.AGENTS_MD, original, rec["injected"], rec.get("block", ""))
            try:
                note = ak_pointers.cleanup(inj)
            except (ak_pointers.PointerFileError, OSError) as e:
                print(f"ak-skill-launch: cleanup failed, record kept: {e}", file=sys.stderr)
                return EX_IOERR
        else:
            note = "no injection was recorded"
        path.unlink()
        print(f"ak-skill-launch: recovered: {note}")
        return 0
    finally:
        lock.release()


def recover_preparing(path: Path, original: str | None, rec: dict) -> str:
    """No worker ran: AGENTS.md is either the original or the planned text. Anything else is left alone."""
    block = rec.get("block", "")
    if not isinstance(block, str):
        raise ValueError("record has no block")
    try:
        planned, _ = ak_pointers.apply_pointer_block(original, block)
    except ak_pointers.MalformedBlockError as e:
        raise ValueError(f"recorded original has a {e}") from None
    if rec.get("injected") is not None and rec["injected"] != planned:
        raise ValueError("recorded planned text does not match the recorded original and block")
    snap = ak_pointers.read_snapshot(path)
    if snap.text == original:
        return f"preparation did not change {ak_pointers.AGENTS_MD}"
    if snap.text == planned:
        ak_pointers.write_replacing(path, snap, original, snap.mode)
        return f"{ak_pointers.AGENTS_MD} restored byte for byte"
    raise ValueError(f"{ak_pointers.AGENTS_MD} matches neither the original nor the planned text; left as it is")


def load_settings() -> None:
    md.load_env_file()
    md.configure()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ak_skill_launch.py")
    sub = p.add_subparsers(dest="mode", required=True)
    f = sub.add_parser("fleet")
    f.add_argument("--wrapper", required=True)
    f.add_argument("args", nargs=argparse.REMAINDER)
    c = sub.add_parser("ctl")
    c.add_argument("op", choices=("hello", "finish"))
    c.add_argument("--pid", type=int, required=True, help="the wrapper's $$")
    c.add_argument("rc", nargs="?", type=int, default=0)
    w = sub.add_parser("worker-exec")
    w.add_argument("args", nargs=argparse.REMAINDER)
    d = sub.add_parser("direct")
    d.add_argument("--runtime", required=True, choices=("claude", "codex"))
    for name in ("--cwd", "--lane", "--spec", "--log"):
        d.add_argument(name, required=True)
    d.add_argument("--timeout", type=int, default=300)
    d.add_argument("--purpose", choices=("pilot", "coding"), default="pilot")
    r = sub.add_parser("recover")
    r.add_argument("--cwd", required=True)
    ns = p.parse_args(argv)
    if ns.mode == "ctl":
        return main_ctl(ns)
    if ns.mode == "worker-exec":
        return main_worker_exec(ns)
    load_settings()
    return {"fleet": main_fleet, "direct": main_direct, "recover": main_recover}[ns.mode](ns)


if __name__ == "__main__":
    sys.exit(main())
