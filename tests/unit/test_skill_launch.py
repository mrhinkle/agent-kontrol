#!/usr/bin/env python3
"""ak_skill_launch: the shared context, the fleet supervisor protocol, worker-exec, direct mode and recovery.

Context tests reuse the dispatcher Harness (real linked worktrees, fake api). Process tests run the real
helper as a subprocess against a local fake pointer server, with a stub wrapper that follows the
fleet-dispatch.sh hooks and stub CLIs. No network beyond 127.0.0.1, no real CLI, no host env file.
"""
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_dispatcher_skills import BLOCK, DISPATCHER, GIT_ENV, Harness, run_git  # noqa: E402

import ak_pointers  # noqa: E402
import ak_skill_launch as sl  # noqa: E402
import mc_dispatcher as md  # noqa: E402

HELPER = DISPATCHER / "ak_skill_launch.py"


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def wait_for(pred, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.05)
    return False


class ContextHarness(Harness):
    def setUp(self):
        super().setUp()
        for p in (mock.patch.object(md, "MC_URL", "https://ak.invalid"), mock.patch.object(md, "MC_TOKEN", "t")):
            p.start()
            self.addCleanup(p.stop)
        self.agents = self.wt / "AGENTS.md"

    def prepare(self, lane="lane-a", runtime="grok", cwd=None):
        return sl.prepare_context(str(cwd or self.wt), lane, runtime)

    def finish(self, ctx, **kw):
        try:
            return sl.finish_context(ctx, **kw)
        finally:
            sl.release_context(ctx)


