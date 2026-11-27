#!/usr/bin/env python3
"""Short-lived GitHub installation tokens for lanes (#190). Stdlib unittest. Python 3.9.

Everything here runs against fixtures: a fixture GitHub API on 127.0.0.1, a
throwaway RSA key generated in this module's own temp dir, real temporary
linked worktrees, a scripted or real broker admin socket and fake CLIs. No
real GitHub App, key, or api.github.com is touched.
"""
from __future__ import annotations

import base64
import builtins
import http.client
import io
import json
import logging
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
BROKER_DIR = ROOT / "agents" / "broker"
sys.path.insert(0, str(BROKER_DIR))
sys.path.insert(0, str(ROOT / "agents" / "dispatcher"))
import audit  # noqa: E402
import broker  # noqa: E402
import child_env  # noqa: E402
import github  # noqa: E402
import mc_dispatcher as md  # noqa: E402

HELPER = BROKER_DIR / "git-credential-ak"
APP_ID = 424242
SVC_SECRET = "fixture-service-secret-190"
PREFIX = "secret broker unavailable, no worker started"
NO_GRANT = "[github] no grant: remote.origin.url is not a supported GitHub remote"
PERMISSIONS = {"contents": "write", "pull_requests": "write"}
REAL_RUN_CLI = md.run_cli
RESULT_JSON = '{"type":"result","result":"RESULT: ok","is_error":false}'
PH = "akp_" + "A" * 43
# The python:3.9-slim CI step has no git; the git-backed tests run in the pnpm test (3.12) lane.
NEEDS_GIT = unittest.skipUnless(shutil.which("git"), "git is required for real linked worktrees")

KEY_DIR = ""
KEY_PEM = ""
PUB_PATH = ""
KEY_LINES: list = []


def setUpModule() -> None:
    global KEY_DIR, KEY_PEM, PUB_PATH, KEY_LINES
    if shutil.which("openssl") is None:
        raise unittest.SkipTest("openssl is required")
    KEY_DIR = tempfile.mkdtemp(prefix="akgh-key-")
    key = os.path.join(KEY_DIR, "throwaway.pem")
    subprocess.run(["openssl", "genrsa", "-out", key, "2048"], check=True, capture_output=True)
    PUB_PATH = os.path.join(KEY_DIR, "throwaway.pub")
    subprocess.run(["openssl", "rsa", "-in", key, "-pubout", "-out", PUB_PATH], check=True, capture_output=True)
    with open(key) as handle:
        KEY_PEM = handle.read()
    # The base64 body, line by line, for the leak checks.
    KEY_LINES = [line for line in KEY_PEM.splitlines() if line and not line.startswith("-----")]


def tearDownModule() -> None:
    if KEY_DIR:
        shutil.rmtree(KEY_DIR, ignore_errors=True)


def key_leaks(text: str) -> list:
    """Every way the key could show up in ``text``."""
    found = []
    if "-----BEGIN" in text:
        found.append("-----BEGIN")
    for line in KEY_LINES:
        if len(line) >= 16 and line[:48] in text:
            found.append("key body")
            break
    if KEY_PEM.strip() and KEY_PEM.strip().replace("\n", "\\n") in text:
        found.append("escaped key")
    return found


def _short_tmp(test: unittest.TestCase, prefix: str = "akgh-") -> Path:
    base = "/tmp" if os.path.isdir("/tmp") else None
    path = Path(tempfile.mkdtemp(prefix=prefix, dir=base))
    test.addCleanup(shutil.rmtree, str(path), True)
    return path


def _write(path: Path, data: str, mode: int = 0o600) -> None:
    path.write_text(data)
    os.chmod(path, mode)


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Clock:
    def __init__(self, now: float) -> None:
        self.now = now
        self.lock = threading.Lock()

    def __call__(self) -> float:
        with self.lock:
            return self.now

    def advance(self, seconds: float) -> None:
        with self.lock:
            self.now += seconds


class LogLines(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


def capture_log(test: unittest.TestCase) -> LogLines:
    handler = LogLines()
    log = logging.getLogger("ak.broker")
    log.addHandler(handler)
    old = log.level
    log.setLevel(logging.DEBUG)

    def undo() -> None:
        log.removeHandler(handler)
        log.setLevel(old)

    test.addCleanup(undo)
    return handler


# ---------------------------------------------------------------------------
# Fixture GitHub API.

class FakeGitHub:
    """Records every request. ``script[kind]`` overrides a response: (status, body bytes, headers) or a callable."""

    def __init__(self, test: unittest.TestCase, clock: Clock) -> None:
        self.clock = clock
        self.calls: list = []
        self.lock = threading.Lock()
        self.script: dict = {}
        self.count = 0
        self.gate: threading.Event | None = None
        self.entered = threading.Event()
        self.release = threading.Event()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: object) -> None:
                return

            def _go(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                call = {"method": self.command, "path": self.path, "headers": dict(self.headers.items()), "body": body}
                with outer.lock:
                    outer.calls.append(call)
                kind = outer.kind(self.command, self.path)
                response = outer.respond(kind, call)
                if response == "hang":
                    outer.release.wait(10)
                    return
                if response == "trickle":
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n")
                    self.wfile.flush()
                    for _ in range(40):
                        if outer.release.wait(0.2):
                            return
                        try:
                            self.wfile.write(b" ")
                            self.wfile.flush()
                        except OSError:
                            return
                    return
                status, data, headers = response
                self.send_response(status)
                sent = {k.lower() for k, _v in headers}
                for name, value in headers:
                    self.send_header(name, value)
                if "content-type" not in sent:
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_DELETE = _go

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        test.addCleanup(self.close)

    def close(self) -> None:
        self.release.set()
        if self.gate is not None:
            self.gate.set()
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.server.server_address[1]

    def client_factory(self, api: str, timeout: object) -> github.GitHubAPI:
        self.api_seen = api
        return github.GitHubAPI(self.url, timeout, _plaintext_loopback=True)

    @staticmethod
    def kind(method: str, path: str) -> str:
        if method == "GET" and path.endswith("/installation") and path.startswith("/repos/"):
            return "installation"
        if method == "POST" and path.startswith("/app/installations/") and path.endswith("/access_tokens"):
            return "tokens"
        if method == "DELETE" and path == "/installation/token":
            return "delete"
        return "other"

    def respond(self, kind: str, call: dict):
        action = self.script.get(kind)
        if kind == "tokens" and self.gate is not None:
            self.entered.set()
            self.gate.wait(10)
        if callable(action):
            return action(call)
        if action is not None:
            return action
        if kind == "installation":
            return 200, b'{"id":4242,"account":{"login":"Owner"}}', []
        if kind == "tokens":
            with self.lock:
                self.count += 1
                n = self.count
            body = {"token": "ghs_fixtureToken%04d" % n, "expires_at": iso(self.clock() + 3600)}
            return 201, json.dumps(body).encode(), []
        if kind == "delete":
            return 204, b"", []
        return 404, b'{"message":"Not Found"}', []

    def of(self, kind: str) -> list:
        with self.lock:
            return [c for c in self.calls if self.kind(c["method"], c["path"]) == kind]


# ---------------------------------------------------------------------------
# Broker harness.

def broker_config(root: Path, block: bool = True, **overrides: object) -> dict:
    secrets_file = root / "secrets.env"
    escaped = KEY_PEM.strip().replace("\n", "\\n")
    _write(secrets_file, "KEY=%s\nGHKEY=%s\n" % (SVC_SECRET, escaped))
    providers = root / "providers.json"
    _write(providers, json.dumps({"file": {"lanes": str(secrets_file)}}))
    data = {
        "admin_socket": str(root / "admin.sock"),
        "bind": "127.0.0.1",
        "port": 0,
        "providers": str(providers),
        "placeholder_ttl_seconds": 3600,
        "upstream_timeout_seconds": 5,
        "max_request_body_bytes": 1024 * 1024,
        "services": [{
            "name": "openrouter",
            "upstream": "https://up.invalid",
            "header": "Authorization",
            "template": "Bearer {secret}",
            "secret": "secretref://file/lanes/KEY",
            "methods": ["GET", "POST"],
            "path_prefixes": ["/v1/"],
            "env_key": "OPENROUTER_API_KEY",
            "env_base_url": "OPENROUTER_BASE_URL",
        }],
    }
    if block:
        data["github"] = {
            "app_id": APP_ID,
            "private_key": "secretref://file/lanes/GHKEY",
            "permissions": dict(PERMISSIONS),
        }
    data.update(overrides)
    return data


def admin(path: str, request: object) -> dict:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10)
    try:
        sock.connect(path)
        sock.sendall(json.dumps(request).encode() + b"\n")
        buf = b""
        while b"\n" not in buf:
            block = sock.recv(65536)
            if not block:
                break
            buf += block
    finally:
        sock.close()
    return json.loads(buf.decode())


class GHBroker:
    def __init__(self, test: unittest.TestCase, block: bool = True, openssl: str = "openssl",
                 store_clock: object = None, config: dict | None = None, wall: float = 1_800_000_000.0) -> None:
        self.root = _short_tmp(test)
        self.clock = Clock(wall)
        self.gh = FakeGitHub(test, self.clock)
        self.config = config or broker_config(self.root, block=block)
        self.store = broker.PlaceholderStore(store_clock) if store_clock is not None else broker.PlaceholderStore()
        self.log = capture_log(test)
        self.server = broker.BrokerServer(
            self.config, self.store, lambda *_a: None,
            github_client_factory=self.gh.client_factory, github_clock=self.clock, github_openssl=openssl,
        )
        self.port = self.server.bound_port
        self.path = self.config["admin_socket"]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.stopped = False
        test.addCleanup(self.stop)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                if admin(self.path, {"op": "health"}) == {"ok": True}:
                    break
            except OSError:
                pass
            threading.Event().wait(0.02)

    def stop(self) -> None:
        if not self.stopped:
            self.stopped = True
            self.server.shutdown()
            self.thread.join(5)

    @property
    def service(self) -> github.TokenService:
        return self.server._state.github

    def mint(self, task: str = "7", services: list | None = None, repo: str | None = "Owner/Repo") -> dict:
        request: dict = {"op": "mint", "task_id": task, "services": ["openrouter"] if services is None else services}
        if repo is not None:
            request["github_repo"] = repo
        return admin(self.path, request)

    def placeholder(self, task: str = "7", repo: str = "Owner/Repo") -> str:
        resp = self.mint(task, repo=repo)
        return resp["github"]["placeholder"]

    def post(self, placeholder: str | None, body: object = None, target: str = "/_github/token",
             method: str = "POST", headers: dict | None = None, raw_body: bytes | None = None) -> tuple:
        data = raw_body if raw_body is not None else json.dumps(
            {"repository": "Owner/Repo"} if body is None else body).encode()
        hdrs = {"Content-Type": "application/json"}
        if placeholder is not None:
            hdrs["Authorization"] = "Bearer " + placeholder
        if headers is not None:
            hdrs.update(headers)
            hdrs = {k: v for k, v in hdrs.items() if v is not None}
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        try:
            conn.request(method, target, body=data, headers=hdrs)
            resp = conn.getresponse()
            return resp.status, resp.getheader("Content-Type"), resp.read()
        except (ConnectionResetError, BrokenPipeError):
            # Linux reports ECONNRESET when the server closes with unread data.
            return None, None, b""
        finally:
            conn.close()

    def raw(self, request: bytes) -> bytes:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        try:
            sock.sendall(request)
            buf = b""
            while True:
                try:
                    block = sock.recv(65536)
                except ConnectionResetError:
                    break
                if not block:
                    break
                buf += block
            return buf
        finally:
            sock.close()


def error_of(result: tuple) -> object:
    status, ctype, body = result
    if status is None:
        return None
    return status, ctype, body


# ---------------------------------------------------------------------------
# Strict helpers (C13, H7).

