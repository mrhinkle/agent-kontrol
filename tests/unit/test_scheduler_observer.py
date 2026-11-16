"""Offline fixtures for the inert scheduler observer.

Synthetic credentials, temporary files, and loopback stubs only. These tests
do not call launchctl, read a configured secret, or contact a live host.
"""
import contextlib
import importlib.util
import json
import os
import pathlib
import plistlib
import signal
import subprocess
import sys
import tempfile
import threading
import time
import http.server
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOKEN = "synthetic-observer-fixture-token"
RAW = "CANARY-LAUNCHCTL-NOT-FOR-STORAGE"
JOBS = (
    "com.missioncontrol.progress-collector",
    "com.peripety.neuro-independent-review",
)
OBSERVER = ROOT / "scripts" / "observe-scheduler.py"
SWEEP = ROOT / "scripts" / "sweep-once.sh"
EXAMPLE = ROOT / "scripts" / "observe-scheduler.config.example.json"
PLIST = ROOT / "docs" / "examples" / "com.peripety.agent-kontrol-observer.plist"
CHECKER = ROOT / "scripts" / "check-scheduler-observation.ts"
TSX = ROOT / "node_modules" / ".bin" / "tsx"
DEADLINE = 1.6

_spec = importlib.util.spec_from_file_location("observe_scheduler_under_test", OBSERVER)
obs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(obs)


def isolated_env(extra=None):
    env = {}
    for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if extra:
        env.update(extra)
    return env


def domain_text(uid, services, disabled=None):
    disabled = disabled or {}
    lines = [
        "user/%d = {" % uid,
        "  type = user",
        "  info = {",
        "    message = " + RAW,
        "  }",
        "  services = {",
    ]
    lines.extend("    %s %s %s" % row for row in services)
    lines.append("  }")
    lines.append("  disabled services = {")
    lines.extend('    "%s" => %s' % item for item in disabled.items())
    lines.extend(["  }", "}"])
    return "\n".join(lines) + "\n"


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def reap(pid):
    if pid and alive(pid):
        os.kill(pid, signal.SIGKILL)


class QuietHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return


class BoundServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


