#!/usr/bin/env python3
"""Dispatcher bridge wiring (#212). Fake HTTP, real worktrees, real child processes.

The golden fixture pins one polling iteration of the disabled dispatcher
(``MC_BRIDGE_ENABLED`` unset). It was captured from ``main`` at ``5c57bff``
before any dispatcher edit:

    python3 tests/unit/test_dispatcher_bridge.py --capture-golden
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

DISPATCHER = Path(__file__).resolve().parents[2] / "agents" / "dispatcher"
sys.path.insert(0, str(DISPATCHER))
import mc_dispatcher as md  # noqa: E402



def setUpModule():
    # A container shell can leave this process in the init group (pgid 1), which
    # #211 refuses as a controller identity. Give the test runner its own group.
    if os.getpgrp() <= 1:
        os.setpgid(0, 0)


GOLDEN = Path(__file__).resolve().parent / "fixtures" / "dispatcher_bridge_disabled_golden.json"
GOLDEN_HOST = "goldenhost"
GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}
BLOCK = (
    "<!-- ak-skills:begin -->\n- a (1.0.0, aaaaaaa) — first. Fetch: get_skill {\"id\":\"a\"}\n"
    "<!-- ak-skills:end -->"
)

# A fake agent CLI. It records its argv, cwd and environment names, then
# prints a claude-code result envelope. A review run prints an approval.
FAKE_CLI = r'''#!/usr/bin/env python3
import json, os, sys
log = "@CLI_LOG@"
review = "default" in sys.argv
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "env": sorted(k for k in os.environ if k != "LC_CTYPE" and not k.startswith("__CF"))}) + "\n")
text = "looks right\nVERDICT: APPROVE" if review else "did it\nRESULT: golden ok"
print(json.dumps({"type": "result", "result": text, "total_cost_usd": 0.25}))
'''


def run_git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True,
                   env={**os.environ, **GIT_ENV})


def make_worktree(base: Path, name: str = "proj") -> tuple[Path, Path]:
    """(MC_WORKDIR root, linked worktree) under base."""
    main_repo = base / "main"
    root = base / "work"
    root.mkdir()
    run_git(base, "init", "-q", "-b", "main", str(main_repo))
    (main_repo / "README.md").write_text("hi\n")
    run_git(main_repo, "add", "README.md")
    run_git(main_repo, "commit", "-q", "-m", "init")
    wt = root / name
    run_git(main_repo, "worktree", "add", "-q", "-b", f"lane-{name}", str(wt))
    return root, wt


def make_fakebin(base: Path, script: str = FAKE_CLI) -> Path:
    fakebin = base / "bin"
    fakebin.mkdir()
    for cli in ("claude", "codex", "grok"):
        path = fakebin / cli
        path.write_text(script.replace("#!/usr/bin/env python3", f"#!{sys.executable}")
                        .replace("@CLI_LOG@", str(base / "cli.log")))
        path.chmod(0o755)
    return fakebin


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.data = json.dumps(payload).encode()

    def read(self, n: int = -1) -> bytes:
        return self.data if n is None or n < 0 else self.data[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeServer:
    """urlopen replacement that records every request byte for byte."""

    def __init__(self, task: dict | None) -> None:
        self.task = task
        self.requests: list[dict] = []
        self.claim_reply = None  # callable(body) -> payload, overrides the default

    def urlopen(self, req, timeout=None):
        split = md.urllib.parse.urlsplit(req.full_url)
        raw = req.data.decode("utf-8") if req.data is not None else None
        self.requests.append({
            "method": req.get_method(),
            "path": split.path + (("?" + split.query) if split.query else ""),
            "headers": {k.lower(): v for k, v in sorted(req.header_items())},
            "body": raw,
            "timeout": timeout,
        })
        body = json.loads(raw) if raw else None
        if split.path == "/api/tasks/claim":
            if self.claim_reply is not None:
                return FakeResponse(self.claim_reply(body))
            task, self.task = self.task, None
            return FakeResponse({"task": task})
        if split.path == "/api/skills/pointers":
            q = md.urllib.parse.parse_qs(split.query)
            return FakeResponse({"demo": False, "lane": q["lane"][0], "runtime": q["runtime"][0],
                                 "empty": False, "block": BLOCK})
        if split.path == "/api/ingest":
            return FakeResponse({"ok": True})
        if req.get_method() == "PATCH" and split.path.startswith("/api/tasks/"):
            task_id = split.path.rsplit("/", 1)[1]
            return FakeResponse({"ok": True, "task": {
                "id": task_id if getattr(self, "string_ids", False) else int(task_id),
                "status": (body or {}).get("status")}})
        return FakeResponse({})


class _OneIteration(Exception):
    pass


class InlineThread:
    """threading.Thread stand-in that runs the target when started."""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}

    def start(self):
        self._target(*self._args, **self._kwargs)


def _normalize(value, tmp: str):
    if isinstance(value, str):
        return value.replace(tmp, "<TMP>")
    if isinstance(value, list):
        return [_normalize(v, tmp) for v in value]
    if isinstance(value, dict):
        return {k: _normalize(v, tmp) for k, v in value.items()}
    return value


_VOLATILE = re.compile(r'"(started_at|ended_at|duration_ms|run_id)": ("[^"]*"|[0-9]+)')


def _normalize_body(raw: str | None, tmp: str):
    """The exact request bytes, with only run timing replaced."""
    if raw is None:
        return None
    return _VOLATILE.sub(lambda m: f'"{m.group(1)}": "<{m.group(1)}>"', raw).replace(tmp, "<TMP>")


def golden_task() -> dict:
    return {"id": 41, "title": "Golden task", "description": "do the golden thing",
            "project": "proj", "platform": "claude-code", "machine": GOLDEN_HOST,
            "reviewer_platform": "claude-code", "status": "claimed"}


def disabled_iteration(extra_env: dict | None = None) -> dict:
    """One polling iteration of main() with bridge mode not enabled. Normalized record."""
    with tempfile.TemporaryDirectory() as tmp_name:
        base = Path(tmp_name).resolve()
        root, _wt = make_worktree(base)
        fakebin = make_fakebin(base)
        home = base / "home"
        home.mkdir()
        cli_log = base / "cli.log"
        env = {
            "PATH": f"{fakebin}:/usr/bin:/bin",
            "HOME": str(home),
            "MC_URL": "https://ak.invalid",
            "MC_TOKEN": "golden-token",
            "MC_WORKDIR": str(root),
            "MC_PLATFORMS": "claude-code",
            **GIT_ENV,
            **(extra_env or {}),
        }
        server = FakeServer(golden_task())
        printed: list[str] = []
        errors: list[str] = []

        def fake_print(*args, file=None, **kwargs):
            text = " ".join(str(a) for a in args)
            (errors if file is sys.stderr else printed).append(text)

        def stop_wait(self, timeout):
            raise _OneIteration()

        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(md, "HOSTNAME", GOLDEN_HOST), \
                mock.patch.object(md.urllib.request, "urlopen", side_effect=server.urlopen), \
                mock.patch.object(md.threading, "Thread", InlineThread), \
                mock.patch.object(md.DispatchWake, "wait", stop_wait), \
                mock.patch("builtins.print", side_effect=fake_print):
            try:
                md.main()
            except _OneIteration:
                pass
        cli_runs = [json.loads(line) for line in cli_log.read_text().splitlines()] if cli_log.exists() else []
        record = {
            "requests": [
                {**{k: v for k, v in r.items() if k != "body"}, "body": _normalize_body(r["body"], str(base))}
                for r in server.requests
            ],
            "stdout": printed,
            "stderr": errors,
            "cli_runs": _normalize(cli_runs, str(base)),
            "agents_md_after": (_wt / "AGENTS.md").read_text() if (_wt / "AGENTS.md").exists() else None,
        }
        return _normalize(record, str(base))


class GoldenDisabledTests(unittest.TestCase):
    """C13 / AC1: with MC_BRIDGE_ENABLED unset, one iteration matches main byte for byte."""

    def test_disabled_iteration_matches_main_golden(self):
        expected = json.loads(GOLDEN.read_text(encoding="utf-8"))
        self.assertEqual(disabled_iteration(), expected)



# ---------------------------------------------------------------------------
# Bridge mode (#212). A real ledger directory, a real worktree, real gated
# children and real signals to their own process groups. Fake HTTP only.

import ast  # noqa: E402
import signal  # noqa: E402
import stat  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import ak_pointers  # noqa: E402
import ak_stop_control as stopctl  # noqa: E402
import dispatch_ready_bridge as drb  # noqa: E402

HOST = "bridgehost"
AUTHORITY = "ak-test"
REPO = "mrhinkle/agent-kontrol"
TID = 101
COMPETING = 99

# The worker behaviour is chosen per test by baking a mode into the fake CLI.
BRIDGE_CLI = r"""#!/usr/bin/env python3
import json, os, subprocess, sys, time
base = "@BASE@"
review = "default" in sys.argv or "read-only" in sys.argv
role = "reviewer" if review else "worker"
mode = "@MODE@"
with open(os.path.join(base, "cli.log"), "a", encoding="utf-8") as f:
    f.write(json.dumps({"role": role, "pid": os.getpid(), "pgid": os.getpgrp(), "argv": sys.argv[1:],
                        "env": sorted(k for k in os.environ if k != "LC_CTYPE" and not k.startswith("__CF"))}) + "\n")