class TestStrictHelpers(unittest.TestCase):
    def test_strict_json_rejects_duplicates_constants_and_bad_utf8(self) -> None:
        self.assertEqual(github.strict_json(b'{"a":1}'), {"a": 1})
        for bad in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}', b"\xff", b"", b"{", "x"):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    github.strict_json(bad)

    def test_rfc3339_z_and_offsets_normalized_to_utc(self) -> None:
        base = datetime(2027, 1, 2, 3, 4, 5, tzinfo=timezone.utc).timestamp()
        self.assertEqual(github.parse_rfc3339("2027-01-02T03:04:05Z"), base)
        self.assertEqual(github.parse_rfc3339("2027-01-02T05:04:05+02:00"), base)
        self.assertEqual(github.parse_rfc3339("2027-01-01T22:04:05-05:00"), base)
        self.assertAlmostEqual(github.parse_rfc3339("2027-01-02T03:04:05.5Z"), base + 0.5)
        self.assertAlmostEqual(github.parse_rfc3339("2027-01-02T03:04:05.123456789Z"), base + 0.123456, places=5)
        for bad in ("2027-01-02T03:04:05", "2027-01-02 03:04:05Z", "2027-01-02T03:04:05z", "2027-13-02T03:04:05Z",
                    "2027-01-02T25:04:05Z", "2027-01-02T03:04:05+0200", "", 1700000000, None, "2027-01-02T03:04:05Z "):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    github.parse_rfc3339(bad)

    def test_repo_grammar(self) -> None:
        for good in ("o/r", "Owner-1/repo.name_x", "a" * 39 + "/" + "b" * 100, "o/.github", "o/r.git"):
            self.assertTrue(github.valid_repo(good), good)
        for bad in ("o", "o/r/x", "/r", "o/", "o/.", "o/..", "a" * 40 + "/r", "o/" + "b" * 101, "o_x/r", "o/r?x",
                    "o/r#x", "o/r%2f", "o /r", None, 1, "ö/r"):
            self.assertFalse(github.valid_repo(bad), bad)


# ---------------------------------------------------------------------------
# AC1, AC12/D6, G4, H1, H2: the JWT and the two App calls.

class TestJWTAndMint(unittest.TestCase):
    def test_jwt_exact_and_verifies_body_exact_token_returned(self) -> None:
        run = GHBroker(self, wall=1_800_000_000.75)
        placeholder = run.placeholder()
        status, ctype, body = run.post(placeholder)
        self.assertEqual((status, ctype), (200, "application/json"))
        data = json.loads(body)
        self.assertEqual(set(data), {"token", "expires_at"})
        self.assertEqual(data["token"], "ghs_fixtureToken0001")
        self.assertEqual(body, json.dumps(data, separators=(",", ":")).encode())
        install, tokens = run.gh.of("installation"), run.gh.of("tokens")
        self.assertEqual(len(install), 1)
        self.assertEqual(len(tokens), 1)
        # The repository is sent as written in the remote (the grant), not as the body spelled it.
        self.assertEqual(install[0]["path"], "/repos/Owner/Repo/installation")
        self.assertEqual(tokens[0]["path"], "/app/installations/4242/access_tokens")
        self.assertEqual(json.loads(tokens[0]["body"]), {"repositories": ["Repo"], "permissions": PERMISSIONS})
        self.assertEqual(tokens[0]["body"], b'{"repositories":["Repo"],"permissions":{"contents":"write","pull_requests":"write"}}')
        auth = install[0]["headers"]["Authorization"]
        self.assertEqual(auth, tokens[0]["headers"]["Authorization"])
        self.assertTrue(auth.startswith("Bearer "))
        jwt = auth[len("Bearer "):]
        header_b64, claims_b64, sig_b64 = jwt.split(".")

        def unb64(text: str) -> bytes:
            return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))

        self.assertEqual(header_b64, github.b64url(b'{"alg":"RS256","typ":"JWT"}'))
        self.assertEqual(json.loads(unb64(header_b64)), {"alg": "RS256", "typ": "JWT"})
        self.assertEqual(unb64(claims_b64), b'{"iss":%d,"iat":1799999940,"exp":1800000540}' % APP_ID)
        self.assertNotIn("=", jwt)
        tmp = _short_tmp(self)
        (tmp / "data").write_bytes((header_b64 + "." + claims_b64).encode("ascii"))
        (tmp / "sig").write_bytes(unb64(sig_b64))
        verify = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", PUB_PATH, "-signature", str(tmp / "sig"), str(tmp / "data")],
            capture_output=True,
        )
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn(b"Verified OK", verify.stdout)
        # A tampered signing input does not verify.
        (tmp / "data").write_bytes((header_b64 + "." + github.b64url(b'{"iss":1}')).encode("ascii"))
        bad = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", PUB_PATH, "-signature", str(tmp / "sig"), str(tmp / "data")],
            capture_output=True,
        )
        self.assertNotEqual(bad.returncode, 0)
        self.assertEqual(run.gh.api_seen, "https://api.github.com")

    def test_openssl_child_gets_key_only_through_inherited_pipe(self) -> None:
        # AC1 + G4 + D6: a blocking openssl wrapper records argv, env and its fds.
        work = _short_tmp(self)
        log_path, ready, go = work / "openssl.json", work / "ready", work / "go"
        broker_tmp = work / "brokertmp"
        broker_tmp.mkdir()
        wrapper = work / "openssl"
        real = shutil.which("openssl")
        wrapper.write_text(
            "#!%s\n"
            "import json, os, stat, sys, time\n"
            "fds = {}\n"
            "for arg in sys.argv[1:]:\n"
            "    if arg.startswith('/dev/fd/'):\n"
            "        st = os.fstat(int(arg[8:]))\n"
            "        fds[arg] = {'fifo': stat.S_ISFIFO(st.st_mode), 'regular': stat.S_ISREG(st.st_mode)}\n"
            "    elif os.path.exists(arg):\n"
            "        fds[arg] = {'exists': True}\n"
            "with open(%r, 'w') as h:\n"
            "    json.dump({'argv': sys.argv, 'env': dict(os.environ), 'fds': fds}, h)\n"
            "open(%r, 'w').close()\n"
            "end = time.time() + 10\n"
            "while not os.path.exists(%r) and time.time() < end:\n"
            "    time.sleep(0.02)\n"
            "os.execv(%r, [%r] + sys.argv[1:])\n"
            % (sys.executable, str(log_path), str(ready), str(go), real, real)
        )
        os.chmod(wrapper, 0o755)
        with mock.patch.object(tempfile, "tempdir", str(broker_tmp)), \
                mock.patch.dict(os.environ, {"TMPDIR": str(broker_tmp)}):
            run = GHBroker(self, openssl=str(wrapper))
            placeholder = run.placeholder()
            out: list = []
            worker = threading.Thread(target=lambda: out.append(run.post(placeholder)))
            worker.start()
            deadline = time.monotonic() + 10
            while not ready.exists() and time.monotonic() < deadline:
                threading.Event().wait(0.02)
            self.assertTrue(ready.exists(), "wrapper never ran")
            # While openssl is blocked: nothing in the broker's temp dir.
            during = sorted(p.name for p in broker_tmp.rglob("*"))
            go.write_text("")
            worker.join(15)
        self.assertEqual(during, [])
        self.assertEqual(sorted(p.name for p in broker_tmp.rglob("*")), [])
        self.assertEqual(out[0][0], 200)
        record = json.loads(log_path.read_text())
        argv = record["argv"]
        self.assertEqual(argv[1:4], ["dgst", "-sha256", "-sign"])
        self.assertRegex(argv[4], r"\A/dev/fd/[0-9]+\Z")
        self.assertEqual(len(argv), 5)
        self.assertEqual(record["fds"], {argv[4]: {"fifo": True, "regular": False}})
        for blob in (json.dumps(argv), json.dumps(record["env"]), json.dumps(record["fds"])):
            self.assertEqual(key_leaks(blob), [])
        self.assertEqual(set(record["env"]) - {"PATH", "LC_ALL", "__CF_USER_TEXT_ENCODING", "LC_CTYPE"}, set())
        # No file the test or the broker wrote, other than the provider's own store, holds the key.
        for path in [p for p in work.rglob("*") if p.is_file()] + [p for p in run.root.rglob("*") if p.is_file()]:
            if path.name == "secrets.env":
                continue
            with self.subTest(path=path.name):
                try:
                    text = path.read_text(errors="replace")
                except OSError:
                    continue
                self.assertEqual(key_leaks(text), [])
        for line in run.log.lines:
            self.assertEqual(key_leaks(line), [])

    def test_missing_openssl_and_nonzero_exit_give_github_unavailable(self) -> None:
        work = _short_tmp(self)
        failing = work / "openssl-fails"
        failing.write_text("#!/bin/sh\ncat >/dev/null\nexit 3\n")
        os.chmod(failing, 0o755)
        noisy = work / "openssl-noisy"
        noisy.write_text("#!/bin/sh\ncat >/dev/null\nprintf signature\nexit 3\n")
        os.chmod(noisy, 0o755)
        empty = work / "openssl-empty"
        empty.write_text("#!/bin/sh\ncat >/dev/null\nexit 0\n")
        os.chmod(empty, 0o755)
        for name, program in (("missing", str(work / "no-such-openssl")), ("nonzero", str(failing)),
                              ("nonzero with output", str(noisy)), ("empty", str(empty))):
            with self.subTest(case=name):
                run = GHBroker(self, openssl=program)
                placeholder = run.placeholder()
                status, ctype, body = run.post(placeholder)
                self.assertEqual((status, ctype, body), (502, "application/json", b'{"error":"github_unavailable"}'))
                self.assertEqual(run.gh.calls, [])
        # A bare name is resolved on the fixed OPENSSL_PATH, never the inherited PATH.
        with mock.patch.object(github, "OPENSSL_PATH", str(work)):
            with self.assertRaises(github.GitHubUnavailable):
                github.sign_jwt(APP_ID, KEY_PEM.encode(), 1.0, "openssl")
        with mock.patch.dict(os.environ, {"PATH": str(work)}):
            self.assertTrue(github.sign_jwt(APP_ID, KEY_PEM.encode(), 1.0, "openssl").count(".") == 2)


# ---------------------------------------------------------------------------
# AC2, AC11/D4, G5, H11: the endpoint.

