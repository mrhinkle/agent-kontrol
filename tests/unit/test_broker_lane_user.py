#!/usr/bin/env python3
"""Lanes run as a separate OS user (#193). Stdlib unittest, Python 3.9 compatible.

A stub ``sudo`` on PATH stands in for the real one: it records its argv and the
environment it receives, runs the ops commands (``/usr/bin/test``, ``/bin/kill``)
as this user, and forks the fake CLI into its own process group. These stubs
prove how each command is built, not the privilege boundary (C12); the host
checks in the issue do that. No real sudo runs, no user is created, and nothing
here is a real secret.
"""
from __future__ import annotations

import json
import os
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents" / "dispatcher"))
import ak_pointers  # noqa: E402
import mc_dispatcher as md  # noqa: E402

REAL_POPEN = subprocess.Popen
FIXTURE = ROOT / "tests" / "unit" / "fixtures" / "lane_user_unset.json"
CHECKER = ROOT / "agents" / "dispatcher" / "lane-user-check.sh"
PREFIX = "lane user unavailable, no worker started"

# AC3 golden capture: a fixed parent environment, prompt, cwd and overlay.
CAPTURE_ENV = {
    "PATH": "/fixture/bin:/usr/bin:/bin",
    "HOME": "/fixture/home/dispatcher",
    "USER": "dispatcher",
    "LOGNAME": "dispatcher",
    "SHELL": "/bin/zsh",
    "LANG": "C.UTF-8",
    "ANTHROPIC_API_KEY": "fixture-anthropic-key-193",
    "OPENAI_API_KEY": "fixture-openai-key-193",
    "XAI_API_KEY": "fixture-xai-key-193",
    "MC_URL": "https://mc.fixture.invalid",
    "MC_TOKEN": "fixture-mc-token-193-NEVER",
    "MC_EVENT_TOKEN": "fixture-event-token-193-NEVER",
}
CAPTURE_PROMPT = "fixture prompt 193"
CAPTURE_CWD = "/fixture/worktree"
CAPTURE_OVERLAY = {
    "OPENROUTER_API_KEY": "akp_fixtureplaceholder193",
    "OPENROUTER_BASE_URL": "http://127.0.0.1:8765/openrouter",
    "GIT_CONFIG_COUNT": "2",
    "GIT_CONFIG_KEY_0": "credential.helper",
    "GIT_CONFIG_VALUE_0": "",
    "GIT_CONFIG_KEY_1": "credential.https://github.com.helper",
    "GIT_CONFIG_VALUE_1": "/fixture/agents/broker/git-credential-ak",
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_ASKPASS": "",
    "SSH_ASKPASS": "",
    "AK_GITHUB_PLACEHOLDER": "akp_" + "g" * 43,
    "AK_BROKER_URL": "http://127.0.0.1:8765",
    "AK_GITHUB_REPO": "fixture-owner/fixture-repo",
}
CAPTURE_MODES = ("worker", "review", "worker+overlay", "review+overlay")


class _Captured(Exception):
    pass


def capture_launches(mod) -> list:
    """What Popen (and the stop path) receive for each platform and mode, with MC_LANE_USER unset."""
    rows: list = []
    current: dict = {}

    class FakeProc:
        pid = 999_999

        def wait(self, timeout=None):
            current["timeout"] = timeout
            raise _Captured()

        def poll(self):
            return None

    def fake_popen(cmd, **kwargs):
        current["argv"] = list(cmd)
        current["env"] = dict(sorted(kwargs.pop("env").items()))
        current["cwd"] = kwargs.pop("cwd")
        current["start_new_session"] = kwargs.pop("start_new_session")
        current["stdin_devnull"] = kwargs.pop("stdin") is subprocess.DEVNULL
        current["stdout_file"] = hasattr(kwargs.pop("stdout"), "fileno")
        current["stderr_file"] = hasattr(kwargs.pop("stderr"), "fileno")
        current["other_kwargs"] = sorted(kwargs)
        return FakeProc()

    def fake_stop(proc, grace):
        current["stop"] = {"function": "stop_group", "pid": proc.pid, "grace": grace}
        return True

    with mock.patch.dict(os.environ, CAPTURE_ENV, clear=True), \
            mock.patch.object(mod.subprocess, "Popen", side_effect=fake_popen), \
            mock.patch.object(mod, "stop_group", side_effect=fake_stop), \
            mock.patch.object(mod, "ingest"), \
            mock.patch.object(mod, "TASK_TIMEOUT", 3600):
        for platform in ("claude-code", "codex", "grok"):
            for mode in CAPTURE_MODES:
                current.clear()
                kw = {"env_overlay": dict(CAPTURE_OVERLAY)} if mode.endswith("+overlay") else {}
                try:
                    mod.run_cli(platform, CAPTURE_PROMPT, Path(CAPTURE_CWD), review=mode.startswith("review"),
                                task_id=7, **kw)
                except _Captured:
                    pass
                rows.append({"platform": platform, "mode": mode, **current})
    return rows


def regenerate() -> None:
    """Write the golden fixture from the code path imported as ``md`` (run against main only)."""
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    data = {"source": "main 974dc9d, MC_LANE_USER unset", "rows": capture_launches(md)}
    FIXTURE.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


# ---------------------------------------------------------------------------
# Stubs. Each one is a Python script whose shebang is this interpreter.