class TestContext(ContextHarness):
    def test_restored_byte_for_byte_with_mode_and_crlf(self):
        raw = b"# rules\r\nkeep\r\n"
        self.agents.write_bytes(raw)
        self.agents.chmod(0o640)
        ctx = self.prepare()
        self.assertIn(BLOCK.replace("\n", "\r\n"), self.agents.read_bytes().decode())
        rec = json.loads(ctx.recovery_path.read_text())
        self.assertEqual(stat.S_IMODE(os.stat(ctx.recovery_path).st_mode), 0o600)
        self.assertEqual(rec["state"], "prepared")
        self.assertNotIn("t", [rec.get(k) for k in rec])  # no token in the record
        receipt = self.finish(ctx)
        self.assertTrue(receipt.ok, receipt.note)
        self.assertEqual(self.agents.read_bytes(), raw)
        self.assertEqual(stat.S_IMODE(os.stat(self.agents).st_mode), 0o640)
        self.assertFalse(ctx.recovery_path.exists())
        self.assert_unlocked()

    def test_only_lane_and_runtime_sent(self):
        ctx = self.prepare(lane="team/a", runtime="codex")
        self.finish(ctx)
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.pointer_calls()[0][0]).query)
        self.assertEqual(q, {"lane": ["team/a"], "runtime": ["codex"]})

    def test_empty_selection_writes_nothing(self):
        self.block = ""
        ctx = self.prepare()
        self.assertFalse(self.agents.exists())
        self.assertFalse(ctx.pointers_written)
        self.assertTrue(self.finish(ctx).ok)
        self.assertFalse(self.agents.exists())

    def test_worker_edits_kept(self):
        self.agents.write_text("# rules\n")
        ctx = self.prepare()
        self.agents.write_text("# worker line\n" + self.agents.read_text())
        self.assertTrue(self.finish(ctx).ok)
        self.assertEqual(self.agents.read_text(), "# worker line\n# rules\n")

    def test_edited_block_fails_and_keeps_record(self):
        self.agents.write_text("# rules\n")
        ctx = self.prepare()
        self.agents.write_text(self.agents.read_text().replace("first", "FIRST"))
        receipt = self.finish(ctx)
        self.assertFalse(receipt.ok)
        self.assertIn("edited", receipt.note)
        self.assertIn("FIRST", self.agents.read_text())
        self.assertTrue(ctx.recovery_path.exists())

    def test_staged_block_is_leakage(self):
        self.agents.write_text("# rules\n")
        run_git(self.wt, "add", "AGENTS.md")
        run_git(self.wt, "commit", "-q", "-m", "rules")
        ctx = self.prepare()
        run_git(self.wt, "add", "AGENTS.md")
        receipt = self.finish(ctx)
        self.assertFalse(receipt.ok)
        self.assertEqual(receipt.leaked, "staged in the git index")
        self.assertEqual(self.agents.read_text(), "# rules\n")

    def test_finish_runs_once(self):
        ctx = self.prepare()
        with mock.patch.object(ak_pointers, "cleanup", wraps=ak_pointers.cleanup) as cl:
            first = sl.finish_context(ctx)
            second = sl.finish_context(ctx)
        sl.release_context(ctx)
        self.assertIs(first, second)
        self.assertEqual(cl.call_count, 1)

    def test_unconfirmed_containment_writes_nothing(self):
        self.agents.write_text("# rules\n")
        ctx = self.prepare()
        injected = self.agents.read_text()
        receipt = self.finish(ctx, containment_confirmed=False)
        self.assertFalse(receipt.ok)
        self.assertFalse(receipt.contained)
        self.assertEqual(self.agents.read_text(), injected)
        self.assertTrue(ctx.recovery_path.exists())
        with self.assertRaises(sl.ContextError) as e:
            self.prepare()
        self.assertEqual(e.exception.code, 73)
        self.assertIn("interrupted", str(e.exception))

    def test_confirmed_finish_completes_after_unconfirmed_receipt(self):
        self.agents.write_text("# rules\n")
        ctx = self.prepare()
        self.assertFalse(sl.finish_context(ctx, containment_confirmed=False).ok)
        receipt = self.finish(ctx)
        self.assertTrue(receipt.ok, receipt.note)
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertFalse(ctx.recovery_path.exists())

    def test_refusals_start_nothing(self):
        cases = [
            ({"cwd": "relative/path"}, 73, "absolute"),
            ({"cwd": str(self.main_repo)}, 73, "MC_WORKDIR"),
            ({"lane": "../x"}, 73, "invalid lane"),
            ({"runtime": "claude-code"}, 73, "runtime"),
        ]
        sub = self.wt / "sub"
        sub.mkdir()
        cases.append(({"cwd": str(sub)}, 73, "not a git worktree"))
        link = self.root / "link"
        link.symlink_to(self.wt)
        cases.append(({"cwd": str(link)}, 73, "symlink"))
        for kw, code, needle in cases:
            with self.subTest(**kw):
                with self.assertRaises(sl.ContextError) as e:
                    self.prepare(**kw)
                self.assertEqual(e.exception.code, code)
                self.assertIn(needle, str(e.exception))
        self.assertEqual(self.pointer_calls(), [])
        self.assertFalse(self.agents.exists())

    def test_bad_responses_and_config_are_unavailable(self):
        for resp, needle in [({"demo": True, "empty": True, "block": "", "lane": "lane-a", "runtime": "grok"}, "demo"),
                             ({"demo": False, "empty": False, "block": BLOCK, "lane": "x", "runtime": "grok"},
                              "different lane")]:
            with self.subTest(needle=needle):
                self.pointer_response = resp
                with self.assertRaises(sl.ContextError) as e:
                    self.prepare()
                self.assertEqual(e.exception.code, 69)
                self.assertIn(needle, str(e.exception))
        self.pointer_response = None
        with mock.patch.object(md, "MC_TOKEN", ""):
            with self.assertRaises(sl.ContextError) as e:
                self.prepare()
        self.assertEqual(e.exception.code, 69)
        self.assertFalse(self.agents.exists())
        self.assertFalse((self.wt / ".git").read_text() == "")
        self.assert_unlocked()

    def test_same_worktree_contention(self):
        ctx = self.prepare()
        with self.assertRaises(sl.ContextError) as e:
            self.prepare()
        self.assertEqual(e.exception.code, 73)
        self.assertIn("already running", str(e.exception))
        self.finish(ctx)

    def test_malformed_existing_marker_refused(self):
        self.agents.write_text(f"{ak_pointers.POINTERS_BEGIN}\n")
        with self.assertRaises(sl.ContextError) as e:
            self.prepare()
        self.assertEqual(e.exception.code, 73)
        self.assertEqual(self.agents.read_text(), f"{ak_pointers.POINTERS_BEGIN}\n")
        self.assertFalse((md.linked_worktree_git_dir(self.wt) / sl.RECOVERY_NAME).exists())
        self.assert_unlocked()