class TestEndpoint(unittest.TestCase):
    def assert_error(self, result: tuple, status: int, code: str) -> None:
        self.assertEqual(result, (status, "application/json", ('{"error":"%s"}' % code).encode()))

    def test_valid_request_case_insensitive_repo(self) -> None:
        run = GHBroker(self)
        placeholder = run.placeholder(repo="Owner/Repo")
        status, _ctype, body = run.post(placeholder, {"repository": "owner/REPO"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["token"], "ghs_fixtureToken0001")
        status, _c, _b = run.post(placeholder, raw_body=b'{ "repository" : "Owner/Repo" }',
                                  headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(status, 200)

    def test_refusals_make_no_github_call(self) -> None:
        clock_now = [100.0]
        run = GHBroker(self, store_clock=lambda: clock_now[0])
        good = run.placeholder("7")
        service_ph = run.mint("8")["grants"][0]["placeholder"]
        revoked = run.placeholder("9")
        admin(run.path, {"op": "revoke_task", "task_id": "9"})
        cases = [
            ("service placeholder", lambda: run.post(service_ph), 401, "bad_placeholder"),
            ("unknown placeholder", lambda: run.post(PH), 401, "bad_placeholder"),
            ("not a placeholder", lambda: run.post("ghp_nope"), 401, "bad_placeholder"),
            ("no authorization", lambda: run.post(None), 401, "missing_placeholder"),
            ("two authorization", lambda: run.raw(
                b"POST /_github/token HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\nAuthorization: Bearer %s\r\n"
                b"Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}" % (good.encode(), good.encode())),
             401, "missing_placeholder"),
            ("revoked", lambda: run.post(revoked), 401, "revoked_placeholder"),
            ("other repository", lambda: run.post(good, {"repository": "Owner/Other"}), 403, "github_repo_mismatch"),
            ("other owner", lambda: run.post(good, {"repository": "Evil/Repo"}), 403, "github_repo_mismatch"),
            ("extra key", lambda: run.post(good, {"repository": "Owner/Repo", "x": 1}), 400, "bad_request"),
            ("duplicate key", lambda: run.post(good, raw_body=b'{"repository":"Owner/Repo","repository":"Owner/Repo"}'), 400, "bad_request"),
            ("array", lambda: run.post(good, ["Owner/Repo"]), 400, "bad_request"),
            ("not json", lambda: run.post(good, raw_body=b"repository=Owner/Repo"), 400, "bad_request"),
            ("nan", lambda: run.post(good, raw_body=b'{"repository":NaN}'), 400, "bad_request"),
            ("bad grammar", lambda: run.post(good, {"repository": "Owner/Repo/x"}), 400, "bad_request"),
            ("not a string", lambda: run.post(good, {"repository": 7}), 400, "bad_request"),
            ("empty body", lambda: run.post(good, raw_body=b""), 400, "bad_request"),
            ("text content type", lambda: run.post(good, headers={"Content-Type": "text/plain"}), 400, "bad_request"),
            ("no content type", lambda: run.post(good, headers={"Content-Type": None}), 400, "bad_request"),
            ("odd charset", lambda: run.post(good, headers={"Content-Type": "application/json; charset=latin-1"}), 400, "bad_request"),
            ("query placeholder", lambda: run.post(good, target="/_github/token?placeholder=" + good), 400, "bad_request"),
            ("query repository", lambda: run.post(good, target="/_github/token?repository=Owner/Repo"), 400, "bad_request"),
            ("path repository", lambda: run.post(good, target="/_github/token/Owner/Repo"), 400, "bad_request"),
            ("path placeholder", lambda: run.post(good, target="/_github/" + good), 400, "bad_request"),
            ("trailing slash", lambda: run.post(good, target="/_github/token/"), 400, "bad_request"),
            ("fragment", lambda: run.post(good, target="/_github/token#x"), 400, "bad_request"),
            ("get", lambda: run.post(good, method="GET"), 400, "bad_request"),
            ("put", lambda: run.post(good, method="PUT"), 400, "bad_request"),
        ]
        for name, call, status, code in cases:
            with self.subTest(case=name):
                result = call()
                if isinstance(result, bytes):
                    head, _sep, body = result.partition(b"\r\n\r\n")
                    self.assertTrue(head.startswith(b"HTTP/1.1 %d " % status), head)
                    self.assertEqual(body, ('{"error":"%s"}' % code).encode())
                else:
                    self.assert_error(result, status, code)
                self.assertEqual(run.gh.calls, [])
        # Expired: the store's clock moves past the TTL.
        clock_now[0] += 3601
        self.assert_error(run.post(good), 401, "expired_placeholder")
        # A github entry without a repository (defensive code).
        clock_now[0] = 100.0
        fresh = run.placeholder("10")
        with run.store._lock:
            run.store._entries[fresh]["repo"] = None
        self.assert_error(run.post(fresh), 403, "github_no_repo")
        self.assertEqual(run.gh.calls, [])

    def test_chunked_body_refused(self) -> None:
        run = GHBroker(self)
        good = run.placeholder()
        raw = run.raw(
            b"POST /_github/token HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\n"
            b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n1e\r\n{\"repository\":\"Owner/Repo\"}\r\n0\r\n\r\n" % good.encode()
        )
        if raw:  # Linux may report ECONNRESET instead (unread body).
            self.assertTrue(raw.startswith(b"HTTP/1.1 400 "), raw)
            self.assertTrue(raw.endswith(b'{"error":"bad_request"}'))
        self.assertEqual(run.gh.calls, [])

    def test_order_target_then_placeholder_then_body_then_config(self) -> None:
        run = GHBroker(self)
        good = run.placeholder()
        # A bad target wins over a bad placeholder.
        self.assert_error(run.post("nope", target="/_github/token?x"), 400, "bad_request")
        # A bad placeholder wins over a bad body.
        self.assert_error(run.post(PH, raw_body=b"junk"), 401, "bad_placeholder")
        # A bad body wins over the repository check.
        self.assert_error(run.post(good, {"repository": "Owner/Other", "x": 1}), 400, "bad_request")
        # Without a github block: placeholder first, then body, then github_not_configured.
        plain = GHBroker(self, block=False)
        svc = plain.mint("1", repo=None)["grants"][0]["placeholder"]
        self.assert_error(plain.post(PH), 401, "bad_placeholder")
        self.assert_error(plain.post(svc, raw_body=b"junk"), 400, "bad_request")
        self.assert_error(plain.post(svc), 403, "github_not_configured")
        self.assertEqual(plain.gh.calls, [])

    def test_cache_one_mint_for_concurrent_requests(self) -> None:
        run = GHBroker(self)
        placeholder = run.placeholder()
        run.gh.gate = threading.Event()
        results: list = []
        threads = [threading.Thread(target=lambda: results.append(run.post(placeholder))) for _ in range(2)]
        for t in threads:
            t.start()
        self.assertTrue(run.gh.entered.wait(10))
        threading.Event().wait(0.3)  # the second request is now waiting on the per-task mint
        run.gh.gate.set()
        for t in threads:
            t.join(15)
        self.assertEqual([r[0] for r in results], [200, 200])
        self.assertEqual(results[0][2], results[1][2])
        self.assertEqual(len(run.gh.of("tokens")), 1)
        self.assertEqual(len(run.gh.of("installation")), 1)

    def test_cache_remints_at_300_second_boundary(self) -> None:
        run = GHBroker(self)
        placeholder = run.placeholder()
        first = json.loads(run.post(placeholder)[2])
        run.clock.advance(3600 - 301)
        self.assertEqual(json.loads(run.post(placeholder)[2]), first)
        self.assertEqual(len(run.gh.of("tokens")), 1)
        run.clock.advance(1)  # exactly expires_at - 300
        second = json.loads(run.post(placeholder)[2])
        self.assertNotEqual(second["token"], first["token"])
        self.assertEqual(len(run.gh.of("tokens")), 2)

    def test_cache_not_shared_across_tasks(self) -> None:
        run = GHBroker(self)
        a = run.placeholder("A")
        b = run.placeholder("B")
        ta = json.loads(run.post(a)[2])["token"]
        tb = json.loads(run.post(b)[2])["token"]
        self.assertNotEqual(ta, tb)
        self.assertEqual(len(run.gh.of("tokens")), 2)
        self.assertEqual(json.loads(run.post(a)[2])["token"], ta)
        self.assertEqual(len(run.gh.of("tokens")), 2)

    def test_bad_github_responses_are_unavailable_and_clear_cache(self) -> None:
        def tokens(body: object, status: int = 201, headers: list | None = None):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            return lambda _call: (status, data, headers or [])

        later = lambda: iso(time.time() + 3600)  # noqa: E731 - replaced per run below
        cases = [
            ("install 404", {"installation": (404, b'{"message":"x"}', [])}),
            ("install redirect", {"installation": (302, b"", [("Location", "https://evil.invalid/")])}),
            ("install id bool", {"installation": (200, b'{"id":true}', [])}),
            ("install id zero", {"installation": (200, b'{"id":0}', [])}),
            ("install id string", {"installation": (200, b'{"id":"4242"}', [])}),
            ("install not object", {"installation": (200, b"[4242]", [])}),
            ("install malformed", {"installation": (200, b"{", [])}),
            ("tokens 500", {"tokens": (500, b"{}", [])}),
            ("tokens redirect", {"tokens": (307, b"", [("Location", "http://127.0.0.1:1/")])}),
            ("tokens malformed", {"tokens": (201, b"not json", [])}),
            ("tokens duplicate", {"tokens": (201, b'{"token":"a","token":"b","expires_at":"x"}', [])}),
            ("tokens missing token", "missing"),
            ("tokens empty token", "empty"),
            ("tokens bad expires", "badexp"),
            ("tokens no offset", "nooffset"),
            ("tokens over an hour", "long"),
            ("tokens already expired", "past"),
            ("tokens all repositories", "selection_all"),
            ("tokens two repositories", "two_repos"),
            ("tokens other repository", "other_repo"),
            ("tokens wider permissions", "wide_perms"),
            ("tokens lower permission", "lower_perm"),
            ("tokens missing configured permission", "missing_perm"),
            ("tokens metadata write", "metadata_write"),
            ("tokens empty permissions", "empty_perms"),
            ("tokens hang (timeout)", {"tokens": "hang"}),
            ("tokens trickle (one deadline)", {"tokens": "trickle"}),
        ]
        for name, script in cases:
            with self.subTest(case=name):
                config = broker_config(_short_tmp(self), upstream_timeout_seconds=1)
                run = GHBroker(self, config=config)
                now = run.clock()
                if isinstance(script, str):
                    body = {
                        "missing": {"expires_at": iso(now + 3600)},
                        "empty": {"token": "", "expires_at": iso(now + 3600)},
                        "badexp": {"token": "ghs_x", "expires_at": "tomorrow"},
                        "nooffset": {"token": "ghs_x", "expires_at": iso(now + 3600)[:-1]},
                        "long": {"token": "ghs_x", "expires_at": iso(now + 3601)},
                        "past": {"token": "ghs_x", "expires_at": iso(now - 1)},
                        "selection_all": {"token": "ghs_x", "expires_at": iso(now + 3600), "repository_selection": "all"},
                        "two_repos": {"token": "ghs_x", "expires_at": iso(now + 3600),
                                      "repositories": [{"name": "Repo"}, {"name": "Other"}]},
                        "other_repo": {"token": "ghs_x", "expires_at": iso(now + 3600), "repositories": [{"name": "Other"}]},
                        "wide_perms": {"token": "ghs_x", "expires_at": iso(now + 3600),
                                       "permissions": dict(PERMISSIONS, administration="write")},
                        "lower_perm": {"token": "ghs_x", "expires_at": iso(now + 3600),
                                       "permissions": {"contents": "read"}},
                        "missing_perm": {"token": "ghs_x", "expires_at": iso(now + 3600),
                                         "permissions": {"contents": "write"}},
                        "metadata_write": {"token": "ghs_x", "expires_at": iso(now + 3600),
                                           "permissions": dict(PERMISSIONS, metadata="write")},
                        "empty_perms": {"token": "ghs_x", "expires_at": iso(now + 3600), "permissions": {}},
                    }[script]
                    run.gh.script = {"tokens": tokens(body)}
                else:
                    run.gh.script = dict(script)
                placeholder = run.placeholder()
                started = time.monotonic()
                result = run.post(placeholder)
                elapsed = time.monotonic() - started
                self.assertEqual(result, (502, "application/json", b'{"error":"github_unavailable"}'))
                self.assertLess(elapsed, 4.0, "one deadline, not one per read")
                # Every rejected answer that issued a token gets that token DELETEd.
                issued = isinstance(script, str) and script not in ("missing", "empty")
                deletes = [d["headers"]["Authorization"] for d in run.gh.of("delete")]
                self.assertEqual(deletes, ["Bearer ghs_x"] if issued else [])
                self.assertEqual(run.service._cache, {})
                run.gh.release.set()
                # The next request mints again.
                run.gh.script = {}
                self.assertEqual(run.post(placeholder)[0], 200)
                self.assertEqual(set(run.service._cache), {"7"})
        del later

    def test_documented_extras_accepted_and_unknown_keys_ignored(self) -> None:
        # H2: "a strict object containing" token and expires_at. GitHub's documented
        # extras are checked against the request; undocumented keys are ignored.
        run = GHBroker(self)

        def tokens(_call: dict) -> tuple:
            body = {
                "token": "ghs_withExtras", "expires_at": iso(run.clock() + 3600),
                "permissions": dict(PERMISSIONS, metadata="read"), "repository_selection": "selected",
                "repositories": [{"id": 1, "name": "repo", "full_name": "Owner/repo"}],
                "single_file": None, "has_multiple_single_files": False, "future_field": {"x": 1},
            }
            return 201, json.dumps(body).encode(), []

        run.gh.script = {"tokens": tokens}
        status, _ctype, body = run.post(run.placeholder())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"token": "ghs_withExtras", "expires_at": iso(run.clock() + 3600)})

    def test_task_lock_entries_are_dropped(self) -> None:
        run = GHBroker(self)
        for n in range(5):
            task = "T%d" % n
            self.assertEqual(run.post(run.placeholder(task))[0], 200)
        self.assertEqual(len(run.service._mint_locks), 5)  # one per task with a cached token
        for n in range(5):
            admin(run.path, {"op": "revoke_task", "task_id": "T%d" % n})
        self.assertEqual(run.service._mint_locks, {})
        self.assertEqual(run.service._cache, {})
        # A refused request leaves nothing either.
        self.assertEqual(run.post(run.placeholder("U"), {"repository": "Owner/Other"})[0], 403)
        run.gh.script = {"tokens": (500, b"{}", [])}
        self.assertEqual(run.post(run.placeholder("V"))[0], 502)
        self.assertEqual(run.service._mint_locks, {})

    def test_revoke_during_mint_returns_no_token(self) -> None:
        # H3.
        run = GHBroker(self)
        placeholder = run.placeholder()
        run.gh.gate = threading.Event()
        out: list = []
        worker = threading.Thread(target=lambda: out.append(run.post(placeholder)))
        worker.start()
        self.assertTrue(run.gh.entered.wait(10))
        revoked: list = []
        revoker = threading.Thread(target=lambda: revoked.append(admin(run.path, {"op": "revoke_task", "task_id": "7"})))
        revoker.start()
        # The store is revoked at once; the GitHub side waits for the task lock (I5).
        deadline = time.monotonic() + 5
        while run.store.check(placeholder, "github") != "revoked" and time.monotonic() < deadline:
            threading.Event().wait(0.01)
        self.assertEqual(run.store.check(placeholder, "github"), "revoked")
        run.gh.gate.set()
        worker.join(15)
        revoker.join(15)
        self.assertEqual(revoked, [{"ok": True}])
        self.assertEqual(out[0], (401, "application/json", b'{"error":"revoked_placeholder"}'))
        deletes = run.gh.of("delete")
        self.assertEqual(len(deletes), 1)
        self.assertEqual(deletes[0]["headers"]["Authorization"], "Bearer ghs_fixtureToken0001")
        self.assertEqual(run.service._cache, {})

    def test_revoke_before_commit_with_failing_delete_gets_no_cached_token(self) -> None:
        # I5: a cached token is chosen, the barrier holds the request, revoke_task runs and
        # its DELETE fails; the request must still get 401 and no token.
        run = GHBroker(self)
        placeholder = run.placeholder()
        token = json.loads(run.post(placeholder)[2])["token"]
        run.gh.script = {"delete": (500, b"{}", [])}
        chosen, release = threading.Event(), threading.Event()

        def barrier(_self: object, _task: str) -> None:
            chosen.set()
            release.wait(10)

        out: list = []
        revoked: list = []
        with mock.patch.object(github.TokenService, "_chosen", barrier):
            worker = threading.Thread(target=lambda: out.append(run.post(placeholder)))
            worker.start()
            self.assertTrue(chosen.wait(10))
            revoker = threading.Thread(target=lambda: revoked.append(admin(run.path, {"op": "revoke_task", "task_id": "7"})))
            revoker.start()
            deadline = time.monotonic() + 5
            while run.store.check(placeholder, "github") != "revoked" and time.monotonic() < deadline:
                threading.Event().wait(0.01)
            self.assertEqual(run.store.check(placeholder, "github"), "revoked")
            self.assertTrue(revoker.is_alive(), "revoke_task must wait for the task lock")
            release.set()
            worker.join(15)
            revoker.join(15)
        self.assertEqual(out[0], (401, "application/json", b'{"error":"revoked_placeholder"}'))
        self.assertNotIn(token.encode(), out[0][2])
        self.assertEqual(revoked, [{"ok": True}])
        self.assertIn('{"github":"github_revoke_failed"}', run.log.lines)
        self.assertEqual(run.service._cache, {})
        self.assertEqual(len(run.gh.of("tokens")), 1)

    def test_revoke_waits_until_committed_response_is_written(self) -> None:
        # I5: once the liveness check passed, the response is written under the task
        # lock; revoke_task waits for it, then DELETEs the token that was handed out.
        run = GHBroker(self)
        placeholder = run.placeholder()
        entered, release = threading.Event(), threading.Event()
        real_send = broker._send_token

        def slow_send(handler: object, token: str, expires_at: str) -> None:
            entered.set()
            release.wait(10)
            real_send(handler, token, expires_at)

        out: list = []
        revoked: list = []
        with mock.patch.object(broker, "_send_token", slow_send):
            worker = threading.Thread(target=lambda: out.append(run.post(placeholder)))
            worker.start()
            self.assertTrue(entered.wait(10))
            revoker = threading.Thread(target=lambda: revoked.append(admin(run.path, {"op": "revoke_task", "task_id": "7"})))
            revoker.start()
            revoker.join(0.5)
            self.assertTrue(revoker.is_alive(), "revoke_task must wait for the response to be written")
            self.assertEqual(run.gh.of("delete"), [])
            release.set()
            worker.join(15)
            revoker.join(15)
        self.assertEqual(out[0][0], 200)
        token = json.loads(out[0][2])["token"]
        self.assertEqual(revoked, [{"ok": True}])
        self.assertEqual([d["headers"]["Authorization"] for d in run.gh.of("delete")], ["Bearer " + token])

    def test_body_not_read_before_target_and_placeholder(self) -> None:
        # I6: a declared body that never arrives does not hold up the refusal.
        run = GHBroker(self)
        good = run.placeholder()
        cases = [
            ("bad target, slow body", b"/_github/token?x", good, b"4000"),
            ("bad method target", b"/_github/other", good, b"4000"),
            ("bad placeholder, slow body", b"/_github/token", PH, b"4000"),
            ("no placeholder, huge body", b"/_github/token", None, b"999999999"),
        ]
        for name, target, ph, length in cases:
            with self.subTest(case=name):
                sock = socket.create_connection(("127.0.0.1", run.port), timeout=3)
                try:
                    head = b"POST " + target + b" HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                    if ph is not None:
                        head += b"Authorization: Bearer " + ph.encode() + b"\r\n"
                    sock.sendall(head + b"Content-Length: " + length + b"\r\n\r\n{")
                    started = time.monotonic()
                    data = b""
                    while True:
                        try:
                            block = sock.recv(65536)
                        except ConnectionResetError:
                            break
                        if not block:
                            break
                        data += block
                finally:
                    sock.close()
                self.assertLess(time.monotonic() - started, 2.0)
                if data:  # Linux may report ECONNRESET for the unread body instead
                    self.assertTrue(data.startswith(b"HTTP/1.1 400 ") or data.startswith(b"HTTP/1.1 401 "), data)
        self.assertEqual(run.gh.calls, [])

    def test_proxy_variables_are_never_used(self) -> None:
        # H16: a proxy sentinel in every proxy variable is never contacted.
        sentinel = socket.socket()
        sentinel.bind(("127.0.0.1", 0))
        sentinel.listen(4)
        sentinel.settimeout(0.2)
        self.addCleanup(sentinel.close)
        proxy = "http://127.0.0.1:%d" % sentinel.getsockname()[1]
        names = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")
        with mock.patch.dict(os.environ, {n: proxy for n in names}):
            run = GHBroker(self)
            self.assertEqual(run.post(run.placeholder())[0], 200)
            helper = run_helper(b"protocol=https\nhost=github.com\n\n", {
                "AK_GITHUB_PLACEHOLDER": PH, "AK_BROKER_URL": "http://127.0.0.1:%d" % run.port,
                "AK_GITHUB_REPO": "Owner/Repo", **{n: proxy for n in names},
            })
            self.assertNotEqual(helper.returncode, 0)  # PH is not minted; the request still went direct
        with self.assertRaises(socket.timeout):
            sentinel.accept()

    def test_production_client_requires_https_and_verifies(self) -> None:
        client = github.default_client_factory("https://api.github.com", 5)
        self.assertEqual(client._tls.verify_mode, __import__("ssl").CERT_REQUIRED)
        self.assertTrue(client._tls.check_hostname)
        with self.assertRaises(ValueError):
            github.GitHubAPI("http://api.github.com", 5)
        with self.assertRaises(ValueError):
            github.GitHubAPI("http://evil.invalid", 5, _plaintext_loopback=True)


# ---------------------------------------------------------------------------
# AC3, C7, H3: revoke.

class TestRevoke(unittest.TestCase):
    def test_revoke_task_deletes_token_and_clears_cache(self) -> None:
        run = GHBroker(self)
        placeholder = run.placeholder()
        token = json.loads(run.post(placeholder)[2])["token"]
        self.assertEqual(set(run.service._cache), {"7"})
        self.assertEqual(admin(run.path, {"op": "revoke_task", "task_id": "7"}), {"ok": True})
        deletes = run.gh.of("delete")
        self.assertEqual(len(deletes), 1)
        self.assertEqual(deletes[0]["headers"]["Authorization"], "Bearer " + token)
        self.assertEqual(run.service._cache, {})
        self.assertEqual(run.post(placeholder)[0], 401)
        self.assertNotIn("github_revoke_failed", "".join(run.log.lines))

    def test_failed_delete_is_logged_and_revoke_succeeds(self) -> None:
        for name, script in (("500", (500, b"{}", [])), ("hang", "hang")):
            with self.subTest(case=name):
                run = GHBroker(self)
                placeholder = run.placeholder()
                token = json.loads(run.post(placeholder)[2])["token"]
                run.gh.script = {"delete": script}
                started = time.monotonic()
                self.assertEqual(admin(run.path, {"op": "revoke_task", "task_id": "7"}), {"ok": True})
                self.assertLess(time.monotonic() - started, 4.5)
                self.assertEqual(run.service._cache, {})
                self.assertIn('{"github":"github_revoke_failed"}', run.log.lines)
                for line in run.log.lines:
                    self.assertNotIn(token, line)
                run.gh.release.set()
                # The placeholder is revoked whatever GitHub said.
                self.assertEqual(run.post(placeholder)[0], 401)

    def test_revoked_task_can_mint_again(self) -> None:
        run = GHBroker(self)
        first = run.placeholder()
        self.assertEqual(run.mint()["ok"], False)  # live task id
        admin(run.path, {"op": "revoke_task", "task_id": "7"})
        second = run.placeholder()
        self.assertNotEqual(first, second)
        self.assertEqual(run.post(second)[0], 200)


# ---------------------------------------------------------------------------
# AC13, F1, G2, G10: audit and the ak.broker log.

class TestAudit(unittest.TestCase):
    class Sink:
        def __init__(self) -> None:
            self.events: list = []

        def record(self, *args: object) -> None:
            # The real mapping: an unknown reason raises here and the event would be lost.
            self.events.append(audit.build_event("broker-test", *args))

        def start(self) -> None:
            return

        def close(self) -> None:
            return

    def test_every_answer_is_one_audit_event(self) -> None:
        run = GHBroker(self)
        sink = self.Sink()
        run.server._state.audit = sink
        good = run.placeholder()
        service_ph = run.mint("8")["grants"][0]["placeholder"]
        expected = []

        def check(result: tuple, task: object, status: int, reason: object) -> None:
            self.assertEqual(result[0], status)
            expected.append({"task_id": task, "service": "github", "method": "POST",
                             "path_prefix": "/_github/token", "status": status, "reason": reason})

        check(run.post(good), "7", 200, None)
        check(run.post(PH), None, 401, "bad_placeholder")
        check(run.post(service_ph), None, 401, "bad_placeholder")
        check(run.post(good, target="/_github/token?x"), None, 400, "bad_request")
        check(run.post(good, raw_body=b"junk"), "7", 400, "bad_request")
        check(run.post(good, {"repository": "Owner/Other"}), "7", 403, "github_repo_mismatch")
        other = run.placeholder("9")
        run.gh.script = {"tokens": (500, b"{}", [])}
        check(run.post(other), "9", 502, "github_unavailable")
        deadline = time.monotonic() + 5
        while len(sink.events) < len(expected) and time.monotonic() < deadline:
            threading.Event().wait(0.02)
        self.assertEqual([e["detail"] for e in sink.events], expected)
        kinds = [e["kind"] for e in sink.events]
        self.assertEqual(kinds, ["broker_forwarded"] + ["broker_refused"] * 6)
        # A GET is reported as OTHER, never echoed.
        sink.events.clear()
        run.post(good, method="GET")
        threading.Event().wait(0.2)
        self.assertEqual(sink.events[0]["detail"]["method"], "OTHER")
        # ak.broker logs the exact refusal code (G10).
        lines = [json.loads(line) for line in run.log.lines if line.startswith("{\"service\"")]
        reasons = {line["reason"] for line in lines}
        self.assertTrue({"github_repo_mismatch", "github_unavailable", "bad_placeholder"} <= reasons, reasons)
        for line in run.log.lines:
            self.assertNotIn("ghs_fixtureToken", line)
            self.assertNotIn("akp_", line)
            self.assertNotIn("Bearer", line)

    def test_no_audit_block_no_events(self) -> None:
        run = GHBroker(self)
        self.assertIsNone(run.server._state.audit)
        with mock.patch.object(audit, "build_event", side_effect=AssertionError("event built")):
            self.assertEqual(run.post(run.placeholder())[0], 200)
            self.assertEqual(run.post(PH)[0], 401)

    def test_new_codes_are_refusals(self) -> None:
        for code, status in (("github_not_configured", 403), ("github_no_repo", 403),
                             ("github_repo_mismatch", 403), ("github_unavailable", 502)):
            event = audit.build_event("a", "7", "github", "POST", ("POST",), "/_github/token", status, code)
            self.assertEqual(event["kind"], "broker_refused")
            self.assertEqual(event["detail"]["reason"], code)
            self.assertIn(code, broker._REASONS)


# ---------------------------------------------------------------------------
# AC14, G8, H5, H6, H9, F2: startup and admin validation.

class TestValidation(unittest.TestCase):
    def test_startup_rejections_create_no_socket(self) -> None:
        root = _short_tmp(self)
        base = broker_config(root)
        good = dict(base["github"])

        def gh(**changes: object) -> dict:
            block = dict(good)
            for key, value in changes.items():
                if value is KeyError:
                    block.pop(key)
                else:
                    block[key] = value
            return dict(base, github=block)

        svc_github = dict(base["services"][0], name="github")
        cases = {
            "unknown key": gh(extra=1),
            "missing app_id": gh(app_id=KeyError),
            "missing private_key": gh(private_key=KeyError),
            "missing permissions": gh(permissions=KeyError),
            "app_id bool": gh(app_id=True),
            "app_id zero": gh(app_id=0),
            "app_id negative": gh(app_id=-1),
            "app_id string": gh(app_id="1"),
            "app_id float": gh(app_id=1.0),
            "private_key empty": gh(private_key=""),
            "private_key literal": gh(private_key=KEY_PEM),
            "private_key not ref": gh(private_key="env://KEY"),
            "private_key int": gh(private_key=1),
            "permissions empty": gh(permissions={}),
            "permissions list": gh(permissions=["contents"]),
            "permission name": gh(permissions={"Contents": "write"}),
            "permission name dash": gh(permissions={"pull-requests": "write"}),
            "permission value": gh(permissions={"contents": "admin"}),
            "permission value type": gh(permissions={"contents": True}),
            "api http": gh(api="http://api.github.com"),
            "api path": gh(api="https://api.github.com/v3"),
            "api slash": gh(api="https://api.github.com/"),
            "api query": gh(api="https://api.github.com?x=1"),
            "api fragment": gh(api="https://api.github.com#f"),
            "api userinfo": gh(api="https://u:p@api.github.com"),
            "api empty": gh(api=""),
            "api type": gh(api=1),
            "api port": gh(api="https://api.github.com:99999"),
            "block not object": dict(base, github=[]),
            "service named github": dict(base, services=[svc_github]),
            "service named github without block": dict({k: v for k, v in base.items() if k != "github"}, services=[svc_github]),
            "unusable key": None,
        }
        for name, config in cases.items():
            with self.subTest(case=name):
                if config is None:
                    broken = root / "broken.env"
                    _write(broken, "KEY=%s\nGHKEY=not-a-pem\n" % SVC_SECRET)
                    prov = root / "providers-broken.json"
                    _write(prov, json.dumps({"file": {"lanes": str(broken)}}))
                    config = dict(base, providers=str(prov))
                with mock.patch.object(broker, "_BoundServer", side_effect=AssertionError("http socket")), \
                        mock.patch.object(broker, "_AdminServer", side_effect=AssertionError("admin socket")):
                    with self.assertRaises(ValueError) as caught:
                        broker.BrokerServer(config, broker.PlaceholderStore())
                self.assertEqual(key_leaks(str(caught.exception)), [])
                self.assertFalse(os.path.exists(base["admin_socket"]))
        # The defaults (H5) and a validated config validating again unchanged.
        checked = broker.validate_config(base, port_zero_ok=True)
        self.assertEqual(checked["github"]["api"], "https://api.github.com")
        self.assertEqual(broker.validate_config(checked, port_zero_ok=True), checked)
        example = json.loads((BROKER_DIR / "config.example.json").read_text())
        self.assertEqual(broker.validate_config(example)["github"]["permissions"], PERMISSIONS)

    def test_admin_rejections_mint_nothing(self) -> None:
        run = GHBroker(self)
        cases = [
            {"op": "mint", "task_id": "1", "services": []},
            {"op": "mint", "task_id": "1", "services": ["github"]},
            {"op": "mint", "task_id": "1", "services": ["github"], "github_repo": "Owner/Repo"},
            {"op": "mint", "task_id": "1", "services": [], "github_repo": "Owner"},
            {"op": "mint", "task_id": "1", "services": [], "github_repo": "Owner/Repo/x"},
            {"op": "mint", "task_id": "1", "services": [], "github_repo": "Owner/.."},
            {"op": "mint", "task_id": "1", "services": [], "github_repo": "Owner/Repo?x"},
            {"op": "mint", "task_id": "1", "services": [], "github_repo": None},
            {"op": "mint", "task_id": "1", "services": [], "github_repo": 7},
            {"op": "mint", "task_id": "1", "services": [], "github_repo": "Owner/Repo", "x": 1},
            {"op": "mint", "task_id": "1", "github_repo": "Owner/Repo"},
        ]
        for request in cases:
            with self.subTest(request=request):
                self.assertEqual(admin(run.path, request), {"ok": False, "error": "bad_request"})
        self.assertEqual(run.store.known_placeholders(), ())
        self.assertEqual(run.gh.calls, [])

    def test_admin_mint_shapes(self) -> None:
        run = GHBroker(self)
        both = run.mint("1", ["openrouter"], "Owner/Repo")
        self.assertEqual(set(both), {"ok", "grants", "github"})
        self.assertEqual(set(both["github"]), {"placeholder", "broker_url"})
        self.assertRegex(both["github"]["placeholder"], r"\Aakp_[A-Za-z0-9_-]{43}\Z")
        self.assertEqual(both["github"]["broker_url"], "http://127.0.0.1:%d" % run.port)
        only = run.mint("2", [], "Owner/Repo")
        self.assertEqual(only["grants"], [])
        self.assertIn("github", only)
        none = run.mint("3", ["openrouter"], None)
        self.assertEqual(set(none), {"ok", "grants"})
        # G1: no block, services empty, supported repo: exactly {"ok":true,"grants":[]}.
        plain = GHBroker(self, block=False)
        self.assertEqual(plain.mint("1", [], "Owner/Repo"), {"ok": True, "grants": []})
        self.assertEqual(plain.store.known_placeholders(), ())
        with_svc = plain.mint("2", ["openrouter"], "Owner/Repo")
        self.assertEqual(set(with_svc), {"ok", "grants"})


# ---------------------------------------------------------------------------
# AC4, D5, H12, H15, C6: the credential helper.

class TokenStub:
    """A stand-in for the broker's token endpoint."""

    def __init__(self, test: unittest.TestCase) -> None:
        self.calls: list = []
        self.response: object = None
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_a: object) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                outer.calls.append({"path": self.path, "headers": dict(self.headers.items()), "body": body})
                response = outer.response
                if response is None:
                    response = (200, [("Content-Type", "application/json")],
                                b'{"token":"ghs_stubToken","expires_at":"2099-01-01T00:00:00Z"}')
                status, headers, data = response
                self.send_response(status)
                for name, value in headers:
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        test.addCleanup(self.close)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.server.server_address[1]