STUB_SUDO = r'''
import json, os, signal, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))


def cfg():
    try:
        with open(os.path.join(HERE, "config.json")) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def log(kind, **extra):
    env = dict(os.environ)
    env.pop("__CF_USER_TEXT_ENCODING", None)  # macOS adds it to every process; Linux adds nothing
    entry = {"kind": kind, "argv": sys.argv[1:], "env": env, "pid": os.getpid(),
             "pgid": os.getpgrp(), **extra}
    fd = os.open(os.path.join(HERE, "sudo.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.write(fd, (json.dumps(entry) + "\n").encode())
    os.close(fd)


def members(pgid):
    """Live members of pgid other than the wrapper (pid == pgid): a lane user cannot signal root's sudo."""
    found = []
    if os.path.isdir("/proc/self"):
        for name in os.listdir("/proc"):
            if not name.isdigit() or int(name) == pgid:
                continue
            try:
                with open("/proc/%s/stat" % name) as f:
                    fields = f.read().rsplit(")", 1)[1].split()
            except (OSError, IndexError):
                continue
            if int(fields[2]) == pgid and fields[0] not in ("Z", "X"):
                found.append(int(name))
    else:
        out = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="], capture_output=True, text=True).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 3 and int(parts[1]) == pgid and int(parts[0]) != pgid and not parts[2].startswith("Z"):
                found.append(int(parts[0]))
    return found


c = cfg()
a = sys.argv[1:]
if len(a) < 4 or a[:2] != ["-n", "-u"] or a[2] != c.get("lane", a[2]):
    log("refused")
    sys.exit(1)
rest = a[3:]
if rest[0] == "/usr/bin/test":
    log("test")
    sys.exit(c.get("preflight_rc", 0))
if rest[0] == "/bin/kill" and len(rest) == 4 and rest[2] == "--" and rest[3][:1] == "-":
    sig, pgid = rest[1], int(rest[3][1:])
    log("kill", sig=sig)
    if sig == "-0":
        if "kill0_rc" in c:
            sys.exit(c["kill0_rc"])
        sys.exit(0 if members(pgid) else 1)
    if c.get("kill_noop"):
        sys.exit(1)
    num = {"-TERM": signal.SIGTERM, "-KILL": signal.SIGKILL}[sig]
    hit = False
    for pid in members(pgid):
        try:
            os.kill(pid, num)
            hit = True
        except OSError:
            pass
    sys.exit(0 if hit else 1)
if rest[0].startswith("--preserve-env=") and len(rest) >= 3 and rest[1] == "--":
    log("launch")
    child = os.fork()
    if child == 0:
        os.execv(rest[2], rest[2:])
    _, status = os.waitpid(child, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
if rest[0] == "--" and len(rest) >= 2:
    log("probe")
    os.execv(rest[1], rest[1:])
log("refused")
sys.exit(1)
'''

STUB_CLI = r'''
import json, os, signal, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
try:
    with open(os.path.join(HERE, "config.json")) as f:
        c = json.load(f).get("cli", {})
except FileNotFoundError:
    c = {}
entry = {"argv": sys.argv, "pid": os.getpid(), "pgid": os.getpgrp(), "uid": os.getuid()}
if c.get("orphan"):
    # Leave a TERM-ignoring child in this process group, then exit normally.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    child = os.fork()
    if child == 0:
        time.sleep(60)
        os._exit(0)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    entry["orphan_pid"] = child
fd = os.open(os.path.join(HERE, "cli.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
os.write(fd, (json.dumps(entry) + "\n").encode())
os.close(fd)
if c.get("ignore_term"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(c.get("sleep", 0))
print(json.dumps({"type": "result", "result": "RESULT: ok", "is_error": False}))
'''

STUB_ID = r'''
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "config.json")) as f:
    ids = json.load(f).get("ids", {})
a = sys.argv[1:]
if a == ["-u"]:
    print(os.getuid())
    sys.exit(0)
if len(a) == 2 and a[0] == "-u" and a[1] in ids:
    print(ids[a[1]])
    sys.exit(0)
sys.exit(1)
'''

LANE = "aklane"
LANE_UID = os.geteuid() + 4242
LANE_SHELL = "/bin/sh"
BLOCK = f'{ak_pointers.POINTERS_BEGIN}\n- a (1.0.0, aaaaaaa) — first. Fetch: get_skill {{"id":"a"}}\n{ak_pointers.POINTERS_END}'
AGENTS_TEXT = "# fixture AGENTS.md\n"
RECOVERY_TEXT = '{"fixture": "recovery record"}\n'


def _short_tmp(test: unittest.TestCase) -> Path:
    # AF_UNIX paths are limited to ~104 bytes; keep the directory short.
    base = "/tmp" if os.path.isdir("/tmp") else None
    path = Path(tempfile.mkdtemp(prefix="aklu-", dir=base)).resolve()
    test.addCleanup(_rmtree, path)
    return path


def _rmtree(path: Path) -> None:
    for root, dirs, _files in os.walk(str(path)):
        for d in dirs:
            try:
                os.chmod(os.path.join(root, d), 0o700)
            except OSError:
                pass
    subprocess.run(["rm", "-rf", str(path)], check=False)


def _script(path: Path, body: str) -> None:
    path.write_text(f"#!{sys.executable} -I\n" + body)
    os.chmod(path, 0o755)


def make_stubs(directory: Path, config: dict) -> None:
    directory.mkdir(exist_ok=True)
    _script(directory / "sudo", STUB_SUDO)
    _script(directory / "id", STUB_ID)
    for cli in ("claude", "codex", "grok"):
        _script(directory / cli, STUB_CLI)
    (directory / "config.json").write_text(json.dumps(config))


def read_jsonl(path: Path) -> list:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