class TestRecover(ContextHarness):
    def run_recover(self):
        with mock.patch.object(sys, "stdout"), mock.patch.object(sys, "stderr"):
            return sl.main_recover(mock.Mock(cwd=str(self.wt)))

    def test_recover_after_group_gone(self):
        self.agents.write_text("# rules\n")
        ctx = self.prepare()
        dead = subprocess.Popen(["true"], start_new_session=True)
        dead.wait()
        ctx.register_worker(dead.pid)
        sl.release_context(ctx)  # as after SIGKILL of the supervisor: record and block remain
        self.assertEqual(self.run_recover(), 0)
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertFalse(ctx.recovery_path.exists())

    def record_path(self):
        return md.linked_worktree_git_dir(self.wt) / sl.RECOVERY_NAME

    def fail_prepared_record(self):
        real = sl.SkillContext.record

        def record(ctx, state):
            if state == "prepared":
                raise OSError(28, "No space left on device")
            return real(ctx, state)
        return mock.patch.object(sl.SkillContext, "record", record)

    def test_prepared_record_failure_restores_and_clears(self):
        self.agents.write_text("# rules\n")
        with self.fail_prepared_record(), self.assertRaises(sl.ContextError) as e:
            self.prepare()
        self.assertEqual(e.exception.code, 73)
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertFalse(self.record_path().exists())
        self.assert_unlocked()

    def test_prepared_record_and_restore_failure_keeps_recoverable_journal(self):
        self.agents.write_text("# rules\n")
        with self.fail_prepared_record(), \
                mock.patch.object(ak_pointers, "cleanup", side_effect=ak_pointers.PointerFileError("busy")), \
                self.assertRaises(sl.ContextError) as e:
            self.prepare()
        self.assertEqual(e.exception.code, 74)
        self.assertIn("kept", str(e.exception))
        self.assertIn(BLOCK, self.agents.read_text())
        self.assertEqual(json.loads(self.record_path().read_text())["state"], "preparing")
        with self.assertRaises(sl.ContextError):
            self.prepare()
        self.assertEqual(self.run_recover(), 0)
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertFalse(self.record_path().exists())

    def crash_preparing(self, failpoint):
        """Kill a real preparing process at a failpoint: os._exit, so no handler or finally runs."""
        script = textwrap.dedent(f"""
            import os, sys
            from pathlib import Path
            sys.path.insert(0, {str(DISPATCHER)!r})
            import ak_pointers, ak_skill_launch as sl, mc_dispatcher as md
            md.WORKDIR, md.MC_URL, md.MC_TOKEN = Path({str(self.root)!r}), "https://ak.invalid", "t"
            md.fetch_pointers = lambda lane, runtime: {BLOCK!r}
            if {failpoint!r} == "after-write":
                real = sl.SkillContext.record
                sl.SkillContext.record = lambda ctx, st: os._exit(9) if st == "prepared" else real(ctx, st)
            else:
                ak_pointers.write_replacing = lambda *a: os._exit(9)
            sl.prepare_context({str(self.wt)!r}, "lane-a", "grok")
            os._exit(0)
        """)
        r = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 9, r.stderr)
        self.assertEqual(json.loads(self.record_path().read_text())["state"], "preparing")
        with self.assertRaises(sl.ContextError) as e:
            self.prepare()
        self.assertIn("interrupted", str(e.exception))

    def test_crash_after_injection_before_prepared_record(self):
        self.agents.write_text("# rules\n")
        self.crash_preparing("after-write")
        self.assertIn(BLOCK, self.agents.read_text())
        self.assertEqual(self.run_recover(), 0)
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertFalse(self.record_path().exists())

    def test_crash_before_injection_after_preparing_record(self):
        self.agents.write_text("# rules\n")
        self.crash_preparing("before-write")
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertEqual(self.run_recover(), 0)
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertFalse(self.record_path().exists())

    def test_ambiguous_preparing_state_is_kept(self):
        self.agents.write_text("# rules\n")
        self.crash_preparing("after-write")
        self.agents.write_text("# someone else\n")
        self.assertEqual(self.run_recover(), 74)
        self.assertEqual(self.agents.read_text(), "# someone else\n")
        self.assertTrue(self.record_path().exists())

    def test_recover_refuses_live_group_without_signalling(self):
        ctx = self.prepare()
        live = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.addCleanup(lambda: (live.kill(), live.wait()))
        ctx.register_worker(live.pid)
        sl.release_context(ctx)
        self.assertEqual(self.run_recover(), 73)
        self.assertIsNone(live.poll())
        self.assertTrue(ctx.recovery_path.exists())