def run_helper(stdin: bytes, env: dict, args: tuple = ("get",)) -> subprocess.CompletedProcess:
    base = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    base.update(env)
    return subprocess.run([str(HELPER), *args], input=stdin, capture_output=True, env=base, timeout=30)


class TestCredentialHelper(unittest.TestCase):
    def setUp(self) -> None:
        self.stub = TokenStub(self)
        self.env = {"AK_GITHUB_PLACEHOLDER": PH, "AK_BROKER_URL": self.stub.url, "AK_GITHUB_REPO": "Owner/Repo"}

    def test_mode_is_exactly_0755_and_stdlib(self) -> None:
        self.assertEqual(stat.S_IMODE(os.stat(HELPER).st_mode), 0o755)
        text = HELPER.read_text()
        self.assertTrue(text.startswith("#!/usr/bin/env python3\n"))
        import ast
        allowed = {"__future__", "json", "os", "re", "socket", "sys", "time"}
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertIn(alias.name.split(".")[0], allowed)
            elif isinstance(node, ast.ImportFrom):
                self.assertIn((node.module or "").split(".")[0], allowed)

    def test_get_writes_exact_credential(self) -> None:
        for name, stdin in (
            ("blank line", b"protocol=https\nhost=github.com\n\n"),
            ("path ignored", b"protocol=https\nhost=github.com\npath=Other/Thing.git\n\n"),
            ("git 2.50 form", b"capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\n"
                              b'wwwauth[]=Basic realm="GitHub"\n'),
        ):
            with self.subTest(case=name):
                self.stub.calls.clear()
                out = run_helper(stdin, self.env)
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertEqual(out.stdout, b"username=x-access-token\npassword=ghs_stubToken\n\n")
                self.assertEqual(len(self.stub.calls), 1)
                call = self.stub.calls[0]
                self.assertEqual(call["path"], "/_github/token")
                self.assertEqual(call["body"], b'{"repository":"Owner/Repo"}')
                self.assertEqual(call["headers"]["Authorization"], "Bearer " + PH)
                self.assertEqual(call["headers"]["Content-Type"], "application/json")
                self.assertNotIn(b"ghs_stubToken", out.stderr)

    def test_malformed_input_refused_without_request(self) -> None:
        cases = {
            "empty": b"",
            "only blank": b"\n",
            "no final newline": b"protocol=https\nhost=github.com",
            "duplicate protocol": b"protocol=https\nprotocol=https\nhost=github.com\n\n",
            "conflicting host": b"protocol=https\nhost=github.com\nhost=evil.example\n\n",
            "duplicate path": b"protocol=https\nhost=github.com\npath=a\npath=b\n\n",
            "username": b"protocol=https\nhost=github.com\nusername=x\n\n",
            "password": b"protocol=https\nhost=github.com\npassword=x\n\n",
            "unknown field": b"protocol=https\nhost=github.com\nurl=https://github.com/o/r\n\n",
            "cr": b"protocol=https\r\nhost=github.com\r\n\r\n",
            "nul": b"protocol=https\nhost=github.com\x00\n\n",
            "no equals": b"protocol=https\nhost\n\n",
            "data after blank line": b"protocol=https\nhost=github.com\n\nhost=evil\n",
            "two blank lines": b"protocol=https\nhost=github.com\n\n\n",
            "missing host": b"protocol=https\n\n",
            "missing protocol": b"host=github.com\n\n",
            "too large": b"protocol=https\nhost=github.com\n" + b"capability[]=x\n" * 6000 + b"\n",
            "bad utf8": b"protocol=https\nhost=github.com\npath=\xff\n\n",
        }
        for name, stdin in cases.items():
            with self.subTest(case=name):
                out = run_helper(stdin, self.env)
                self.assertNotEqual(out.returncode, 0)
                self.assertEqual(out.stdout, b"")
        self.assertEqual(self.stub.calls, [])

    def test_bad_environment_refused_without_request(self) -> None:
        stdin = b"protocol=https\nhost=github.com\n\n"
        for name, change in (
            ("no repo", {"AK_GITHUB_REPO": None}),
            ("empty repo", {"AK_GITHUB_REPO": ""}),
            ("repo extra segment", {"AK_GITHUB_REPO": "Owner/Repo/x"}),
            ("repo dotdot", {"AK_GITHUB_REPO": "Owner/.."}),
            ("repo space", {"AK_GITHUB_REPO": "Owner/Re po"}),
            ("no placeholder", {"AK_GITHUB_PLACEHOLDER": None}),
            ("short placeholder", {"AK_GITHUB_PLACEHOLDER": "akp_abc"}),
            ("no broker", {"AK_BROKER_URL": None}),
            ("remote broker", {"AK_BROKER_URL": "http://10.0.0.1:80"}),
            ("broker path", {"AK_BROKER_URL": self.stub.url + "/x"}),
            ("broker https", {"AK_BROKER_URL": self.stub.url.replace("http", "https")}),
            ("broker port", {"AK_BROKER_URL": "http://127.0.0.1:70000"}),
        ):
            with self.subTest(case=name):
                env = dict(self.env)
                for key, value in change.items():
                    if value is None:
                        env.pop(key)
                    else:
                        env[key] = value
                out = run_helper(stdin, env)
                self.assertNotEqual(out.returncode, 0)
                self.assertEqual(out.stdout, b"")
        self.assertEqual(self.stub.calls, [])

    def test_bad_responses_refused(self) -> None:
        stdin = b"protocol=https\nhost=github.com\n\n"
        json_type = [("Content-Type", "application/json")]
        cases = {
            "refusal": (403, json_type, b'{"error":"github_repo_mismatch"}'),
            "unavailable": (502, json_type, b'{"error":"github_unavailable"}'),
            "redirect": (302, json_type + [("Location", "http://127.0.0.1:1/")], b'{"token":"ghs_x","expires_at":"x"}'),
            "not json": (200, json_type, b"token=ghs_x"),
            "non json type": (200, [("Content-Type", "text/plain")], b'{"token":"ghs_x","expires_at":"x"}'),
            "missing token": (200, json_type, b'{"expires_at":"2099-01-01T00:00:00Z"}'),
            "empty token": (200, json_type, b'{"token":"","expires_at":"2099-01-01T00:00:00Z"}'),
            "token newline": (200, json_type, b'{"token":"a\\nusername=evil","expires_at":"2099-01-01T00:00:00Z"}'),
            "extra key": (200, json_type, b'{"token":"ghs_x","expires_at":"x","x":1}'),
            "duplicate key": (200, json_type, b'{"token":"a","token":"b","expires_at":"x"}'),
            "array": (200, json_type, b'["ghs_x"]'),
            "over 64 KiB": (200, json_type, b'{"token":"' + b"a" * 70000 + b'","expires_at":"x"}'),
        }
        for name, response in cases.items():
            with self.subTest(case=name):
                self.stub.response = response
                out = run_helper(stdin, self.env)
                self.assertNotEqual(out.returncode, 0)
                self.assertEqual(out.stdout, b"")
        # Unreachable broker.
        dead = socket.socket()
        dead.bind(("127.0.0.1", 0))
        port = dead.getsockname()[1]
        dead.close()
        out = run_helper(stdin, dict(self.env, AK_BROKER_URL="http://127.0.0.1:%d" % port))
        self.assertNotEqual(out.returncode, 0)
        self.assertEqual(out.stdout, b"")

    def test_other_actions_protocols_hosts_are_silent(self) -> None:
        get = b"protocol=https\nhost=github.com\n\n"
        cases = [
            (("store",), get + b""), (("erase",), get), (("unknown",), get), ((), get), (("get", "extra"), get),
            (("get",), b"protocol=http\nhost=github.com\n\n"),
            (("get",), b"protocol=ssh\nhost=github.com\n\n"),
            (("get",), b"protocol=https\nhost=gitlab.com\n\n"),
            (("get",), b"protocol=https\nhost=github.com:443\n\n"),
            (("get",), b"protocol=https\nhost=api.github.com\n\n"),
        ]
        for args, stdin in cases:
            with self.subTest(args=args, stdin=stdin):
                out = run_helper(stdin, self.env, args)
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertEqual(out.stdout, b"")
        self.assertEqual(self.stub.calls, [])