class FakePw:
    def __init__(self, name: str, uid: int, home: str, shell: str) -> None:
        self.pw_name, self.pw_uid, self.pw_dir, self.pw_shell = name, uid, home, shell
        self.pw_gid, self.pw_gecos, self.pw_passwd = uid, "", "x"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class LaneHarness(unittest.TestCase):
    """run_task and run_cli with a stub sudo on PATH; no git, no network, no real CLI."""

    platform = "claude-code"

    def setUp(self) -> None:
        self.base = _short_tmp(self)
        self.stub = self.base / "stub"
        self.config = {"lane": LANE}
        make_stubs(self.stub, self.config)
        self.wt = self.base / "wt"
        self.wt.mkdir()
        (self.wt / "AGENTS.md").write_text(AGENTS_TEXT)
        self.git_dir = self.base / "gitdir"
        self.git_dir.mkdir()
        self.lane_home = str(self.base / "lanehome")
        self.passwd = {
            LANE: FakePw(LANE, LANE_UID, self.lane_home, LANE_SHELL),
            "rootuser": FakePw("rootuser", 0, "/root", "/bin/sh"),
            "selfuser": FakePw("selfuser", os.geteuid(), "/home/self", "/bin/sh"),
            "nohome": FakePw("nohome", LANE_UID + 1, "", "/bin/sh"),
            "noshell": FakePw("noshell", LANE_UID + 2, "/home/noshell", ""),
        }
        self.events: list = []
        self.calls: list = []
        self.ingests: list = []
        self.popens: list = []
        self.procs: list = []
        self.path = f"{self.stub}:/usr/bin:/bin"
        env = dict(CAPTURE_ENV, PATH=self.path, LC_ALL="C", MC_LANE_USER=LANE)
        real_popen = subprocess.Popen

        def spy(cmd, *args, **kwargs):
            self.popens.append(list(cmd))
            self.events.append(("popen", list(cmd)))
            proc = real_popen(cmd, *args, **kwargs)
            self.procs.append((list(cmd), proc))
            return proc

        for p in (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(md.subprocess, "Popen", side_effect=spy),
            mock.patch.object(md.pwd, "getpwnam", side_effect=self.getpwnam),
            mock.patch.object(md, "resolve_project", side_effect=lambda project, workdir: self.wt),
            mock.patch.object(md, "linked_worktree_git_dir", side_effect=lambda cwd: self.git_dir),
            mock.patch.object(md, "git", side_effect=lambda cwd, *a: subprocess.CompletedProcess(["git", *a], 1, "", "")),
            mock.patch.object(md, "api", side_effect=self.fake_api),
            mock.patch.object(md, "ingest", side_effect=self.fake_ingest),
            mock.patch.object(md, "KILL_GRACE", 1.0),
            mock.patch.object(md, "LANE_POLL", 0.05),
            mock.patch.object(md, "TASK_TIMEOUT", 30),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.reap_all)

    def reap_all(self) -> None:
        for cli in read_jsonl(self.stub / "cli.jsonl"):
            if _alive(cli["pid"]):
                try:
                    os.kill(cli["pid"], signal.SIGKILL)
                except OSError:
                    pass
        for _cmd, proc in self.procs:
            if proc.returncode is None:
                try:
                    proc.kill()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass

    def set_config(self, **values: object) -> None:
        self.config.update(values)
        (self.stub / "config.json").write_text(json.dumps(self.config))

    def getpwnam(self, name: str) -> FakePw:
        if name not in self.passwd:
            raise KeyError(name)
        return self.passwd[name]

    def fake_api(self, path: str, body: object = None, method: str = "POST", max_bytes: object = None) -> dict:
        self.calls.append((path, body, method))
        self.events.append(("api", method, path, (body or {}).get("status") if isinstance(body, dict) else None))
        if path.startswith("/api/skills/pointers"):
            return {"demo": False, "lane": "proj", "runtime": "claude", "empty": False, "block": BLOCK}
        return {}

    def fake_ingest(self, *args: object, **kwargs: object) -> None:
        self.ingests.append((args, kwargs))
        self.events.append(("ingest",))

    def sudo_log(self, kind: str | None = None) -> list:
        rows = read_jsonl(self.stub / "sudo.jsonl")
        return [r for r in rows if kind is None or r["kind"] == kind]

    def cli_log(self) -> list:
        return read_jsonl(self.stub / "cli.jsonl")

    def lane(self) -> md.LaneUser:
        return md.lane_user()

    def dispatch(self, **extra: object) -> dict:
        sem = threading.Semaphore(1)
        sem.acquire()
        task = {"id": 7, "title": "t", "project": "proj", **extra}
        md.run_task(task, self.platform, sem)
        self.assertTrue(sem.acquire(blocking=False), "semaphore not released")
        lock = md.WorktreeLock(self.git_dir)
        lock.acquire(self.wt)  # raises DispatchRefused if still held
        lock.release()
        patches = [c[1] for c in self.calls if c[2] == "PATCH"]
        return patches[-1]

    def expected_env(self, platform: str, mode: str) -> dict:
        row = self.fixture_row(platform, mode)
        env = dict(row["env"], PATH=self.path, LC_ALL="C")
        env.update({"HOME": self.lane_home, "USER": LANE, "LOGNAME": LANE, "SHELL": LANE_SHELL})
        return env

    @staticmethod
    def fixture_row(platform: str, mode: str) -> dict:
        rows = json.loads(FIXTURE.read_text())["rows"]
        return next(r for r in rows if r["platform"] == platform and r["mode"] == mode)


def ops_env(row: dict) -> dict:
    """The env an ops sudo got. The stub is Python, which adds LC_CTYPE=C.UTF-8 itself (PEP 538) when no locale is set."""
    env = dict(row["env"])
    if env.get("LC_CTYPE") == "C.UTF-8":
        del env["LC_CTYPE"]
    return env


def _secret_values() -> list:
    """Every fixture value that would be a leak if it showed up in an argv."""
    values = [v for k, v in CAPTURE_ENV.items() if k not in ("USER", "LOGNAME")]
    values += [v for v in CAPTURE_OVERLAY.values() if len(v) > 4]
    return [v for v in values if v]