if mode == "stop-" + role:
    with open(os.path.join(base, role + ".pid"), "w") as f:
        f.write(str(os.getpid()))
    open(os.path.join(base, "STOP"), "w").close()
    time.sleep(60)
if mode == "leftover-" + role:
    child = subprocess.Popen(["sleep", "60"])
    with open(os.path.join(base, "leftover.pid"), "w") as f:
        f.write(str(child.pid))
if mode == "slow-" + role:
    time.sleep(60)
text = "looks right\nVERDICT: APPROVE" if review else "did it\nRESULT: bridge ok"
print(json.dumps({"type": "result", "result": text, "total_cost_usd": 0.5}))
"""


def frozen_body(reviewer=None, title="Bridge task", machine=HOST, platform="claude-code", project="proj"):
    body = {
        "title": title,
        "description": drb.encode_issue_content(
            title=title, body="Do the bridge thing.", url=f"https://github.com/{REPO}/issues/7",
            node_id="I_7", repository=REPO, number=7, authority=AUTHORITY),
        "project": project,
        "platform": platform,
        "machine": machine,
        "priority": 2,
        "created_by": drb.CREATED_BY,
    }
    if reviewer is not None:
        body["reviewer_platform"] = reviewer
    return body


def handoff_row(node="I_7", task_id=TID, body=None, repository=REPO, state="acknowledged"):
    return {
        "state": state,
        "issue_node_id": node,
        "repository": repository,
        "issue_number": 7,
        "idempotency_key": drb._idempotency_key(AUTHORITY, node),
        "actor_id": "tester",
        "authority": AUTHORITY,
        "attempt_at": "2026-11-28T00:00:00Z",
        "task_id": task_id,
        "body": body or frozen_body(),
        "bound_by": "post",
        "halt_reason": None,
    }


def server_task(task_id, body):
    task = {"id": task_id, "status": "claimed", "reviewer_platform": body.get("reviewer_platform")}
    task.update({k: v for k, v in body.items() if k != "reviewer_platform"})
    return task


class QueueServer(FakeServer):
    """The #173 claim route over a small queue: task_id claims that row only; no id claims by priority."""

    def __init__(self, queue: list[dict]) -> None:
        super().__init__(None)
        self.queue = list(queue)
        self.claimed: list[int] = []
        self.lost = False
        self.string_ids = False  # Postgres returns the bigint id as a decimal string

    def urlopen(self, req, timeout=None):
        split = md.urllib.parse.urlsplit(req.full_url)
        if split.path == "/api/tasks/claim":
            body = json.loads(req.data.decode())
            self.requests.append({"method": req.get_method(), "path": split.path, "body": req.data.decode(),
                                  "headers": {k.lower(): v for k, v in req.header_items()}})
            if self.lost:
                raise md.urllib.error.URLError("connection reset")
            if "task_id" in body:
                found = [t for t in self.queue if t["id"] == body["task_id"]]
            else:
                found = sorted(self.queue, key=lambda t: t["priority"])[:1]
            task = found[0] if found else None
            if task is not None:
                self.queue.remove(task)
                self.claimed.append(task["id"])
                if self.string_ids:
                    task = {**task, "id": str(task["id"])}
            return FakeResponse({"task": task})
        return super().urlopen(req, timeout)