# ---------------------------------------------------------------------------
# AC5, AC5b, AC6, AC7, C8, D2, D3, D7, E1, G1, G6, G11, G13, H4, H10: the dispatcher.

def git_run(cwd: Path, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, env=env, timeout=60)


def make_repo(test: unittest.TestCase, urls: tuple = ("https://github.com/Owner/Repo.git",),
              pushurls: tuple = (), extra: tuple = ()) -> tuple:
    base = _short_tmp(test, "akgh-repo-").resolve()
    main = base / "main"
    subprocess.run(["git", "init", "-q", str(main)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(main), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                    "commit", "-q", "--allow-empty", "-m", "init"], check=True, capture_output=True)
    wt = base / "wt"
    subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "lane", str(wt)], check=True, capture_output=True)
    for url in urls:
        subprocess.run(["git", "-C", str(main), "config", "--add", "remote.origin.url", url], check=True)
    if urls:
        subprocess.run(["git", "-C", str(main), "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], check=True)
    for url in pushurls:
        subprocess.run(["git", "-C", str(main), "config", "--add", "remote.origin.pushurl", url], check=True)
    for key, value in extra:
        subprocess.run(["git", "-C", str(main), "config", "--add", key, value], check=True)
    return main, wt


class ScriptedBroker:
    """Scripted admin socket. ``github`` is the grant returned when github_repo is sent (or a value to send)."""

    MISSING = object()

    def __init__(self, test: unittest.TestCase, broker_url: str = "http://127.0.0.1:45678") -> None:
        self.root = _short_tmp(test)
        self.path = str(self.root / "s.sock")
        self.requests: list = []
        self.github: object = {"placeholder": "akp_" + "G" * 43, "broker_url": broker_url}
        self.stop = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(8)
        self.listener.settimeout(0.05)
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        test.addCleanup(self.close)

    def close(self) -> None:
        self.stop.set()
        self.thread.join(2)
        self.listener.close()

    def _loop(self) -> None:
        while not self.stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with conn:
                conn.settimeout(5)
                buf = b""
                while b"\n" not in buf:
                    block = conn.recv(65536)
                    if not block:
                        break
                    buf += block
                if not buf:
                    continue
                request = json.loads(buf)
                self.requests.append(request)
                if request["op"] == "mint":
                    resp: dict = {"ok": True, "grants": [{
                        "service": name, "placeholder": "akp_" + name[0].upper() * 43,
                        "env_key": name.upper() + "_API_KEY", "env_base_url": name.upper() + "_BASE_URL",
                        "base_url": "http://127.0.0.1:45678/" + name,
                    } for name in request["services"]]}
                    if "github_repo" in request and self.github is not self.MISSING:
                        resp["github"] = self.github
                else:
                    resp = {"ok": True}
                conn.sendall(json.dumps(resp).encode() + b"\n")

    def ops(self) -> list:
        return [r["op"] for r in self.requests]


def overlay_expected(placeholder: str, broker_url: str, repo: str = "Owner/Repo") -> dict:
    return {
        "GIT_CONFIG_COUNT": "2",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": "",
        "GIT_CONFIG_KEY_1": "credential.https://github.com.helper",
        "GIT_CONFIG_VALUE_1": str(HELPER),
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "",
        "SSH_ASKPASS": "",
        "AK_GITHUB_PLACEHOLDER": placeholder,
        "AK_BROKER_URL": broker_url,
        "AK_GITHUB_REPO": repo,
    }


GITHUB_ENV_NAMES = set(overlay_expected("x", "y")) | {"GIT_CONFIG_PARAMETERS"}


class Dispatch:
    """run_task on a real linked worktree with a fake API, fake CLIs and patched sinks (D7)."""

    def __init__(self, test: unittest.TestCase, wt: Path, socket_path: str, services: str = "openrouter",
                 env: dict | None = None, worker=None) -> None:
        self.test = test
        self.wt = wt
        self.calls: list = []
        self.ingests: list = []
        self.prints: list = []
        self.envs: list = []
        self.events: list = []
        self.worker = worker
        empty_global = _short_tmp(test) / "global.gitconfig"
        empty_global.write_text("")
        self.environ = {
            "MC_BROKER_SOCKET": socket_path,
            "MC_BROKER_SERVICES": services,
            # The dispatcher's own git calls must not see the host's insteadOf rules.
            "GIT_CONFIG_GLOBAL": str(empty_global),
            "GIT_CONFIG_NOSYSTEM": "1",
            "ANTHROPIC_FIXTURE": "a", "OPENAI_FIXTURE": "o",
        }
        self.environ.update(env or {})

    REAL_WHICH = staticmethod(shutil.which)

    def which(self, name: str, *args: object, **kwargs: object) -> object:
        # Only the agent CLIs are faked; openssl and git resolve for real.
        if name in ("claude", "codex", "grok"):
            return "/usr/bin/true"
        return self.REAL_WHICH(name, *args, **kwargs)

    def run(self, reviewer: str | None = "codex") -> dict:
        def fake_api(path: str, body: object = None, method: str = "POST", max_bytes: object = None) -> dict:
            self.calls.append((path, body, method))
            if path.startswith("/api/skills/pointers"):
                return {"demo": False, "lane": "proj", "runtime": "claude", "empty": True, "block": ""}
            return {}

        def contained(cmd: list, cwd: Path, timeout: float, *, env: dict) -> tuple:
            self.envs.append(dict(env))
            self.events.append("cli")
            if self.worker is not None and len(self.envs) == 1:
                return self.worker(cmd, cwd, env)
            if cmd[0] == "codex":
                return 0, json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "VERDICT: APPROVE"}}) + "\n" + json.dumps(
                    {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}}), ""
            return 0, RESULT_JSON, ""

        real_build = child_env.build_child_env

        def build(platform: str) -> dict:
            self.events.append("build_child_env")
            return real_build(platform)

        real_remote = md.github_remote

        def remote(cwd: Path) -> object:
            self.events.append("remote")
            return real_remote(cwd)

        def fake_print(*args: object, **kwargs: object) -> None:
            self.prints.append(" ".join(str(a) for a in args))

        def fake_ingest(*args: object, **kwargs: object) -> None:
            self.ingests.append((args, kwargs))

        task = {"id": 7, "title": "t", "project": "proj"}
        if reviewer:
            task["reviewer_platform"] = reviewer
        with mock.patch.dict(os.environ, self.environ), \
                mock.patch.object(md, "resolve_project", return_value=self.wt), \
                mock.patch.object(md, "api", side_effect=fake_api), \
                mock.patch.object(md, "ingest", side_effect=fake_ingest), \
                mock.patch.object(builtins, "print", side_effect=fake_print), \
                mock.patch.object(md, "run_cli", REAL_RUN_CLI), \
                mock.patch.object(md, "run_contained", side_effect=contained), \
                mock.patch.object(md.child_env, "build_child_env", side_effect=build), \
                mock.patch.object(md, "github_remote", side_effect=remote), \
                mock.patch.object(md.shutil, "which", side_effect=self.which):
            sem = threading.Semaphore(1)
            sem.acquire()
            md.run_task(task, "claude-code", sem)
            self.expected_envs = [real_build("claude-code"), real_build("codex")]
        return [c[1] for c in self.calls if c[2] == "PATCH"][-1]