class TestLaneLaunch(LaneHarness):
    def test_ac1_launch_matrix_argv_env_and_no_value_in_argv(self) -> None:
        # AC1, C5, C6: six worker/reviewer rows, with and without the broker/GitHub overlay.
        lane = self.lane()
        for platform in ("claude-code", "codex", "grok"):
            for mode in CAPTURE_MODES:
                with self.subTest(platform=platform, mode=mode):
                    for name in ("sudo.jsonl", "cli.jsonl"):
                        (self.stub / name).unlink() if (self.stub / name).exists() else None
                    kw = {"env_overlay": dict(CAPTURE_OVERLAY)} if mode.endswith("+overlay") else {}
                    md.run_cli(platform, CAPTURE_PROMPT, self.wt, review=mode.startswith("review"),
                               task_id=7, lane=lane, **kw)
                    main_argv = self.fixture_row(platform, mode)["argv"]
                    env = self.expected_env(platform, mode)
                    launches = self.sudo_log("launch")
                    self.assertEqual(len(launches), 1)
                    launch = launches[0]
                    exe = str(self.stub / main_argv[0])
                    self.assertEqual(launch["argv"], [
                        "-n", "-u", LANE, "--preserve-env=" + ",".join(sorted(env)), "--", exe, *main_argv[1:],
                    ])
                    self.assertEqual(launch["env"], env)
                    names = launch["argv"][3][len("--preserve-env="):].split(",")
                    self.assertEqual(names, sorted(env))
                    self.assertNotIn("MC_TOKEN", names)
                    self.assertNotIn("MC_EVENT_TOKEN", names)
                    self.assertNotIn("MC_LANE_USER", names)
                    if kw:
                        for name in ("AK_GITHUB_PLACEHOLDER", "AK_BROKER_URL", "AK_GITHUB_REPO", "GIT_CONFIG_COUNT",
                                     "GIT_CONFIG_VALUE_1", "GIT_TERMINAL_PROMPT", "OPENROUTER_API_KEY"):
                            self.assertIn(name, names)
                    self.assertEqual(launch["pid"], launch["pgid"], "sudo leads its own process group")
                    cli = self.cli_log()
                    self.assertEqual(len(cli), 1)
                    self.assertEqual(cli[0]["argv"], [exe, *main_argv[1:]])
                    self.assertEqual(cli[0]["pgid"], launch["pgid"], "the CLI runs in sudo's process group")
        argvs = self.popens + [["sudo", *r["argv"]] for r in self.sudo_log()]
        self.assertTrue(argvs)
        for argv in argvs:
            for element in argv:
                for value in _secret_values():
                    self.assertNotIn(value, element, f"fixture value in argv {argv!r}")
                if "=" in element:
                    self.assertTrue(element.startswith("--preserve-env="), f"K=V in argv {argv!r}")

    def test_ac1_mc_args_with_lane_user_fail_closed_with_no_process(self) -> None:
        # C5: per-machine CLI args are env values; with a lane user they fail closed before anything runs.
        value = "--fixture-args-193-VALUE"
        for var in md.LANE_REFUSED_ARGS:
            for platform in ("claude-code", "codex", "grok"):
                with self.subTest(var=var, platform=platform):
                    self.calls.clear()
                    self.ingests.clear()
                    self.popens.clear()
                    self.platform = platform
                    with mock.patch.dict(os.environ, {var: "  " + value + "  "}):
                        body = self.dispatch(reviewer_platform="codex")
                    self.assertEqual(body["status"], "failed")
                    self.assertEqual(body["result"], f"{PREFIX}: {var} is not supported with a lane user")
                    self.assertEqual(len([c for c in self.calls if c[2] == "PATCH"]), 1)
                    self.assertEqual(self.ingests, [])
                    self.assertEqual(self.popens, [], "no sudo, preflight or CLI")
                    self.assertEqual(self.sudo_log(), [])
                    self.assertEqual(self.cli_log(), [])
                    self.assertEqual((self.wt / "AGENTS.md").read_text(), AGENTS_TEXT)
        self.platform = "claude-code"
        # Whitespace-only is unset; the task runs as the lane user.
        with mock.patch.dict(os.environ, {"MC_CODEX_ARGS": "   "}):
            self.assertEqual(md.lane_user().name, LANE)
        # Direct callers of run_cli are refused too, for their own platform's variable.
        lane = self.lane()
        for var, platform in zip(md.LANE_REFUSED_ARGS, ("claude-code", "codex", "grok")):
            with mock.patch.dict(os.environ, {var: value}):
                ok, out, _ = md.run_cli(platform, CAPTURE_PROMPT, self.wt, task_id=7, lane=lane)
            self.assertFalse(ok)
            self.assertEqual(out, f"{PREFIX}: {var} is not supported with a lane user")
        self.assertEqual(self.popens, [])
        self.assertEqual(self.sudo_log(), [])
        for argv in self.popens + [r["argv"] for r in self.sudo_log()]:
            self.assertFalse(any(value in x for x in argv))
        # Unset lane user: MC_*_ARGS still reach the CLI argv as on main.
        os.environ.pop("MC_LANE_USER")
        with mock.patch.dict(os.environ, {"MC_CLAUDE_ARGS": "--fixture-flag"}):
            md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7)
        self.assertIn(["claude", "-p", CAPTURE_PROMPT, "--output-format", "json", "--fixture-flag"], self.popens)

    def test_tokens_are_never_preserved(self) -> None:
        # Binding constraint: MC_TOKEN and MC_EVENT_TOKEN never reach a lane, even if a mapping held them.
        lane = self.lane()
        for name in ("MC_TOKEN", "MC_EVENT_TOKEN"):
            with self.subTest(name=name):
                child = {"PATH": self.path, name: "fixture-token-in-child"}
                with mock.patch.object(md.child_env, "build_child_env", return_value=dict(child)):
                    ok, out, _ = md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=lane)
                self.assertFalse(ok)
                self.assertTrue(out.startswith(PREFIX), out)
                self.assertNotIn("fixture-token-in-child", out)
                self.assertEqual(self.sudo_log("launch"), [])
                ok, out, _ = md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=lane,
                                        env_overlay={name: "fixture-token-in-overlay"})
                self.assertFalse(ok)
                self.assertTrue(out.startswith(PREFIX), out)
                self.assertEqual(self.sudo_log("launch"), [])
        self.assertEqual(self.cli_log(), [])

    def test_unpreservable_name_missing_cli_and_missing_sudo_fail_closed(self) -> None:
        lane = self.lane()
        with mock.patch.object(md.child_env, "build_child_env", return_value={"PATH": self.path, "A,B": "x"}):
            ok, out, _ = md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=lane)
        self.assertTrue(out.startswith(PREFIX) and not ok, out)
        with mock.patch.object(md.shutil, "which", return_value=None):
            ok, out, _ = md.run_cli("codex", CAPTURE_PROMPT, self.wt, task_id=7, lane=lane)
        self.assertTrue(out.startswith(PREFIX) and not ok, out)
        real = subprocess.Popen

        def no_sudo(cmd, *a, **k):
            if cmd[0] == "sudo" and any(str(x).startswith("--preserve-env=") for x in cmd):
                raise FileNotFoundError("sudo")
            return real(cmd, *a, **k)

        with mock.patch.object(md.subprocess, "Popen", side_effect=no_sudo):
            ok, out, _ = md.run_cli("grok", CAPTURE_PROMPT, self.wt, task_id=7, lane=lane)
        self.assertEqual(out, f"{PREFIX}: sudo could not start")
        self.assertFalse(ok)
        self.assertEqual(self.sudo_log("launch"), [])
        self.assertEqual(self.cli_log(), [])

    def test_dispatched_worker_and_reviewer_both_run_as_lane(self) -> None:
        body = self.dispatch(reviewer_platform="codex")
        launches = self.sudo_log("launch")
        self.assertEqual(len(launches), 2, body)
        self.assertEqual([r["argv"][5] for r in launches], [str(self.stub / "claude"), str(self.stub / "codex")])
        for row in launches:
            self.assertEqual((row["env"]["HOME"], row["env"]["USER"], row["env"]["LOGNAME"], row["env"]["SHELL"]),
                             (self.lane_home, LANE, LANE, LANE_SHELL))
        self.assertEqual(len(self.sudo_log("test")), 1)
        self.assertFalse([p for p in self.popens if p[0] in ("claude", "codex", "grok") or p[0].startswith(str(self.stub) + "/c")])