class BridgeHarness(unittest.TestCase):
    reviewer = None
    mode = "ok"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.root, self.wt = make_worktree(self.base)
        self.fakebin = make_fakebin(self.base, BRIDGE_CLI.replace("@BASE@", str(self.base)).replace("@MODE@", self.mode))
        self.ledger = self.base / "ledger"
        self.ledger.mkdir(mode=0o700)
        os.chmod(self.ledger, 0o700)
        self.stop_file = self.base / "STOP"
        self.config = {
            "enabled": False,  # ignored by the dispatcher (H4)
            "authority": AUTHORITY,
            "actor_id": "tester",
            "ledger_dir": str(self.ledger),
            "workdir": str(self.root),
            "stop_file": str(self.stop_file),
            "repos": [{"repo": REPO, "project": "proj", "platform": "claude-code", "machine": HOST,
                       "ready_labels": ["dispatch-ready"], "blocked_labels": [],
                       "reviewer_platform": self.reviewer}],
        }
        self.body = frozen_body(self.reviewer)
        self.server = QueueServer([server_task(TID, self.body)])
        env = {"PATH": f"{self.fakebin}:/usr/bin:/bin", "HOME": str(self.base), "MC_URL": "https://ak.invalid",
               "MC_TOKEN": "bridge-token", "MC_MAX_CONCURRENT": "1", **GIT_ENV}
        for p in (mock.patch.dict(os.environ, env, clear=True),
                  mock.patch.object(md, "HOSTNAME", HOST),
                  mock.patch.object(md, "WORKDIR", self.root),
                  mock.patch.object(md, "TASK_TIMEOUT", 30),
                  mock.patch.object(md, "MC_URL", "https://ak.invalid"),
                  mock.patch.object(md, "MC_TOKEN", "bridge-token"),
                  mock.patch.object(md.urllib.request, "urlopen", side_effect=self.server.urlopen)):
            p.start()
            self.addCleanup(p.stop)
        self.write_rows([handoff_row(body=self.body)])
        self.killpg_callers: list[str] = []
        real_killpg = os.killpg

        def spy_killpg(pgid, sig):
            frame = sys._getframe(1)
            while frame is not None and not frame.f_code.co_filename.endswith("mc_dispatcher.py"):
                frame = frame.f_back
            self.killpg_callers.append(frame.f_code.co_name if frame is not None else "<outside>")
            return real_killpg(pgid, sig)

        p = mock.patch.object(md.os, "killpg", side_effect=spy_killpg)
        p.start()
        self.addCleanup(p.stop)
        self._bridge = None

    def tearDown(self):
        if self._bridge is not None:
            # Only a child this dispatcher still holds unreaped is ours to stop: its zombie
            # pins the group id. A reaped pid (or a pid file) may already name someone else.
            for child in list(self._bridge.children._items.values()):
                if child.proc.returncode is None:
                    try:
                        os.killpg(child.proc.pid, signal.SIGKILL)
                    except OSError:
                        pass
                    child.proc.wait(timeout=10)
            held = self._bridge.held or {}
            if held.get("lock") is not None:
                held["lock"].release()
            self._bridge.close()
            os.close(self._bridge.dir_fd)
        self.tmp.cleanup()

    def write_rows(self, rows, authority=AUTHORITY):
        data = {"version": 1, "authority": authority, "actor_id": "tester",
                "handoffs": {r["issue_node_id"]: r for r in rows}}
        (self.ledger / "handoff.json").write_text(json.dumps(data))

    def bridge(self, **kw):
        if self._bridge is None:
            parsed = drb.parse_bridge_config(self.config)
            self.assertIsInstance(parsed, dict)
            fd = os.open(str(self.ledger), os.O_RDONLY)
            kw.setdefault("grace", 0.3)
            kw.setdefault("stop_budget", 5.0)
            self._bridge = md.BridgeDispatcher(parsed, fd, **kw)
        return self._bridge

    def poll(self, **kw):
        err: list[str] = []
        real_print = print

        def capture(*args, file=None, **k):
            if file is sys.stderr:
                err.append(" ".join(str(a) for a in args))
            else:
                real_print(*args, **k)

        with mock.patch("builtins.print", side_effect=capture):
            outcome = self.bridge(**kw).poll_once("claude-code")
        self.stderr = err
        return outcome

    # -- views ----------------------------------------------------------------

    def claims(self):
        return [json.loads(r["body"]) for r in self.server.requests if r["path"] == "/api/tasks/claim"]

    def patches(self):
        return [json.loads(r["body"]) for r in self.server.requests if r["method"] == "PATCH"]

    def result_patches(self):
        return [p for p in self.patches() if p.get("status") in ("done", "failed", "queued")]

    def ingests(self, kind):
        return [json.loads(r["body"]) for r in self.server.requests
                if r["path"] == "/api/ingest" and json.loads(r["body"])["kind"] == kind]

    def cli_runs(self):
        log = self.base / "cli.log"
        return [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []

    def journal(self):
        path = self.ledger / md.BRIDGE_JOURNAL
        return json.loads(path.read_text()) if path.exists() else None

    def agents_md(self):
        path = self.wt / "AGENTS.md"
        return path.read_text() if path.exists() else None

    def assert_halt(self, code, *, phase=None):
        record = self.journal()
        self.assertIsNotNone(record, "halt left no durable journal")
        self.assertEqual(record["halt"]["code"], code)
        self.assertEqual(record["halt"]["machine"], HOST)
        if phase is not None:
            self.assertEqual(record["halt"]["phase"], phase)
        lines = [l for l in self.stderr if l.startswith("[mc] bridge halt ")]
        self.assertTrue(lines, self.stderr)
        self.assertIn(f"code={code} ", lines[-1] + " ")
        self.assertIn(f"machine={HOST}", lines[-1])
        self.assertNotIn("bridge-token", "\n".join(self.stderr))
        self.assertEqual(self.bridge().halted.code, code)
        self.assertEqual(self.result_patches(), [], "a halt must not mark done, fail, or requeue")
        return record

    def assert_no_child(self):
        self.assertEqual(self.cli_runs(), [])

    def assert_only_port_signalled(self):
        self.assertTrue(set(self.killpg_callers) <= {"signal_group"}, self.killpg_callers)


class BridgeClaimTests(BridgeHarness):
    def test_exact_claim_ignores_competing_queued_task(self):
        # The competing task is first in priority order; an unfiltered claim would take it.
        competing = server_task(COMPETING, {**frozen_body(), "priority": 1, "title": "Competing"})
        self.server.queue.insert(0, competing)
        self.assertEqual(self.poll(), "done")
        self.assertEqual(self.server.claimed, [TID])
        self.assertIn(competing, self.server.queue, "the competing queued task was taken")
        self.assertEqual(self.result_patches()[-1]["status"], "done")
        self.assertEqual([r["path"] for r in self.server.requests if r["method"] == "PATCH"][-1],
                         f"/api/tasks/{TID}")
        self.assertIsNone(self.journal(), "a completed round clears its journal")
        self.assertIsNone(self.agents_md(), "pointer cleanup restores the worktree")

    def test_claim_request_fields_exact(self):
        os.environ["MC_TASK_PROJECT"] = "some-other-lane"
        self.assertEqual(self.poll(), "done")
        raw = [r["body"] for r in self.server.requests if r["path"] == "/api/tasks/claim"]
        self.assertEqual(raw, [json.dumps({"platform": "claude-code", "machine": HOST,
                                           "agent_id": f"claude-code-{HOST}", "project": "proj",
                                           "task_id": TID})])

    def test_no_claim_on_zero_candidates(self):
        for rows in ([], [handoff_row(body=frozen_body(machine="otherhost"))],
                     [handoff_row(body=frozen_body(platform="codex"))],
                     [handoff_row(state="halted") | {"halt_reason": "x", "bound_by": None}]):
            with self.subTest(rows=len(rows)):
                self.write_rows(rows)
                self.assertEqual(self.poll(), "idle")
                self.assertEqual(self.claims(), [])
                self.assertIsNone(self.journal())
                self.assert_no_child()

    def test_no_claim_on_duplicate_candidates(self):
        second = frozen_body(title="Second")
        self.write_rows([handoff_row(body=self.body), handoff_row(node="I_8", task_id=TID + 1, body=second)])
        self.assertEqual(self.poll(), "halt")
        record = self.assert_halt("duplicate_candidate", phase="select")
        self.assertEqual(record["halt"]["rows"], ["I_7", "I_8"])
        self.assertEqual(self.claims(), [])
        self.assert_no_child()

    def test_missing_task_id_halts(self):
        for bad in (None, 0, -3, "101", True):
            with self.subTest(task_id=bad):
                self.setUp_fresh()
                self.write_rows([handoff_row(task_id=bad)])
                self.assertEqual(self.poll(), "halt")
                record = self.assert_halt("missing_task_id", phase="select")
                self.assertEqual(record["halt"]["rows"], ["I_7"])
                self.assertEqual(self.claims(), [])
                self.assert_no_child()

    def setUp_fresh(self):
        if self._bridge is not None:
            held = self._bridge.held or {}
            if held.get("lock") is not None:
                held["lock"].release()  # what process exit does for a halted dispatcher
            if held.get("injection") is not None:
                ak_pointers.cleanup(held["injection"])
            os.close(self._bridge.dir_fd)
            self._bridge = None
        path = self.ledger / md.BRIDGE_JOURNAL
        if path.exists():
            path.unlink()
        self.server.requests.clear()

    def test_conflicting_candidate_halts(self):
        cases = {
            "repository": handoff_row(repository="mrhinkle/other"),
            "project": handoff_row(body=frozen_body(project="elsewhere")),
            "reviewer": handoff_row(body=frozen_body(reviewer="codex")),
        }
        for name, row in cases.items():
            with self.subTest(case=name):
                self.setUp_fresh()
                self.write_rows([row])
                self.assertEqual(self.poll(), "halt")
                self.assert_halt("conflicting_candidate", phase="select")
                self.assertEqual(self.claims(), [])

    def test_ledger_authority_mismatch_halts(self):
        self.write_rows([handoff_row()], authority="other-authority")
        # Rows carry their own authority; a ledger rewritten under another one is refused.
        data = json.loads((self.ledger / "handoff.json").read_text())
        for row in data["handoffs"].values():
            row["authority"] = "other-authority"
            row["idempotency_key"] = drb._idempotency_key("other-authority", row["issue_node_id"])
        (self.ledger / "handoff.json").write_text(json.dumps(data))
        self.assertEqual(self.poll(), "halt")
        self.assert_halt("conflicting_candidate")

    def test_unexpected_selection_error_halts(self):
        with mock.patch.object(md.BridgeDispatcher, "select", side_effect=KeyError("body")):
            self.assertEqual(self.poll(), "halt")
        self.assert_halt("ledger_unreadable", phase="select")
        self.assertEqual(self.claims(), [])

    def test_malformed_ledger_halts(self):
        (self.ledger / "handoff.json").write_text("{not json")
        self.assertEqual(self.poll(), "halt")
        self.assert_halt("ledger_unreadable", phase="select")
        self.assertEqual(self.claims(), [])

    def test_returned_task_identity_mismatch(self):
        cases = {
            "title": {"title": "Changed"},
            "description": {"description": "other"},
            "machine_null": {"machine": None},
            "platform": {"platform": "codex"},
            "priority": {"priority": 1},
            "reviewer": {"reviewer_platform": "grok"},
            "other_id": {"id": COMPETING},
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                self.setUp_fresh()
                self.server.queue = []
                task = {**server_task(TID, self.body), **change}
                self.server.claim_reply_task = task

                def reply(req, timeout=None, task=task):
                    split = md.urllib.parse.urlsplit(req.full_url)
                    if split.path == "/api/tasks/claim":
                        self.server.requests.append({"method": "POST", "path": split.path,
                                                     "body": req.data.decode(), "headers": {}})
                        return FakeResponse({"task": task})
                    return FakeServer.urlopen(self.server, req, timeout)

                with mock.patch.object(md.urllib.request, "urlopen", side_effect=reply):
                    self.assertEqual(self.poll(), "halt")
                record = self.assert_halt("claim_mismatch", phase="claim")
                self.assertTrue(record["controller"]["recovery_retained"])
                self.assert_no_child()

    def test_exact_claim_miss(self):
        self.server.queue = []
        self.assertEqual(self.poll(), "halt")
        record = self.assert_halt("exact_claim_miss", phase="claim")
        self.assertTrue(record["controller"]["recovery_retained"])
        self.assertEqual(len(self.claims()), 1, "no fallback claim")
        self.assert_no_child()

    def test_lost_reply_recovery(self):
        self.server.lost = True
        self.assertEqual(self.poll(), "halt")
        record = self.assert_halt("claim_unknown", phase="claim")
        self.assertEqual(record["controller"]["outcome"], "claim_unknown")
        self.assertTrue(record["controller"]["recovery_retained"])
        self.assertEqual(len(self.claims()), 1, "no fallback claim")
        self.assert_no_child()
        # The retained record blocks every later poll, including a fresh dispatcher.
        self.server.lost = False
        self.setUp_bridge_only()
        self.assertEqual(self.poll(), "halt")
        self.assertEqual(self.bridge().halted.code, "stop_journal_present")
        self.assertEqual(len(self.claims()), 1)

    def setUp_bridge_only(self):
        os.close(self._bridge.dir_fd)
        self._bridge = None

    def test_lost_reply_deadline(self):
        # A claim that never answers is bounded by one deadline and is unknown, not retried.
        gate = threading.Event()

        def hang(req, timeout=None):
            if md.urllib.parse.urlsplit(req.full_url).path == "/api/tasks/claim":
                self.server.requests.append({"method": "POST", "path": "/api/tasks/claim",
                                             "body": req.data.decode(), "headers": {}})
                gate.wait(5)
                return FakeResponse({"task": server_task(TID, self.body)})
            return FakeServer.urlopen(self.server, req, timeout)

        with mock.patch.object(md.urllib.request, "urlopen", side_effect=hang):
            started = time.monotonic()
            self.assertEqual(self.poll(net_budget=0.3), "halt")
            self.assertLess(time.monotonic() - started, 3.0)
        gate.set()
        self.assert_halt("claim_unknown", phase="claim")
        self.assert_no_child()


class BridgeDoneRecordTests(BridgeHarness):
    """Amendment I1: finished tasks are recorded and never offered again."""

    def done_record(self):
        path = self.ledger / md.BRIDGE_DONE
        return json.loads(path.read_text()) if path.exists() else None

    def test_two_tasks_complete_in_sequence(self):
        self.assertEqual(self.poll(), "done")
        record = self.done_record()
        self.assertEqual([(d["task_id"], d["issue"]) for d in record["done"]], [(TID, "I_7")])
        self.assertEqual(stat.S_IMODE(os.stat(self.ledger / md.BRIDGE_DONE).st_mode), 0o600)
        # A second handoff arrives; the first row stays acknowledged in handoff.json.
        second = frozen_body(title="Second bridge task")
        self.write_rows([handoff_row(body=self.body), handoff_row(node="I_8", task_id=TID + 1, body=second)])
        self.server.queue.append(server_task(TID + 1, second))
        self.server.requests.clear()
        self.assertEqual(self.poll(), "done")
        self.assertEqual([c["task_id"] for c in self.claims()], [TID + 1])
        self.assertEqual(self.server.claimed, [TID, TID + 1])
        self.assertEqual([d["task_id"] for d in self.done_record()["done"]], [TID, TID + 1])
        # Both rows finished: the next poll is idle, not a miss or a duplicate.
        self.server.requests.clear()
        self.assertEqual(self.poll(), "idle")
        self.assertEqual(self.claims(), [])
        self.assertIsNone(self.journal())

    def test_corrupt_done_record_halts(self):
        cases = {
            "not_json": "{bad",
            "wrong_shape": json.dumps({"version": 1, "done": {}}),
            "bad_id": json.dumps({"version": 1, "done": [{"task_id": "101", "issue": "I_7", "completed_at": "x"}]}),
            "extra_key": json.dumps({"version": 1, "done": [], "more": 1}),
        }
        for name, text in cases.items():
            with self.subTest(case=name):
                self.setUp_fresh()
                (self.ledger / md.BRIDGE_DONE).write_text(text)
                self.assertEqual(self.poll(), "halt")
                self.assert_halt("invalid_config", phase="select")
                self.assertEqual(self.claims(), [])
                self.assert_no_child()

    def setUp_fresh(self):
        if self._bridge is not None:
            os.close(self._bridge.dir_fd)
            self._bridge = None
        path = self.ledger / md.BRIDGE_JOURNAL
        if path.exists():
            path.unlink()
        self.server.requests.clear()

    def test_done_record_write_failure_keeps_journal(self):
        with mock.patch.object(md.BridgeDoneRecord, "_write", side_effect=OSError("disk full")):
            self.assertEqual(self.poll(), "halt")
        record = self.journal()
        self.assertIsNotNone(record, "the journal was cleared without a durable done record")
        self.assertEqual(record["halt"]["code"], "claim_unknown")
        self.assertEqual(record["halt"]["phase"], "result")
        self.assertIsNone(self.done_record())
        self.assertEqual(len(self.result_patches()), 1, "exactly one result PATCH, no retry")


class BridgeStrictEvent(BridgeHarness):
    """Codex review on ebc03a1: a work event that is not recorded must hold the child."""

    def failing_ingest(self, how):
        real = self.server.urlopen

        def urlopen(req, timeout=None):
            split = md.urllib.parse.urlsplit(req.full_url)
            if split.path == "/api/ingest" and json.loads(req.data.decode())["kind"] == "status":
                self.server.requests.append({"method": "POST", "path": split.path,
                                             "body": req.data.decode(), "headers": {}})
                if how == "http_500":
                    raise md.urllib.error.HTTPError(req.full_url, 500, "boom", {}, None)
                if how == "transport":
                    raise md.urllib.error.URLError("connection reset")
                if how == "timeout":
                    time.sleep(2)
                    return FakeResponse({"ok": True})
                if how == "malformed":
                    resp = FakeResponse({})
                    resp.data = b"<html>"
                    return resp
                return FakeResponse({"ok_false": {"ok": False}, "demo": {"ok": True, "demo": True},
                                     "not_object": [1]}[how])
            return real(req, timeout)

        return urlopen

    def test_failed_status_event_holds_child(self):
        for how in ("http_500", "transport", "timeout", "malformed", "ok_false", "demo", "not_object"):
            with self.subTest(failure=how):
                if self._bridge is not None:
                    held = self._bridge.held or {}
                    if held.get("lock") is not None:
                        held["lock"].release()
                    if held.get("injection") is not None:
                        ak_pointers.cleanup(held["injection"])
                    os.close(self._bridge.dir_fd)
                    self._bridge = None
                    (self.ledger / md.BRIDGE_JOURNAL).unlink(missing_ok=True)
                    self.server.queue = [server_task(TID, self.body)]
                self.server.requests.clear()
                with mock.patch.object(md.urllib.request, "urlopen", side_effect=self.failing_ingest(how)):
                    self.assertEqual(self.poll(net_budget=0.5), "halt")
                record = self.assert_halt("claim_unknown", phase="worker_event")
                self.assertEqual(record["controller"]["claim"]["task_id"], TID)
                self.assert_no_child()
                self.assertEqual(self.bridge().signals.sent, [], "the gate is retired by EOF, not a signal")
                self.assertIsNotNone(self.agents_md(), "no cleanup after a halt")


class CodeRabbit215(BridgeHarness):
    """Findings on PR #215 at fa37e9b."""

    def test_lost_reply_after_commit_keeps_claim(self):
        # Finding 9: the server commits the claim, then the reply is lost.
        real = self.server.urlopen

        def commit_then_lose(req, timeout=None):
            if md.urllib.parse.urlsplit(req.full_url).path == "/api/tasks/claim":
                real(req, timeout)  # commits: the task leaves the queue
                raise md.urllib.error.URLError("reply lost")
            return real(req, timeout)

        with mock.patch.object(md.urllib.request, "urlopen", side_effect=commit_then_lose):
            self.assertEqual(self.poll(), "halt")
        self.assert_halt("claim_unknown", phase="claim")
        self.assertEqual(self.server.claimed, [TID])
        self.assertEqual(self.server.queue, [], "the committed claim stays claimed")
        self.assert_no_child()
        held = self._bridge.held
        held["lock"].release()  # process exit
        os.close(self._bridge.dir_fd)
        self._bridge = None
        self.assertEqual(self.poll(), "halt")
        self.assertEqual(self.bridge().halted.code, "stop_journal_present")
        self.assertEqual(len(self.claims()), 1, "a fresh dispatcher sent a second claim")

    def test_stop_during_work_event_holds_payload(self):
        # Finding 4.
        bridge = self.bridge()
        bridge.boundary = lambda name: bridge.stop_event.set() if name == "worker_acked" else None
        self.assertEqual(self.poll(), "halt")
        self.assert_halt("stop_requested", phase="worker_release")
        self.assert_no_child()
        self.assertEqual(bridge.signals.sent, [])

    def test_phase_patch_failure_holds_payload(self):
        # Finding 6: a running PATCH that failed or timed out may land late; never run, never finish.
        for how in ("timeout", "http_500", "demo", "wrong_status"):
            with self.subTest(failure=how):
                if self._bridge is not None:
                    held = self._bridge.held or {}
                    if held.get("lock") is not None:
                        held["lock"].release()
                    if held.get("injection") is not None:
                        ak_pointers.cleanup(held["injection"])
                    os.close(self._bridge.dir_fd)
                    self._bridge = None
                    (self.ledger / md.BRIDGE_JOURNAL).unlink(missing_ok=True)
                    self.server.queue = [server_task(TID, self.body)]
                self.server.requests.clear()
                real = self.server.urlopen

                def urlopen(req, timeout=None, how=how):
                    split = md.urllib.parse.urlsplit(req.full_url)
                    if req.get_method() == "PATCH" and json.loads(req.data.decode())["status"] == "running":
                        self.server.requests.append({"method": "PATCH", "path": split.path,
                                                     "body": req.data.decode(), "headers": {}})
                        if how == "timeout":
                            time.sleep(2)
                        if how == "http_500":
                            raise md.urllib.error.HTTPError(req.full_url, 500, "boom", {}, None)
                        if how == "demo":
                            return FakeResponse({"ok": True, "demo": True})
                        return FakeResponse({"ok": True, "task": {"id": TID, "status": "claimed"}})
                    return real(req, timeout)

                with mock.patch.object(md.urllib.request, "urlopen", side_effect=urlopen):
                    self.assertEqual(self.poll(net_budget=0.5), "halt")
                self.assert_halt("claim_unknown", phase="worker_event")
                self.assert_no_child()
                self.assertIsNone((self.ledger / md.BRIDGE_DONE).exists() or None)

    def test_terminal_patch_not_recorded_halts(self):
        # Finding 7.
        for reply in ({"ok": True, "demo": True}, {"ok": False}, {}, {"ok": True, "task": {"id": TID, "status": "running"}}):
            with self.subTest(reply=reply):
                if self._bridge is not None:
                    os.close(self._bridge.dir_fd)
                    self._bridge = None
                    (self.ledger / md.BRIDGE_JOURNAL).unlink(missing_ok=True)
                    self.server.queue = [server_task(TID, self.body)]
                self.server.requests.clear()
                real = self.server.urlopen

                def urlopen(req, timeout=None, reply=reply):
                    if req.get_method() == "PATCH" and json.loads(req.data.decode())["status"] in ("done", "failed"):
                        self.server.requests.append({"method": "PATCH", "path": "/api/tasks/101",
                                                     "body": req.data.decode(), "headers": {}})
                        return FakeResponse(reply)
                    return real(req, timeout)

                with mock.patch.object(md.urllib.request, "urlopen", side_effect=urlopen):
                    self.assertEqual(self.poll(), "halt")
                record = self.journal()
                self.assertEqual(record["halt"]["code"], "claim_unknown")
                self.assertEqual(record["halt"]["phase"], "result")
                self.assertFalse((self.ledger / md.BRIDGE_DONE).exists(), "an unrecorded result was marked done")

    def test_single_racy_listing_never_proves_empty(self):
        # Finding 3: a member forked during the first listing appears only in the second.
        children = md.BridgeChildren()
        proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
        self.addCleanup(proc.wait)
        self.assertTrue(md._wait_exit_unreaped(proc.pid, 10))
        birth = children.add(proc, "worker", None)
        me = os.getpid()
        empty = {proc.pid: (me, proc.pid, True)}
        late = {proc.pid: (me, proc.pid, True), 999991: (proc.pid, proc.pid, False)}
        listings = iter([empty, late])
        observer = md.BridgeObserver(children, table=lambda: next(listings))
        identity = stopctl.OwnedIdentity(pid=proc.pid, pgid=proc.pid, role="worker", phase="worker",
                                         birth=birth, ancestry=(me,))
        self.assertEqual(observer.observe(identity).status, "unverifiable")
        # Two complete listings that agree prove it.
        observer = md.BridgeObserver(children, table=lambda: empty)
        seen = observer.observe(identity)
        self.assertEqual((seen.status, seen.group_status), ("absent", "empty"))

        def churn():
            raise md.BridgeTableIncomplete("vanished")

        observer = md.BridgeObserver(children, table=churn)
        with self.assertRaises(md.BridgeTableIncomplete):
            observer.observe(identity)


class CodeRabbit215Second(BridgeHarness):
    """Second CodeRabbit pass on PR #215 at 81bea10."""

    reviewer = "claude-code"

    def test_postgres_string_ids_complete_round(self):
        # Finding 1: tasks.id is a bigint; the real routes return "101".
        self.server.string_ids = True
        self.assertEqual(self.poll(), "done")
        final = self.result_patches()
        self.assertEqual([p["status"] for p in final], ["done"])
        done = json.loads((self.ledger / md.BRIDGE_DONE).read_text())["done"]
        self.assertEqual([d["task_id"] for d in done], [TID])
        self.assertIsNone(self.journal())

    def test_noncanonical_string_ids_rejected(self):
        for bad in ("0101", " 101", "101 ", "+101", "101.0", "1e2", "", "9007199254740992", True, 101.0):
            with self.subTest(task_id=bad):
                if self._bridge is not None:
                    held = self._bridge.held or {}
                    if held.get("lock") is not None:
                        held["lock"].release()
                    if held.get("injection") is not None:
                        ak_pointers.cleanup(held["injection"])
                    os.close(self._bridge.dir_fd)
                    self._bridge = None
                    (self.ledger / md.BRIDGE_JOURNAL).unlink(missing_ok=True)
                self.server.requests.clear()
                task = {**server_task(TID, self.body), "id": bad}
                real = self.server.urlopen

                def urlopen(req, timeout=None, task=task):
                    if md.urllib.parse.urlsplit(req.full_url).path == "/api/tasks/claim":
                        self.server.requests.append({"method": "POST", "path": "/api/tasks/claim",
                                                     "body": req.data.decode(), "headers": {}})
                        return FakeResponse({"task": task})
                    return real(req, timeout)

                with mock.patch.object(md.urllib.request, "urlopen", side_effect=urlopen):
                    self.assertEqual(self.poll(), "halt")
                self.assert_halt("claim_mismatch", phase="claim")
                self.assert_no_child()

    def test_canonical_task_id(self):
        self.assertEqual(drb.canonical_task_id("101"), 101)
        self.assertEqual(drb.canonical_task_id(101), 101)
        self.assertEqual(drb.canonical_task_id("9007199254740991"), 9007199254740991)
        for bad in ("0101", " 101", "+101", "-1", "0", 0, -1, True, None, 1.0, "١٠١", "9007199254740992"):
            self.assertIsNone(drb.canonical_task_id(bad), bad)
        # The handoff's recovery listing and identity match see Postgres rows too.
        self.assertTrue(drb._identity_matches({**server_task(TID, self.body), "id": "101"}, self.body))
        self.assertFalse(drb._identity_matches({**server_task(TID, self.body), "id": "0101"}, self.body))

    def test_signal_handler_takes_no_lock(self):
        # Finding 3: the handler must never touch the Event (its lock) or block.
        bridge = self.bridge()
        bridge.stop_event = mock.Mock(**{"set.side_effect": AssertionError("took the Event lock"),
                                         "is_set.return_value": False})
        md.bridge_signal_handler(bridge)(signal.SIGTERM, None)
        self.assertTrue(bridge.signalled)
        self.assertTrue(bridge.stop_requested())
        started = time.monotonic()
        bridge.sleep(30)  # the pending wake byte ends the sleep at once
        self.assertLess(time.monotonic() - started, 5)
        bridge.stop_event.set.assert_not_called()
        for _ in range(100000):  # a full pipe must not block or raise in the handler
            md.bridge_signal_handler(bridge)(signal.SIGTERM, None)


class CodeRabbit215Third(BridgeHarness):
    """Third CodeRabbit pass on PR #215 at 35287c5."""

    def test_out_of_range_task_id_halts_at_selection(self):
        # Finding 1: a hand-edited id above the safe-integer bound halts before any lock or grant.
        self.write_rows([handoff_row(task_id=drb.MAX_TASK_ID + 1)])
        with mock.patch.object(md.WorktreeLock, "acquire", side_effect=AssertionError("locked")), \
                mock.patch.object(md.ak_pointers, "inject", side_effect=AssertionError("injected")):
            self.assertEqual(self.poll(), "halt")
        self.assert_halt("missing_task_id", phase="select")
        self.assertEqual(self.claims(), [])
        self.assertIsNone(self.agents_md())

    def test_wake_pipe_closed(self):
        # Finding 2: a dispatcher's lifetime leaves the open fd count unchanged.
        def open_fds():
            return len(os.listdir("/dev/fd"))

        parsed = drb.parse_bridge_config(self.config)
        fd = os.open(str(self.ledger), os.O_RDONLY)
        self.addCleanup(os.close, fd)
        before = open_fds()
        for _ in range(20):
            md.BridgeDispatcher(parsed, fd).close()
        self.assertEqual(open_fds(), before)
        with mock.patch.object(md.os, "set_blocking", side_effect=OSError("nope")):
            with self.assertRaises(OSError):
                md.BridgeDispatcher(parsed, fd)
        self.assertEqual(open_fds(), before)
        # A signal after close neither raises nor blocks.
        bridge = md.BridgeDispatcher(parsed, fd)
        bridge.close()
        md.bridge_signal_handler(bridge)(signal.SIGTERM, None)
        self.assertTrue(bridge.signalled)


class BridgeStopTests(BridgeHarness):
    def test_stop_before_claim(self):
        bridge = self.bridge()
        bridge.boundary = lambda name: bridge.stop_event.set() if name == "prepared" else None
        self.assertEqual(self.poll(), "stop")
        self.assertEqual(self.claims(), [])
        self.assert_no_child()
        self.assertIsNone(self.journal(), "a stop before any claim is fully reconciled")
        self.assertIsNone(self.agents_md())
        self.assertIn("code=stop_requested", "\n".join(self.stderr))

    def test_stop_file_blocks_claim(self):
        self.stop_file.write_text("")
        self.assertEqual(self.poll(), "stop")
        self.assertEqual(self.claims(), [])

    def test_stop_file_error_is_a_stop(self):
        bridge = self.bridge()
        with mock.patch.object(md.os, "stat", side_effect=PermissionError("denied")):
            self.assertTrue(bridge.stop_requested())

    def test_stop_after_claim(self):
        bridge = self.bridge()
        bridge.boundary = lambda name: bridge.stop_event.set() if name == "claim_sent" else None
        self.assertEqual(self.poll(), "halt")
        record = self.assert_halt("stop_requested", phase="post_claim")
        self.assertEqual(record["controller"]["claim"]["task_id"], TID)
        self.assertEqual(self.server.claimed, [TID])
        self.assert_no_child()
        self.assertIsNone(self.agents_md(), "#211 permitted cleanup after a contained stop")

    def test_pre_exec_stop(self):
        bridge = self.bridge()
        bridge.boundary = lambda name: bridge.stop_event.set() if name == "worker_registered" else None
        self.assertEqual(self.poll(), "halt")
        self.assert_halt("stop_requested", phase="worker_ack")
        self.assert_no_child()
        self.assertEqual(bridge.signals.sent, [], "a gated child is released by EOF, never signalled")
        self.assert_only_port_signalled()

    def test_child_payload_waits_for_ack(self):
        bridge = self.bridge()
        seen = {}

        def look(name):
            if name == "worker_registered":
                seen["cli_before_ack"] = self.cli_runs()
                seen["status_before_ack"] = self.ingests("status")
            if name == "worker_acked":
                seen["status_after_ack"] = self.ingests("status")
                seen["cli_after_ack"] = self.cli_runs()

        bridge.boundary = look
        self.assertEqual(self.poll(), "done")
        self.assertEqual(seen["cli_before_ack"], [], "payload ran before register and confirm_ack")
        self.assertEqual(seen["status_before_ack"], [])
        self.assertEqual(seen["cli_after_ack"], [], "payload ran before the work event")
        self.assertEqual([e["detail"]["task_id"] for e in seen["status_after_ack"]], [TID])
        self.assertEqual(len(self.cli_runs()), 1)


class BridgeStopDuringWorker(BridgeHarness):
    mode = "stop-worker"

    def test_stop_during_worker_uses_signal_port(self):
        bridge = self.bridge()
        self.assertEqual(self.poll(), "halt")
        self.assert_halt("stop_requested", phase="worker")
        runs = self.cli_runs()
        self.assertEqual(len(runs), 1)
        pgid = runs[0]["pgid"]
        self.assertEqual([s[:2] for s in bridge.signals.sent][:1], [(pgid, stopctl.SIGTERM)])
        self.assert_only_port_signalled()
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.base / "worker.pid").read_text()), 0)
        self.assertIsNone(self.agents_md(), "cleanup ran only after #211 confirmed the group gone")