@contextlib.contextmanager
def serve(handler):
    server = BoundServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def call_within(seconds, fn):
    box = {}

    def run():
        try:
            box["value"] = fn()
        except BaseException as exc:
            box["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise AssertionError("call exceeded %ss" % seconds)
    if "error" in box:
        raise box["error"]
    return box["value"]


class TestContract(unittest.TestCase):
    def test_allowlist_is_the_two_existing_jobs(self):
        self.assertEqual(obs.JOBS, JOBS)
        self.assertEqual(obs.STALE_AFTER_MINUTES, 30)
        self.assertEqual(obs.SOURCE, "mini-launchd")
        self.assertEqual(obs.AGENT_ID, "mini-observer")
        example = json.loads(EXAMPLE.read_text())
        self.assertIs(example["enabled"], False)
        self.assertEqual(example["jobs"], list(JOBS))
        self.assertEqual(example["stale_after_minutes"], 30)
        self.assertEqual(example["domain"], "user")
        self.assertIsNone(example["secret_file"])
        self.assertIsNone(example["state_dir"])
        loaded = obs.load_config(EXAMPLE)
        self.assertFalse(loaded["enabled"])

    def test_config_rejects_a_changed_allowlist_or_freshness(self):
        example = json.loads(EXAMPLE.read_text())
        changes = [
            {"jobs": [JOBS[0]]},
            {"jobs": [JOBS[1], JOBS[0]]},
            {"jobs": [JOBS[0], "unknown.job"]},
            {"stale_after_minutes": 31},
            {"source": "forged"},
            {"domain": "gui"},
            {"enabled": True},
        ]
        for change in changes:
            with tempfile.TemporaryDirectory() as tmp:
                path = pathlib.Path(tmp) / "config.json"
                path.write_text(json.dumps({**example, **change}))
                with self.assertRaises(obs.ConfigError):
                    obs.load_config(path)

    def test_plist_and_docs_stay_inert(self):
        plist = plistlib.loads(PLIST.read_bytes())
        self.assertEqual(plist["Label"], "com.peripety.agent-kontrol-observer")
        self.assertEqual(plist["StartInterval"], 300)
        self.assertIs(plist["RunAtLoad"], True)
        self.assertNotIn("KeepAlive", plist)
        self.assertNotIn("EnvironmentVariables", plist)
        self.assertNotIn("ThrottleInterval", plist)
        joined = " ".join(plist["ProgramArguments"])
        self.assertNotIn(TOKEN, joined)
        self.assertNotIn("MC_TOKEN", joined)
        source = OBSERVER.read_text()
        self.assertNotIn("86400", source)
        self.assertNotIn("pilot", source.lower())
        docs = (ROOT / "docs" / "VELOCITY.md").read_text()
        self.assertIn("com.missioncontrol.progress-collector", docs)
        self.assertIn("com.peripety.neuro-independent-review", docs)
        self.assertIn("existing 900-second jobs", docs)
        self.assertIn("no invocation cap and no second enablement gate", docs)
        self.assertIn("`enabled: false`", docs)
        self.assertIn("StartInterval` 300", docs)

    def test_shipped_example_does_no_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            before = set(pathlib.Path(tmp).iterdir())
            proc = subprocess.run(
                [sys.executable, str(OBSERVER), "--config", str(EXAMPLE)],
                cwd=tmp,
                env=isolated_env(),
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("observe-scheduler: disabled", proc.stderr)
            self.assertEqual(set(pathlib.Path(tmp).iterdir()), before)
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)


class TestParser(unittest.TestCase):
    def setUp(self):
        self.uid = os.getuid()
        self.idle = ("0", "-3", JOBS[0])
        self.running = ("283", "-", JOBS[1])

    def test_loaded_idle_and_running_are_active(self):
        parsed = obs.parse_domain(domain_text(self.uid, [self.idle, self.running]), self.uid)
        self.assertIsNotNone(parsed)
        self.assertEqual(obs.classify(parsed, JOBS[0]), "active")
        self.assertEqual(obs.classify(parsed, JOBS[1]), "active")

    def test_explicit_disabled_wins_and_absence_is_paused(self):
        both = obs.parse_domain(
            domain_text(self.uid, [self.idle, self.running], {JOBS[0]: "disabled", JOBS[1]: "enabled"}),
            self.uid,
        )
        self.assertEqual(obs.classify(both, JOBS[0]), "paused")
        self.assertEqual(obs.classify(both, JOBS[1]), "active")
        absent = obs.parse_domain(
            domain_text(self.uid, [self.idle], {JOBS[0]: "disabled", JOBS[1]: "enabled"}),
            self.uid,
        )
        self.assertEqual(obs.classify(absent, JOBS[0]), "paused")
        self.assertEqual(obs.classify(absent, JOBS[1]), "paused")
        missing = obs.parse_domain(domain_text(self.uid, []), self.uid)
        self.assertEqual(obs.classify(missing, JOBS[0]), "paused")
        self.assertEqual(obs.classify(missing, JOBS[1]), "paused")

    def test_ambiguous_domain_is_not_an_observation(self):
        good = domain_text(self.uid, [self.idle, self.running])
        duplicate_disabled = domain_text(self.uid, [self.idle], {JOBS[0]: "disabled"})
        duplicate_disabled = duplicate_disabled.replace(
            '    "%s" => disabled\n' % JOBS[0],
            '    "%s" => disabled\n    "%s" => enabled\n' % (JOBS[0], JOBS[0]),
        )
        cases = [
            good.replace("0 -3 " + JOBS[0], "bad row"),
            good.replace("services = {", "services = {\n    0 -3 " + JOBS[0], 1),
            good[:-2],
            good.replace("user/%d" % self.uid, "user/999999", 1),
            duplicate_disabled,
            good.replace("  services = {", "  absent = {", 1),
            good + "trailing\n",
            good.replace(RAW, RAW + "\x00"),
        ]
        self.assertGreaterEqual(len(cases), 6)
        for text in cases:
            self.assertIsNone(obs.parse_domain(text, self.uid))


class TestLedger(unittest.TestCase):
    def assert_clean(self, label, text):
        self.assertNotIn(TOKEN, text, label)
        self.assertNotIn(RAW, text, label)

    def test_clock_and_first_pause_do_not_invent_history(self):
        with patch.object(obs, "now_iso", return_value="2026-11-16T04:45:00Z"):
            first = obs.fresh_record(JOBS[0], "paused", None)
            self.assertIsNone(first["paused_at"])
            self.assertEqual(first["transition"], 1)
            body = json.loads(first["pending"])
            self.assertIsNone(body["observation"]["paused_at"])
            self.assertNotIn("paused_reason", body["observation"])
            self.assertNotIn("until", body["observation"])
            self.assertNotIn("decision", body["observation"])
            previous = obs.fresh_record(JOBS[0], "active", None)
            self.assertEqual(obs.fresh_record(JOBS[0], "active", previous), "clock-not-advanced")
        with patch.object(obs, "now_iso", return_value="2026-11-16T04:44:00Z"):
            self.assertEqual(obs.fresh_record(JOBS[0], "active", previous), "clock-not-advanced")
        self.validate_with_server([body])

    def test_failed_save_keeps_exact_pending_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = pathlib.Path(tmp)
            config = {"http_timeout": 1, "launchctl": "fake", "launch_timeout": 1, "sweep_timeout": 1, "sweep_once": "fake"}
            posts = []
            sweeps = []
            with open(os.devnull, "w") as devnull, \
                    patch.object(obs, "credential", return_value=("http://127.0.0.1:9", TOKEN)), \
                    patch.object(obs, "read_launchctl", return_value={"loaded": set(JOBS), "disabled": set()}), \
                    patch.object(obs, "save_ledger", return_value=False), \
                    patch.object(obs, "post_observation", side_effect=lambda *args: posts.append(args) or "applied"), \
                    patch.object(obs, "run_sweep", side_effect=lambda *args: sweeps.append(True) or "0"), \
                    contextlib.redirect_stderr(devnull):
                self.assertEqual(obs.run_locked(config, state), 1)
            self.assertEqual(posts, [])
            self.assertEqual(sweeps, [True])

            record = obs.fresh_record(JOBS[0], "active", None)
            jobs = {JOBS[0]: record}
            self.assertTrue(obs.save_ledger(state, jobs))
            original = record["pending"]
            with patch.object(obs, "post_observation", return_value="applied"), \
                    patch.object(obs, "save_ledger", return_value=False):
                self.assertEqual(
                    obs.deliver(jobs, JOBS[0], record, "http://127.0.0.1:9", TOKEN, config, None, state),
                    "state-unavailable",
                )
            self.assertEqual(obs.load_ledger(state)[JOBS[0]]["pending"], original)
            seen = []
            with patch.object(obs, "post_observation", side_effect=lambda endpoint, body, *rest: seen.append(body) or "replay"):
                self.assertEqual(
                    obs.deliver(obs.load_ledger(state), JOBS[0], obs.load_ledger(state)[JOBS[0]],
                                "http://127.0.0.1:9", TOKEN, config, None, state),
                    "replay",
                )
            self.assertEqual(seen, [original.encode()])
            self.assertIsNone(obs.load_ledger(state)[JOBS[0]]["pending"])

            halted = []
            for outcome in ("older", "conflict", "rejected", "redirect-denied", "unknown-response", "invalid-response", "lost-response"):
                record = obs.fresh_record(JOBS[0], "paused", None)
                jobs = {JOBS[0]: record}
                self.assertTrue(obs.save_ledger(state, jobs))
                with patch.object(obs, "post_observation", return_value=outcome):
                    self.assertEqual(
                        obs.deliver(jobs, JOBS[0], record, "http://127.0.0.1:9", TOKEN, config, None, state),
                        outcome,
                    )
                saved = obs.load_ledger(state)[JOBS[0]]
                self.assertEqual(saved["pending"], record["pending"])
                if outcome == "lost-response":
                    self.assertFalse(saved["halted"])
                    self.assertIsNone(saved["halt_class"])
                else:
                    self.assertTrue(saved["halted"])
                    self.assertEqual(saved["halt_class"], outcome)
                    halted.append(outcome)
            self.assertEqual(len(halted), 6)

    def test_restart_replay_lock_and_corruption(self):
        uid = os.getuid()
        accepted = []
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            state = root / "state"
            timeline = root / "timeline"
            fixture = root / "domain"
            launch = root / "launch"
            sweep = root / "sweep"
            secret = root / "secret"
            config_path = root / "config.json"
            fixture.write_text(domain_text(uid, [("0", "-3", JOBS[0]), ("283", "-", JOBS[1])]))
            launch.write_text(
                "#!%s\nfrom pathlib import Path\nimport sys\nsys.stdout.write(Path(%r).read_text())\n"
                % (sys.executable, str(fixture))
            )
            launch.chmod(0o700)
            sweep.write_text(
                "#!%s\nfrom pathlib import Path\np = Path(%r)\nwith p.open('a') as handle: handle.write('sweep\\n')\n"
                % (sys.executable, str(timeline))
            )
            sweep.chmod(0o700)
            calls = []
            status = {"first_fault": True, "conflict": False}

            class Handler(QuietHandler):
                def do_POST(self):
                    if self.path != "/api/ingest":
                        raise AssertionError("unexpected ingest path")
                    if self.headers.get("Authorization") != "Bearer " + TOKEN:
                        raise AssertionError("authorization was not the synthetic bearer")
                    raw = self.rfile.read(int(self.headers["Content-Length"]))
                    body = json.loads(raw)
                    job = body["observation"]["job_id"]
                    saved = json.loads((state / "ledger.json").read_text())["jobs"][job]["pending"].encode()
                    if saved != raw:
                        raise AssertionError("pending bytes were not durable before the POST")
                    calls.append(raw)
                    accepted.append(body)
                    with timeline.open("a") as handle:
                        handle.write("ingest:%s\n" % job)
                    if job == JOBS[0] and status["first_fault"]:
                        status["first_fault"] = False
                        code = 503
                        response = {"error": "temporary"}
                    elif job == JOBS[0] and status["conflict"]:
                        code = 409
                        response = {"error": "conflict"}
                    else:
                        code = 200
                        response = {
                            "ok": True,
                            "kind": "sweep.scheduler_job",
                            "outcome": "replay" if len(calls) == 3 else "applied",
                            "observation_id": str(len(calls)),
                            "received_at": "2026-11-16T04:45:00Z",
                        }
                    payload = json.dumps(response).encode()
                    self.send_response(code)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)

            server = BoundServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            outputs = []
            try:
                origin = "http://127.0.0.1:%d" % server.server_port
                secret.write_text("MC_URL=%s\nMC_TOKEN=%s\n" % (origin, TOKEN))
                secret.chmod(0o600)
                example = json.loads(EXAMPLE.read_text())
                config = {
                    **example,
                    "enabled": True,
                    "target_origin": origin,
                    "secret_file": str(secret),
                    "state_dir": str(state),
                    "launchctl": str(launch),
                    "sweep_once": str(sweep),
                    "http_timeout_seconds": 5,
                    "launchctl_timeout_seconds": 5,
                    "sweep_timeout_seconds": 5,
                }
                config_path.write_text(json.dumps(config))

                def tick(code):
                    before = len(calls)
                    previous = timeline.read_text().splitlines() if timeline.exists() else []
                    proc = subprocess.run(
                        [sys.executable, str(OBSERVER), "--config", str(config_path)],
                        cwd=tmp,
                        env=isolated_env(),
                        capture_output=True,
                        text=True,
                        timeout=8,
                    )
                    outputs.append(proc.stdout + proc.stderr)
                    self.assertEqual(proc.returncode, code, proc.stderr)
                    current = timeline.read_text().splitlines() if timeline.exists() else []
                    new = current[len(previous):]
                    if new:
                        self.assertEqual(new[-1], "sweep", new)
                        self.assertEqual(new.count("sweep"), 1, new)
                    return [json.loads(item) for item in calls[before:]]

                first = tick(1)
                self.assertEqual([item["observation"]["job_id"] for item in first], list(JOBS))
                self.assertTrue(all(item["observation"]["state"] == "active" and item["observation"]["transition"] == 1 for item in first))
                on_disk = json.loads((state / "ledger.json").read_text())["jobs"]
                self.assertIsNotNone(on_disk[JOBS[0]]["pending"])
                self.assertIsNone(on_disk[JOBS[1]]["pending"])
                original = calls[0]

                fixture.write_text(domain_text(uid, [("0", "-3", JOBS[0]), ("283", "-", JOBS[1])], {JOBS[0]: "disabled", JOBS[1]: "disabled"}))
                second = tick(0)
                self.assertEqual(calls[2], original)
                self.assertEqual(second[0]["observation"]["state"], "active")
                self.assertEqual(second[0]["observation"]["transition"], 1)
                self.assertEqual(second[1]["observation"]["state"], "paused")
                self.assertEqual(second[1]["observation"]["transition"], 2)
                paused_at = second[1]["observation"]["paused_at"]

                third = tick(0)
                self.assertEqual(third[0]["observation"]["state"], "paused")
                self.assertEqual(third[0]["observation"]["transition"], 2)
                self.assertEqual(third[0]["observation"]["paused_at"], third[0]["observation"]["observed_at"])
                self.assertEqual(third[1]["observation"]["transition"], 2)
                self.assertEqual(third[1]["observation"]["paused_at"], paused_at)
                self.assertGreater(third[1]["observation"]["observed_at"], second[1]["observation"]["observed_at"])

                status["conflict"] = True
                fourth = tick(1)
                self.assertEqual(len(fourth), 2)
                disk = json.loads((state / "ledger.json").read_text())["jobs"]
                self.assertTrue(disk[JOBS[0]]["halted"])
                self.assertEqual(disk[JOBS[0]]["halt_class"], "conflict")
                self.assertIsNotNone(disk[JOBS[0]]["pending"])
                self.assertFalse(disk[JOBS[1]]["halted"])
                fifth = tick(1)
                self.assertEqual(len(fifth), 1)
                self.assertEqual(fifth[0]["observation"]["job_id"], JOBS[1])
                self.assertEqual(len(calls), 9)

                fixture.write_text("not a complete domain\n")
                self.assertEqual(tick(1), [])
                ledger = state / "ledger.json"
                saved = ledger.read_bytes()
                ledger.write_text("{bad")
                self.assertEqual(tick(1), [])
                self.assertEqual(ledger.read_text(), "{bad")
                ledger.unlink()
                self.assertEqual(tick(1), [])
                self.assertFalse(ledger.exists())
                self.assertTrue((state / "ledger.seal").exists())
                ledger.write_bytes(saved)

                lock = obs.acquire_lock(state / "observer.flock")
                self.assertIsInstance(lock, int)
                try:
                    before_calls = len(calls)
                    before_timeline = timeline.read_text()
                    blocked = subprocess.run(
                        [sys.executable, str(OBSERVER), "--config", str(config_path)],
                        cwd=tmp,
                        env=isolated_env(),
                        capture_output=True,
                        text=True,
                        timeout=3,
                    )
                    outputs.append(blocked.stdout + blocked.stderr)
                    self.assertEqual(blocked.returncode, 1)
                    self.assertIn("lock-busy", blocked.stderr)
                    self.assertEqual(len(calls), before_calls)
                    self.assertEqual(timeline.read_text(), before_timeline)
                finally:
                    os.close(lock)
                self.assertEqual(tick(1), [])

                disabled = {
                    **config,
                    "enabled": False,
                    "state_dir": str(root / "never-created"),
                    "secret_file": str(root / "missing-secret"),
                    "launchctl": str(root / "missing-launch"),
                    "sweep_once": str(root / "missing-sweep"),
                }
                config_path.write_text(json.dumps(disabled))
                before_calls = len(calls)
                inert = subprocess.run(
                    [sys.executable, str(OBSERVER), "--config", str(config_path)],
                    cwd=tmp,
                    env=isolated_env(),
                    capture_output=True,
                    text=True,
                    timeout=3,
                )
                outputs.append(inert.stdout + inert.stderr)
                self.assertEqual(inert.returncode, 0, inert.stderr)
                self.assertIn("disabled", inert.stderr)
                self.assertFalse((root / "never-created").exists())
                self.assertFalse((root / "missing-secret").exists())
                self.assertEqual(len(calls), before_calls)

                for text in outputs:
                    self.assert_clean("output", text)
                for path in state.iterdir():
                    if path.is_file():
                        self.assert_clean(path.name, path.read_text(errors="replace"))
                for body in accepted:
                    observation = body["observation"]
                    self.assertEqual(observation["source"], "mini-launchd")
                    self.assertEqual(observation["stale_after_minutes"], 30)
                    self.assertIn(observation["job_id"], JOBS)
                    self.assertLessEqual(
                        set(observation),
                        {"source", "job_id", "state", "transition", "observed_at", "stale_after_minutes", "paused_at"},
                    )
                    self.assert_clean("observation", json.dumps(body))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(2)
        self.assertEqual(len(accepted), 9)
        self.validate_with_server(accepted)

    def validate_with_server(self, bodies):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for index, body in enumerate(bodies):
                path = pathlib.Path(tmp) / ("%d.json" % index)
                path.write_text(json.dumps(body))
                paths.append(str(path))
            bad = pathlib.Path(tmp) / "bad.json"
            bad.write_text(json.dumps({"observation": {"job_id": "not a job"}}))
            env = isolated_env()
            proc = subprocess.run(
                [str(TSX), str(CHECKER), *paths],
                cwd=str(ROOT),
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stdout.strip(), str(len(paths)))
            self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
            rejected = subprocess.run(
                [str(TSX), str(CHECKER), str(bad)],
                cwd=str(ROOT),
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(rejected.returncode, 1, rejected.stdout)
            self.assertIn("rejected", rejected.stderr)


class TestTransport(unittest.TestCase):
    def test_deadlines_cover_headers_and_later_reads(self):
        class SlowBody(QuietHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.dumps({
                    "ok": True, "kind": "sweep.scheduler_job", "outcome": "applied",
                    "observation_id": "1", "received_at": "2026-11-16T12:00:00Z",
                }).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    for start in range(0, len(body), 30):
                        time.sleep(0.4)
                        self.wfile.write(body[start:start + 30])
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        class SlowHeaders(QuietHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                try:
                    self.wfile.write(b"HTTP/1.1 200 OK\r\n")
                    self.wfile.flush()
                    for number in range(8):
                        time.sleep(0.3)
                        self.wfile.write(("X-Test-%d: x\r\n" % number).encode())
                        self.wfile.flush()
                    self.wfile.write(b"Content-Length: 2\r\n\r\n{}")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        class LaterRead(QuietHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                try:
                    for piece in (b"{", b"}"):
                        time.sleep(0.8)
                        self.wfile.write(piece)
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        for handler in (SlowBody, SlowHeaders, LaterRead):
            with serve(handler) as server:
                endpoint = "http://127.0.0.1:%d/api/ingest" % server.server_port
                started = time.monotonic()
                outcome = call_within(
                    3,
                    lambda: obs.post_observation(endpoint, b"{}", TOKEN, 1, obs.request_opener()),
                )
                elapsed = time.monotonic() - started
            self.assertEqual(outcome, "lost-response")
            self.assertGreater(elapsed, 0.75)
            self.assertLess(elapsed, DEADLINE)

    def test_capture_caps_output_and_kills_its_own_group(self):
        started = time.monotonic()
        kind, out, err, _code = obs.capture_process(
            [sys.executable, "-c", "import os\nwhile True:\n os.write(1, b'x'*16384); os.write(2, b'y'*16384)\n"],
            3,
            32768,
            obs.child_env(),
        )
        self.assertEqual(kind, "oversize")
        self.assertEqual(len(out) + len(err), 32768)
        self.assertLess(time.monotonic() - started, 1)

        kind, out, _err, code = obs.capture_process(
            [sys.executable, "-c", "print('ok')"],
            3,
            32768,
            obs.child_env(),
        )
        self.assertEqual((kind, code, out), ("exited", 0, b"ok\n"))

        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            pidfile = root / "child.pid"
            child = root / "child.py"
            parent = root / "parent.py"
            child.write_text("import os, pathlib, time\npathlib.Path(%r).write_text(str(os.getpid()))\ntime.sleep(30)\n" % str(pidfile))
            parent.write_text("import subprocess, sys\nsubprocess.Popen([sys.executable, %r])\n" % str(child))
            started = time.monotonic()
            kind, _out, _err, code = obs.capture_process([sys.executable, str(parent)], 1, 32768, obs.child_env())
            elapsed = time.monotonic() - started
            pid = int(pidfile.read_text()) if pidfile.exists() else None
            try:
                self.assertEqual(kind, "timeout")
                self.assertIsNotNone(pid)
                self.assertFalse(alive(pid), "descendant still alive")
                self.assertGreater(elapsed, 0.75)
                self.assertLess(elapsed, DEADLINE)
            finally:
                reap(pid)

        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            pidfile = root / "grand.pid"
            script = root / "slow.py"
            script.write_text(
                "#!%s\nimport os, pathlib, subprocess, sys, time\n"
                "subprocess.Popen([sys.executable, '-c', %r])\n"
                "time.sleep(30)\n" % (
                    sys.executable,
                    "import os, pathlib, time; pathlib.Path(%r).write_text(str(os.getpid())); time.sleep(30)" % str(pidfile),
                )
            )
            script.chmod(0o700)
            started = time.monotonic()
            outcome = obs.run_sweep({"sweep_once": str(script), "sweep_timeout": 1}, "http://127.0.0.1:9", TOKEN)
            elapsed = time.monotonic() - started
            deadline = time.monotonic() + 1
            while not pidfile.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            pid = int(pidfile.read_text()) if pidfile.exists() else None
            try:
                self.assertEqual(outcome, "timeout")
                self.assertIsNotNone(pid)
                self.assertFalse(alive(pid))
                self.assertGreater(elapsed, 0.75)
                self.assertLess(elapsed, DEADLINE)
                self.assertNotIn(TOKEN, outcome)
            finally:
                reap(pid)

    def test_sweep_bounds_body_blocks_redirects_and_hides_the_token(self):
        received = []

        class Target(QuietHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                received.append(self.headers.get("Authorization"))
                body = b'{"checks":[],"retention":{"state":"ok"}}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class Redirect(QuietHandler):
            target_port = 0

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1:%d/elsewhere" % self.target_port)
                self.send_header("Content-Length", "0")
                self.end_headers()

        with tempfile.TemporaryDirectory() as tmp, serve(Target) as target:
            home = pathlib.Path(tmp)
            (home / ".curlrc").write_text("location\nlocation-trusted\n")
            Redirect.target_port = target.server_port
            base = obs.child_env()

            def hostile(extra=None):
                env = dict(base)
                env.update({"HOME": tmp, "TMPDIR": tmp, "http_proxy": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9"})
                if extra:
                    env.update(extra)
                return env

            with serve(Redirect) as origin, patch.object(obs, "child_env", hostile):
                outcome = obs.run_sweep(
                    {"sweep_once": str(SWEEP), "sweep_timeout": 5},
                    "http://127.0.0.1:%d" % origin.server_port,
                    TOKEN,
                )
            self.assertEqual(received, [])
            self.assertEqual(outcome, "failed")

            self.assertEqual(
                obs.run_sweep({"sweep_once": str(home / "missing"), "sweep_timeout": 1}, "http://127.0.0.1:9", TOKEN),
                "missing",
            )
            noop = home / "noop.sh"
            noop.write_text("#!/bin/sh\nexit 0\n")
            noop.chmod(0o700)
            seen = []
            original = obs.capture_process

            def capture(argv, timeout, limit, env):
                seen.append((argv, env))
                return original(argv, timeout, limit, env)

            with patch.object(obs, "capture_process", capture):
                quiet = obs.run_sweep({"sweep_once": str(noop), "sweep_timeout": 1}, "http://127.0.0.1:9", TOKEN)
            self.assertEqual(quiet, "0")
            self.assertEqual(len(seen), 1)
            argv, env = seen[0]
            self.assertEqual(env.get("MC_TOKEN"), TOKEN)
            self.assertTrue(all(TOKEN not in arg for arg in argv))

        with serve(Target) as target:
            outcome = obs.run_sweep(
                {"sweep_once": str(SWEEP), "sweep_timeout": 5},
                "http://127.0.0.1:%d" % target.server_port,
                TOKEN,
            )
            self.assertEqual(outcome, "0")
            self.assertEqual(len(received), 1)
            self.assertNotIn(TOKEN, outcome)

        class Large(QuietHandler):
            framing = "close"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(200)
                self.send_header("Connection", "close")
                if self.framing == "length":
                    body = b'{"checks":[],"retention":{"state":"ok"},"padding":"%s"}' % (b"x" * (2 * 1024 * 1024))
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    try:
                        self.wfile.write(body)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                if self.framing == "chunked":
                    self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    for _ in range(128):
                        chunk = b"x" * 8192
                        if self.framing == "chunked":
                            self.wfile.write(b"2000\r\n" + chunk + b"\r\n")
                        else:
                            self.wfile.write(chunk)
                        self.wfile.flush()
                    if self.framing == "chunked":
                        self.wfile.write(b"0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass

        for framing in ("length", "close", "chunked"):
            handler = type("Handler", (Large,), {"framing": framing})
            with tempfile.TemporaryDirectory() as tmp, serve(handler) as server:
                root = pathlib.Path(tmp)
                bindir = root / "bin"
                bindir.mkdir()
                mark = root / "size"
                jq_mark = root / "jq"
                shim = bindir / "python3"
                shim.write_text(
                    "#!%s\nimport pathlib, subprocess, sys\n"
                    "proc = subprocess.run([%r, *sys.argv[1:]])\n"
                    "pathlib.Path(%r).write_text(str(pathlib.Path(sys.argv[4]).stat().st_size))\n"
                    "raise SystemExit(proc.returncode)\n" % (sys.executable, sys.executable, str(mark))
                )
                shim.chmod(0o700)
                jq = bindir / "jq"
                jq.write_text("#!%s\nimport pathlib\npathlib.Path(%r).write_text('called')\nraise SystemExit(99)\n" % (sys.executable, str(jq_mark)))
                jq.chmod(0o700)
                base = obs.child_env()

                def env(extra=None):
                    merged = dict(base)
                    merged["TMPDIR"] = tmp
                    merged["PATH"] = str(bindir) + os.pathsep + base.get("PATH", "")
                    if extra:
                        merged.update(extra)
                    return merged

                with patch.object(obs, "child_env", env):
                    started = time.monotonic()
                    outcome = obs.run_sweep(
                        {"sweep_once": str(SWEEP), "sweep_timeout": 5},
                        "http://127.0.0.1:%d" % server.server_port,
                        TOKEN,
                    )
                    elapsed = time.monotonic() - started
                size = int(mark.read_text())
                self.assertEqual(outcome, "failed", framing)
                self.assertGreater(size, obs.MAX_SWEEP_CAPTURE - 8192, framing)
                self.assertLessEqual(size, obs.MAX_SWEEP_CAPTURE, framing)
                self.assertFalse(jq_mark.exists(), framing)
                self.assertLess(elapsed, 5, framing)


if __name__ == "__main__":
    unittest.main()
