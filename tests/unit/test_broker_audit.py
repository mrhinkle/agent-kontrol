#!/usr/bin/env python3
"""Broker audit events (#192). Stdlib unittest. Loopback fixtures only.

The ingest endpoint is an in-process fixture server on 127.0.0.1. A guard
refuses every non-loopback connect and name lookup, so nothing here can reach
the real API. Fixture values are not real secrets.
"""
from __future__ import annotations

import ast
import contextlib
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
BROKER = ROOT / "agents" / "broker"
sys.path.insert(0, str(BROKER))
import audit  # noqa: E402
import broker  # noqa: E402

SECRET = "fixture-secret-VALUE-192"
AUDIT_TOKEN = "akc_fixture-audit-token-192"
MC_TOKEN_VALUE = "mc-token-fixture-192-not-akc"
BODY_MARKER = "body-marker 192/&x"
QUERY_MARKER = "query-marker 192/&y"
HEADER_MARKER = "header-marker-192-zz"
ONE_MIB = 1024 * 1024
AGENT = audit.agent_id()
_EVENT = audit.build_event(AGENT, None, None, "GET", (), None, 404, "unknown_service")

_OLD_CONNECT = None
_OLD_GETADDRINFO = None
_BLOCKED_HOSTS: list = []


def _loopback(host: object) -> bool:
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    return host in ("127.0.0.1", "::1", "localhost")


def setUpModule() -> None:
    global _OLD_CONNECT, _OLD_GETADDRINFO
    _OLD_CONNECT = socket.socket.connect
    _OLD_GETADDRINFO = socket.getaddrinfo

    def connect(self: socket.socket, address: object) -> object:
        host = address[0] if isinstance(address, tuple) and address else None
        if isinstance(address, tuple) and not _loopback(host):
            _BLOCKED_HOSTS.append(host)
            raise OSError("guard: non-loopback connect")
        return _OLD_CONNECT(self, address)

    def getaddrinfo(host: object, *args: object, **kwargs: object):
        if not _loopback(host):
            _BLOCKED_HOSTS.append(host)
            raise socket.gaierror(socket.EAI_NONAME, "guard: non-loopback lookup")
        return _OLD_GETADDRINFO(host, *args, **kwargs)

    socket.socket.connect = connect  # type: ignore[assignment]
    socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]
    # Keep the bounded counter line off stderr; tests attach their own capture.
    logging.getLogger("ak.broker.audit").addHandler(logging.NullHandler())


def tearDownModule() -> None:
    socket.socket.connect = _OLD_CONNECT  # type: ignore[assignment]
    socket.getaddrinfo = _OLD_GETADDRINFO  # type: ignore[assignment]


# Fixtures ----------------------------------------------------------------