class TestLaneFailClosed(LaneHarness):
    INVALID = ("", " ", "\t", " aklane", "aklane ", "ak\nlane", "-u", "nosuchuser",
               "rootuser", "selfuser", "nohome", "noshell")

    def assert_no_worker(self, body: dict) -> None:
        self.assertEqual(body["status"], "failed")
        self.assertTrue(body["result"].startswith(PREFIX), body["result"])
        patches = [c for c in self.calls if c[2] == "PATCH"]
        self.assertEqual(len(patches), 1, patches)
        self.assertFalse([c for c in self.calls if c[0].startswith("/api/skills/pointers")])
        self.assertEqual(self.ingests, [])
        self.assertEqual(self.sudo_log("launch"), [])
        self.assertEqual(self.cli_log(), [])
        self.assertFalse([p for p in self.popens if p[0] != "sudo" or "--preserve-env" in " ".join(p)])
        self.assertEqual((self.wt / "AGENTS.md").read_text(), AGENTS_TEXT)
        self.assertEqual(sorted(os.listdir(self.wt)), ["AGENTS.md"])

    def test_ac2_each_invalid_lane_user_fails_closed_without_fallback(self) -> None:
        for value in self.INVALID:
            with self.subTest(value=value):
                self.calls.clear()
                self.ingests.clear()
                self.popens.clear()
                with mock.patch.dict(os.environ, {"MC_LANE_USER": value}):
                    body = self.dispatch()
                self.assert_no_worker(body)
                self.assertEqual(self.popens, [], "an invalid lane user runs nothing, not even the preflight")
                self.assertEqual(self.sudo_log(), [])

    def test_ac2_failing_preflight_fails_closed(self) -> None:
        self.set_config(preflight_rc=1)
        body = self.dispatch()
        self.assert_no_worker(body)
        tests = self.sudo_log("test")
        self.assertEqual([r["argv"] for r in tests], [["-n", "-u", LANE, "/usr/bin/test", "-w", str(self.wt)]])
        self.assertEqual(ops_env(tests[0]), {"PATH": self.path}, "the preflight's sudo holds no secrets")

    def test_c7_preflight_runs_before_recovery_check_and_leaves_record_untouched(self) -> None:
        record = self.git_dir / md.SKILL_RECOVERY_NAME
        record.write_text(RECOVERY_TEXT)
        before = os.stat(record)
        self.set_config(preflight_rc=1)
        body = self.dispatch()
        self.assert_no_worker(body)
        self.assertEqual(record.read_text(), RECOVERY_TEXT)
        self.assertEqual(os.stat(record).st_mtime_ns, before.st_mtime_ns)
        # A good lane user reaches the recovery check, which still refuses as on main.
        self.calls.clear()
        self.set_config(preflight_rc=0)
        body = self.dispatch()
        self.assertIn("records an interrupted skills launch", body["result"])
        self.assertEqual(record.read_text(), RECOVERY_TEXT)
        self.assertEqual(self.sudo_log("launch"), [])

    def test_c7_preflight_order_after_lock_before_broker_pointers_running_ingest_and_cli(self) -> None:
        real_acquire, real_release = md.WorktreeLock.acquire, md.WorktreeLock.release

        def acquire(lock: object, worktree: Path) -> None:
            real_acquire(lock, worktree)
            self.events.append(("lock",))

        def release(lock: object) -> None:
            self.events.append(("unlock",))
            real_release(lock)

        def refuse(git_dir: Path) -> None:
            self.events.append(("recovery",))

        real_inject = ak_pointers.inject

        def inject(cwd: Path, block: str) -> object:
            self.events.append(("inject",))
            return real_inject(cwd, block)

        with mock.patch.object(md.WorktreeLock, "acquire", acquire), \
                mock.patch.object(md.WorktreeLock, "release", release), \
                mock.patch.object(md, "refuse_unresolved_recovery", side_effect=refuse), \
                mock.patch.object(ak_pointers, "inject", side_effect=inject):
            body = self.dispatch()
            self.assertEqual(body["status"], "done", body)

            def index(pred) -> int:
                return next(i for i, e in enumerate(self.events) if pred(e))

            lock = index(lambda e: e[0] == "lock")
            preflight = index(lambda e: e[0] == "popen")
            self.assertEqual(self.events[preflight][1], ["sudo", "-n", "-u", LANE, "/usr/bin/test", "-w", str(self.wt)])
            self.assertLess(lock, preflight)
            self.assertLess(preflight, index(lambda e: e[0] == "recovery"))
            self.assertLess(preflight, index(lambda e: e[0] == "api" and e[2].startswith("/api/skills/pointers")))
            self.assertLess(preflight, index(lambda e: e[0] == "inject"))
            self.assertLess(preflight, index(lambda e: e[0] == "api" and e[3] == "running"))
            self.assertLess(preflight, index(lambda e: e[0] == "ingest"))
            launch = index(lambda e: e[0] == "popen" and any(x.startswith("--preserve-env=") for x in e[1]))
            self.assertLess(preflight, launch)
            self.assertLess(launch, index(lambda e: e[0] == "unlock"))
            # The broker is contacted only after the preflight: with a failing preflight it is never reached.
            self.calls.clear()
            self.set_config(preflight_rc=1)
            with mock.patch.dict(os.environ, {"MC_BROKER_SOCKET": str(self.base / "absent.sock")}), \
                    mock.patch.object(md.socket, "socket", side_effect=AssertionError("broker contacted")):
                body = self.dispatch()
            self.assertTrue(body["result"].startswith(PREFIX), body["result"])
            self.set_config(preflight_rc=0)
            with mock.patch.dict(os.environ, {"MC_BROKER_SOCKET": str(self.base / "absent.sock")}):
                body = self.dispatch()
            self.assertTrue(body["result"].startswith(md.BROKER_UNAVAILABLE), body["result"])

    def test_c6_lane_user_read_after_env_file_and_not_trimmed(self) -> None:
        home = self.base / "home"
        (home / ".claude").mkdir(parents=True)
        (home / ".claude" / "mission-control.env").write_text("MC_LANE_USER=nosuchuser\n")
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            md.load_env_file()  # setdefault: the exported value wins
            self.assertEqual(os.environ["MC_LANE_USER"], LANE)
            self.assertEqual(md.lane_user().name, LANE)
        with self.assertRaises(md.LaneUserUnavailable):
            md.lane_user({"MC_LANE_USER": LANE + " "})
        self.assertIsNone(md.lane_user({}))
        with mock.patch.object(md.os, "geteuid", return_value=LANE_UID):
            with self.assertRaises(md.LaneUserUnavailable):
                md.lane_user({"MC_LANE_USER": LANE})


