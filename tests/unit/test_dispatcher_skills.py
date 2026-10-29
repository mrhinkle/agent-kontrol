#!/usr/bin/env python3
"""Dispatcher skill pointers: project confinement, worktree lock, AGENTS.md inject + cleanup.

Every run_task test uses a real linked git worktree in a temp dir, a fake api,
and a fake run_cli. No network, no real CLI, no host env file.
"""
import fcntl
import os
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock

DISPATCHER = Path(__file__).resolve().parents[2] / "agents" / "dispatcher"
sys.path.insert(0, str(DISPATCHER))
import ak_pointers  # noqa: E402
import mc_dispatcher as md  # noqa: E402
from ak_pointers import POINTERS_BEGIN, POINTERS_END, MalformedBlockError, apply_pointer_block  # noqa: E402

BLOCK = f'{POINTERS_BEGIN}\n- a (1.0.0, aaaaaaa) — first. Fetch: get_skill {{"id":"a"}}\n{POINTERS_END}'
BLOCK_2 = f'{POINTERS_BEGIN}\n- b (2.0.0, bbbbbbb) — second. Fetch: get_skill {{"id":"b"}}\n{POINTERS_END}'
GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
}


def run_git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


class TestMarkerParity(unittest.TestCase):
    """The same cases as tests/ui/skills-agents-md.test.ts for applyPointerBlock."""

    def test_append_and_line_break(self):
        self.assertEqual(apply_pointer_block("# Repo\nRules.\n", BLOCK), (f"# Repo\nRules.\n\n{BLOCK}\n", True))
        self.assertEqual(apply_pointer_block("# Repo", BLOCK)[0], f"# Repo\n\n{BLOCK}\n")
        self.assertEqual(apply_pointer_block("", BLOCK)[0], f"{BLOCK}\n")

    def test_replace_in_place_and_idempotent(self):
        out = apply_pointer_block(f"top\n\n{BLOCK}\n\nbottom\n", BLOCK_2)
        self.assertEqual(out, (f"top\n\n{BLOCK_2}\n\nbottom\n", True))
        first = apply_pointer_block("# Repo\n", BLOCK)[0]
        self.assertEqual(apply_pointer_block(first, BLOCK), (first, False))

    def test_remove(self):
        original = "# Repo\nRules.\n"
        with_block = apply_pointer_block(original, BLOCK)[0]
        self.assertEqual(apply_pointer_block(with_block, ""), (original, True))
        self.assertEqual(apply_pointer_block(original, "")[1], False)
        self.assertEqual(apply_pointer_block(f"top\n\n{BLOCK}\n\nbottom\n", "")[0], "top\n\nbottom\n")

    def test_duplicates_collapse(self):
        self.assertEqual(apply_pointer_block(f"{BLOCK}\n\nmid\n\n{BLOCK}\n", BLOCK_2)[0], f"{BLOCK_2}\n\nmid\n")
        self.assertEqual(apply_pointer_block(f"{BLOCK}\n\nmid\n\n{BLOCK}\n", "")[0], "mid\n")

    def test_crlf(self):
        original = "# Repo\r\nRules.\r\n"
        inserted = apply_pointer_block(original, BLOCK)[0]
        self.assertEqual(inserted, f"# Repo\r\nRules.\r\n\r\n{BLOCK.replace(chr(10), chr(13) + chr(10))}\r\n")
        replaced = apply_pointer_block(inserted, BLOCK_2)[0]
        self.assertNotIn("\n", replaced.replace("\r\n", ""))
        self.assertEqual(apply_pointer_block(replaced, BLOCK_2)[1], False)
        self.assertEqual(apply_pointer_block(replaced, "")[0], original)

    def test_missing_file(self):
        self.assertEqual(apply_pointer_block(None, ""), (None, False))
        self.assertEqual(apply_pointer_block(None, BLOCK), (f"{BLOCK}\n", True))

    def test_quoted_markers_are_prose(self):
        prose = f"Wrap it in {POINTERS_BEGIN} and {POINTERS_END} lines.\nKeep {POINTERS_BEGIN} in docs.\n"
        self.assertEqual(apply_pointer_block(prose, "")[1], False)
        self.assertEqual(apply_pointer_block(prose, BLOCK)[0], f"{prose}\n{BLOCK}\n")

    def test_malformed_refused(self):
        for text, msg in [
            (f"a\n{POINTERS_BEGIN}\nb\n", "begin marker without end"),
            (f"a\n{POINTERS_END}\nb\n", "end marker without begin"),
            (f"{POINTERS_END}\n{POINTERS_BEGIN}\n", "end marker without begin"),
            (f"{POINTERS_BEGIN}\n{POINTERS_BEGIN}\n{POINTERS_END}\n", "nested"),
        ]:
            with self.assertRaisesRegex(MalformedBlockError, msg):
                apply_pointer_block(text, BLOCK)

    def test_non_ascii_preserved(self):
        original = "# Règles — 日本語 🚀\nkeep\n"
        inserted = apply_pointer_block(original, BLOCK)[0]
        self.assertTrue(inserted.startswith(original))
        self.assertEqual(apply_pointer_block(inserted, "")[0], original)