# --- real processes ------------------------------------------------------------------

STUB_WRAPPER = """#!/usr/bin/env bash
# Follows fleet-dispatch.sh hooks 2 and 3 for the supervised path.
echo $$ > "$STATE/wrapper.pid"
spec="$("$PY" "$HELPER" ctl hello --pid $$)" || exit 69
echo "$spec" > "$STATE/spec_path"
[ "${STUB_HANG_BEFORE_WORKER:-}" = 1 ] && { echo $$ > "$STATE/wrapper.ready"; sleep 30; }
"$PY" "$HELPER" worker-exec -- "$STUB_GROK" "$spec" >> "$STATE/log" 2>&1 &
pid=$!
echo $pid > "$STATE/worker.pid"
wait $pid; rc=$?
kill -0 -"$pid" 2>/dev/null && echo orphans > "$STATE/orphans"
"$PY" "$HELPER" ctl finish "$rc" --pid $$ >> "$STATE/log" 2>&1 || { cp "$CWD/AGENTS.md" "$STATE/agents_at_finish" 2>/dev/null; exit 74; }
cp "$CWD/AGENTS.md" "$STATE/agents_at_finish" 2>/dev/null || echo missing > "$STATE/agents_at_finish"
exit $rc
"""

STUB_GROK = """#!{py}
import os, signal, sys, time
state, cwd, mode = os.environ["STATE"], os.environ["CWD"], os.environ.get("STUB_MODE", "ok")
open(os.path.join(state, "grok.ran"), "w").write(open(sys.argv[1]).read())
saw = "ak-skills:begin" in open(os.path.join(cwd, "AGENTS.md")).read()
open(os.path.join(state, "saw_block"), "w").write(str(saw))
if "AK_SKILL_CONTROL" in os.environ:
    open(os.path.join(state, "env_leak"), "w").write("1")
if mode == "bgchild":
    if os.fork() == 0:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        open(os.path.join(state, "child.pid"), "w").write(str(os.getpid()))
        time.sleep(3.0)  # past the supervisor's 2s TERM grace: only SIGKILL stops it
        open(os.path.join(cwd, "AGENTS.md"), "a").write("late\\n")
        open(os.path.join(state, "child.wrote"), "w").write("1")
        os._exit(0)
    time.sleep(0.2)
    sys.exit(0)
if mode == "bgfinish":
    if os.fork() == 0:
        signal.signal(signal.SIGTERM, lambda *a: open(os.path.join(state, "term.hit"), "w").write("1"))
        open(os.path.join(state, "child.pid"), "w").write(str(os.getpid()))
        time.sleep(30)
        os._exit(0)
    sys.exit(0)
if mode == "hang":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    open(os.path.join(state, "grok.ready"), "w").write("1")
    time.sleep(60)
sys.exit(3 if mode == "fail" else 0)
"""