class TestLaneUnsetGolden(unittest.TestCase):
    def test_ac3_unset_matches_main_golden_fixture(self) -> None:
        # AC3, C11: argv, env, cwd, timeout, start_new_session and the stop path, byte for byte.
        expected = json.loads(FIXTURE.read_text())["rows"]
        self.assertEqual(len(expected), 12)
        rows = capture_launches(md)
        self.assertEqual(json.dumps(rows, indent=2, sort_keys=True), json.dumps(expected, indent=2, sort_keys=True))


class TestLaneUnset(LaneHarness):
    def test_ac3_unset_task_runs_no_sudo(self) -> None:
        os.environ.pop("MC_LANE_USER")
        with mock.patch.object(md, "lane_preflight", side_effect=AssertionError("preflight ran")):
            body = self.dispatch(reviewer_platform="codex")
        self.assertIn(body["status"], ("done", "failed"), body)
        self.assertEqual(self.sudo_log(), [])
        self.assertFalse([p for p in self.popens if p[0] == "sudo"])
        self.assertEqual([p[0] for p in self.popens], ["claude", "codex"])


class TestLaneContainment(LaneHarness):
    def kill_rows(self) -> list:
        return [(r["argv"][4], r["argv"][6]) for r in self.sudo_log("kill")]

    def wrapper(self) -> subprocess.Popen:
        return next(p for cmd, p in self.procs if any(x.startswith("--preserve-env=") for x in cmd))

    def test_ac5_timeout_signals_recorded_group_through_permitted_kill_and_reaps(self) -> None:
        self.set_config(cli={"ignore_term": True, "sleep": 60})
        with mock.patch.object(md, "TASK_TIMEOUT", 3), \
                mock.patch.object(md.os, "killpg", wraps=os.killpg) as killpg:
            ok, out, _ = md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=self.lane())
        self.assertFalse(ok)
        self.assertEqual(out, "timed out after 3s")
        launch = self.sudo_log("launch")[0]
        pgid = launch["pid"]
        cli = self.cli_log()[0]
        self.assertEqual(cli["pgid"], pgid)
        rows = self.kill_rows()
        self.assertTrue(rows and all(target == f"-{pgid}" for _sig, target in rows), rows)
        sigs = [s for s, _t in rows]
        self.assertEqual(sigs[0], "-TERM")
        self.assertIn("-KILL", sigs)
        self.assertLess(sigs.index("-TERM"), sigs.index("-KILL"))
        self.assertEqual(sigs[-1], "-0")
        for row in self.sudo_log("kill"):
            self.assertEqual(row["argv"][:4], ["-n", "-u", LANE, "/bin/kill"])
            self.assertEqual(row["argv"][5], "--")
            self.assertEqual(ops_env(row), {"PATH": self.path})
        self.assertFalse(_alive(cli["pid"]), "the lane CLI survived")
        self.assertIsNotNone(self.wrapper().returncode, "the sudo wrapper was not reaped")
        # The dispatcher never signals the group itself; only a final signal-0 probe after the reap.
        self.assertTrue(killpg.call_args_list)
        self.assertTrue(all(c.args == (pgid, 0) for c in killpg.call_args_list), killpg.call_args_list)

    def test_ac5_normal_exit_confirms_group_gone_without_kill(self) -> None:
        ok, out, _ = md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=self.lane())
        self.assertTrue(ok, out)
        sigs = [s for s, _t in self.kill_rows()]
        self.assertEqual(sigs[0], "-TERM")
        self.assertEqual(sigs[-1], "-0")
        self.assertNotIn("-KILL", sigs)

    def test_ac5_containment_error_when_stub_reports_group_alive(self) -> None:
        self.set_config(kill0_rc=0, cli={"sleep": 60})
        with mock.patch.object(md, "TASK_TIMEOUT", 2):
            with self.assertRaises(md.ContainmentError):
                md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=self.lane())
        self.assertIsNone(self.wrapper().returncode, "the wrapper must not be reaped before confirmation")
        sigs = [s for s, _t in self.kill_rows()]
        self.assertIn("-TERM", sigs)
        self.assertIn("-KILL", sigs)

    def test_containment_error_when_wrapper_outlives_its_group(self) -> None:
        # sudo kill reports the group gone but the CLI is still running (a broken rule, or use_pty).
        self.set_config(kill0_rc=1, kill_noop=True, cli={"sleep": 60})
        with mock.patch.object(md, "TASK_TIMEOUT", 2):
            with self.assertRaises(md.ContainmentError) as ctx:
                md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=self.lane())
        self.assertIn("sudo wrapper did not exit", str(ctx.exception))

    def test_containment_error_when_members_remain_after_reap(self) -> None:
        lane = self.lane()
        with mock.patch.object(md.os, "killpg", side_effect=PermissionError()):
            with self.assertRaises(md.ContainmentError) as ctx:
                md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=lane)
        self.assertIn("cannot signal", str(ctx.exception))