class TestImport(unittest.TestCase):
    def test_import_reads_no_env_file(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, ".claude").mkdir()
            Path(home, ".claude", "mission-control.env").write_text("MC_URL=https://sentinel.invalid\nMC_TOKEN=sentinel\n")
            env = {k: v for k, v in os.environ.items() if not k.startswith("MC_")}
            env["HOME"] = home
            out = subprocess.run(
                [sys.executable, "-c", "import mc_dispatcher as m; print(repr(m.MC_URL), repr(m.MC_TOKEN))"],
                cwd=str(DISPATCHER), env=env, capture_output=True, text=True, check=True,
            )
            self.assertEqual(out.stdout.strip(), "'' ''")
            loaded = subprocess.run(
                [sys.executable, "-c", "import mc_dispatcher as m; m.load_env_file(); m.configure(); print(m.MC_URL)"],
                cwd=str(DISPATCHER), env=env, capture_output=True, text=True, check=True,
            )
            self.assertEqual(loaded.stdout.strip(), "https://sentinel.invalid")


class TestTransport(unittest.TestCase):
    def test_bounded_read(self):
        class Resp:
            def __init__(self, data):
                self.data = data

            def read(self, n=-1):
                return self.data if n < 0 else self.data[:n]

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        body = b'{"a": "' + b"x" * 100 + b'"}'
        with mock.patch.object(md, "MC_URL", "https://ak.invalid"), \
                mock.patch.object(md.urllib.request, "urlopen", return_value=Resp(body)) as opened:
            with self.assertRaisesRegex(ValueError, "larger than"):
                md.api("/api/skills/pointers?lane=a&runtime=b", None, "GET", max_bytes=50)
            self.assertEqual(md.api("/x", None, "GET", max_bytes=1000), {"a": "x" * 100})
            req = opened.call_args[0][0]
            self.assertEqual(req.get_method(), "GET")
            self.assertIsNone(req.data)