class PointerServer:
    def __init__(self):
        self.block = BLOCK
        self.demo = False
        self.requests = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.requests.append((self.path, self.headers.get("Authorization")))
                q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                body = json.dumps({"demo": outer.demo, "lane": q["lane"][0], "runtime": q["runtime"][0],
                                   "empty": outer.block == "", "block": outer.block}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class ProcessHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.base = base
        main = base / "main"
        root = base / "work"
        root.mkdir()
        env = dict(os.environ, **GIT_ENV)
        subprocess.run(["git", "init", "-q", "-b", "main", str(main)], check=True, env=env)
        (main / "README.md").write_text("hi\n")
        subprocess.run(["git", "-C", str(main), "add", "."], check=True, env=env)
        subprocess.run(["git", "-C", str(main), "commit", "-qm", "init"], check=True, env=env)
        self.wt = root / "proj"
        subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "lane", str(self.wt)], check=True,
                       env=env)
        self.agents = self.wt / "AGENTS.md"
        self.agents.write_text("# rules\n")
        self.state = base / "state"
        self.state.mkdir()
        self.server = PointerServer()
        self.addCleanup(self.server.close)
        wrapper = base / "wrapper.sh"
        wrapper.write_text(STUB_WRAPPER)
        grok = base / "grok"
        grok.write_text(STUB_GROK.format(py=sys.executable))
        for f in (wrapper, grok):
            f.chmod(0o755)
        self.wrapper, self.grok = wrapper, grok
        (base / "spec.md").write_text("do the thing\n")
        home = base / "home"
        home.mkdir()
        self.env = {**GIT_ENV, "PATH": os.environ["PATH"], "HOME": str(home),
                    "TMPDIR": tempfile.gettempdir(), "MC_URL": self.server.url,
                    "MC_TOKEN": "fixture-token", "MC_WORKDIR": str(root), "PY": sys.executable, "HELPER": str(HELPER),
                    "STATE": str(self.state), "CWD": str(self.wt), "STUB_GROK": str(grok)}
        self.git_dir = md.linked_worktree_git_dir(self.wt)

    def launch(self, **extra):
        env = {**self.env, **extra}
        return subprocess.Popen(
            [sys.executable, str(HELPER), "fleet", "--wrapper", str(self.wrapper), "--",
             "--cwd", str(self.wt), "--spec", str(self.base / "spec.md"), "--skills-lane", "lane-a"],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def run_launch(self, **extra):
        p = self.launch(**extra)
        out, err = p.communicate(timeout=60)
        return p.returncode, err

    def worker_pid(self):
        return int((self.state / "worker.pid").read_text())

    def assert_clean(self):
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assertFalse((self.git_dir / sl.RECOVERY_NAME).exists())
        self.assertEqual(list(Path(tempfile.gettempdir()).glob("aksk-*/ctl")), [])


class TestSupervisorProcess(ProcessHarness):
    def test_success_reads_block_and_cleans_before_classification(self):
        rc, err = self.run_launch()
        self.assertEqual(rc, 0, err)
        self.assertEqual((self.state / "saw_block").read_text(), "True")
        self.assertEqual((self.state / "agents_at_finish").read_text(), "# rules\n")
        ran = (self.state / "grok.ran").read_text()
        self.assertIn("lane=lane-a", ran)
        self.assertIn("runtime=grok", ran)
        self.assertTrue(ran.endswith("do the thing\n"))
        self.assertFalse(str(self.state / "spec_path").startswith(str(self.wt)))
        self.assertFalse((self.state / "env_leak").exists())
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0][1], "Bearer fixture-token")
        self.assert_clean()

    def test_worker_code_passed_through(self):
        rc, _ = self.run_launch(STUB_MODE="fail")
        self.assertEqual(rc, 3)
        self.assert_clean()

    def test_term_ignoring_background_child_stopped_before_cleanup(self):
        rc, err = self.run_launch(STUB_MODE="bgchild")
        self.assertEqual(rc, 0, err)
        child = int((self.state / "child.pid").read_text())
        self.assertFalse(alive(child))
        time.sleep(3.5)
        self.assertFalse((self.state / "child.wrote").exists(), "background child wrote after cleanup")
        self.assert_clean()

    def test_supervisor_term_while_worker_runs(self):
        p = self.launch(STUB_MODE="hang")
        self.assertTrue(wait_for(lambda: (self.state / "grok.ready").exists()))
        worker = self.worker_pid()
        p.send_signal(signal.SIGTERM)
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 128 + signal.SIGTERM)
        self.assertFalse(alive(worker))
        self.assert_clean()

    def test_controller_killed_after_ack(self):
        p = self.launch(STUB_MODE="hang")
        self.assertTrue(wait_for(lambda: (self.state / "grok.ready").exists()))
        worker = self.worker_pid()
        os.killpg(os.getpgid(worker), 0)
        os.kill(int((self.state / "wrapper.pid").read_text()), signal.SIGKILL)
        _, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 70)
        self.assertIn("supervisor-failure", err)
        self.assertFalse(alive(worker))
        self.assert_clean()

    def test_controller_killed_during_finish_containment(self):
        p = self.launch(STUB_MODE="bgfinish")
        self.assertTrue(wait_for(lambda: (self.state / "term.hit").exists()), "finish containment never began")
        child = int((self.state / "child.pid").read_text())
        os.kill(int((self.state / "wrapper.pid").read_text()), signal.SIGKILL)
        _, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 70, err)
        self.assertIn("while its finish cleanup ran", err)
        self.assertFalse(alive(child), "TERM-ignoring child outlived the supervisor")
        self.assert_clean()

    def test_supervisor_killed_then_queue_dispatch_refused(self):
        tmp = self.base / "tmp"  # a SIGKILLed supervisor cannot remove its socket dir; keep it in this test's tree
        tmp.mkdir()
        p = self.launch(STUB_MODE="hang", TMPDIR=str(tmp))
        self.assertTrue(wait_for(lambda: (self.state / "grok.ready").exists()))
        worker = self.worker_pid()
        wrapper = int((self.state / "wrapper.pid").read_text())

        def reap():
            for g in (worker, wrapper):
                try:
                    os.killpg(g, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.addCleanup(reap)
        p.kill()  # the supervisor only: its lock goes, the worker stays
        p.wait(timeout=30)  # not communicate: the surviving wrapper and worker still hold its pipes
        for f in (p.stdout, p.stderr):
            f.close()
        self.assertTrue(alive(worker))
        calls, cli = [], []

        def fake_api(path, body=None, method="POST", max_bytes=None):
            calls.append((path, body, method))
            return {}
        sem = threading.Semaphore(1)
        sem.acquire()
        with mock.patch.object(md, "WORKDIR", self.wt.parent), mock.patch.object(md, "api", side_effect=fake_api), \
                mock.patch.object(md, "ingest"), \
                mock.patch.object(md, "run_cli", side_effect=lambda *a, **k: cli.append(a) or (True, "x", None)):
            md.run_task({"id": 9, "title": "t", "project": "proj"}, "grok", sem)
        self.assertEqual(cli, [])
        self.assertFalse([c for c in calls if c[0].startswith("/api/skills/pointers")])
        final = [c for c in calls if c[2] == "PATCH"][-1][1]
        self.assertEqual(final["status"], "failed")
        self.assertIn("interrupted skills launch", final["result"])
        self.assertTrue(alive(worker))
        self.assertIn(BLOCK, self.agents.read_text())  # the live worker's view is left alone
        self.assertTrue((self.git_dir / sl.RECOVERY_NAME).exists())

    def test_controller_killed_before_registration_then_barrier_refuses(self):
        p = self.launch(STUB_HANG_BEFORE_WORKER="1")
        self.assertTrue(wait_for(lambda: (self.state / "wrapper.ready").exists()))
        sock = next(Path(tempfile.gettempdir()).glob("aksk-*/ctl"))
        os.kill(int((self.state / "wrapper.ready").read_text()), signal.SIGKILL)
        _, err = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 70, err)
        self.assert_clean()
        mark = self.base / "mark"
        r = subprocess.run([sys.executable, str(HELPER), "worker-exec", "--", str(self.grok), "x"],
                           env={**self.env, "AK_SKILL_CONTROL": str(sock), "AK_SKILL_NONCE": "n",
                                "FLEET_LAUNCH_MARK": str(mark)}, capture_output=True, timeout=30)
        self.assertEqual(r.returncode, 127)
        self.assertIn("registration failed", mark.read_text())
        self.assertFalse((self.state / "grok.ran").exists())

    def test_registration_refused_without_hello(self):
        sup_dir = Path(tempfile.mkdtemp(prefix="aksk-"))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(sup_dir)]))
        ctx = mock.Mock(worker_pgid=None)
        sup = sl.Supervisor(ctx, "/bin/false", [], sup_dir / "spec", sup_dir)
        self.addCleanup(sup.close)
        threading.Thread(target=sup.serve, daemon=True).start()
        mark = self.base / "mark"
        r = subprocess.run([sys.executable, str(HELPER), "worker-exec", "--", str(self.grok), "x"],
                           env={**self.env, "AK_SKILL_CONTROL": sup.sock_path, "AK_SKILL_NONCE": sup.nonce,
                                "FLEET_LAUNCH_MARK": str(mark)}, capture_output=True, timeout=30)
        self.assertEqual(r.returncode, 127)
        self.assertIn("refused", mark.read_text())
        self.assertFalse((self.state / "grok.ran").exists())
        ctx.register_worker.assert_not_called()

    def test_stale_record_blocks_second_launch(self):
        (self.git_dir / sl.RECOVERY_NAME).write_text("{}")
        rc, err = self.run_launch()
        self.assertEqual(rc, 73)
        self.assertIn("interrupted", err)
        self.assertFalse((self.state / "spec_path").exists())
        self.assertEqual(self.server.requests, [])

    def test_demo_response_starts_nothing(self):
        self.server.demo = True
        rc, err = self.run_launch()
        self.assertEqual(rc, 69)
        self.assertIn("demo", err)
        self.assertFalse((self.state / "spec_path").exists())
        self.assertEqual(self.agents.read_text(), "# rules\n")


