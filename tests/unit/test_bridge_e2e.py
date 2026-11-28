"""Deterministic unit tests for scripts/run-bridge-e2e.py (#213 L6). No network, no database.

The two-page test drives the real ``dispatch_ready_bridge._list_all`` through the
runner's task transport with an injected ``send``.
"""
from __future__ import annotations

import http.client
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents" / "dispatcher"))

import dispatch_ready_bridge as drb  # noqa: E402

# BRIDGE_E2E_RUNNER lets the same tests run against an older runner to show a fixed bug RED.
_spec = importlib.util.spec_from_file_location(
    "run_bridge_e2e", os.environ.get("BRIDGE_E2E_RUNNER") or ROOT / "scripts" / "run-bridge-e2e.py")
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

FIELDS = "id,title,description,project,platform,machine,priority,reviewer_platform,created_by,status"
BASE = urllib.parse.urlsplit("http://127.0.0.1:3999")


def row(task_id: str) -> dict:
    return {"id": task_id, "title": "t", "description": "d", "project": "bridge-62", "platform": "claude-code",
            "machine": "m", "priority": 2, "reviewer_platform": None, "created_by": "x", "status": "queued"}


class FakeSend:
    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def __call__(self, method, path, headers, body):
        self.calls.append({"method": method, "path": path, "headers": dict(headers), "body": body})
        status, payload = self.pages.pop(0)
        return status, json.dumps(payload).encode()


class TwoPageTransport(unittest.TestCase):
    def test_follows_cursor_with_exact_query(self):
        cursor = "eyJrIjpbInF1ZXVlZCIsMl19/+=?&"
        send = FakeSend([(200, {"demo": False, "tasks": [row("1")], "next_cursor": cursor}),
                         (200, {"demo": False, "tasks": [row("2")], "next_cursor": None})])
        transport = runner.TaskTransport(BASE, "tok", send=send)
        kind, rows = drb._list_all(transport)
        self.assertEqual(kind, "ok")
        self.assertEqual([r["id"] for r in rows], ["1", "2"])
        self.assertEqual(len(send.calls), 2)
        for call in send.calls:
            self.assertEqual(call["method"], "GET")
            self.assertEqual(call["headers"]["Authorization"], "Bearer tok")
            path, _, query = call["path"].partition("?")
            self.assertEqual(path, "/api/tasks")
            params = urllib.parse.parse_qs(query, keep_blank_values=True)
            self.assertEqual(params["status"], ["all"])
            self.assertEqual(params["limit"], ["200"])
            self.assertEqual(params["fields"], [FIELDS])
        self.assertNotIn("cursor=", send.calls[0]["path"])
        self.assertTrue(send.calls[1]["path"].endswith("&cursor=" + urllib.parse.quote(cursor, safe="")))
        self.assertEqual(urllib.parse.parse_qs(send.calls[1]["path"].partition("?")[2])["cursor"], [cursor])

    def test_demo_page_is_rejected(self):
        send = FakeSend([(200, {"demo": True, "tasks": [], "next_cursor": None})])
        transport = runner.TaskTransport(BASE, "tok", send=send)
        self.assertEqual(drb._list_all(transport)[0], "list_incomplete")
        self.assertTrue(transport.demo_seen)

    def test_page_without_next_cursor_is_rejected(self):
        send = FakeSend([(200, {"demo": False, "tasks": [row("1")]})])
        self.assertEqual(drb._list_all(runner.TaskTransport(BASE, "tok", send=send))[0], "list_incomplete")

    def test_create_sends_idempotency_key_and_maps_lost_reply(self):
        def dropped(method, path, headers, body):
            self.assertEqual(headers["Idempotency-Key"], "drb1-k")
            self.assertEqual(headers["Authorization"], "Bearer tok")
            raise http.client.RemoteDisconnected("closed")

        transport = runner.TaskTransport(BASE, "tok", send=dropped)
        with self.assertRaises(drb.LostTaskReply):
            transport.create_task({"title": "t"}, "drb1-k")
        self.assertEqual((transport.posts, transport.lost), (1, 1))


class Endpoints(unittest.TestCase):
    def test_mc_url(self):
        runner.check_mc_url("http://127.0.0.1:3999")
        for bad in ("http://u:p@127.0.0.1:3999", "https://127.0.0.1:3999", "http://192.0.2.10:3999",
                    "http://127.0.0.1:3999/api", "http://127.0.0.1"):
            with self.assertRaises(runner.Failure, msg=bad):
                runner.check_mc_url(bad)

    def test_database_url(self):
        runner.check_database_url("postgresql://postgres:pg@127.0.0.1:55462/postgres")
        for bad in ("postgresql://admin:pg@127.0.0.1:5432/x", "postgresql://postgres@127.0.0.1:5432/x",
                    "postgresql://postgres:pg@192.0.2.10:5432/x", "postgresql://postgres:pg@127.0.0.1:5432/x?host=h",
                    "mysql://postgres:pg@127.0.0.1:5432/x"):
            with self.assertRaises(runner.Failure, msg=bad):
                runner.check_database_url(bad)