class TestLaneNormalExitOrphan(LaneHarness):
    """C9 on the normal-exit path: the wrapper stays unreaped until its group is confirmed gone."""

    def setUp(self) -> None:
        super().setUp()
        self.libc = None
        if sys.platform.startswith("linux"):
            try:
                import ctypes
                self.libc = ctypes.CDLL(None, use_errno=True)
                self.libc.prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER: orphans come back to this process
            except Exception:
                self.libc = None
        self.stop_reaper = threading.Event()
        self.reaper = threading.Thread(target=self.reap_orphan, daemon=True)
        self.reaper.start()

    def tearDown(self) -> None:
        self.stop_reaper.set()
        self.reaper.join(5)
        if self.libc is not None:
            self.libc.prctl(36, 0, 0, 0, 0)

    def reap_orphan(self) -> None:
        # Stands in for init: reaps only the orphan, once it is our child (subreaper, or PID 1 in a container).
        while not self.stop_reaper.is_set():
            for row in self.cli_log():
                if "orphan_pid" in row:
                    try:
                        os.waitpid(row["orphan_pid"], os.WNOHANG)
                    except ChildProcessError:
                        pass
            time.sleep(0.02)

    def test_c9_normal_exit_with_child_left_in_group_stops_group_before_reap(self) -> None:
        self.set_config(cli={"orphan": True})
        order: list = []
        real_wait = REAL_POPEN.wait
        real_unreaped = md._wait_exit_unreaped
        real_op = md._lane_op

        def reap(proc, *a, **k):
            order.append(("reap", proc.pid))
            return real_wait(proc, *a, **k)

        def unreaped(pid, timeout):
            done = real_unreaped(pid, timeout)
            order.append(("exited-unreaped", pid, done))
            return done

        def op(lane, *args, **kw):
            code = real_op(lane, *args, **kw)
            if args and args[0] == md.LANE_KILL:
                order.append(("kill", args[1], args[3], code))
            return code

        patches = [mock.patch.object(REAL_POPEN, "wait", reap),
                   mock.patch.object(md, "_wait_exit_unreaped", side_effect=unreaped),
                   mock.patch.object(md, "_lane_op", side_effect=op)]
        waitid = None
        if hasattr(os, "waitid"):
            waitid = mock.patch.object(md.os, "waitid", wraps=os.waitid)
            patches.append(waitid)
        started = [p.start() for p in patches]
        try:
            ok, out, _ = md.run_cli("claude-code", CAPTURE_PROMPT, self.wt, task_id=7, lane=self.lane())
        finally:
            for p in patches:
                p.stop()
        self.assertTrue(ok, out)
        launch = self.sudo_log("launch")[0]
        pgid = launch["pid"]
        orphan = next(r["orphan_pid"] for r in self.cli_log() if "orphan_pid" in r)
        wrapper_reaps = [i for i, e in enumerate(order) if e == ("reap", pgid)]
        self.assertTrue(wrapper_reaps, order)
        first_reap = wrapper_reaps[0]
        before = order[:first_reap]
        self.assertEqual(before[0], ("exited-unreaped", pgid, True), order)
        kills = [e for e in before if e[0] == "kill"]
        self.assertTrue(all(target == f"-{pgid}" for _k, _s, target, _c in kills), kills)
        sigs = [sig for _k, sig, _t, _c in kills]
        self.assertEqual(sigs[0], "-TERM")
        self.assertIn("-KILL", sigs, "the TERM-ignoring child needed SIGKILL")
        self.assertLess(sigs.index("-TERM"), sigs.index("-KILL"))
        self.assertEqual((sigs[-1], kills[-1][3]), ("-0", 1), "confirmed gone before the reap")
        self.assertFalse(_alive(orphan) and not _zombie(orphan), "the child left in the group survived")
        if waitid is not None:
            calls = started[-1].call_args_list
            self.assertTrue(calls)
            for call in calls:
                self.assertTrue(call.args[2] & os.WNOWAIT, call)


def _zombie(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] == "Z"
    except (OSError, IndexError):
        out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return out.startswith("Z") or out == ""