class BridgeStopDuringReviewer(BridgeHarness):
    mode = "stop-reviewer"
    reviewer = "claude-code"

    def test_stop_during_reviewer_uses_signal_port(self):
        bridge = self.bridge()
        self.assertEqual(self.poll(), "halt")
        self.assert_halt("stop_requested", phase="reviewer")
        runs = self.cli_runs()
        self.assertEqual([r["role"] for r in runs], ["worker", "reviewer"])
        self.assertEqual(bridge.signals.sent[0][:2], (runs[1]["pgid"], stopctl.SIGTERM))
        self.assert_only_port_signalled()
        with self.assertRaises(ProcessLookupError):
            os.kill(int((self.base / "reviewer.pid").read_text()), 0)


class BridgeContainment(BridgeHarness):
    mode = "leftover-worker"

    def test_worker_containment(self):
        bridge = self.bridge()
        self.assertEqual(self.poll(), "done")
        leftover = int((self.base / "leftover.pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(leftover, 0)
        self.assertTrue(bridge.signals.sent, "the leftover group was stopped through the port")
        self.assert_only_port_signalled()
        final = self.result_patches()[-1]
        self.assertEqual(final["status"], "failed")
        self.assertIn("outlived the worker", final["result"])
        self.assertIsNone(self.journal())


class BridgeTimeout(BridgeHarness):
    mode = "slow-worker"

    def test_timeout_is_an_ordinary_failure(self):
        with mock.patch.object(md, "TASK_TIMEOUT", 1):
            self.assertEqual(self.poll(), "done")
        final = self.result_patches()
        self.assertEqual(len(final), 1)
        self.assertEqual(final[0]["status"], "failed")
        self.assertIn("timed out", final[0]["result"])
        self.assert_only_port_signalled()
        self.assertIsNone(self.journal())


class BridgeEvents(BridgeHarness):
    reviewer = "claude-code"

    def test_authenticated_task_id_events(self):
        self.assertEqual(self.poll(), "done")
        status = self.ingests("status")
        self.assertEqual([e["detail"]["task_id"] for e in status], [TID, TID])
        runs = self.ingests("run_complete")
        self.assertEqual([(e["detail"]["role"], e["detail"]["task_id"]) for e in runs],
                         [("worker", TID), ("review", TID)])
        for r in self.server.requests:
            if r["path"] == "/api/ingest":
                self.assertEqual(r["headers"]["authorization"], "Bearer bridge-token")
        final = self.result_patches()
        self.assertEqual(len(final), 1, "exactly one result PATCH")
        self.assertEqual(final[0]["status"], "done")
        # D25: run_complete is emitted before pointer cleanup, and the result PATCH after it.
        order = [(r["path"], json.loads(r["body"]).get("kind") or json.loads(r["body"]).get("status"))
                 for r in self.server.requests if r["body"]]
        self.assertLess(order.index(("/api/ingest", "run_complete")), order.index((f"/api/tasks/{TID}", "done")))


class BridgeFailClosed(BridgeHarness):
    def test_cleanup_refusal_after_journal_failure(self):
        bridge = self.bridge()
        real = bridge.journal.persist

        def persist(record):
            if record.get("outcome") == "cleanup_pending":
                raise OSError("disk full")
            return real(record)

        bridge.journal.persist = persist
        self.assertEqual(self.poll(), "halt")
        self.assert_halt("journal_write_failed", phase="cleanup")
        self.assertIsNotNone(self.agents_md(), "pointers were cleaned up without #211 permission")
        self.assertIn(ak_pointers.POINTERS_BEGIN, self.agents_md())

    def test_identity_unverifiable_retains_journal(self):
        calls = {"n": 0}
        real = md.bridge_process_table

        def table():
            calls["n"] += 1
            if calls["n"] > 1:  # register sees the child; the exit check cannot
                raise OSError("process table unavailable")
            return real()

        self.bridge(table=table)
        self.assertEqual(self.poll(), "halt")
        record = self.assert_halt("identity_unverifiable", phase="worker_exit")
        self.assertTrue(record["controller"]["recovery_retained"])
        self.assertEqual(len(self.cli_runs()), 1, "no second child")
        self.assertIsNotNone(self.agents_md(), "cleanup must wait for a confirmed group")

    def test_journal_write_failure_before_claim(self):
        bridge = self.bridge()
        bridge.journal.persist = mock.Mock(side_effect=OSError("read-only"))
        self.assertEqual(self.poll(), "halt")
        self.assertEqual(self.claims(), [])
        self.assertEqual(bridge.halted.code, "journal_write_failed")
        self.assert_no_child()

    def test_exact_claim_not_proven_without_durable_write(self):
        bridge = self.bridge()
        real = bridge.journal.persist

        def persist(record):
            if record.get("outcome") == "claimed":
                raise OSError("disk full")
            return real(record)

        bridge.journal.persist = persist
        self.assertEqual(self.poll(), "halt")
        self.assertEqual(bridge.halted.code, "journal_write_failed")
        self.assert_no_child()


class BridgeLaneUser(BridgeHarness):
    mode = "stop-worker"

    def test_lane_user_containment_uses_signal_port(self):
        lane = md.LaneUser("lane", 4242, str(self.base), "/bin/sh")
        ops: list[tuple] = []

        def lane_op(lane_user, *args, timeout=md.LANE_OP_TIMEOUT):
            ops.append(args)
            return 0

        def argv(lane_user, cmd, env):
            self.assertNotIn("MC_TOKEN", env)
            # sudo itself is not available here: the wrapper runs the CLI directly.
            return [md.shutil.which(cmd[0]), *cmd[1:]]

        with mock.patch.object(md, "lane_user", return_value=lane), \
                mock.patch.object(md, "lane_preflight"), \
                mock.patch.object(md, "lane_argv", side_effect=argv), \
                mock.patch.object(md, "_lane_op", side_effect=lane_op):
            bridge = self.bridge()
            self.assertEqual(self.poll(), "halt")
        self.assert_halt("stop_requested", phase="worker")
        pgid = self.cli_runs()[0]["pgid"]
        self.assertIn((md.LANE_KILL, "-TERM", "--", f"-{pgid}"), ops)
        self.assertIn((pgid, stopctl.SIGTERM, True), bridge.signals.sent)
        self.assert_only_port_signalled()
        self.assertEqual(self.cli_runs()[0]["env"].count("HOME"), 1)


class BridgeStartupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name).resolve()
        self.ledger = self.base / "ledger"
        self.ledger.mkdir(mode=0o700)
        os.chmod(self.ledger, 0o700)
        self.root = self.base / "work"
        self.root.mkdir()
        self.config = {"authority": AUTHORITY, "actor_id": "tester", "ledger_dir": str(self.ledger),
                       "workdir": str(self.root), "repos": [{"repo": REPO, "project": "proj",
                       "platform": "claude-code", "machine": HOST, "ready_labels": ["r"], "blocked_labels": []}]}

    def tearDown(self):
        self.tmp.cleanup()

    def start(self, env_extra=None, config=None, platforms=("claude-code",)):
        path = self.base / "bridge.json"
        path.write_text(json.dumps(self.config if config is None else config))
        env = {"MC_BRIDGE_ENABLED": "1", "MC_BRIDGE_CONFIG": str(path), "MC_MAX_CONCURRENT": "1",
               "PATH": "/usr/bin:/bin", **(env_extra or {})}
        env = {k: v for k, v in env.items() if v is not None}
        err: list[str] = []

        def capture(*args, file=None, **k):
            err.append(" ".join(str(a) for a in args))

        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(md, "HOSTNAME", HOST), \
                mock.patch.object(md, "WORKDIR", self.root), mock.patch("builtins.print", side_effect=capture), \
                mock.patch.object(md.signal, "signal"), \
                mock.patch.object(md.BridgeDispatcher, "poll_once", side_effect=AssertionError("polled")):
            code = md.bridge_main(list(platforms))
        return code, "\n".join(err)

    def test_concurrency_must_be_exactly_one(self):
        for value in (None, "2", "0", "-1", "abc", " 1", "1.0"):
            with self.subTest(value=value):
                code, err = self.start({"MC_MAX_CONCURRENT": value})
                self.assertEqual(code, 2)
                self.assertIn("code=invalid_concurrency", err)
        with mock.patch.dict(os.environ, {"MC_BRIDGE_ENABLED": "1", "MC_MAX_CONCURRENT": "abc"}):
            md.configure()  # a bad value no longer breaks import in bridge mode
        md.configure()

    def test_invalid_config_before_ledger(self):
        for name, env, config in (
            ("relative", {"MC_BRIDGE_CONFIG": "bridge.json"}, None),
            ("forbidden_key", None, {**self.config, "token": "x"}),
            ("missing_authority", None, {k: v for k, v in self.config.items() if k != "authority"}),
        ):
            with self.subTest(case=name):
                code, err = self.start(env, config)
                self.assertEqual(code, 2)
                self.assertIn("code=invalid_config phase=startup", err)
                self.assertFalse((self.ledger / md.BRIDGE_JOURNAL).exists())

    def test_ledger_must_be_private(self):
        os.chmod(self.ledger, 0o755)
        code, err = self.start()
        self.assertEqual(code, 2)
        self.assertIn("code=invalid_config", err)

    def test_platform_any_rejected(self):
        config = json.loads(json.dumps(self.config))
        config["repos"][0]["platform"] = "any"
        code, err = self.start(config=config)
        self.assertEqual(code, 2)
        self.assertIn("code=invalid_config", err)
        self.assertEqual(json.loads((self.ledger / md.BRIDGE_JOURNAL).read_text())["halt"]["code"], "invalid_config")

    def test_init_process_group_refused(self):
        with mock.patch.object(md.os, "getpgrp", return_value=1):
            code, err = self.start()
        self.assertEqual(code, 2)
        self.assertIn("code=invalid_config phase=startup", err)

    def test_dispatcher_platform_must_be_concrete(self):
        code, err = self.start(platforms=("hermes",))
        self.assertEqual(code, 2)
        self.assertIn("code=invalid_config", err)

    def test_workdir_must_match(self):
        config = {**self.config, "workdir": str(self.base)}
        code, err = self.start(config=config)
        self.assertEqual(code, 2)
        self.assertIn("code=invalid_config", err)

    def test_existing_stop_journal_is_left_untouched(self):
        path = self.ledger / md.BRIDGE_JOURNAL
        path.write_text('{"left": "by an earlier run"}\n')
        before = (path.read_bytes(), os.stat(path).st_mtime_ns)
        code, err = self.start()
        self.assertEqual(code, 3)
        self.assertIn("code=stop_journal_present", err)
        self.assertEqual((path.read_bytes(), os.stat(path).st_mtime_ns), before)


class BridgeDisabledTests(unittest.TestCase):
    def test_other_values_do_not_enable_bridge(self):
        expected = json.loads(GOLDEN.read_text(encoding="utf-8"))
        for value in ("0", "true", "yes", " 1", "1 ", ""):
            with self.subTest(value=value):
                with mock.patch.object(md, "bridge_main", side_effect=AssertionError("bridge mode")), \
                        mock.patch.object(md, "bridge_read_config", side_effect=AssertionError("config read")), \
                        mock.patch.object(md.drb, "load_handoff_rows", side_effect=AssertionError("ledger read")):
                    self.assertEqual(disabled_iteration({"MC_BRIDGE_ENABLED": value,
                                                         "MC_BRIDGE_CONFIG": "/nonexistent/bridge.json"}),
                                     expected)

    def test_disabled_claim_request_unchanged(self):
        with mock.patch.object(md, "HOSTNAME", HOST), mock.patch.dict(os.environ, {}, clear=True):
            body, headers, observed = md.task_claim_request("codex", None)
        self.assertEqual(json.dumps(body), json.dumps({"platform": "codex", "machine": HOST,
                                                       "agent_id": f"codex-{HOST}"}))
        self.assertIsNone(headers)
        self.assertIsNone(observed)

    def test_bridge_claim_request_requires_exact_id(self):
        for bad in (None, 0, True, "5", md.stopctl.MAX_TASK_ID + 1):
            with self.subTest(task_id=bad), self.assertRaises(ValueError):
                md.task_claim_request("codex", None, project="proj", task_id=bad)


class BridgeCodeTests(unittest.TestCase):
    def test_public_codes_mapping(self):
        for internal in ("stop_before_claim", "stopped_after_claim", "launch_after_stop", "ack_after_stop",
                         "stopped_group_absent", "stopped_after_exit"):
            self.assertEqual(md.bridge_public_code(internal), "stop_requested")
        self.assertEqual(md.bridge_public_code("claim_unresolved"), "claim_unknown")
        for internal in ("journal_failed", "journal_clear_failed", "cleanup_unconfirmed"):
            self.assertEqual(md.bridge_public_code(internal), "journal_write_failed")
        for internal in ("register_unverifiable", "foreign", "reused", "timeout", "ambiguous_owner",
                         "signal_uncertain", "containment_unconfirmed", "anything_else"):
            self.assertEqual(md.bridge_public_code(internal), "identity_unverifiable")
        self.assertEqual(md.BridgeHalt("made_up", "x").code, "identity_unverifiable")
        self.assertEqual(set(md.BRIDGE_CODES), {
            "invalid_config", "invalid_concurrency", "ledger_unreadable", "stop_journal_present",
            "missing_task_id", "conflicting_candidate", "duplicate_candidate", "claim_mismatch",
            "exact_claim_miss", "claim_unknown", "journal_write_failed", "identity_unverifiable",
            "stop_requested"})

    def test_signal_port_refuses_unregistered_targets(self):
        children = md.BridgeChildren()
        port = md.BridgeSignalPort(children, table=lambda: {})
        with mock.patch.object(md.os, "killpg", side_effect=AssertionError("signalled")):
            for pgid in (0, 1, os.getpgrp(), os.getpid(), 999999, True):
                self.assertEqual(port.signal_group(pgid, stopctl.SIGTERM), "uncertain")
        self.assertEqual(port.sent, [])

    def test_signal_port_refuses_reaped_child(self):
        children = md.BridgeChildren()
        proc = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
        children.add(proc, "worker", None)
        proc.wait()  # reaped: its pid and group id may now belong to anyone
        port = md.BridgeSignalPort(children, table=lambda: {})
        with mock.patch.object(md.os, "killpg", side_effect=AssertionError("signalled a reaped group")):
            self.assertEqual(port.signal_group(proc.pid, stopctl.SIGTERM), "uncertain")
        observer = md.BridgeObserver(children, table=lambda: {})
        identity = stopctl.OwnedIdentity(pid=proc.pid, pgid=proc.pid, role="worker", phase="worker",
                                         birth=children.get(proc.pid).birth, ancestry=(os.getpid(),))
        self.assertEqual(observer.observe(identity).status, "unverifiable")

    def test_no_direct_stop_outside_signal_port(self):
        tree = ast.parse((DISPATCHER / "mc_dispatcher.py").read_text(encoding="utf-8"))
        forbidden = {"killpg", "stop_group", "stop_group_id", "stop_lane_group", "kill", "terminate",
                     "send_signal"}
        for node in tree.body:
            name = getattr(node, "name", "")
            if not (name.startswith("Bridge") or name.startswith("bridge_") or name.startswith("_bridge")):
                continue
            for item in ast.walk(node):
                if isinstance(item, ast.Call):
                    func = item.func
                    called = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
                    if called in forbidden or (called == "_lane_op" and name != "BridgeSignalPort"):
                        owner = [f.name for f in ast.walk(node) if isinstance(f, ast.FunctionDef)
                                 and item in list(ast.walk(f))]
                        self.assertEqual((name, owner[-1:]), ("BridgeSignalPort", ["signal_group"]),
                                         f"{called} called from {name}")


class CodeRabbit215Startup(BridgeStartupTests):
    def test_second_instance_refused(self):
        # Finding 5: a second dispatcher on the same ledger exits invalid_config and touches nothing.
        dir_fd = os.open(str(self.ledger), os.O_RDONLY)
        self.addCleanup(os.close, dir_fd)
        held = md.bridge_lock_ledger(dir_fd)
        self.addCleanup(os.close, held)
        (self.ledger / md.BRIDGE_JOURNAL).write_text("{}\n")
        before = sorted((p.name, p.stat().st_mtime_ns) for p in self.ledger.iterdir())
        code, err = self.start()
        self.assertEqual(code, 2)
        self.assertIn("code=invalid_config phase=startup", err)
        self.assertNotIn("stop_journal_present", err, "the journal was looked at under another instance")
        self.assertEqual(sorted((p.name, p.stat().st_mtime_ns) for p in self.ledger.iterdir()), before)

    def test_fifo_config_does_not_hang(self):
        # Findings 1 and 2: a FIFO is refused, not waited on.
        fifo = self.base / "bridge.fifo"
        os.mkfifo(fifo)
        # Each read runs under a deadline, so a blocking open fails the test instead of hanging it.
        def refused(fn):
            try:
                return md.bridge_bounded(fn, 3.0)
            except md.BridgeHalt as h:
                return h.code

        self.assertEqual(refused(lambda: md.bridge_read_config({"MC_BRIDGE_CONFIG": str(fifo)})),
                         "invalid_config")
        dir_fd = os.open(str(self.ledger), os.O_RDONLY)
        self.addCleanup(os.close, dir_fd)
        os.mkfifo(self.ledger / "handoff.json")
        self.assertEqual(refused(lambda: drb.load_handoff_rows(AUTHORITY, dir_fd=dir_fd)), "ledger_unreadable")
        os.mkfifo(self.ledger / md.BRIDGE_DONE)
        self.assertEqual(refused(lambda: md.BridgeDoneRecord(dir_fd).load()), "invalid_config")


class CodeRabbit215SecondStartup(BridgeStartupTests):
    def test_ledger_fd_closed_on_every_exit(self):
        # Finding 2: the ledger dir fd is closed after a lock refusal and after a normal return.
        opened: list[int] = []
        real = md.bridge_read_config

        def spy(environ):
            parsed, fd = real(environ)
            opened.append(fd)
            return parsed, fd

        dir_fd = os.open(str(self.ledger), os.O_RDONLY)
        self.addCleanup(os.close, dir_fd)
        held = md.bridge_lock_ledger(dir_fd)
        with mock.patch.object(md, "bridge_read_config", side_effect=spy):
            code, _err = self.start()
        self.assertEqual(code, 2)
        with self.assertRaises(OSError):
            os.fstat(opened[-1])
        os.close(held)
        (self.ledger / md.BRIDGE_JOURNAL).write_text("{}\n")  # returns 3 through _bridge_run
        with mock.patch.object(md, "bridge_read_config", side_effect=spy):
            code, _err = self.start()
        self.assertEqual(code, 3)
        with self.assertRaises(OSError):
            os.fstat(opened[-1])


if __name__ == "__main__":
    if "--capture-golden" in sys.argv:
        GOLDEN.write_text(json.dumps(disabled_iteration(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {GOLDEN}")
    else:
        unittest.main()