class Harness(unittest.TestCase):
    """A temp MC_WORKDIR with linked worktrees, a fake api, and a fake CLI."""

    def setUp(self):
        self._env = mock.patch.dict(os.environ, GIT_ENV)
        self._env.start()
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name).resolve()
        self.main_repo = base / "main"
        self.root = base / "work"
        self.root.mkdir()
        run_git(base, "init", "-q", "-b", "main", str(self.main_repo))
        (self.main_repo / "README.md").write_text("hi\n")
        run_git(self.main_repo, "add", "README.md")
        run_git(self.main_repo, "commit", "-q", "-m", "init")
        self.wt = self.add_worktree("proj")
        self.pointer_response = None
        self.pointer_error = None
        self.calls = []
        self.cli_calls = []
        self.worker = None
        self.reviewer = None
        patches = [
            mock.patch.object(md, "WORKDIR", self.root),
            mock.patch.object(md, "api", side_effect=self.fake_api),
            mock.patch.object(md, "ingest"),
            mock.patch.object(md, "run_cli", side_effect=self.fake_cli),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.tmp.cleanup()
        self._env.stop()

    def add_worktree(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        run_git(self.main_repo, "worktree", "add", "-q", "-b", f"lane-{name.replace('/', '-')}", str(path))
        return path

    def fake_api(self, path, body=None, method="POST", max_bytes=None):
        self.calls.append((path, body, method, max_bytes))
        if path.startswith("/api/skills/pointers"):
            if self.pointer_error:
                raise self.pointer_error
            if self.pointer_response is not None:
                return self.pointer_response
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
            return {"demo": False, "lane": q["lane"][0], "runtime": q["runtime"][0],
                    "empty": self.block == "", "block": self.block}
        return {}

    block = BLOCK

    def fake_cli(self, platform, prompt, cwd, review=False):
        self.cli_calls.append((platform, review, prompt, cwd))
        fn = self.reviewer if review else self.worker
        if fn:
            return fn(cwd)
        return True, "RESULT: ok\nVERDICT: APPROVE" if review else "RESULT: ok", None

    def patches(self):
        return [c for c in self.calls if c[2] == "PATCH"]

    def final(self):
        return self.patches()[-1][1]

    def dispatch(self, project="proj", platform="claude-code", **extra):
        sem = threading.Semaphore(1)
        sem.acquire()
        task = {"id": 7, "title": "t", "project": project, **extra}
        md.run_task(task, platform, sem)
        self.assertTrue(sem.acquire(blocking=False), "task semaphore not released")
        self.assert_unlocked()
        return self.final()

    def assert_unlocked(self):
        for gd in (self.main_repo / ".git" / "worktrees").glob("*"):
            lock = gd / md.LOCK_NAME
            if lock.exists():
                fd = os.open(lock, os.O_RDWR)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)

    def pointer_calls(self):
        return [c for c in self.calls if c[0].startswith("/api/skills/pointers")]


class TestConfinement(Harness):
    def assert_refused(self, project, needle):
        body = self.dispatch(project)
        self.assertEqual(body["status"], "failed")
        self.assertIn(needle, body["result"])
        self.assertEqual(self.cli_calls, [])
        self.assertEqual(self.pointer_calls(), [])

    def test_hostile_projects_refused_before_any_request(self):
        outside = Path(self.tmp.name).resolve() / "outside"
        outside.mkdir()
        os.symlink(outside, self.root / "escape")
        os.symlink(self.wt, self.root / "alias")
        (self.root / "plain").mkdir()
        (self.root / "file").write_text("x")
        for project, needle in [
            (None, "task.project is required"),
            ("", "task.project is required"),
            ("/etc", "task.project is required"),
            ("../main", "task.project is required"),
            ("./proj", "task.project is required"),
            (".", "task.project is required"),
            ("proj/..", "may not contain"),
            ("proj/../proj", "may not contain"),
            ("proj//x", "may not contain"),
            ("proj/", "may not contain"),
            ("pro\0j", "task.project is required"),
            ("missing", "project folder not found"),
            ("escape", "symlink"),
            ("alias", "symlink"),
            ("file", "not a directory"),
            ("plain", "not a git worktree"),
            ("x" * 101, "task.project is required"),
        ]:
            with self.subTest(project=project):
                self.calls.clear()
                self.assert_refused(project, needle)

    def test_resolve_project_rules(self):
        for bad in ["", "/abs", "a\0b", "a\\b", "..", "a/./b", "a/../b"]:
            with self.subTest(bad=bad), self.assertRaises(md.DispatchRefused):
                md.resolve_project(bad, self.root)
        self.assertEqual(md.resolve_project("proj", self.root), self.wt)
        nested = self.add_worktree("team/proj2")
        self.assertEqual(md.resolve_project("team/proj2", self.root), nested)
        os.symlink(self.root / "team", self.root / "teamlink")
        with self.assertRaisesRegex(md.DispatchRefused, "symlink"):
            md.resolve_project("teamlink/proj2", self.root)

    def test_root_itself_refused(self):
        with mock.patch.object(md, "WORKDIR", self.wt):
            with self.assertRaises(md.DispatchRefused):
                md.resolve_project(".", self.wt)

    def test_main_checkout_and_subfolder_refused(self):
        main_in_root = self.root / "maincheckout"
        run_git(self.root, "init", "-q", str(main_in_root))
        self.assert_refused("maincheckout", "main checkout")
        (self.wt / "sub").mkdir()
        self.calls.clear()
        self.assert_refused("proj/sub", "not a git worktree")

    def test_platform_runtime_mapping_and_privacy(self):
        secret = "PRIVATE-AGENTS-CONTENT-do-not-send"
        (self.wt / "AGENTS.md").write_text(f"# rules\n{secret}\n")
        for platform, runtime in [("claude-code", "claude"), ("codex", "codex"), ("grok", "grok")]:
            with self.subTest(platform=platform):
                self.calls.clear()
                self.assertEqual(self.dispatch(platform=platform)["status"], "done")
                [(path, body, method, max_bytes)] = self.pointer_calls()
                self.assertEqual(method, "GET")
                self.assertIsNone(body)
                self.assertEqual(max_bytes, md.MAX_POINTER_RESPONSE)
                self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(path).query),
                                 {"lane": ["proj"], "runtime": [runtime]})
                self.assertNotIn(secret, repr(self.calls))

    def test_nested_lane_is_url_encoded(self):
        self.add_worktree("team/proj2")
        self.assertEqual(self.dispatch("team/proj2")["status"], "done")
        path = self.pointer_calls()[0][0]
        self.assertIn("lane=team%2Fproj2", path)

    def test_unknown_platform_refused(self):
        body = self.dispatch(platform="hermes")
        self.assertEqual(body["status"], "failed")
        self.assertEqual(self.cli_calls, [])