class Ingest:
    """Fixture ingest server. ``mode`` picks the answer; every request is recorded."""

    def __init__(self, mode: str = "ok", delay: float = 0.0) -> None:
        self.mode = mode
        self.delay = delay
        self.requests: list = []
        self.cond = threading.Condition()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: object) -> None:
                return

            def do_POST(self) -> None:
                outer._handle(self)

            def do_GET(self) -> None:
                outer._handle(self)

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            block_on_close = False

            def handle_error(self, *_args: object) -> None:
                return

        self.httpd = Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length", "0") or "0")
        body = handler.rfile.read(length) if length else b""
        with self.cond:
            self.requests.append({
                "method": handler.command,
                "path": handler.path,
                "headers": list(handler.headers.items()),
                "body": body,
            })
            self.cond.notify_all()
        mode = self.mode
        if mode == "drop":
            handler.close_connection = True
            return
        if mode == "slow":
            time.sleep(self.delay)
        if mode == "trickle":
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", "40")
            handler.end_headers()
            try:
                for _ in range(40):
                    handler.wfile.write(b" ")
                    handler.wfile.flush()
                    time.sleep(0.1)
            except OSError:
                pass
            return
        status, payload, extra = {
            "ok": (200, b'{"ok":true}', []),
            "slow": (200, b'{"ok":true}', []),
            "500": (500, b'{"error":"x"}', []),
            "redirect": (302, b"", [("Location", "/elsewhere")]),
            "text": (200, b"not json", []),
            "array": (200, b"[]", []),
        }[mode]
        handler.send_response(status)
        for name, value in extra:
            handler.send_header(name, value)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)

    def wait(self, count: int, timeout: float = 5.0) -> bool:
        with self.cond:
            return self.cond.wait_for(lambda: len(self.requests) >= count, timeout)

    def events(self) -> list:
        return [json.loads(item["body"].decode("utf-8")) for item in self.requests]

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class Blackhole:
    """Accepts TCP connections in the kernel backlog and never answers."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.sock.getsockname()[1]

    def close(self) -> None:
        self.sock.close()


class Clock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


class ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


class Scripted:
    def __init__(self, status: int, chunks: list) -> None:
        payload = b"".join(chunks)
        self.status = status
        self.headers = [("Content-Type", "text/plain"), ("Content-Length", str(len(payload)))]
        self._chunks = [payload] if payload else []

    def read_chunk(self, _max: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


class Recorder:
    def __init__(self) -> None:
        self.status = 200
        self.chunks = [b"ok"]
        self.fail: BaseException | None = None
        self.calls: list = []

    def factory(self, _service: dict, _timeout: object) -> object:
        recorder = self

        class Conn:
            def request(self, method: str, target: str, headers: list, body_chunks: object) -> Scripted:
                if recorder.fail is not None:
                    raise recorder.fail
                body = b"".join(piece for piece in body_chunks if piece)
                recorder.calls.append({"method": method, "target": target, "headers": headers, "body": body})
                return Scripted(recorder.status, recorder.chunks)

            def close(self) -> None:
                return

        return Conn()


def _write(path: Path, data: str) -> None:
    path.write_bytes(data.encode("utf-8"))
    os.chmod(path, 0o600)


def _provider_tree(root: Path, values: dict) -> str:
    secret = root / "secrets.env"
    _write(secret, "".join("%s=%s\n" % item for item in values.items()))
    config = root / "providers.json"
    _write(config, json.dumps({"file": {"lanes": str(secret)}}))
    return str(config)


def _service(**overrides: object) -> dict:
    data = {
        "name": "openrouter",
        "upstream": "https://openrouter.ai",
        "header": "Authorization",
        "template": "Bearer {secret}",
        "secret": "secretref://file/lanes/KEY",
        "methods": ["GET", "POST"],
        "path_prefixes": ["/api/v1/"],
        "env_key": "AK_OPENROUTER_KEY",
        "env_base_url": "AK_OPENROUTER_BASE_URL",
    }
    data.update(overrides)
    return data


def _config(providers: str, port: int = 0, **overrides: object) -> dict:
    data = {
        "admin_socket": os.path.join(os.path.dirname(providers), "admin.sock"),
        "bind": "127.0.0.1",
        "port": port,
        "providers": providers,
        "placeholder_ttl_seconds": 3600,
        "upstream_timeout_seconds": 60,
        "max_request_body_bytes": ONE_MIB,
        "services": [_service()],
    }
    data.update(overrides)
    return data


def _audit_block(url: str) -> dict:
    return {"url": url, "token": "secretref://file/lanes/AUDIT"}


class Harness:
    def __init__(self, test: unittest.TestCase, audit_url: str | None = None, token: str = AUDIT_TOKEN, **overrides: object) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="ak-audit-"))
        test.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.providers = _provider_tree(self.root, {"KEY": SECRET, "AUDIT": token})
        self.recorder = Recorder()
        self.clock = Clock()
        self.store = broker.PlaceholderStore(clock=self.clock)
        self.config = _config(self.providers, **overrides)
        if audit_url is not None:
            self.config["audit"] = _audit_block(audit_url)
        self.server = broker.BrokerServer(self.config, self.store, self.recorder.factory)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        test.addCleanup(self.stop)
        self.port = self.server.bound_port

    @property
    def auditor(self) -> object:
        return self.server._state.audit

    def stop(self) -> None:
        self.server.shutdown()
        self.thread.join(5)

    def mint(self, task: str = "task-192") -> str:
        return self.store.mint(task, ["openrouter"])["openrouter"]

    def send(self, payload: bytes, timeout: float = 5.0) -> bytes:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=timeout)
        try:
            sock.sendall(payload)
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            data = b""
            while True:
                try:
                    block = sock.recv(65536)
                except ConnectionResetError:
                    # Linux reports a close with unread data as a reset, not EOF.
                    break
                if not block:
                    break
                data += block
            return data
        finally:
            sock.close()


def _request(method: str, target: str, headers: list, body: bytes | None = None) -> bytes:
    lines = ["%s %s HTTP/1.1" % (method, target), "Host: 127.0.0.1"]
    lines.extend("%s: %s" % item for item in headers)
    if body is not None:
        lines.append("Content-Length: %d" % len(body))
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + (body or b"")


def _status(raw: bytes) -> int | None:
    match = re.match(rb"HTTP/1\.[01] (\d{3}) ", raw)
    return int(match.group(1)) if match else None


def _event(kind: str, task_id: object, service: object, method: str, prefix: object, status: object, reason: object) -> dict:
    return {
        "agent_id": AGENT,
        "platform": "other",
        "kind": kind,
        "detail": {
            "task_id": task_id,
            "service": service,
            "method": method,
            "path_prefix": prefix,
            "status": status,
            "reason": reason,
        },
    }


F = audit.KIND_FORWARDED
R = audit.KIND_REFUSED


def _strings(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


# AC1 / C10: exact events ---------------------------------------------------

# Each row: name, broker overrides, trusted context, request, upstream setup,
# the broker's response status, and the complete expected audit JSON.
# "ctx" is "valid" (a live placeholder for task-192), "expired", "revoked",
# "none" (no placeholder), "unknown" (an akp_ value the store never minted),
# or "no_task" (valid placeholder, store returns no task: C8 defensive row).
AC1_ROWS = [
    ("forwarded_200", {}, "valid", ("GET", "/openrouter/api/v1/models?q=1", None), {}, 200,
     _event(F, "task-192", "openrouter", "GET", "/api/v1/", 200, None)),
    ("forwarded_upstream_500", {}, "valid", ("POST", "/openrouter/api/v1/chat", b"{}"), {"status": 500}, 500,
     _event(F, "task-192", "openrouter", "POST", "/api/v1/", 500, "upstream_error")),
    ("forwarded_upstream_404_is_not_a_refusal", {}, "valid", ("GET", "/openrouter/api/v1/x", None), {"status": 404}, 404,
     _event(F, "task-192", "openrouter", "GET", "/api/v1/", 404, None)),
    ("broker_502_upstream_error", {}, "valid", ("GET", "/openrouter/api/v1/x", None), {"fail": OSError("down")}, 502,
     _event(F, "task-192", "openrouter", "GET", "/api/v1/", 502, "upstream_error")),
    ("secret_in_response", {}, "valid", ("GET", "/openrouter/api/v1/x", None), {"chunks": [b"leak:" + SECRET.encode()]}, 200,
     _event(F, "task-192", "openrouter", "GET", "/api/v1/", 200, "secret_in_response")),
    ("refused_401_bad_placeholder", {}, "unknown", ("GET", "/openrouter/api/v1/x", None), {}, 401,
     _event(R, None, "openrouter", "GET", None, 401, "bad_placeholder")),
    ("refused_401_missing_placeholder", {}, "none", ("GET", "/openrouter/api/v1/x", None), {}, 401,
     _event(R, None, "openrouter", "GET", None, 401, "missing_placeholder")),
    ("refused_401_expired", {}, "expired", ("GET", "/openrouter/api/v1/x", None), {}, 401,
     _event(R, None, "openrouter", "GET", None, 401, "expired_placeholder")),
    ("refused_401_revoked", {}, "revoked", ("GET", "/openrouter/api/v1/x", None), {}, 401,
     _event(R, None, "openrouter", "GET", None, 401, "revoked_placeholder")),
    ("refused_401_missing_task_context", {}, "no_task", ("GET", "/openrouter/api/v1/x", None), {}, 401,
     _event(R, None, "openrouter", "GET", None, 401, "missing_task_context")),
    ("refused_403_path_not_allowed", {}, "valid", ("GET", "/openrouter/admin/keys?x=1", None), {}, 403,
     _event(R, "task-192", "openrouter", "GET", None, 403, "path_not_allowed")),
    ("refused_403_method_not_allowed_is_OTHER", {}, "valid", ("DELETE", "/openrouter/api/v1/x", None), {}, 403,
     _event(R, "task-192", "openrouter", "OTHER", None, 403, "method_not_allowed")),
    ("refused_403_lowercase_method_is_OTHER", {}, "valid", ("get", "/openrouter/api/v1/x", None), {}, 403,
     _event(R, "task-192", "openrouter", "OTHER", None, 403, "method_not_allowed")),
    ("refused_404_unknown_service", {}, "valid", ("GET", "/nope/api/v1/x?y=2", None), {}, 404,
     _event(R, None, None, "OTHER", None, 404, "unknown_service")),
    ("refused_400_bad_request", {}, "valid", ("GET", "/openrouter/../x", None), {}, 400,
     _event(R, None, None, "OTHER", None, 400, "bad_request")),
    ("refused_413_body_too_large_A1", {"max_request_body_bytes": 100}, "valid", ("POST", "/openrouter/api/v1/x", b"a" * 101), {}, 413,
     _event(R, "task-192", "openrouter", "POST", "/api/v1/", 413, "body_too_large")),
]


class AuditEventTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ingest = Ingest()
        self.addCleanup(self.ingest.close)
        del _BLOCKED_HOSTS[:]

    def _run_row(self, row: tuple) -> tuple:
        name, overrides, ctx, (method, target, body), upstream, want_status, want_event = row
        harness = Harness(self, audit_url=self.ingest.url, **overrides)
        for key, value in upstream.items():
            setattr(harness.recorder, key, value)
        headers = []
        if ctx in ("valid", "expired", "revoked", "no_task"):
            headers.append(("Authorization", "Bearer " + harness.mint()))
        elif ctx == "unknown":
            headers.append(("Authorization", "Bearer akp_" + "Q" * 43))
        if ctx == "expired":
            harness.clock.now += 3600
        if ctx == "revoked":
            harness.store.revoke_task("task-192")
        before = len(self.ingest.requests)
        if ctx == "no_task":
            with mock.patch.object(harness.store, "task_of", return_value=None):
                raw = harness.send(_request(method, target, headers, body))
        else:
            raw = harness.send(_request(method, target, headers, body))
        self.assertTrue(self.ingest.wait(before + 1), name)
        time.sleep(0.05)
        return raw, self.ingest.requests[before:], want_status, want_event

    def test_ac1_exact_event_table(self) -> None:
        for row in AC1_ROWS:
            with self.subTest(row=row[0]):
                raw, posts, want_status, want_event = self._run_row(row)
                self.assertEqual(_status(raw), want_status)
                self.assertEqual(len(posts), 1)
                self.assertEqual(json.loads(posts[0]["body"].decode("utf-8")), want_event)

    def test_ac1_post_shape_and_bearer(self) -> None:
        raw, posts, _status_code, _event_obj = self._run_row(AC1_ROWS[0])
        post = posts[0]
        self.assertEqual(post["method"], "POST")
        self.assertEqual(post["path"], "/api/ingest")
        headers = {name.lower(): value for name, value in post["headers"]}
        self.assertEqual(headers["authorization"], "Bearer " + AUDIT_TOKEN)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertNotIn(AUDIT_TOKEN.encode(), raw)

    def test_a2_mid_upload_abort_has_null_status(self) -> None:
        harness = Harness(self, audit_url=self.ingest.url, max_request_body_bytes=100)
        placeholder = harness.mint()
        payload = (
            "POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            "Authorization: Bearer %s\r\nTransfer-Encoding: chunked\r\n\r\n"
            "3c\r\n%s\r\n3c\r\n%s\r\n0\r\n\r\n" % (placeholder, "a" * 60, "b" * 60)
        ).encode("ascii")
        raw = harness.send(payload)
        self.assertIsNone(_status(raw))
        self.assertTrue(self.ingest.wait(1))
        self.assertEqual(
            self.ingest.events()[0],
            _event(R, "task-192", "openrouter", "POST", "/api/v1/", None, "body_too_large"),
        )

    def test_catch_all_path_keeps_matched_service(self) -> None:
        harness = Harness(self, audit_url=self.ingest.url)
        placeholder = harness.mint()
        with mock.patch.object(broker, "_forward", side_effect=RuntimeError("injected")):
            raw = harness.send(_request("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]))
        self.assertEqual(_status(raw), 502)
        self.assertTrue(self.ingest.wait(1))
        self.assertEqual(
            self.ingest.events()[0],
            _event(F, "task-192", "openrouter", "GET", "/api/v1/", 502, "upstream_error"),
        )

    def test_task_id_only_from_store(self) -> None:
        harness = Harness(self, audit_url=self.ingest.url)
        placeholder = harness.mint("task-from-store")
        evil = [
            ("Authorization", "Bearer " + placeholder),
            ("X-Task-Id", "task-from-header"),
            ("X-AK-Task", "task-from-header"),
            ("Task-Id", "task-from-header"),
        ]
        body = b'{"task_id":"task-from-body"}'
        for target in ("/openrouter/api/v1/x?task_id=task-from-query", "/openrouter/admin?task_id=task-from-query"):
            harness.send(_request("POST", target, evil, body))
        harness.send(_request("POST", "/openrouter/api/v1/x?task_id=task-from-query", evil[1:], body))
        self.assertTrue(self.ingest.wait(3))
        ids = [event["detail"]["task_id"] for event in self.ingest.events()]
        self.assertEqual(ids, ["task-from-store", "task-from-store", None])


# AC2: allowed keys and no leaked values ------------------------------------


class AuditLeakTests(unittest.TestCase):
    def test_ac2_keys_and_recursive_walk(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        harness = Harness(self, audit_url=ingest.url)
        placeholder = harness.mint()
        harness.recorder.chunks = [b"upstream says " + SECRET.encode()]
        q = urllib.parse.quote(QUERY_MARKER, safe="")
        targets = [
            "/openrouter/api/v1/chat?m=" + q,
            "/openrouter/elsewhere/" + urllib.parse.quote(BODY_MARKER, safe="&/") + "?m=" + q,
            "/unknown-svc/api/v1/chat?m=" + q,
            "/openrouter/api/v1/chat?leak=" + placeholder,
        ]
        sent_headers = []
        count = 0
        for target in targets:
            for auth in (placeholder, "akp_" + "Z" * 43):
                headers = [
                    ("Authorization", "Bearer " + auth),
                    ("X-Marker", HEADER_MARKER),
                    ("User-Agent", "agent-ua-marker-192"),
                    ("Content-Type", "text/x-marker-192"),
                ]
                sent_headers.extend(headers)
                body = ("payload " + BODY_MARKER).encode("ascii")
                harness.send(_request("POST", target, headers, body))
                count += 1
        self.assertTrue(ingest.wait(count))
        time.sleep(0.1)
        self.assertEqual(len(ingest.requests), count)
        forbidden = {
            "fixture secret": SECRET,
            "placeholder": placeholder,
            "audit token": AUDIT_TOKEN,
            "body marker": BODY_MARKER,
            "query marker": QUERY_MARKER,
            "encoded body marker": urllib.parse.quote(BODY_MARKER, safe=""),
            "encoded body marker (path form)": urllib.parse.quote(BODY_MARKER, safe="&/"),
            "encoded query marker": q,
            "encoded query marker (plus form)": urllib.parse.quote_plus(QUERY_MARKER),
        }
        # Content-Length is a number the broker regenerates; every other value is checked.
        # One entry per value: a shared key would keep only the last value.
        for index, (name, value) in enumerate(sent_headers + [("Host", "127.0.0.1")]):
            forbidden["header %s #%d" % (name, index)] = value
        for index, target in enumerate(targets):
            forbidden["full target #%d" % index] = target
            forbidden["full path #%d" % index] = target.split("?", 1)[0]
        for post in ingest.requests:
            event = json.loads(post["body"].decode("utf-8"))
            self.assertEqual(list(event), list(audit.TOP_KEYS))
            self.assertEqual(list(event["detail"]), list(audit.DETAIL_KEYS))
            for text in _strings(event):
                self.assertNotIn("://", text)
                self.assertNotIn("?", text)
                for label, needle in forbidden.items():
                    if needle in text:
                        self.fail("%s appeared in an audit event" % label)
            raw_body = post["body"].decode("utf-8")
            for label, needle in forbidden.items():
                if needle in raw_body:
                    self.fail("%s appeared in a raw audit body" % label)
        kinds = {json.loads(post["body"])["detail"]["reason"] for post in ingest.requests}
        self.assertIn("secret_in_response", kinds)
        self.assertIn("placeholder_leak", kinds)
        self.assertIn("unknown_service", kinds)
        self.assertIn("path_not_allowed", kinds)

    def test_ac2_audit_log_lines_carry_no_values(self) -> None:
        auditor = audit.Auditor("http://127.0.0.1:9", AUDIT_TOKEN, clock=Clock())
        cap = ListHandler()
        log = logging.getLogger("ak.broker.audit")
        log.addHandler(cap)
        self.addCleanup(log.removeHandler, cap)
        auditor._bump("delivery_failed")
        auditor.maybe_log()
        self.assertEqual(len(cap.lines), 1)
        self.assertEqual(json.loads(cap.lines[0]), {"audit": "degraded", "dropped_full": 0, "delivery_failed": 1})
        self.assertNotIn(AUDIT_TOKEN, cap.lines[0])
        self.assertNotIn("127.0.0.1", cap.lines[0])


# Counting: one event per answered request, zero without the block ----------


class AuditCountTests(unittest.TestCase):
    def _mixed(self, harness: Harness) -> int:
        placeholder = harness.mint()
        requests = [
            _request("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]),
            _request("GET", "/openrouter/nope", [("Authorization", "Bearer " + placeholder)]),
            _request("GET", "/nope/x", []),
            _request("GET", "/openrouter/api/v1/x", []),
            b"BROKEN\r\n\r\n",
        ]
        for payload in requests:
            harness.send(payload)
        # A connection closed before any request line is not answered.
        sock = socket.create_connection(("127.0.0.1", harness.port), timeout=2)
        sock.close()
        return len(requests)

    def test_one_event_per_answered_request(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        harness = Harness(self, audit_url=ingest.url)
        expected = self._mixed(harness)
        self.assertTrue(ingest.wait(expected))
        time.sleep(0.5)
        self.assertEqual(len(ingest.requests), expected)
        self.assertEqual(harness.auditor.stats()["sent"], expected)

    def test_zero_events_without_audit_block(self) -> None:
        with mock.patch.object(audit.Auditor, "record") as record, mock.patch.object(audit.Auditor, "start") as start:
            harness = Harness(self)
            self.assertIsNone(harness.auditor)
            self._mixed(harness)
            time.sleep(0.2)
        self.assertEqual(record.call_count, 0)
        self.assertEqual(start.call_count, 0)
        self.assertFalse(any(t.name == "ak-broker-audit" for t in threading.enumerate()))


# AC3: config and the agent-credential-only token ---------------------------


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class AuditConfigTests(unittest.TestCase):
    def test_block_validation(self) -> None:
        good = {"url": "https://ak.example.com", "token": "secretref://file/lanes/AUDIT"}
        self.assertEqual(audit.check_block(good), good)
        self.assertEqual(audit.check_block(dict(good, url="http://127.0.0.1:3000"))["url"], "http://127.0.0.1:3000")
        bad = [
            None, [], {}, {"url": good["url"]}, {"token": good["token"]}, dict(good, extra=1),
            dict(good, url="https://ak.example.com/"), dict(good, url="https://ak.example.com/api"),
            dict(good, url="https://ak.example.com?x=1"), dict(good, url="https://ak.example.com#f"),
            dict(good, url="ftp://ak.example.com"), dict(good, url="https://u:p@ak.example.com"),
            dict(good, url="https://ak.example.com:99999"), dict(good, url="https://"), dict(good, url=" https://a.b"),
            dict(good, url="https://a.b\r\nX: y"), dict(good, url=7), dict(good, token=AUDIT_TOKEN),
            dict(good, token="env://MC_TOKEN"), dict(good, token=None),
        ]
        for value in bad:
            with self.subTest(value=value):
                with self.assertRaises(ValueError) as caught:
                    audit.check_block(value)
                self.assertEqual(str(caught.exception), "invalid broker config: audit")
                self.assertNotIn(AUDIT_TOKEN, str(caught.exception))

    def test_validate_config_accepts_optional_block(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="ak-audit-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        base = _config(_provider_tree(root, {"KEY": SECRET, "AUDIT": AUDIT_TOKEN}))
        self.assertNotIn("audit", broker.validate_config(base, port_zero_ok=True))
        with_block = dict(base, audit=_audit_block("https://ak.example.com"))
        checked = broker.validate_config(with_block, port_zero_ok=True)
        self.assertEqual(checked["audit"]["url"], "https://ak.example.com")
        # A validated config validates again unchanged (BrokerServer re-checks it).
        self.assertEqual(broker.validate_config(checked, port_zero_ok=True), checked)
        example = json.loads((BROKER / "config.example.json").read_text())
        self.assertIn("audit", broker.validate_config(example))

    def test_resolve_token_requires_akc(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="ak-audit-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        values = {"GOOD": AUDIT_TOKEN, "MC": MC_TOKEN_VALUE, "BARE": "akc_", "SK": "sk-other-192", "UPPER": "AKC_x192"}
        providers_path = _provider_tree(root, values)
        self.assertEqual(audit.resolve_token("secretref://file/lanes/GOOD", providers_path), AUDIT_TOKEN)
        for key in ("MC", "BARE", "SK", "UPPER"):
            with self.subTest(key=key):
                with self.assertRaises(ValueError) as caught:
                    audit.resolve_token("secretref://file/lanes/%s" % key, providers_path)
                self.assertEqual(str(caught.exception), audit.TOKEN_ERROR)
                self.assertNotIn(values[key], str(caught.exception))
        with mock.patch.dict(os.environ, {"MC_TOKEN": AUDIT_TOKEN, "AK_BROKER_AUDIT_TOKEN": AUDIT_TOKEN}):
            with self.assertRaises(ValueError):
                audit.resolve_token("secretref://file/lanes/MISSING", providers_path)

    def _run_cli(self, block: object, token_value: str, ingest: Ingest) -> tuple:
        root = Path(tempfile.mkdtemp(prefix="ak-audit-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        providers_path = _provider_tree(root, {"KEY": SECRET, "AUDIT": token_value})
        port = _free_port()
        config = _config(providers_path, port=port)
        if block is not None:
            config["audit"] = block
        path = root / "broker.json"
        _write(path, json.dumps(config))
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "MC_TOKEN": MC_TOKEN_VALUE,
            "AK_BROKER_AUDIT_TOKEN": AUDIT_TOKEN,
            "AK_AUDIT_TOKEN": AUDIT_TOKEN,
        }
        proc = subprocess.run(
            [sys.executable, str(BROKER / "broker.py"), "--config", str(path)],
            cwd=str(ROOT), env=env, capture_output=True, timeout=30,
        )
        with self.assertRaises(OSError):
            probe = socket.create_connection(("127.0.0.1", port), timeout=0.5)
            probe.close()
        return proc, ingest.requests

    def test_ac3_cli_startup_failures(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        good_ref = "secretref://file/lanes/AUDIT"
        cases = [
            ("url_with_path", {"url": ingest.url + "/api", "token": good_ref}, AUDIT_TOKEN, "invalid broker config"),
            ("url_with_query", {"url": ingest.url + "?a=1", "token": good_ref}, AUDIT_TOKEN, "invalid broker config"),
            ("url_with_fragment", {"url": ingest.url + "#f", "token": good_ref}, AUDIT_TOKEN, "invalid broker config"),
            ("url_ftp", {"url": "ftp://127.0.0.1", "token": good_ref}, AUDIT_TOKEN, "invalid broker config"),
            ("literal_token", {"url": ingest.url, "token": AUDIT_TOKEN}, AUDIT_TOKEN, "invalid broker config"),
            ("no_token_env_fallback", {"url": ingest.url}, AUDIT_TOKEN, "invalid broker config"),
            ("mc_token_value", {"url": ingest.url, "token": good_ref}, MC_TOKEN_VALUE, audit.TOKEN_ERROR),
            ("other_value", {"url": ingest.url, "token": good_ref}, "sk-other-value-192", audit.TOKEN_ERROR),
        ]
        for name, block, value, message in cases:
            with self.subTest(case=name):
                proc, seen = self._run_cli(block, value, ingest)
                out = proc.stdout.decode("utf-8", "replace")
                err = proc.stderr.decode("utf-8", "replace")
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn(message, err)
                self.assertEqual(seen, [])
                for needle in {value, AUDIT_TOKEN, MC_TOKEN_VALUE, SECRET}:
                    for part in (needle, needle[4:], needle[-12:]):
                        self.assertNotIn(part, out)
                        self.assertNotIn(part, err)
        self.assertEqual(ingest.requests, [])

    def test_ac3_redirect_not_followed_and_exact_path(self) -> None:
        ingest = Ingest(mode="redirect")
        self.addCleanup(ingest.close)
        auditor = audit.Auditor(ingest.url, AUDIT_TOKEN)
        self.assertFalse(auditor._deliver(_EVENT))
        time.sleep(0.2)
        self.assertEqual([item["path"] for item in ingest.requests], ["/api/ingest"])

    def test_audit_module_imports_and_tls(self) -> None:
        text = (BROKER / "audit.py").read_text()
        for banned in ("CERT_NONE", "CERT_OPTIONAL", "_create_unverified_context", "check_hostname", "os.environ", "getenv", "MC_TOKEN"):
            self.assertNotIn(banned, text)
        allowed = {
            "__future__", "http", "json", "logging", "queue", "socket", "ssl", "threading", "time", "urllib",
            "providers", "refs",
        }
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertIn(alias.name.split(".")[0], allowed)
            elif isinstance(node, ast.ImportFrom):
                self.assertIn((node.module or "").split(".")[0], allowed)
        auditor = audit.Auditor("https://ak.example.com", AUDIT_TOKEN)
        self.assertEqual(auditor._ssl.verify_mode, __import__("ssl").CERT_REQUIRED)
        self.assertIs(auditor._ssl.check_hostname, True)


# AC4: delivery never delays the request path -------------------------------


def _wait_until(predicate: object, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


class AuditDeliveryTests(unittest.TestCase):
    def setUp(self) -> None:
        del _BLOCKED_HOSTS[:]

    def test_constants(self) -> None:
        self.assertEqual(audit.QUEUE_MAX, 1000)
        self.assertEqual(audit.TIMEOUT_SECONDS, 5.0)
        auditor = audit.Auditor("http://127.0.0.1:9", AUDIT_TOKEN)
        self.assertEqual(auditor._timeout, 5.0)
        self.assertEqual(auditor._queue.maxsize, 1000)

    def test_full_queue_drops_and_counts(self) -> None:
        auditor = audit.Auditor("http://127.0.0.1:9", AUDIT_TOKEN)
        for _ in range(1000):
            auditor.record(None, None, "GET", (), None, 404, "unknown_service")
        # The enqueue attempt on a full queue returns at once: it never waits for room.
        started = time.monotonic()
        auditor.record(None, None, "GET", (), None, 404, "unknown_service")
        self.assertLess(time.monotonic() - started, 0.05)
        self.assertEqual(auditor.stats(), {"queued": 1000, "sent": 0, "dropped_full": 1, "delivery_failed": 0})
        auditor.reset_stats()
        self.assertEqual(auditor.stats(), {"queued": 1000, "sent": 0, "dropped_full": 0, "delivery_failed": 0})

    def test_ac4_blocked_fixture_never_delays_requests(self) -> None:
        # Baseline: the same requests with the audit off.
        base = Harness(self)
        base_placeholder = base.mint()
        baseline = 0.0
        for index in range(20):
            if index % 2:
                payload = _request("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + base_placeholder)])
            else:
                payload = _request("GET", "/nope/x", [])
            started = time.monotonic()
            base.send(payload)
            baseline = max(baseline, time.monotonic() - started)
        base.stop()
        hole = Blackhole()
        self.addCleanup(hole.close)
        harness = Harness(self, audit_url=hole.url)
        placeholder = harness.mint()
        # Hold the in-flight delivery for the whole loop so no slot frees up
        # mid-fill. The 5-second default is asserted in test_constants.
        harness.auditor._timeout = 60.0
        # Observe (not replace) delivery so the test knows the worker is busy.
        in_flight = threading.Event()
        real_deliver = harness.auditor._deliver

        def observed(event: dict) -> bool:
            in_flight.set()
            return real_deliver(event)

        harness.auditor._deliver = observed  # type: ignore[assignment]
        # The worker takes this one and blocks on the silent endpoint.
        harness.send(_request("GET", "/nope/x", []))
        self.assertTrue(in_flight.wait(5))
        durations = []
        for index in range(1001):
            if index % 100 == 0:
                payload = _request("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)])
            else:
                payload = _request("GET", "/nope/x", [])
            started = time.monotonic()
            raw = harness.send(payload)
            durations.append(time.monotonic() - started)
            self.assertIsNotNone(_status(raw))
        # Each event is enqueued after its response closes, so let the last ones land.
        settled = _wait_until(lambda: sum(harness.auditor.stats()[k] for k in ("queued", "dropped_full")) == 1001)
        stats = harness.auditor.stats()
        self.assertTrue(settled, stats)
        self.assertGreater(stats["dropped_full"], 0, stats)
        self.assertEqual(stats["queued"], 1000, stats)
        slowest = max(durations)
        self.assertLess(slowest, 2.0)
        self.assertLessEqual(slowest, baseline + 0.1, "slowest %.3fs baseline %.3fs" % (slowest, baseline))
        started = time.monotonic()
        harness.stop()
        self.assertLess(time.monotonic() - started, 2.0)

    def _auditor_against(self, ingest: Ingest, **kwargs: object) -> audit.Auditor:
        auditor = audit.Auditor(ingest.url, AUDIT_TOKEN, **kwargs)
        auditor.start()
        self.addCleanup(auditor.close)
        return auditor

    def _one(self, auditor: audit.Auditor) -> None:
        auditor.record("t", "openrouter", "GET", ("GET",), "/api/v1/", 200, "-")

    def test_failure_modes_drop_and_count(self) -> None:
        for mode in ("500", "redirect", "text", "array", "drop"):
            with self.subTest(mode=mode):
                ingest = Ingest(mode=mode)
                self.addCleanup(ingest.close)
                auditor = self._auditor_against(ingest)
                self._one(auditor)
                self.assertTrue(_wait_until(lambda: auditor.stats()["delivery_failed"] == 1))
                time.sleep(0.3)
                # No retry: the fixture saw exactly one POST.
                self.assertEqual(len(ingest.requests), 1)
                self.assertEqual(auditor.stats()["sent"], 0)

    def test_dns_and_connection_failures(self) -> None:
        refused = "http://127.0.0.1:%d" % _free_port()
        for url in ("http://audit-dns-failure.invalid", refused):
            with self.subTest(url=url):
                auditor = audit.Auditor(url, AUDIT_TOKEN)
                auditor.start()
                self.addCleanup(auditor.close)
                self._one(auditor)
                self.assertTrue(_wait_until(lambda: auditor.stats()["delivery_failed"] == 1))
                self.assertEqual(auditor.stats()["sent"], 0)
        self.assertIn("audit-dns-failure.invalid", _BLOCKED_HOSTS)

    def test_timeout_covers_headers_and_body(self) -> None:
        for mode in ("slow", "trickle"):
            with self.subTest(mode=mode):
                ingest = Ingest(mode=mode, delay=3.0)
                self.addCleanup(ingest.close)
                auditor = audit.Auditor(ingest.url, AUDIT_TOKEN, timeout=0.6)
                started = time.monotonic()
                ok = auditor._deliver(_EVENT)
                elapsed = time.monotonic() - started
                self.assertFalse(ok)
                # One deadline for the whole exchange, not a fresh timeout per read.
                self.assertLess(elapsed, 1.5)

    def _network(self, addresses: list, behaviour: dict) -> tuple:
        """Patch name lookup and connect. ``addresses`` are loopback ports in lookup order.

        ``behaviour`` maps a port to ``("slow", s)`` (connect after s seconds),
        ``("refuse", s)`` (refused after s seconds) or ``("hole",)`` (silent
        until the socket's own timeout). Other ports connect normally.
        """
        real_connect = socket.socket.connect
        attempts: list = []
        sockets: list = []

        def connect(sock: socket.socket, address: object) -> object:
            port = address[1]
            kind = behaviour.get(port, ("real",))
            attempts.append(port)
            sockets.append(sock)
            if kind[0] == "hole":
                time.sleep(sock.gettimeout() or 0)
                raise socket.timeout("blackhole")
            if kind[0] == "refuse":
                time.sleep(kind[1])
                raise ConnectionRefusedError("refused")
            if kind[0] == "slow":
                time.sleep(kind[1])
            return real_connect(sock, address)

        def getaddrinfo(_host: object, _port: object, *_args: object, **_kwargs: object) -> list:
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)) for port in addresses]

        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(socket.socket, "connect", connect))
        stack.enter_context(mock.patch.object(audit.socket, "getaddrinfo", getaddrinfo))
        return stack, attempts, sockets

    def _timed(self, url: str, addresses: list, behaviour: dict, timeout: float = 0.6) -> tuple:
        auditor = audit.Auditor(url, AUDIT_TOKEN, timeout=timeout)
        stack, attempts, sockets = self._network(addresses, behaviour)
        with stack:
            started = time.monotonic()
            ok = auditor._deliver(_EVENT)
            elapsed = time.monotonic() - started
        return ok, elapsed, attempts, sockets

    def test_one_deadline_covers_slow_connect_then_slow_response(self) -> None:
        ingest = Ingest(mode="slow", delay=3.0)
        self.addCleanup(ingest.close)
        port = ingest.httpd.server_address[1]
        ok, elapsed, _attempts, _sockets = self._timed(ingest.url, [port], {port: ("slow", 0.45)})
        self.assertFalse(ok)
        self.assertLess(elapsed, 0.6 + 0.2)

    def test_one_deadline_covers_slow_connect_then_tls_handshake(self) -> None:
        # The listener completes TCP in the kernel and never answers the ClientHello.
        hole = Blackhole()
        self.addCleanup(hole.close)
        port = hole.sock.getsockname()[1]
        ok, elapsed, _attempts, _sockets = self._timed("https://127.0.0.1:%d" % port, [port], {port: ("slow", 0.45)})
        self.assertFalse(ok)
        self.assertLess(elapsed, 0.6 + 0.2)

    def test_one_deadline_across_resolved_addresses(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        good = ingest.httpd.server_address[1]
        refused, silent = _free_port(), _free_port()
        ok, elapsed, attempts, sockets = self._timed(
            ingest.url, [refused, silent, good], {refused: ("refuse", 0.35), silent: ("hole",)},
        )
        self.assertFalse(ok)
        self.assertLess(elapsed, 0.6 + 0.2)
        # The budget ran out on the second address; the third was never tried.
        self.assertEqual(attempts, [refused, silent])
        self.assertEqual(ingest.requests, [])
        self.assertTrue(all(sock.fileno() == -1 for sock in sockets))

    def test_later_address_used_and_failed_sockets_closed(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        good = ingest.httpd.server_address[1]
        refused = _free_port()
        ok, _elapsed, attempts, sockets = self._timed(
            ingest.url, [refused, good], {refused: ("refuse", 0.1)}, timeout=2.0,
        )
        self.assertTrue(ok)
        self.assertEqual(attempts, [refused, good])
        self.assertEqual(sockets[0].fileno(), -1)
        self.assertEqual(len(ingest.requests), 1)

    def test_spent_deadline_is_a_timeout(self) -> None:
        auditor = audit.Auditor("http://127.0.0.1:9", AUDIT_TOKEN, timeout=0.0)
        with mock.patch.object(audit.socket, "getaddrinfo") as lookup:
            self.assertFalse(auditor._deliver(_EVENT))
        self.assertEqual(lookup.call_count, 0)

    def test_worker_survives_injected_exception(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        auditor = audit.Auditor(ingest.url, AUDIT_TOKEN)
        real = auditor._deliver
        calls = {"n": 0}

        def flaky(event: dict) -> bool:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("killed mid-flight")
            return real(event)

        auditor._deliver = flaky  # type: ignore[assignment]
        auditor.start()
        self.addCleanup(auditor.close)
        self._one(auditor)
        self.assertTrue(_wait_until(lambda: auditor.stats()["delivery_failed"] == 1))
        self._one(auditor)
        self.assertTrue(_wait_until(lambda: auditor.stats()["sent"] == 1))
        self.assertTrue(auditor.alive())
        self.assertEqual(len(ingest.requests), 1)

    def test_exception_inside_http_client_is_counted(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        auditor = self._auditor_against(ingest)
        original = audit.http.client.HTTPConnection.getresponse
        state = {"n": 0}

        def getresponse(conn: object, *args: object, **kwargs: object) -> object:
            state["n"] += 1
            if state["n"] == 1:
                raise MemoryError("injected")
            return original(conn, *args, **kwargs)

        with mock.patch.object(audit.http.client.HTTPConnection, "getresponse", getresponse):
            self._one(auditor)
            self.assertTrue(_wait_until(lambda: auditor.stats()["delivery_failed"] == 1))
            self._one(auditor)
            self.assertTrue(_wait_until(lambda: auditor.stats()["sent"] == 1))
        self.assertTrue(auditor.alive())

    def test_bounded_log(self) -> None:
        clock = Clock()
        auditor = audit.Auditor("http://127.0.0.1:9", AUDIT_TOKEN, clock=clock)
        cap = ListHandler()
        log = logging.getLogger("ak.broker.audit")
        log.addHandler(cap)
        self.addCleanup(log.removeHandler, cap)
        auditor.maybe_log()
        self.assertEqual(cap.lines, [])
        auditor._bump("dropped_full")
        auditor.maybe_log()
        clock.now += 59
        auditor._bump("delivery_failed")
        auditor.maybe_log()
        self.assertEqual(len(cap.lines), 1)
        clock.now += 1
        auditor.maybe_log()
        self.assertEqual(len(cap.lines), 2)
        self.assertEqual(json.loads(cap.lines[1]), {"audit": "degraded", "dropped_full": 1, "delivery_failed": 1})

    def test_shutdown_does_not_drain(self) -> None:
        ingest = Ingest(mode="slow", delay=0.6)
        self.addCleanup(ingest.close)
        auditor = audit.Auditor(ingest.url, AUDIT_TOKEN)
        for _ in range(5):
            self._one(auditor)
        auditor.start()
        self.assertTrue(ingest.wait(1))
        auditor.close()
        time.sleep(1.5)
        self.assertEqual(len(ingest.requests), 1)
        self.assertFalse(auditor.alive())
        self.assertEqual(auditor.stats()["queued"], 4)

    def test_broker_shutdown_closes_auditor(self) -> None:
        ingest = Ingest()
        self.addCleanup(ingest.close)
        harness = Harness(self, audit_url=ingest.url)
        self.assertTrue(_wait_until(harness.auditor.alive))
        auditor = harness.auditor
        harness.stop()
        self.assertTrue(_wait_until(lambda: not auditor.alive()))


if __name__ == "__main__":
    unittest.main()