class CloseReady(unittest.TestCase):
    def passing(self):
        return {"acceptance": {"AC1": True, "AC2": True, "AC3": True}, "all_scenarios_ran": True,
                "scenarios": {n: {"result": "pass"} for n in runner.ALL_SCENARIOS}, "mutation": None,
                "base": {"is_ancestor": True}, "final_cleanup": {"ok": True, "run_root_removed": True}}

    def test_true_only_when_ac1_to_ac3_pass(self):
        self.assertEqual(runner.close_ready_decision(self.passing())[0], True)
        for key in ("AC1", "AC2", "AC3"):
            report = self.passing()
            report["acceptance"][key] = False
            self.assertFalse(runner.close_ready_decision(report)[0], key)
        for change in (lambda r: r.update(mutation="demo_true"), lambda r: r.update(failure={"code": "x"}),
                       lambda r: r["final_cleanup"].update(ok=False), lambda r: r["scenarios"].pop("safe_stop"),
                       lambda r: r["base"].update(is_ancestor=False)):
            report = self.passing()
            change(report)
            self.assertFalse(runner.close_ready_decision(report)[0])

    def test_guard_rejects_close_ready_beside_a_failed_ac(self):
        report = self.passing()
        report["close_ready"] = True
        self.assertTrue(runner.close_ready_consistent(report))
        report["acceptance"]["AC2"] = False
        self.assertFalse(runner.close_ready_consistent(report))


class StubWorkspace:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.bin = root / "bin"
        self.home = root / "home"
        self.config_path = root / "bridge-config.json"


class ReviewMajors(unittest.TestCase):
    """CodeRabbit #216 Majors. Each test fails on the pre-fix runner (BRIDGE_E2E_RUNNER=<old file>)."""

    def test_unauthenticated_work_event_with_the_same_signature_fails(self):
        good = {"id": "1", "principal_kind": "legacy", "principal_id": "mc-token"}
        bad = {"id": "2", "principal_kind": None, "principal_id": None}
        self.assertEqual(runner.work_event_violations([good], 1), [])
        self.assertNotEqual(runner.work_event_violations([good, bad], 1), [])
        self.assertNotEqual(runner.work_event_violations([bad], 1), [])

    def test_raw_dispatcher_log_is_outside_the_report_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "report" / "scenarios" / "normal"
            disp = runner.Dispatcher(StubWorkspace(Path(tmp) / "ws"), "http://127.0.0.1:1", "tok",
                                     report / "dispatcher.log")
            self.assertNotIn(str(Path(tmp) / "report"), str(disp.log_path))

    def test_publish_log_never_copies_raw_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw, dst = Path(tmp) / "raw.log", Path(tmp) / "out" / "dispatcher.log"
            raw.write_text("Authorization: Bearer Zz9" + "Ab1" * 12 + "\n")
            self.assertTrue(runner.publish_log(raw, dst)["published"])
            self.assertNotIn("Ab1Ab1", dst.read_text())
            missing = runner.publish_log(Path(tmp) / "absent.log", Path(tmp) / "out" / "gone.log")
            self.assertFalse(missing["published"])
            self.assertFalse((Path(tmp) / "out" / "gone.log").exists())

    def test_cleanup_survives_a_dispatcher_that_never_started(self):
        run = runner.Run.__new__(runner.Run)
        with tempfile.TemporaryDirectory() as tmp:
            disp = runner.Dispatcher(StubWorkspace(Path(tmp)), "http://127.0.0.1:1", "tok", Path(tmp) / "d.log")
            run.dispatchers, run.sentinels, run.proxies, run.workspaces = [disp], [], [], []
            run.markers, run.incident = [], None
            out = run.cleanup_scenario({})
        self.assertTrue(out["ok"])
        self.assertEqual(out["dispatchers"], [{"pid": None, "launched": False}])

    def test_cleanup_finds_a_recorded_survivor_on_the_failure_path(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        try:
            start = runner.start_identity(child.pid)
            run = runner.Run.__new__(runner.Run)
            run.dispatchers, run.sentinels, run.proxies, run.workspaces = [], [], [], []
            run.markers, run.incident = [], None
            ctx = {"tree_snapshots": [{"descendant_starts": {str(child.pid): start}}]}
            out = run.cleanup_scenario(ctx)
            self.assertFalse(out["ok"])
            self.assertIn(child.pid, out["process_check"]["survivors"])
        finally:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()

    def test_stop_tree_refuses_a_pid_whose_launch_identity_does_not_match(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                pidfile = Path(tmp) / "next.pid"
                pidfile.write_text(json.dumps({"pid": child.pid, "pgid": child.pid, "start": "not-this-process"}))
                old = dict(os.environ)
                os.environ.update(REPORT_DIR=tmp, RUN_ID="unit")
                try:
                    self.assertEqual(runner.host_stop_tree(pidfile), 1)
                finally:
                    os.environ.clear()
                    os.environ.update(old)
                time.sleep(0.2)
                self.assertIsNone(child.poll(), "an unverified pid must never be signalled")
        finally:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


class Redaction(unittest.TestCase):
    def test_secrets_urls_and_keys(self):
        r = runner.Redactor()
        r.add("s3cr3t-Token-Value", "token")
        text = ("Authorization: Bearer abc.def s3cr3t-Token-Value postgresql://postgres:pg@127.0.0.1:1/x "
                "PASSWORD=hunter2 ghp_ABCDEFGHIJKLMNOPQRSTUV Zx9" + "Ab1" * 12)
        out = r.text(text)
        for leaked in ("abc.def", "s3cr3t", "postgres:pg", "hunter2", "ghp_ABC", "Ab1Ab1"):
            self.assertNotIn(leaked, out)
        sha = "2fc1fde966ba4e2619df7a7b22cfa6d756c6669e"
        self.assertEqual(r.text(sha), sha)
        self.assertEqual(r.text("agent:mc-token:create_task"), "agent:mc-token:create_task")


if __name__ == "__main__":
    unittest.main()