class TestLock(Harness):
    def test_same_worktree_excluded_across_processes(self):
        git_dir = md.linked_worktree_git_dir(self.wt)
        holder = subprocess.Popen(
            [sys.executable, "-c", textwrap.dedent(f"""
                import fcntl, os, sys
                fd = os.open({str(git_dir / md.LOCK_NAME)!r}, os.O_RDWR | os.O_CREAT, 0o600)
                fcntl.flock(fd, fcntl.LOCK_EX)
                print("held", flush=True)
                sys.stdin.read()
            """)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), "held")
            sem = threading.Semaphore(1)
            sem.acquire()
            md.run_task({"id": 1, "title": "t", "project": "proj"}, "codex", sem)
            self.assertTrue(sem.acquire(blocking=False))
            self.assertEqual(self.final()["status"], "failed")
            self.assertIn("already running", self.final()["result"])
            self.assertEqual(self.cli_calls, [])
            self.assertEqual(self.pointer_calls(), [])
        finally:
            holder.stdin.close()
            holder.wait(10)
            holder.stdout.close()

    def test_same_project_concurrent_fails_different_project_parallel(self):
        self.add_worktree("other")
        inside = threading.Barrier(2, timeout=10)
        release = threading.Event()

        def worker(cwd):
            if cwd.name == "proj":
                inside.wait()
                release.wait(10)
            else:
                inside.wait()
            return True, "RESULT: ok", None

        self.worker = worker
        sems = [threading.Semaphore(1) for _ in range(3)]
        for s in sems:
            s.acquire()
        t1 = threading.Thread(target=md.run_task, args=({"id": 1, "title": "a", "project": "proj"}, "codex", sems[0]))
        t2 = threading.Thread(target=md.run_task, args=({"id": 2, "title": "b", "project": "other"}, "grok", sems[1]))
        t1.start()
        t2.start()
        t2.join(15)  # returns only if both workers were inside run_cli at once
        self.assertFalse(t2.is_alive())
        md.run_task({"id": 3, "title": "c", "project": "proj"}, "claude-code", sems[2])
        release.set()
        t1.join(15)
        by_id = {}
        for path, body, method, _ in self.calls:
            if method == "PATCH" and body.get("status") in ("done", "failed"):
                by_id[path] = body
        self.assertEqual(by_id["/api/tasks/1"]["status"], "done")
        self.assertEqual(by_id["/api/tasks/2"]["status"], "done")
        self.assertEqual(by_id["/api/tasks/3"]["status"], "failed")
        self.assertIn("already running", by_id["/api/tasks/3"]["result"])
        self.assertEqual(len([c for c in self.cli_calls if not c[1]]), 2)
        for s in sems:
            self.assertTrue(s.acquire(blocking=False))
        self.assert_unlocked()


class TestPointerResponse(Harness):
    def setUp(self):
        super().setUp()
        self.agents = self.wt / "AGENTS.md"
        self.agents.write_bytes(b"# rules\n")

    def assert_failed_untouched(self, needle):
        before = self.agents.read_bytes()
        body = self.dispatch()
        self.assertEqual(body["status"], "failed")
        self.assertIn(needle, body["result"])
        self.assertEqual(self.cli_calls, [])
        self.assertEqual(self.agents.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.wt.iterdir()), [".git", "AGENTS.md", "README.md"])

    def test_http_failure_and_timeout(self):
        for err in [urllib.error.URLError("down"), socket.timeout("timed out"),
                    urllib.error.HTTPError("u", 500, "boom", {}, None)]:
            with self.subTest(err=err):
                self.calls.clear()
                self.pointer_error = err
                self.assert_failed_untouched("skill pointers unavailable")

    def test_demo_rejected(self):
        self.pointer_response = {"demo": True, "lane": "proj", "runtime": "claude", "empty": False, "block": BLOCK}
        self.assert_failed_untouched("demo")

    def test_malformed_responses(self):
        good = {"demo": False, "lane": "proj", "runtime": "claude", "empty": False, "block": BLOCK}
        for resp in [
            [],
            {},
            {**good, "demo": 0},
            {**good, "lane": "other"},
            {**good, "runtime": "codex"},
            {**good, "empty": True},
            {**good, "empty": "false"},
            {**good, "block": 5},
            {**good, "block": "not a block"},
            {**good, "block": f"{BLOCK}\n{BLOCK}"},
            {**good, "block": BLOCK.replace("\n", "\r\n")},
            {**good, "block": f"{POINTERS_BEGIN}\n{'x' * md.MAX_POINTER_BLOCK}\n{POINTERS_END}"},
        ]:
            with self.subTest(resp=str(resp)[:80]):
                self.calls.clear()
                self.pointer_response = resp
                self.assert_failed_untouched("skill pointers unavailable")

    def test_concurrent_edit_refused(self):
        real_create = ak_pointers._create_temp

        def racing_create(*a, **k):
            self.agents.write_bytes(b"# someone else\n")
            return real_create(*a, **k)

        with mock.patch.object(ak_pointers, "_create_temp", side_effect=racing_create):
            body = self.dispatch()
        self.assertEqual(body["status"], "failed")
        self.assertIn("changed during dispatch", body["result"])
        self.assertEqual(self.cli_calls, [])
        self.assertEqual(self.agents.read_bytes(), b"# someone else\n")
        self.assertEqual(sorted(p.name for p in self.wt.iterdir()), [".git", "AGENTS.md", "README.md"])

    def test_unsafe_agents_files_refused(self):
        self.agents.unlink()
        target = self.wt / "real.md"
        target.write_text("x\n")
        os.symlink(target, self.agents)
        body = self.dispatch()
        self.assertIn("not a regular file", body["result"])
        self.assertTrue(self.agents.is_symlink())
        self.assertEqual(target.read_text(), "x\n")
        self.agents.unlink()
        self.agents.mkdir()
        self.calls.clear()
        self.assertIn("not a regular file", self.dispatch()["result"])
        self.agents.rmdir()
        os.mkfifo(self.agents)
        self.calls.clear()
        self.assertIn("not a regular file", self.dispatch()["result"])
        self.agents.unlink()
        self.agents.write_bytes(b"\xff\xfe bad utf8\n")
        self.calls.clear()
        self.assertIn("not valid UTF-8", self.dispatch()["result"])
        self.assertEqual(self.agents.read_bytes(), b"\xff\xfe bad utf8\n")
        self.agents.write_text(f"a\n{POINTERS_BEGIN}\nb\n")
        self.calls.clear()
        self.assertIn("begin marker without end", self.dispatch()["result"])
        self.assertEqual(self.cli_calls, [])