class TestLaneUserCheck(unittest.TestCase):
    """AC4 with a stub sudo and stub id: each probe really runs, as this user."""

    def setUp(self) -> None:
        self.base = _short_tmp(self)
        self.stub = self.base / "stub"
        make_stubs(self.stub, {"lane": LANE, "ids": {LANE: LANE_UID, "rootuser": 0, "selfuser": os.getuid()}})
        self.canary = "fixture-secret-CONTENT-193"
        self.sockets: list = []

    def tearDown(self) -> None:
        for s in self.sockets:
            s.close()

    def file(self, name: str, mode: int = 0o600) -> str:
        path = self.base / name
        path.write_text(f"KEY={self.canary}\n")
        os.chmod(path, mode)
        return str(path)

    def listening(self, name: str, parent_mode: int | None = None, listen: bool = True) -> str:
        parent = self.base / (name + ".d")
        parent.mkdir()
        path = parent / "s"
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(str(path))
        if listen:
            s.listen(4)
        self.sockets.append(s)
        if parent_mode is not None:
            os.chmod(parent, parent_mode)
        return str(path)

    def run_check(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(CHECKER), *args], capture_output=True, text=True, timeout=120,
                              env={"PATH": f"{self.stub}:{os.path.dirname(sys.executable)}:/usr/bin:/bin"})

    def probes(self) -> list:
        return [r for r in read_jsonl(self.stub / "sudo.jsonl") if r["kind"] == "probe"]

    def need_non_root(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("permission denials need a non-root test user")

    def test_ac4_all_denied_exits_zero(self) -> None:
        self.need_non_root()
        targets = [self.file("config", 0), self.file("providers", 0), self.listening("adm", 0),
                   self.file("env", 0), self.file("prov", 0)]
        out = self.run_check(LANE, *targets)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertEqual(out.stdout.splitlines(), [f"DENIED {t}" for t in targets])
        probes = self.probes()
        self.assertEqual(len(probes), 5)
        kinds = ["file", "file", "socket", "file", "file"]
        for row, target, kind in zip(probes, targets, kinds):
            argv = row["argv"]
            self.assertEqual(argv[:5], ["-n", "-u", LANE, "--", argv[4]])
            self.assertTrue(os.path.isabs(argv[4]))
            self.assertEqual(argv[5:7], ["-I", "-c"])
            self.assertEqual(argv[8:], [kind, target], "each path is one operand")

    def test_ac4_one_readable_target_among_denied_fails(self) -> None:
        self.need_non_root()
        targets = [self.file("config", 0), self.file("providers", 0o600), self.listening("adm", 0),
                   self.file("env", 0), self.file("prov", 0)]
        out = self.run_check(LANE, *targets)
        self.assertEqual(out.returncode, 1)
        self.assertEqual([line.split()[0] for line in out.stdout.splitlines()],
                         ["DENIED", "READABLE", "DENIED", "DENIED", "DENIED"])
        self.assertNotIn(self.canary, out.stdout + out.stderr)

    def test_ac4_readable_and_inconclusive_targets_fail(self) -> None:
        self.need_non_root()
        directory = self.base / "adir"
        directory.mkdir()
        targets = [self.file("config", 0), self.file("providers", 0o600), self.listening("adm"),
                   str(self.base / "missing.env"), str(directory)]
        out = self.run_check(LANE, *targets)
        self.assertEqual(out.returncode, 1)
        self.assertEqual(out.stdout.splitlines(), [
            f"DENIED {targets[0]}", f"READABLE {targets[1]}", f"READABLE {targets[2]}",
            f"INCONCLUSIVE {targets[3]}", f"INCONCLUSIVE {targets[4]}",
        ])
        self.assertNotIn(self.canary, out.stdout + out.stderr)

    def test_ac4_refused_or_non_socket_and_relative_paths_are_inconclusive(self) -> None:
        targets = [self.file("config", 0o600), "relative/providers.json", self.listening("adm", listen=False),
                   self.file("env", 0o600)]
        out = self.run_check(LANE, *targets, self.file("sock-is-file", 0o600))
        self.assertEqual(out.returncode, 1)
        lines = out.stdout.splitlines()
        self.assertEqual(lines[1], "INCONCLUSIVE relative/providers.json")
        self.assertEqual(lines[2], f"INCONCLUSIVE {targets[2]}")
        out = self.run_check(LANE, self.file("c2"), self.file("p2"), self.file("not-a-socket"), self.file("e2"))
        self.assertEqual(out.stdout.splitlines()[2], f"INCONCLUSIVE {self.base / 'not-a-socket'}")
        self.assertNotIn(self.canary, out.stdout + out.stderr)

    def test_ac4_invalid_lane_user_is_inconclusive_and_runs_no_probe(self) -> None:
        for lane in ("nosuchuser", "rootuser", "selfuser"):
            with self.subTest(lane=lane):
                targets = [str(self.base / f"{lane}{i}") for i in range(4)]
                out = self.run_check(lane, *targets)
                self.assertEqual(out.returncode, 1)
                self.assertEqual(out.stdout.splitlines(), [f"INCONCLUSIVE {t}" for t in targets])
        self.assertEqual(self.probes(), [])

    def test_c10_usage_errors_exit_64_with_no_lines(self) -> None:
        a, b, c, d = (str(self.base / n) for n in "abcd")
        for args in ((LANE, a, b, c), (LANE, a, b, c, "-x"), ("-u", a, b, c, d), (LANE, a, b, c, a),
                     (LANE, a, b, c, d, d), ()):
            with self.subTest(args=args):
                out = self.run_check(*args)
                self.assertEqual(out.returncode, 64)
                self.assertEqual(out.stdout, "")
        self.assertEqual(read_jsonl(self.stub / "sudo.jsonl"), [])

    def test_ac4_bash_syntax_and_shellcheck(self) -> None:
        self.assertEqual(subprocess.run(["bash", "-n", str(CHECKER)]).returncode, 0)
        if not shutil_which("shellcheck"):
            self.skipTest("shellcheck not installed (CI runs it as its own step)")
        out = subprocess.run(["shellcheck", str(CHECKER)], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout)


def shutil_which(name: str) -> str | None:
    import shutil
    return shutil.which(name)


if __name__ == "__main__":
    unittest.main()