class TestHelperTrust(unittest.TestCase):
    """H15 at dispatch time: the exact helper path the overlay names must be trustworthy."""

    def helper(self, mode: int = 0o755, parent_mode: int = 0o700) -> Path:
        root = _short_tmp(self).resolve()
        directory = root / "broker"
        directory.mkdir()
        target = directory / "git-credential-ak"
        shutil.copyfile(str(HELPER), str(target))
        os.chmod(target, mode)
        os.chmod(directory, parent_mode)
        self.addCleanup(os.chmod, str(directory), 0o700)
        return target

    def assert_refused(self, path: Path) -> None:
        with mock.patch.object(md, "GITHUB_HELPER", path):
            with self.assertRaises(md.BrokerUnavailable) as caught:
                md._github_helper_path()
        self.assertEqual(str(caught.exception), "github helper unavailable")

    def test_good_helper_accepted(self) -> None:
        path = self.helper()
        with mock.patch.object(md, "GITHUB_HELPER", path):
            self.assertEqual(md._github_helper_path(), str(path))
        self.assertEqual(stat.S_IMODE(os.stat(md.GITHUB_HELPER).st_mode), 0o755)
        md._github_helper_path()  # the real checkout's helper passes

    def test_bad_modes_refused(self) -> None:
        for mode in (0o777, 0o775, 0o757, 0o700, 0o555, 0o4755):
            with self.subTest(mode=oct(mode)):
                self.assert_refused(self.helper(mode=mode))

    def test_symlink_refused(self) -> None:
        real = self.helper()
        link = real.parent / "link-ak"
        os.symlink(str(real), str(link))
        self.assert_refused(link)
        missing = real.parent / "missing-ak"
        self.assert_refused(missing)
        directory = real.parent / "dir-ak"
        directory.mkdir(mode=0o755)
        self.assert_refused(directory)

    def test_wrong_owner_refused(self) -> None:
        path = self.helper()
        other = 4242 if os.geteuid() != 4242 else 4243
        real_lstat = os.lstat

        def lstat(target: object, *args: object, **kwargs: object) -> os.stat_result:
            info = real_lstat(target, *args, **kwargs)
            if str(target) in (str(path), str(path.parent)) and str(target) == which[0]:
                fields = list(info)
                fields[stat.ST_UID] = other
                return os.stat_result(fields)
            return info

        for which in ([str(path)], [str(path.parent)]):
            with self.subTest(owner_of=which[0]):
                with mock.patch.object(md.os, "lstat", side_effect=lstat):
                    self.assert_refused(path)

    def test_writable_parent_refused(self) -> None:
        for parent_mode in (0o777, 0o775, 0o757, 0o1777):
            with self.subTest(parent=oct(parent_mode)):
                self.assert_refused(self.helper(parent_mode=parent_mode))

    @NEEDS_GIT
    def test_untrusted_helper_fails_task_closed(self) -> None:
        main, wt = make_repo(self)
        fake = ScriptedBroker(self)
        run = Dispatch(self, wt, fake.path)
        with mock.patch.object(md, "GITHUB_HELPER", self.helper(mode=0o777)):
            body = run.run()
        self.assertTrue(body["result"].startswith(PREFIX), body["result"])
        self.assertIn("github helper unavailable", body["result"])
        self.assertEqual(run.envs, [])
        self.assertEqual(fake.ops(), ["health", "mint", "revoke_task"])