class TestLifecycle(Harness):
    def setUp(self):
        super().setUp()
        self.agents = self.wt / "AGENTS.md"

    def write_agents(self, data: bytes, mode=0o640):
        self.agents.write_bytes(data)
        os.chmod(self.agents, mode)

    def test_missing_file_empty_block_is_noop(self):
        self.block = ""
        body = self.dispatch()
        self.assertEqual(body["status"], "done")
        self.assertFalse(self.agents.exists())
        self.assertNotIn("ak-skills", self.cli_calls[0][2])

    def test_new_file_mode_follows_umask_without_changing_it(self):
        seen = []

        def worker(cwd):
            seen.append(stat.S_IMODE(os.stat(cwd / "AGENTS.md").st_mode))
            return True, "RESULT: ok", None

        self.worker = worker
        old = os.umask(0o027)
        try:
            with mock.patch.object(os, "umask", side_effect=AssertionError("umask touched")):
                self.assertEqual(self.dispatch()["status"], "done")
        finally:
            os.umask(old)
        self.assertEqual(seen, [0o640])

    def test_missing_file_block_created_then_removed(self):
        seen = []

        def worker(cwd):
            seen.append((cwd / "AGENTS.md").read_text())
            return True, "RESULT: ok", None

        self.worker = worker
        self.assertEqual(self.dispatch()["status"], "done")
        self.assertEqual(seen, [f"{BLOCK}\n"])
        self.assertIn("do not edit, stage, or commit", self.cli_calls[0][2])
        self.assertFalse(self.agents.exists())

    def test_untouched_file_restored_byte_for_byte(self):
        original = "# Règles 日本\r\nkeep\r\n".encode("utf-8")
        self.write_agents(original, 0o600)
        self.assertEqual(self.dispatch()["status"], "done")
        self.assertEqual(self.agents.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(os.stat(self.agents).st_mode), 0o600)

    def edit_outside(self, ok, output="RESULT: worker"):
        def worker(cwd):
            f = cwd / "AGENTS.md"
            text = f.read_text()
            self.assertIn(BLOCK, text)
            f.write_text("worker top\n" + text + "worker bottom\n")
            (cwd / "src.txt").write_text("worker file\n")
            return ok, output, None
        return worker

    def test_cleanup_after_success_failure_timeout_keeps_worker_edits(self):
        cases = [(True, "RESULT: worker", "done"), (False, "RESULT: worker failed", "failed"),
                 (False, "timed out after 3600s", "failed")]
        for ok, output, status in cases:
            with self.subTest(status=status, output=output):
                self.calls.clear()
                self.cli_calls.clear()
                self.write_agents(b"# rules\n", 0o640)
                self.worker = self.edit_outside(ok, output)
                body = self.dispatch()
                self.assertEqual(body["status"], status)
                self.assertEqual(self.agents.read_text(), "worker top\n# rules\nworker bottom\n")
                self.assertEqual(stat.S_IMODE(os.stat(self.agents).st_mode), 0o640)
                self.assertEqual((self.wt / "src.txt").read_text(), "worker file\n")

    def test_original_managed_block_restored(self):
        old = f"# rules\n\n{BLOCK_2}\n\nafter\n"
        self.write_agents(old.encode())

        def worker(cwd):
            f = cwd / "AGENTS.md"
            text = f.read_text()
            self.assertIn(BLOCK, text)
            self.assertNotIn(BLOCK_2, text)
            f.write_text(text.replace("after\n", "after\nworker line\n"))
            return True, "RESULT: ok", None

        self.worker = worker
        self.assertEqual(self.dispatch()["status"], "done")
        self.assertEqual(self.agents.read_text(), f"# rules\n\n{BLOCK_2}\n\nafter\nworker line\n")

    def test_duplicate_blocks_restored_after_collapse(self):
        old = f"{BLOCK_2}\n\nmid\n\n{BLOCK_2}\n"
        self.write_agents(old.encode())

        def worker(cwd):
            f = cwd / "AGENTS.md"
            self.assertEqual(f.read_text(), f"{BLOCK}\n\nmid\n")
            f.write_text(f.read_text() + "worker\n")
            return True, "RESULT: ok", None

        self.worker = worker
        self.assertEqual(self.dispatch()["status"], "done")
        self.assertEqual(self.agents.read_text(), old + "worker\n")

    def test_empty_block_removes_stale_block_then_restores(self):
        self.block = ""
        old = f"# rules\n\n{BLOCK_2}\n"
        self.write_agents(old.encode())

        def worker(cwd):
            f = cwd / "AGENTS.md"
            self.assertNotIn("ak-skills", f.read_text())
            f.write_text("worker top\n" + f.read_text())
            return True, "RESULT: ok", None

        self.worker = worker
        self.assertEqual(self.dispatch()["status"], "done")
        self.assertEqual(self.agents.read_text(), f"worker top\n{old}")

    def test_crlf_with_worker_edit(self):
        self.write_agents("# Règles\r\nkeep\r\n".encode())

        def worker(cwd):
            f = cwd / "AGENTS.md"
            data = f.read_bytes()
            self.assertNotIn(b"\n", data.replace(b"\r\n", b""))
            f.write_bytes(b"top\r\n" + data)
            return True, "RESULT: ok", None

        self.worker = worker
        self.assertEqual(self.dispatch()["status"], "done")
        self.assertEqual(self.agents.read_bytes(), "top\r\n# Règles\r\nkeep\r\n".encode())

    def test_worker_deletes_file(self):
        self.write_agents(b"# rules\n")
        self.worker = lambda cwd: ((cwd / "AGENTS.md").unlink(), (True, "RESULT: ok", None))[1]
        self.assertEqual(self.dispatch()["status"], "done")
        self.assertFalse(self.agents.exists())

    def assert_cleanup_fails(self, mutate, needle):
        self.write_agents(b"# rules\n")
        left = []

        def worker(cwd):
            f = cwd / "AGENTS.md"
            f.write_text(mutate(f.read_text()))
            left.append(f.read_bytes())
            return True, "RESULT: ok", None

        self.worker = worker
        body = self.dispatch(reviewer_platform="codex")
        self.assertEqual(body["status"], "failed")
        self.assertIn("AGENTS.md cleanup failed", body["result"])
        self.assertIn(needle, body["result"])
        self.assertEqual(self.agents.read_bytes(), left[0])
        self.assertEqual([c for c in self.cli_calls if c[1]], [], "reviewer ran after failed cleanup")

    def test_malformed_after_worker_preserved_and_fails(self):
        self.assert_cleanup_fails(lambda t: t + f"{POINTERS_BEGIN}\n", "begin marker without end")

    def test_block_edited_by_worker_preserved_and_fails(self):
        self.assert_cleanup_fails(lambda t: t.replace("first", "edited"), "was edited")

    def test_separator_edited_preserved_and_fails(self):
        self.assert_cleanup_fails(lambda t: t.replace(f"\n\n{POINTERS_BEGIN}", f"\nx\n{POINTERS_BEGIN}"), "was edited")

    def test_reviewer_runs_only_after_cleanup(self):
        self.write_agents(b"# rules\n")
        seen = []

        def reviewer(cwd):
            seen.append((cwd / "AGENTS.md").read_text())
            return True, "VERDICT: APPROVE", None

        self.reviewer = reviewer
        with mock.patch.object(md.shutil, "which", return_value="/usr/bin/true"):
            body = self.dispatch(reviewer_platform="codex")
        self.assertEqual(body["status"], "done")
        self.assertEqual(seen, ["# rules\n"])
        self.assertIn("[codex review] VERDICT: APPROVE", body["result"])

    def test_staged_or_committed_block_fails(self):
        for action in ("stage", "commit"):
            with self.subTest(action=action):
                self.calls.clear()
                self.cli_calls.clear()
                self.write_agents(b"# rules\n")
                run_git(self.wt, "add", "AGENTS.md")
                run_git(self.wt, "commit", "-q", "-m", f"rules {action}")

                def worker(cwd, action=action):
                    run_git(cwd, "add", "AGENTS.md")
                    if action == "commit":
                        run_git(cwd, "commit", "-q", "-m", "oops")
                    return True, "RESULT: ok", None

                self.worker = worker
                with mock.patch.object(md.shutil, "which", return_value="/usr/bin/true"):
                    body = self.dispatch(reviewer_platform="codex")
                self.assertEqual(body["status"], "failed")
                self.assertIn("staged in the git index" if action == "stage" else "skill-pointer block is", body["result"])
                self.assertEqual(self.agents.read_text(), "# rules\n")
                self.assertEqual([c for c in self.cli_calls if c[1]], [])
                run_git(self.wt, "reset", "-q", "--hard", "main")

    def test_worker_exception_still_cleans_up(self):
        self.write_agents(b"# rules\n")

        def worker(cwd):
            raise RuntimeError("cli crashed")

        self.worker = worker
        body = self.dispatch()
        self.assertEqual(body["status"], "failed")
        self.assertIn("cli crashed", body["result"])
        self.assertEqual(self.agents.read_text(), "# rules\n")

    def test_running_patch_failure_still_cleans_up(self):
        self.write_agents(b"# rules\n")
        real = self.fake_api

        def flaky(path, body=None, method="POST", max_bytes=None):
            if method == "PATCH" and body.get("status") == "running":
                self.calls.append((path, body, method, max_bytes))
                raise urllib.error.URLError("api down")
            return real(path, body, method, max_bytes)

        with mock.patch.object(md, "api", side_effect=flaky):
            self.dispatch()
        self.assertEqual(self.cli_calls, [])
        self.assertEqual(self.agents.read_text(), "# rules\n")

    def test_head_probe_failure_writes_nothing_and_launches_nothing(self):
        original = b"# rules\r\nkeep\r\n"
        real_git = md.git
        for exc in (subprocess.TimeoutExpired(["git"], 60), OSError("fork failed")):
            with self.subTest(exc=type(exc).__name__):
                self.calls.clear()
                self.write_agents(original, 0o600)

                def git(cwd, *args, exc=exc):
                    if args[:2] == ("rev-parse", "--verify"):
                        raise exc
                    return real_git(cwd, *args)

                with mock.patch.object(md, "git", side_effect=git):
                    body = self.dispatch()
                self.assertEqual(body["status"], "failed")
                self.assertIn("could not read HEAD, no worker started", body["result"])
                self.assertEqual(self.agents.read_bytes(), original)
                self.assertEqual(stat.S_IMODE(os.stat(self.agents).st_mode), 0o600)
                self.assertEqual(self.cli_calls, [])
                self.assertNotIn("running", [c[1].get("status") for c in self.patches()])