FAKE_DIRECT_CLI = """#!{py}
import os, signal, sys, time
state = os.environ["STATE"]
open(os.path.join(state, "argv"), "w").write("\\n".join(sys.argv[1:]))
open(os.path.join(state, "saw_block"), "w").write(str("ak-skills:begin" in open("AGENTS.md").read()))
mode = os.environ.get("STUB_MODE", "ok")
if mode == "hang":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(60)
if mode == "write":
    open("written.txt", "w").write("edit\\n")
sys.exit(5 if mode == "fail" else 0)
"""


class TestDirect(ProcessHarness):
    def direct(self, runtime="codex", timeout=30, purpose=None, **extra):
        bindir = self.base / "bin"
        bindir.mkdir(exist_ok=True)
        cli = bindir / runtime
        cli.write_text(FAKE_DIRECT_CLI.format(py=sys.executable))
        cli.chmod(0o755)
        env = {**self.env, **extra, "PATH": f"{bindir}{os.pathsep}{self.env['PATH']}"}
        return subprocess.run(
            [sys.executable, str(HELPER), "direct", "--runtime", runtime, "--cwd", str(self.wt), "--lane", "lane-a",
             "--spec", str(self.base / "spec.md"), "--timeout", str(timeout), "--log", str(self.base / "d.log")]
            + (["--purpose", purpose] if purpose else []),
            env=env, capture_output=True, text=True, timeout=60)

    def test_pilot_purpose_keeps_the_pilot_argv(self):
        for runtime, tail in (("codex", ["exec", "-s", "read-only"]), ("claude", ["--permission-mode", "default"])):
            r = self.direct(runtime, purpose="pilot")
            self.assertEqual(r.returncode, 0, r.stderr)
            argv = (self.state / "argv").read_text().split("\n")
            self.assertEqual(argv[:3] if runtime == "codex" else argv[-2:], tail)
            self.assert_clean()

    def test_coding_purpose_codex_workspace_write(self):
        r = self.direct(purpose="coding", STUB_MODE="write")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = (self.state / "argv").read_text().split("\n")
        self.assertEqual(argv[:3], ["exec", "--sandbox", "workspace-write"])
        self.assertIn("runtime=codex", argv[3])
        self.assertNotIn("read-only", argv)
        self.assertEqual((self.wt / "written.txt").read_text(), "edit\n")
        self.assert_clean()

    def test_coding_purpose_claude_accept_edits(self):
        r = self.direct("claude", purpose="coding", STUB_MODE="write")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = (self.state / "argv").read_text().split("\n")
        self.assertEqual(argv[0], "-p")
        self.assertEqual(argv[-4:], ["--output-format", "json", "--permission-mode", "acceptEdits"])
        self.assertFalse(any("bypass" in a or "dangerously" in a for a in argv))
        self.assertEqual((self.wt / "written.txt").read_text(), "edit\n")
        self.assert_clean()

    def test_unknown_purpose_starts_nothing(self):
        r = self.direct(purpose="review")
        self.assertEqual(r.returncode, 2)
        self.assertFalse((self.state / "argv").exists())
        self.assertEqual(self.server.requests, [])

    def test_codex_read_only_argv(self):
        r = self.direct()
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = (self.state / "argv").read_text().split("\n")
        self.assertEqual(argv[:3], ["exec", "-s", "read-only"])
        self.assertIn("runtime=codex", argv[3])
        self.assertEqual((self.state / "saw_block").read_text(), "True")
        self.assert_clean()

    def test_claude_argv_and_failure_passthrough(self):
        r = self.direct("claude", STUB_MODE="fail")
        self.assertEqual(r.returncode, 5)
        argv = (self.state / "argv").read_text().split("\n")
        self.assertEqual(argv[0], "-p")
        self.assertEqual(argv[-4:], ["--output-format", "json", "--permission-mode", "default"])
        self.assert_clean()

    def test_timeout_kills_term_ignoring_cli(self):
        r = self.direct(timeout=1, STUB_MODE="hang")
        self.assertEqual(r.returncode, 124)
        self.assertIn("wall-timeout", r.stdout)
        self.assert_clean()


if __name__ == "__main__":
    unittest.main()