class TestRemoteParsing(unittest.TestCase):
    def test_parse_table(self) -> None:
        good = {
            "https://github.com/Owner/Repo": "Owner/Repo",
            "https://github.com/Owner/Repo.git": "Owner/Repo",
            "https://github.com/Owner/Repo.git.git": "Owner/Repo.git",
            "git@github.com:Owner/Repo.git": "Owner/Repo",
            "git@github.com:owner-1/re.po_x": "owner-1/re.po_x",
            "ssh://git@github.com/Owner/Repo.git": "Owner/Repo",
            "ssh://git@github.com/Owner/Repo": "Owner/Repo",
        }
        for url, repo in good.items():
            with self.subTest(url=url):
                self.assertEqual(md.parse_github_remote(url), repo)
        bad = [
            "https://user@github.com/Owner/Repo", "https://user:pw@github.com/Owner/Repo",
            "https://x-access-token:t@github.com/Owner/Repo", "https://github.com:443/Owner/Repo",
            "ssh://git@github.com:22/Owner/Repo", "ssh://bob@github.com/Owner/Repo", "bob@github.com:Owner/Repo",
            "https://github.com/Owner/Repo?x=1", "https://github.com/Owner/Repo#frag",
            "https://github.com//Repo", "https://github.com/Owner/", "https://github.com/Owner",
            "https://github.com/Owner/Repo/", "https://github.com/Owner/Repo/extra",
            "https://github.com/Own%65r/Repo", "https://github.com/Owner/Re%20po", " https://github.com/Owner/Repo",
            "https://github.com/Owner/Repo ", "https://github.com/Owner/Re po",
            "http://github.com/Owner/Repo", "https://GitHub.com/Owner/Repo", "https://www.github.com/Owner/Repo",
            "https://gitlab.com/Owner/Repo", "git://github.com/Owner/Repo", "file:///srv/Owner/Repo",
            "/srv/repo.git", "https://github.com/Owner/.", "https://github.com/Owner/..", "https://github.com/Owner/.git",
            "https://github.com/o_x/Repo", "https://github.com/" + "a" * 40 + "/Repo",
            "https://github.com/Owner/" + "b" * 101, "https://github.com/Owner/Repo\\x", "", None, 7,
            "https://github.com/Ownér/Repo",
        ]
        for url in bad:
            with self.subTest(url=url):
                self.assertIsNone(md.parse_github_remote(url))

    @NEEDS_GIT
    def test_remote_decision_on_real_repos(self) -> None:
        env = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
        cases = [
            ("plain", dict(), "Owner/Repo"),
            ("ssh", dict(urls=("git@github.com:Owner/Repo.git",)), "Owner/Repo"),
            ("pushurl same repo other case", dict(pushurls=("git@github.com:owner/repo.git",)), "Owner/Repo"),
            ("two pushurls same repo", dict(pushurls=("git@github.com:Owner/Repo.git", "https://github.com/OWNER/REPO")), "Owner/Repo"),
            ("no origin", dict(urls=()), None),
            ("two urls", dict(urls=("https://github.com/Owner/Repo", "https://github.com/Owner/Other")), None),
            ("unsupported url", dict(urls=("https://gitlab.com/Owner/Repo",)), None),
            ("pushurl other repo", dict(pushurls=("https://github.com/Owner/Other",)), None),
            ("pushurl unsupported", dict(pushurls=("https://gitlab.com/Owner/Repo",)), None),
            ("pushurl empty", dict(pushurls=("",)), None),
            ("insteadOf rewrite", dict(extra=(("url.https://evil.example/.insteadOf", "https://github.com/"),)), None),
            ("pushInsteadOf rewrite", dict(extra=(("url.https://github.com/Owner/Other.pushInsteadOf", "https://github.com/Owner/Repo"),)), None),
        ]
        for name, kwargs, expected in cases:
            with self.subTest(case=name):
                _main, wt = make_repo(self, **kwargs)
                with mock.patch.dict(os.environ, env):
                    self.assertEqual(md.github_remote(wt), expected)
        # A failed lookup is unsupported.
        with mock.patch.object(md, "git", side_effect=OSError("no git")):
            self.assertIsNone(md.github_remote(wt))

    def test_fetch_only_rewrite_is_unsupported(self) -> None:
        # C8: get-url differs from the configured value while the push URL is clean.
        url = "https://github.com/Owner/Repo.git"
        answers = {
            ("config", "--no-includes", "--get-all", "remote.origin.url"): (0, url + "\n"),
            ("remote", "get-url", "origin"): (0, "https://evil.example/Owner/Repo.git\n"),
            ("config", "--no-includes", "--get-all", "remote.origin.pushurl"): (1, ""),
            ("remote", "get-url", "--push", "origin"): (0, url + "\n"),
        }

        def fake_git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
            code, out = answers[args]
            return subprocess.CompletedProcess(["git", *args], code, out, "")

        with mock.patch.object(md, "git", side_effect=fake_git):
            self.assertIsNone(md.github_remote(Path("/nonexistent")))
        answers[("remote", "get-url", "origin")] = (0, url + "\n")
        with mock.patch.object(md, "git", side_effect=fake_git):
            self.assertEqual(md.github_remote(Path("/nonexistent")), "Owner/Repo")


@NEEDS_GIT
class TestDispatcherGrant(unittest.TestCase):
    def assert_no_helper_written(self, main: Path, wt: Path) -> None:
        env = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "PATH": os.environ["PATH"]}
        shown = git_run(wt, "config", "--show-origin", "--get-regexp", "^credential", env=env)
        self.assertEqual((shown.returncode, shown.stdout), (1, ""))
        config_text = (main / ".git" / "config").read_text()
        self.assertNotIn("credential", config_text)
        self.assertNotIn("git-credential-ak", config_text)
        for path in (main / ".git" / "worktrees").rglob("*"):
            if path.is_file() and path.name.startswith("config"):
                self.assertNotIn("credential", path.read_text(errors="replace"))

    def test_supported_remote_overlay_on_worker_and_reviewer(self) -> None:
        main, wt = make_repo(self)
        fake = ScriptedBroker(self)
        run = Dispatch(self, wt, fake.path)
        body = run.run()
        mints = [r for r in fake.requests if r["op"] == "mint"]
        self.assertEqual(mints, [{"op": "mint", "task_id": "7", "services": ["openrouter"], "github_repo": "Owner/Repo"}])
        self.assertEqual(fake.ops(), ["health", "mint", "revoke_task"])
        self.assertEqual(len(run.envs), 2)
        expected_overlay = overlay_expected("akp_" + "G" * 43, "http://127.0.0.1:45678")
        expected_overlay.update({"OPENROUTER_API_KEY": "akp_" + "O" * 43,
                                 "OPENROUTER_BASE_URL": "http://127.0.0.1:45678/openrouter"})
        for env, base in zip(run.envs, run.expected_envs):
            self.assertEqual({k: env[k] for k in expected_overlay}, expected_overlay)
            rest = {k: v for k, v in env.items() if k not in expected_overlay}
            self.assertEqual(rest, {k: v for k, v in base.items() if k not in expected_overlay})
        # D7: the overlay comes after build_child_env and after the remote decision.
        self.assertLess(run.events.index("remote"), run.events.index("build_child_env"))
        self.assertLess(run.events.index("build_child_env"), run.events.index("cli"))
        self.assertNotIn(NO_GRANT, body["result"])
        self.assertFalse(body["result"].startswith(PREFIX))
        self.assert_no_helper_written(main, wt)

    def test_inherited_git_config_is_removed(self) -> None:
        # E1, G11, AC5b's inherited-variable assertion.
        _main, wt = make_repo(self)
        fake = ScriptedBroker(self)
        run = Dispatch(self, wt, fake.path, env={
            "GIT_CONFIG_PARAMETERS": "'credential.helper=/inherited'",
            "GIT_CONFIG_KEY_2": "credential.helper", "GIT_CONFIG_VALUE_2": "/inherited",
            "GIT_CONFIG_KEY_7": "x.y", "GIT_CONFIG_VALUE_7": "z",
            "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "/inherited0",
            "MC_CHILD_ENV_ALLOW": "GIT_CONFIG_*",
        })
        run.run(reviewer=None)
        base = run.expected_envs[0]
        self.assertIn("GIT_CONFIG_PARAMETERS", base)  # the allowlist really passes them
        self.assertIn("GIT_CONFIG_KEY_2", base)
        env = run.envs[0]
        for name in ("GIT_CONFIG_PARAMETERS", "GIT_CONFIG_KEY_2", "GIT_CONFIG_VALUE_2", "GIT_CONFIG_KEY_7", "GIT_CONFIG_VALUE_7"):
            self.assertNotIn(name, env)
        self.assertEqual(env["GIT_CONFIG_VALUE_0"], "")
        self.assertEqual(env["GIT_CONFIG_COUNT"], "2")

    def test_unsupported_remote_no_grant_exact_line(self) -> None:
        for urls in (("https://gitlab.com/Owner/Repo.git",), ()):
            with self.subTest(urls=urls):
                main, wt = make_repo(self, urls=urls)
                fake = ScriptedBroker(self)
                run = Dispatch(self, wt, fake.path)
                body = run.run()
                mints = [r for r in fake.requests if r["op"] == "mint"]
                self.assertEqual(mints, [{"op": "mint", "task_id": "7", "services": ["openrouter"]}])
                self.assertEqual(body["result"].count(NO_GRANT), 1)
                self.assertTrue(body["result"].endswith("\n\n" + NO_GRANT))
                for env in run.envs:
                    self.assertEqual(GITHUB_ENV_NAMES & set(env), set())
                    self.assertFalse(any(k.startswith("AK_") for k in env))
                    self.assertFalse(any(k.startswith("GIT_CONFIG_") for k in env))
                self.assert_no_helper_written(main, wt)
        # Without services, an unsupported remote sends no mint at all.
        _main, wt = make_repo(self, urls=("https://gitlab.com/x/y",))
        fake = ScriptedBroker(self)
        run = Dispatch(self, wt, fake.path, services="")
        body = run.run(reviewer=None)
        self.assertEqual(fake.ops(), ["health"])
        self.assertIn(NO_GRANT, body["result"])

    def test_no_github_block_keeps_194_env_and_result(self) -> None:
        # G1, AC7: the broker answers without a github member.
        for services in ("openrouter", ""):
            with self.subTest(services=services):
                _main, wt = make_repo(self)
                fake = ScriptedBroker(self)
                fake.github = ScriptedBroker.MISSING
                run = Dispatch(self, wt, fake.path, services=services)
                body = run.run()
                mints = [r for r in fake.requests if r["op"] == "mint"]
                self.assertEqual(mints[0].get("github_repo"), "Owner/Repo")
                self.assertEqual(body["status"], "done", body)
                self.assertNotIn(NO_GRANT, body["result"])
                self.assertNotIn(PREFIX, body["result"])
                overlay = {"OPENROUTER_API_KEY": "akp_" + "O" * 43, "OPENROUTER_BASE_URL": "http://127.0.0.1:45678/openrouter"} if services else {}
                for env, base in zip(run.envs, run.expected_envs):
                    expected = dict(base)
                    expected.update(overlay)
                    self.assertEqual(env, expected)

    def test_malformed_github_grant_fails_closed(self) -> None:
        # D2, G13, H10.
        good = "akp_" + "G" * 43
        cases = {
            "not object": "akp_x",
            "extra key": {"placeholder": good, "broker_url": "http://127.0.0.1:1", "x": 1},
            "missing url": {"placeholder": good},
            "short placeholder": {"placeholder": "akp_abc", "broker_url": "http://127.0.0.1:1"},
            "long placeholder": {"placeholder": good + "A", "broker_url": "http://127.0.0.1:1"},
            "same as service": {"placeholder": "akp_" + "O" * 43, "broker_url": "http://127.0.0.1:1"},
            "url path": {"placeholder": good, "broker_url": "http://127.0.0.1:1/x"},
            "url host": {"placeholder": good, "broker_url": "http://10.0.0.1:1"},
            "url https": {"placeholder": good, "broker_url": "https://127.0.0.1:1"},
            "url port": {"placeholder": good, "broker_url": "http://127.0.0.1:70000"},
            "url port zero": {"placeholder": good, "broker_url": "http://127.0.0.1:0"},
            "url userinfo": {"placeholder": good, "broker_url": "http://u@127.0.0.1:1"},
            "url query": {"placeholder": good, "broker_url": "http://127.0.0.1:1?x"},
            "null": None,
        }
        for name, grant in cases.items():
            with self.subTest(case=name):
                main, wt = make_repo(self)
                fake = ScriptedBroker(self)
                fake.github = grant
                run = Dispatch(self, wt, fake.path)
                body = run.run()
                self.assertTrue(body["result"].startswith(PREFIX), body["result"])
                self.assertEqual(body["status"], "failed")
                self.assertEqual(run.envs, [])  # no worker, no reviewer
                self.assertEqual(fake.ops(), ["health", "mint", "revoke_task"])
                self.assert_no_helper_written(main, wt)
                for text in [json.dumps(c[1]) for c in run.calls] + run.prints:
                    self.assertNotIn(good, text)
        # The helper itself unusable: also fail closed.
        _main, wt = make_repo(self)
        fake = ScriptedBroker(self)
        run = Dispatch(self, wt, fake.path)
        with mock.patch.object(md, "GITHUB_HELPER", Path("/nonexistent/git-credential-ak")):
            body = run.run()
        self.assertTrue(body["result"].startswith(PREFIX))
        self.assertEqual(run.envs, [])
        with mock.patch.object(md, "GITHUB_HELPER", Path("/tmp/has space/git-credential-ak")):
            with self.assertRaises(md.BrokerUnavailable):
                md._github_helper_path()

    def test_github_required_fails_closed_without_grant(self) -> None:
        # I4: MC_BROKER_GITHUB=required and a supported remote need a valid github member.
        for services in ("openrouter", ""):
            with self.subTest(services=services):
                main, wt = make_repo(self)
                fake = ScriptedBroker(self)
                fake.github = ScriptedBroker.MISSING
                run = Dispatch(self, wt, fake.path, services=services, env={"MC_BROKER_GITHUB": "required"})
                body = run.run()
                self.assertTrue(body["result"].startswith(PREFIX), body["result"])
                self.assertEqual(run.envs, [])
                self.assertEqual(fake.ops(), ["health", "mint", "revoke_task"])
                self.assert_no_helper_written(main, wt)
        # With a grant, required changes nothing.
        _main, wt = make_repo(self)
        fake = ScriptedBroker(self)
        run = Dispatch(self, wt, fake.path, env={"MC_BROKER_GITHUB": "required"})
        body = run.run(reviewer=None)
        self.assertEqual(body["status"], "done", body)
        self.assertEqual(run.envs[0]["AK_GITHUB_REPO"], "Owner/Repo")
        # An unsupported remote keeps the no-grant path even when required.
        _main, wt = make_repo(self, urls=("https://gitlab.com/x/y",))
        fake = ScriptedBroker(self)
        run = Dispatch(self, wt, fake.path, env={"MC_BROKER_GITHUB": "required"})
        body = run.run(reviewer=None)
        self.assertIn(NO_GRANT, body["result"])

    def test_github_setting_other_values_fail_closed(self) -> None:
        for value in ("", "yes", "Required", "required ", "1", "true"):
            with self.subTest(value=value):
                _main, wt = make_repo(self)
                fake = ScriptedBroker(self)
                run = Dispatch(self, wt, fake.path, env={"MC_BROKER_GITHUB": value})
                body = run.run(reviewer=None)
                self.assertTrue(body["result"].startswith(PREFIX), body["result"])
                self.assertIn("MC_BROKER_GITHUB", body["result"])
                self.assertEqual(run.envs, [])
                self.assertEqual(fake.requests, [])
        self.assertFalse(md.broker_github_required({}))
        self.assertTrue(md.broker_github_required({"MC_BROKER_GITHUB": "required"}))

    def test_broker_disabled_changes_nothing(self) -> None:
        _main, wt = make_repo(self)
        run = Dispatch(self, wt, "")
        with mock.patch.object(md, "github_remote", side_effect=AssertionError("remote read")):
            body = run.run(reviewer=None)
        self.assertEqual(run.envs, [run.expected_envs[0]])
        self.assertNotIn(NO_GRANT, body["result"])