REAL_RUN_CLI = md.run_cli

# A fake `codex` CLI. It reads the injected AGENTS.md, starts a background child
# that rewrites it after FAKE_DELAY seconds, waits until the child is ready, then
# hangs (FAKE_MODE=hang), exits 0 (ok), or exits 3 (fail).
FAKE_CLI = """\
import os, subprocess, sys, time
state = os.environ["FAKE_STATE"]
text = open("AGENTS.md").read()
child = subprocess.Popen(
    [sys.executable, "-c", os.environ["FAKE_CHILD"], text, state],
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
open(os.path.join(state, "child.pid"), "w").write(str(child.pid))
deadline = time.time() + 5
while not os.path.exists(os.path.join(state, "child.ready")) and time.time() < deadline:
    time.sleep(0.01)
mode = os.environ["FAKE_MODE"]
if mode == "hang":
    time.sleep(60)
print("RESULT: worker " + mode)
sys.exit(3 if mode == "fail" else 0)
"""
FAKE_CHILD = """\
import os, signal, sys, time
text, state = sys.argv[1], sys.argv[2]
if os.environ.get("FAKE_IGNORE_TERM"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
open(os.path.join(state, "child.ready"), "w").close()
time.sleep(float(os.environ["FAKE_DELAY"]))
open("AGENTS.md", "w").write(text)
open(os.path.join(state, "child.wrote"), "w").close()
"""
CHILD_DELAY = 1.0


class TestProcessContainment(Harness):
    """The real run_cli with a fake CLI whose background child writes AGENTS.md late."""

    def setUp(self):
        super().setUp()
        self.agents = self.wt / "AGENTS.md"
        self.agents.write_text("# rules\n")
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        cli = self.bin / "codex"
        cli.write_text(f"#!{sys.executable}\n{FAKE_CLI}")
        cli.chmod(0o755)
        self.state = Path(self.tmp.name) / "state"
        self.state.mkdir()
        env = mock.patch.dict(os.environ, {
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "FAKE_STATE": str(self.state), "FAKE_CHILD": FAKE_CHILD, "FAKE_DELAY": str(CHILD_DELAY),
            "FAKE_MODE": "ok",
        })
        env.start()
        self.addCleanup(env.stop)
        for p in (mock.patch.object(md, "run_cli", REAL_RUN_CLI),
                  mock.patch.object(md, "TASK_TIMEOUT", 0.5),
                  mock.patch.object(md, "KILL_GRACE", 0.5)):
            p.start()
            self.addCleanup(p.stop)

    def reset_state(self):
        for f in self.state.iterdir():
            f.unlink()

    def assert_child_gone(self):
        pid = int((self.state / "child.pid").read_text())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.05)
        self.fail(f"background child {pid} outlived run_task")

    def assert_no_late_write(self):
        time.sleep(CHILD_DELAY + 0.5)
        self.assertFalse((self.state / "child.wrote").exists(), "background child wrote after cleanup")
        self.assertEqual(self.agents.read_text(), "# rules\n")

    def test_background_child_stopped_on_every_exit(self):
        cases = [("hang", "", "failed", "timed out after 0.5s"), ("ok", "", "done", "worker ok"),
                 ("fail", "", "failed", "worker fail"), ("ok", "1", "done", "worker ok")]
        for mode, ignore_term, status, needle in cases:
            with self.subTest(mode=mode, ignore_term=bool(ignore_term)):
                self.calls.clear()
                self.reset_state()
                with mock.patch.dict(os.environ, {"FAKE_MODE": mode, "FAKE_IGNORE_TERM": ignore_term}):
                    body = self.dispatch(platform="codex")
                self.assertEqual(body["status"], status)
                self.assertIn(needle, body["result"])
                self.assertEqual(self.agents.read_text(), "# rules\n")
                self.assert_child_gone()
                self.assert_no_late_write()

    def test_timed_out_child_cannot_touch_next_task(self):
        with mock.patch.dict(os.environ, {"FAKE_MODE": "hang", "FAKE_IGNORE_TERM": "1"}):
            self.assertEqual(self.dispatch(platform="codex")["status"], "failed")
        seen = []

        def next_worker(platform, prompt, cwd, review=False):
            time.sleep(CHILD_DELAY + 0.5)  # past the moment the first task's child would write
            seen.append(((cwd / "AGENTS.md").read_text(), (self.state / "child.wrote").exists()))
            return True, "RESULT: next", None

        self.block = BLOCK_2
        with mock.patch.object(md, "run_cli", side_effect=next_worker):
            self.assertEqual(self.dispatch(platform="codex")["status"], "done")
        self.assertEqual(seen, [(f"# rules\n\n{BLOCK_2}\n", False)])
        self.assertEqual(self.agents.read_text(), "# rules\n")

    def test_exception_while_waiting_stops_group(self):
        real_wait = subprocess.Popen.wait

        def wait(proc, timeout=None):
            if str(proc.args[0]) == "codex":
                deadline = time.monotonic() + 5
                while not (self.state / "child.ready").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                raise RuntimeError("wait interrupted")
            return real_wait(proc, timeout)

        with mock.patch.dict(os.environ, {"FAKE_MODE": "hang"}), \
                mock.patch.object(subprocess.Popen, "wait", wait):
            body = self.dispatch(platform="codex")
        self.assertEqual(body["status"], "failed")
        self.assertIn("wait interrupted", body["result"])
        self.assertEqual(self.agents.read_text(), "# rules\n")
        self.assert_child_gone()
        self.assert_no_late_write()

    def test_group_that_survives_kill_fails_task(self):
        real_stop = md.stop_group

        def stop(proc, grace):
            real_stop(proc, grace)
            return False

        with mock.patch.object(md, "stop_group", side_effect=stop):
            body = self.dispatch(platform="codex")
        self.assertEqual(body["status"], "failed")
        self.assertIn("still had members after SIGKILL", body["result"])
        self.assertEqual(self.agents.read_text(), "# rules\n")

    def test_group_is_the_cli_not_the_dispatcher(self):
        groups = []
        real_stop = md.stop_group

        def stop(proc, grace):
            groups.append(proc.pid)
            return real_stop(proc, grace)

        with mock.patch.object(md, "stop_group", side_effect=stop):
            self.dispatch(platform="codex")
        self.assertEqual(len(groups), 1)
        self.assertNotEqual(groups[0], os.getpgrp())
        self.assert_child_gone()


if __name__ == "__main__":
    unittest.main()