@NEEDS_GIT
class TestHelperExclusivity(unittest.TestCase):
    """AC5b (E3): with the exact run_task overlay, the broker helper is the only helper git consults."""

    def test_only_ak_helper_is_invoked(self) -> None:
        main, wt = make_repo(self)
        work = _short_tmp(self)
        log = work / "sentinels.log"
        sentinels = {}
        for name in ("global_generic", "global_github", "local_generic", "local_github"):
            path = work / ("sentinel-" + name)
            path.write_text("#!/bin/sh\necho %s \"$1\" >> %s\necho username=sentinel\necho password=sentinel-%s\n"
                            % (name, log, name))
            os.chmod(path, 0o755)
            sentinels[name] = str(path)
        global_cfg = work / "global.gitconfig"
        global_cfg.write_text("[credential]\n\thelper = %s\n[credential \"https://github.com\"]\n\thelper = %s\n"
                              % (sentinels["global_generic"], sentinels["global_github"]))
        subprocess.run(["git", "-C", str(main), "config", "credential.helper", sentinels["local_generic"]], check=True)
        subprocess.run(["git", "-C", str(main), "config", "credential.https://github.com.helper", sentinels["local_github"]], check=True)
        stub = TokenStub(self)
        fake = ScriptedBroker(self, broker_url=stub.url)
        run = Dispatch(self, wt, fake.path)
        run.run()
        self.assertEqual(len(run.envs), 2)
        for label, env in zip(("worker", "reviewer"), run.envs):
            for case in ("ok", "refused"):
                with self.subTest(env=label, case=case):
                    stub.calls.clear()
                    stub.response = None if case == "ok" else (401, [("Content-Type", "application/json")], b'{"error":"revoked_placeholder"}')
                    if log.exists():
                        log.unlink()
                    fill_env = dict(env)
                    # Test process only, never the overlay: a temporary global config with sentinels.
                    fill_env["GIT_CONFIG_GLOBAL"] = str(global_cfg)
                    self.assertNotIn("GIT_CONFIG_GLOBAL", env)
                    self.assertNotIn("GIT_CONFIG_NOSYSTEM", env)
                    out = subprocess.run(
                        ["git", "credential", "fill"], input="url=https://github.com/Owner/Repo.git\n\n",
                        capture_output=True, text=True, cwd=str(wt), env=fill_env, timeout=60)
                    self.assertFalse(log.exists(), log.read_text() if log.exists() else "")
                    self.assertEqual(len(stub.calls), 1)
                    self.assertEqual(stub.calls[0]["body"], b'{"repository":"Owner/Repo"}')
                    if case == "ok":
                        self.assertEqual(out.returncode, 0, out.stderr)
                        self.assertIn("password=ghs_stubToken\n", out.stdout)
                        self.assertIn("username=x-access-token\n", out.stdout)
                    else:
                        self.assertNotEqual(out.returncode, 0)
                        self.assertNotIn("password=", out.stdout)
                        # git refuses to prompt (GIT_TERMINAL_PROMPT=0); no askpass program runs.
                        self.assertIn("terminal prompts disabled", out.stderr)
        # Without the overlay the sentinels answer: the fixture is live. System config is
        # skipped here so a host keychain helper is never asked; nothing from it is printed.
        if log.exists():
            log.unlink()
        plain = dict(run.expected_envs[0], GIT_CONFIG_GLOBAL=str(global_cfg), GIT_CONFIG_NOSYSTEM="1",
                     GIT_TERMINAL_PROMPT="0")
        out = subprocess.run(["git", "credential", "fill"], input="url=https://github.com/Owner/Repo.git\n\n",
                             capture_output=True, text=True, cwd=str(wt), env=plain, timeout=60)
        self.assertTrue("password=sentinel-" in out.stdout, "sentinel fixture did not answer")
        self.assertTrue(log.exists())


@NEEDS_GIT
class TestEndToEnd(unittest.TestCase):
    """AC6, AC7, C12: real broker, fixture GitHub, real worktree, real helper."""

    def test_full_cycle_leaks_no_key_token_or_placeholder(self) -> None:
        run_broker = GHBroker(self)
        main, wt = make_repo(self)
        fills: list = []

        def worker(cmd: list, cwd: Path, env: dict) -> tuple:
            out = subprocess.run(["git", "credential", "fill"], input="url=https://github.com/Owner/Repo.git\n\n",
                                 capture_output=True, text=True, cwd=str(cwd), env=env, timeout=60)
            fills.append(out)
            return 0, json.dumps({"type": "result", "result": "RESULT: fetched", "is_error": False}), ""

        run = Dispatch(self, wt, run_broker.path, worker=worker, env={"MC_BROKER_GITHUB": "required"})
        body = run.run()
        self.assertEqual(body["status"], "done", body)
        self.assertEqual(fills[0].returncode, 0, (fills[0].stderr, run_broker.log.lines))
        token = "ghs_fixtureToken0001"
        # The helper's protocol output carries the token (D6), separately from the sinks.
        self.assertIn("password=%s\n" % token, fills[0].stdout)
        placeholder = run.envs[0]["AK_GITHUB_PLACEHOLDER"]
        self.assertRegex(placeholder, r"\Aakp_")
        # Revoked at task end: DELETE with the token, and the placeholder no longer works.
        deletes = run_broker.gh.of("delete")
        self.assertEqual([d["headers"]["Authorization"] for d in deletes], ["Bearer " + token])
        self.assertEqual(run_broker.post(placeholder)[0], 401)
        sinks = {
            "api": json.dumps([c[1] for c in run.calls], default=str),
            "ingest": json.dumps(run.ingests, default=str),
            "print": "\n".join(run.prints),
            "ak.broker": "\n".join(run_broker.log.lines),
            "result": body["result"],
        }
        for name, text in sinks.items():
            with self.subTest(sink=name):
                self.assertEqual(key_leaks(text), [])
                self.assertNotIn(token, text)
                self.assertNotIn(placeholder, text)
                self.assertNotIn("Bearer", text)
                self.assertNotIn("Authorization", text)
        for env in run.envs:
            self.assertEqual(key_leaks(json.dumps(env)), [])
        for path in list(wt.rglob("*")) + [main / ".git" / "config"] + list((main / ".git" / "worktrees").rglob("config*")):
            if path.is_file():
                with self.subTest(path=str(path)):
                    self.assertEqual(key_leaks(path.read_text(errors="replace")), [])
                    self.assertNotIn(token, path.read_text(errors="replace"))
        shown = git_run(wt, "config", "--show-origin", "--get-regexp", "^credential",
                        env={"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "PATH": os.environ["PATH"]})
        self.assertEqual(shown.stdout, "")

    def test_real_broker_without_block_and_required_fails_closed(self) -> None:
        # I4: a stale or misconfigured broker (no github block) on a host that requires one.
        run_broker = GHBroker(self, block=False)
        _main, wt = make_repo(self)
        run = Dispatch(self, wt, run_broker.path, env={"MC_BROKER_GITHUB": "required"})
        body = run.run()
        self.assertTrue(body["result"].startswith(PREFIX), body["result"])
        self.assertEqual(run.envs, [])

    def test_real_broker_without_block_is_194(self) -> None:
        run_broker = GHBroker(self, block=False)
        _main, wt = make_repo(self)
        run = Dispatch(self, wt, run_broker.path)
        body = run.run()
        self.assertEqual(body["status"], "done", body)
        self.assertNotIn(NO_GRANT, body["result"])
        for env, base in zip(run.envs, run.expected_envs):
            self.assertEqual(set(env) - set(base), {"OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"})
            self.assertRegex(env["OPENROUTER_API_KEY"], r"\Aakp_")
            self.assertEqual(env["OPENROUTER_BASE_URL"], "http://127.0.0.1:%d/openrouter" % run_broker.port)
            self.assertEqual({k: v for k, v in env.items() if not k.startswith("OPENROUTER_")},
                             {k: v for k, v in base.items() if not k.startswith("OPENROUTER_")})


if __name__ == "__main__":
    unittest.main()
