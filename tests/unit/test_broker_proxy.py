#!/usr/bin/env python3
"""Loopback broker proxy. Stdlib unittest. No external network.

Imports agents/broker the way tests/unit/test_child_env.py imports the
dispatcher: directory on sys.path, no package __init__.py. Fixture values
live in temp directories this module creates. Nothing here is a real secret.
"""
from __future__ import annotations

import ast
import contextlib
import http.client
import http.server
import io
import json
import logging
import os
import shutil
import socket
import ssl
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
BROKER = ROOT / "agents" / "broker"
sys.path.insert(0, str(BROKER))
import broker  # noqa: E402

SECRET = "fixture-secret-VALUE-189"
OTHER_SECRET = "other-fixture-SECRET-190"
CANARY = "sk-live-CANARY-189-do-not-echo"
ECHO_TOKEN = "echo-token-189"
ONE_MIB = 1024 * 1024

_OLD_CONNECT = None
_OLD_CONNECT_EX = None
_OLD_GETADDRINFO = None
_SOCKET_TRIPS: list = []


def _host_of(address: object) -> object:
    if isinstance(address, tuple) and address:
        return address[0]
    return None


def _loopback_host(host: object) -> bool:
    if isinstance(host, bytes):
        try:
            host = host.decode("ascii")
        except UnicodeDecodeError:
            return False
    if isinstance(host, str) and host[:1] == "[" and host[-1:] == "]":
        host = host[1:-1]
    return host in ("127.0.0.1", "::1")


def _install_guard() -> None:
    global _OLD_CONNECT, _OLD_CONNECT_EX, _OLD_GETADDRINFO
    _OLD_CONNECT = socket.socket.connect
    _OLD_CONNECT_EX = socket.socket.connect_ex
    _OLD_GETADDRINFO = socket.getaddrinfo

    def connect(self: socket.socket, address: object) -> object:
        host = _host_of(address)
        if not _loopback_host(host):
            _SOCKET_TRIPS.append(("connect", host))
            raise OSError("socket guard blocked non-fixture connect")
        return _OLD_CONNECT(self, address)

    def connect_ex(self: socket.socket, address: object) -> int:
        host = _host_of(address)
        if not _loopback_host(host):
            _SOCKET_TRIPS.append(("connect_ex", host))
            return 1
        return _OLD_CONNECT_EX(self, address)

    def getaddrinfo(host: object, port: object, *args: object, **kwargs: object):
        if not _loopback_host(host):
            _SOCKET_TRIPS.append(("getaddrinfo", host))
            raise socket.gaierror(socket.EAI_NONAME, "socket guard blocked non-fixture resolve")
        return _OLD_GETADDRINFO(host, port, *args, **kwargs)

    socket.socket.connect = connect  # type: ignore[assignment]
    socket.socket.connect_ex = connect_ex  # type: ignore[assignment]
    socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]


def _restore_guard() -> None:
    if _OLD_CONNECT is not None:
        socket.socket.connect = _OLD_CONNECT  # type: ignore[assignment]
    if _OLD_CONNECT_EX is not None:
        socket.socket.connect_ex = _OLD_CONNECT_EX  # type: ignore[assignment]
    if _OLD_GETADDRINFO is not None:
        socket.getaddrinfo = _OLD_GETADDRINFO  # type: ignore[assignment]


def setUpModule() -> None:
    _install_guard()


def tearDownModule() -> None:
    try:
        if _SOCKET_TRIPS:
            leftover = list(_SOCKET_TRIPS)
            raise AssertionError("socket guard trips: %s" % (leftover,))
    finally:
        _restore_guard()


class _GuardedCase(unittest.TestCase):
    def tearDown(self) -> None:
        trips = list(_SOCKET_TRIPS)
        del _SOCKET_TRIPS[:]
        self.assertEqual(trips, [])


class Clock:
    def __init__(self, now: float = 0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


class ListHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


def _write(path: Path, data: str, mode: int) -> None:
    if path.exists():
        os.chmod(path, 0o600)
    path.write_bytes(data.encode("utf-8"))
    os.chmod(path, mode)


def _service(secret: str = "secretref://file/lanes/KEY", **overrides: object) -> dict:
    data = {
        "name": "openrouter",
        "upstream": "https://openrouter.ai",
        "header": "Authorization",
        "template": "Bearer {secret}",
        "secret": secret,
        "methods": ["GET", "POST"],
        "path_prefixes": ["/api/v1/"],
    }
    data.update(overrides)
    return data


def _config(providers: str, services: list | None = None, **overrides: object) -> dict:
    data = {
        "bind": "127.0.0.1",
        "port": 0,
        "providers": providers,
        "placeholder_ttl_seconds": 3600,
        "upstream_timeout_seconds": 60,
        "max_request_body_bytes": ONE_MIB,
        "services": services if services is not None else [_service()],
    }
    data.update(overrides)
    return data


def _provider_tree(root: Path, values: dict[str, str]) -> str:
    lines = []
    for key, value in values.items():
        lines.append("%s=%s" % (key, value))
    secret = root / "secrets.env"
    _write(secret, "\n".join(lines) + "\n", 0o600)
    config = root / "providers.json"
    _write(config, json.dumps({"file": {"lanes": str(secret)}}), 0o600)
    return str(config)


def _request_bytes(method: str, target: str, headers: list[tuple[str, str]], body: bytes | None = None) -> bytes:
    lines = ["%s %s HTTP/1.1" % (method, target), "Host: 127.0.0.1"]
    for name, value in headers:
        lines.append("%s: %s" % (name, value))
    if body is not None:
        lines.append("Content-Length: %d" % len(body))
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1")
    if body:
        raw += body
    return raw


def _parse_response(raw: bytes) -> tuple:
    if b"\r\n\r\n" not in raw:
        return None, {}, b"", raw
    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    parts = lines[0].split(b" ")
    status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
    headers: dict[bytes, list[bytes]] = {}
    for line in lines[1:]:
        if b":" not in line:
            continue
        name, value = line.split(b":", 1)
        headers.setdefault(name.lower(), []).append(value.strip())
    return status, headers, body, raw


def _join_after_shutdown(server: object, thread: threading.Thread) -> None:
    """Shutdown (and server_close) before join, so join is not stuck in serve_forever."""
    shutdown = getattr(server, "shutdown", None)
    if shutdown is not None:
        shutdown()
    closer = getattr(server, "server_close", None)
    if closer is not None:
        closer()
    thread.join(5)


def _exchange(port: int, payload: bytes, timeout: float = 5, on_first_body: object = None, shutdown: bool = True) -> bytes:
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.settimeout(timeout)
    try:
        sock.sendall(payload)
        if shutdown:
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
        data = b""
        signaled = False
        while True:
            try:
                block = sock.recv(65536)
            except socket.timeout:
                break
            if not block:
                break
            data += block
            if not signaled and on_first_body is not None and b"\r\n\r\n" in data:
                _, _, body = data.partition(b"\r\n\r\n")
                if body:
                    on_first_body(body)
                    signaled = True
        return data
    finally:
        sock.close()


def _assert_absent(test: unittest.TestCase, blob: bytes | str, needle: str, label: str) -> None:
    if not needle:
        return
    haystack = blob if isinstance(blob, bytes) else blob.encode("utf-8", "replace")
    if needle.encode("utf-8") in haystack:
        test.fail("%s appeared in a %d-byte capture" % (label, len(haystack)))


def _assert_error(test: unittest.TestCase, raw: bytes, status: int, code: str) -> None:
    got, headers, body, _ = _parse_response(raw)
    test.assertEqual(got, status)
    test.assertEqual(body, ('{"error":"%s"}' % code).encode("ascii"))
    test.assertEqual(headers.get(b"content-type"), [b"application/json"])
    test.assertNotIn(b"<html", raw.lower())
    test.assertNotIn(b"Error response", raw)


class ScriptedResponse:
    def __init__(self, status: int, headers: list, chunks: list[bytes]) -> None:
        self.status = status
        self.headers = headers
        self.chunks = list(chunks)
        self.reads = 0

    def read_chunk(self, _max_bytes: int) -> bytes:
        self.reads += 1
        if not self.chunks:
            return b""
        return self.chunks.pop(0)


class Recorder:
    """In-process upstream double. request() consumes body chunks."""

    def __init__(self) -> None:
        self.factory_calls: list[tuple] = []
        self.calls: list[dict] = []
        self.fail: BaseException | None = None
        self.status = 200
        self.headers: list | None = None
        self.chunks: list[bytes] = [b"ok"]
        self.on_request: object = None
        self.opened = 0
        self.closed = 0
        self.response: ScriptedResponse | None = None

    def factory(self, service_config: dict, timeout_seconds: object) -> object:
        self.factory_calls.append((service_config, timeout_seconds))
        recorder = self

        class Conn:
            def request(self, method: str, target: str, headers: list, body_chunks: object) -> ScriptedResponse:
                recorder.opened += 1
                if recorder.on_request is not None:
                    recorder.on_request()
                if recorder.fail is not None:
                    raise recorder.fail
                body = bytearray()
                for piece in body_chunks:
                    if piece:
                        body.extend(piece)
                recorder.calls.append({
                    "method": method,
                    "target": target,
                    "headers": [(name, value) for name, value in headers],
                    "body": bytes(body),
                })
                if recorder.response is not None:
                    return recorder.response
                chunks = list(recorder.chunks)
                headers_out = recorder.headers
                if headers_out is None:
                    payload = b"".join(chunks)
                    headers_out = [
                        ("Content-Type", "text/plain"),
                        ("Content-Length", str(len(payload))),
                    ]
                    chunks = [payload]
                return ScriptedResponse(recorder.status, list(headers_out), chunks)

            def close(self) -> None:
                recorder.closed += 1

        return Conn()


class BytesResponse:
    def __init__(self, body: bytes, status: int = 200, headers: list | None = None) -> None:
        self.status = status
        self._body = body
        self._off = 0
        self.headers = headers or [
            ("Content-Type", "application/octet-stream"),
            ("Content-Length", str(len(body))),
        ]

    def read_chunk(self, max_bytes: int) -> bytes:
        if self._off >= len(self._body):
            return b""
        chunk = self._body[self._off:self._off + max_bytes]
        self._off += len(chunk)
        return chunk


class GateResponse:
    """Second chunk waits until the client has observed body bytes."""

    def __init__(self) -> None:
        self.status = 200
        first = b"A" * 65536
        second = b"B" * 4096
        self.payload = first + second
        self.headers = [
            ("Content-Type", "application/octet-stream"),
            ("Content-Length", str(len(self.payload))),
        ]
        self._phase = 0
        self.client_got_byte = threading.Event()
        self.saw_client = False

    def read_chunk(self, _max_bytes: int) -> bytes:
        if self._phase == 0:
            self._phase = 1
            return self.payload[:65536]
        if self._phase == 1:
            self._phase = 2
            self.saw_client = self.client_got_byte.wait(8)
            return self.payload[65536:]
        return b""


class RaisingResponse:
    """One body chunk, then an unexpected error. The head has already been sent."""

    def __init__(self, first: bytes, exc: BaseException) -> None:
        self.status = 200
        self.headers = [
            ("Content-Type", "text/plain"),
            ("Content-Length", "200"),
        ]
        self._first = first
        self._exc = exc
        self.reads = 0

    def read_chunk(self, _max_bytes: int) -> bytes:
        self.reads += 1
        if self.reads == 1:
            return self._first
        raise self._exc


class Harness:
    def __init__(self, test: unittest.TestCase, secret: str = SECRET, services: list | None = None, clock: Clock | None = None, **overrides: object) -> None:
        self.test = test
        self.secret = secret
        self.root = Path(tempfile.mkdtemp(prefix="ak-broker-"))
        test.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        values = {"KEY": secret, "OTHER": OTHER_SECRET}
        if services:
            for item in services:
                ref = item["secret"]
                if ref.startswith("secretref://file/lanes/"):
                    values.setdefault(ref.rsplit("/", 1)[-1], secret)
        self.providers = _provider_tree(self.root, values)
        self.recorder = Recorder()
        self.clock = clock or Clock(1000)
        self.store = broker.PlaceholderStore(clock=self.clock)
        self.config = _config(self.providers, services=services, **overrides)
        self.server = broker.BrokerServer(self.config, self.store, self.recorder.factory)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        test.addCleanup(self.stop)
        self.port = self.server.bound_port

    def stop(self) -> None:
        _join_after_shutdown(self.server, self.thread)

    def mint(self, task: str = "task-1", services: list | None = None) -> dict:
        return self.store.mint(task, services or ["openrouter"])

    def auth(self, placeholder: str) -> list[tuple[str, str]]:
        return [("Authorization", "Bearer " + placeholder)]

    def exchange(self, method: str, target: str, headers: list | None = None, body: bytes | None = None, timeout: float = 5, **kwargs: object) -> bytes:
        return _exchange(self.port, _request_bytes(method, target, headers or [], body), timeout=timeout, **kwargs)


def _capture(test: unittest.TestCase) -> tuple:
    log = logging.getLogger("ak.broker")
    root = logging.getLogger()
    old = log.level
    log.setLevel(logging.INFO)
    cap = ListHandler()
    root_cap = ListHandler()
    log.addHandler(cap)
    root.addHandler(root_cap)

    def cleanup() -> None:
        log.removeHandler(cap)
        root.removeHandler(root_cap)
        log.setLevel(old)

    test.addCleanup(cleanup)
    return cap, root_cap


def _one_log(test: unittest.TestCase, cap: ListHandler) -> dict:
    test.assertEqual(len(cap.lines), 1, cap.lines)
    obj = json.loads(cap.lines[0])
    test.assertEqual(set(obj), {"service", "method", "prefix", "status", "reason"})
    return obj


class StoreTests(_GuardedCase):
    def _store(self, now: float = 1000, ttl: int = 10) -> tuple:
        clock = Clock(now)
        store = broker.PlaceholderStore(clock=clock)
        store.configure(["openrouter", "resend"], ttl)
        return store, clock

    def test_mint_shape_and_mapping(self) -> None:
        store, _clock = self._store()
        issued = store.mint("task-a", ["openrouter", "resend"])
        self.assertEqual(set(issued), {"openrouter", "resend"})
        self.assertNotEqual(issued["openrouter"], issued["resend"])
        for value in issued.values():
            self.assertRegex(value, r"\Aakp_[A-Za-z0-9_-]{43}\Z")
            self.assertEqual(store.check(value, "openrouter" if value == issued["openrouter"] else "resend"), "ok")

    def test_mint_rejects_empty_duplicate_and_unknown_service(self) -> None:
        store, _clock = self._store()
        for services in ([], ["openrouter", "openrouter"], ["missing"], [""], [1]):
            with self.subTest(services=services):
                with self.assertRaises(ValueError):
                    store.mint("task-a", services)
        self.assertEqual(store.known_placeholders(), ())

    def test_mint_rejects_bad_task_id(self) -> None:
        store, _clock = self._store()
        for task in ("", None, 1, b"task"):
            with self.subTest(task=task):
                with self.assertRaises(ValueError) as ctx:
                    store.mint(task, ["openrouter"])
                self.assertIn("task", str(ctx.exception).lower())

    def test_mint_same_task_twice_raises(self) -> None:
        store, _clock = self._store()
        store.mint("task-a", ["openrouter"])
        with self.assertRaises(ValueError) as ctx:
            store.mint("task-a", ["resend"])
        self.assertIn("duplicate", str(ctx.exception))

    def test_failed_mint_does_not_consume_task_id(self) -> None:
        store, _clock = self._store()
        with self.assertRaises(ValueError):
            store.mint("task-a", ["openrouter", "missing"])
        issued = store.mint("task-a", ["openrouter"])
        self.assertIn("openrouter", issued)

    def test_expiry_boundary(self) -> None:
        store, clock = self._store(now=1000, ttl=10)
        placeholder = store.mint("task-a", ["openrouter"])["openrouter"]
        clock.now = 1009
        self.assertEqual(store.check(placeholder, "openrouter"), "ok")
        clock.now = 1010
        self.assertEqual(store.check(placeholder, "openrouter"), "expired")

    def test_expired_before_revoked(self) -> None:
        store, clock = self._store(now=1000, ttl=10)
        placeholder = store.mint("task-a", ["openrouter"])["openrouter"]
        store.revoke(placeholder)
        clock.now = 1010
        self.assertEqual(store.check(placeholder, "openrouter"), "expired")

    def test_revoke_and_revoke_task_are_idempotent(self) -> None:
        store, _clock = self._store()
        issued = store.mint("task-a", ["openrouter", "resend"])
        store.revoke(issued["openrouter"])
        store.revoke(issued["openrouter"])
        store.revoke("akp_not-a-real-placeholder")
        store.revoke(None)
        self.assertEqual(store.check(issued["openrouter"], "openrouter"), "revoked")
        self.assertEqual(store.check(issued["resend"], "resend"), "ok")
        store.revoke_task("task-a")
        store.revoke_task("task-a")
        store.revoke_task("missing")
        store.revoke_task(None)
        self.assertEqual(store.check(issued["resend"], "resend"), "revoked")
        self.assertEqual(store.check(issued["openrouter"], "resend"), "wrong_service")

    def test_expired_and_revoked_stay_known(self) -> None:
        store, clock = self._store(now=1000, ttl=10)
        placeholder = store.mint("task-a", ["openrouter"])["openrouter"]
        clock.now = 1010
        store.revoke(placeholder)
        self.assertIn(placeholder, store.known_placeholders())

    def test_configure_once(self) -> None:
        store = broker.PlaceholderStore()
        with self.assertRaises(ValueError):
            store.mint("task-a", ["openrouter"])
        store.configure(("openrouter",), 5)
        with self.assertRaises(ValueError):
            store.configure(["openrouter"], 5)
        for bad in ([], [""], ["BAD"], ["openrouter", "openrouter"], None):
            fresh = broker.PlaceholderStore()
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    fresh.configure(bad, 5)
        fresh = broker.PlaceholderStore()
        with self.assertRaises(ValueError):
            fresh.configure(["openrouter"], 0)
        with self.assertRaises(ValueError):
            fresh.configure(["openrouter"], True)

    def test_concurrent_mint_and_revoke(self) -> None:
        store, _clock = self._store()
        errors: list[BaseException] = []

        def worker(index: int) -> None:
            try:
                task = "task-%d" % index
                issued = store.mint(task, ["openrouter"])
                store.revoke(issued["openrouter"])
                store.revoke_task(task)
                store.revoke_task(task)
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(store.known_placeholders()), 8)


class _Stat:
    def __init__(self, mode: int, uid: int) -> None:
        self.st_mode = mode
        self.st_uid = uid


class ConfigTests(_GuardedCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="ak-broker-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.providers = _provider_tree(self.root, {"KEY": SECRET})

    def _refuse(self, config: dict, fragment: str, absent: str = "") -> None:
        created: list[object] = []

        def boom(*_args: object, **_kwargs: object) -> object:
            created.append(True)
            raise AssertionError("socket")

        store = broker.PlaceholderStore()
        with mock.patch.object(broker.socket, "socket", boom):
            with self.assertRaises(ValueError) as ctx:
                broker.BrokerServer(config, store, lambda *_a: None)
        self.assertEqual(created, [])
        self.assertIsNone(ctx.exception.__context__)
        text = str(ctx.exception)
        self.assertIn(fragment, text)
        if absent:
            self.assertNotIn(absent, text)
        self.assertNotIn(SECRET, text)

    def test_bind_refused_without_socket(self) -> None:
        for bind in ("0.0.0.0", "::", "localhost", "127.0.0.2", ""):
            with self.subTest(bind=bind):
                self._refuse(_config(self.providers, bind=bind), "bind")

    def test_file_rule_and_load_config(self) -> None:
        path = self.root / "broker.json"
        good = _config(self.providers, port=8765)
        _write(path, json.dumps(good), 0o600)
        loaded = broker.load_config(str(path))
        self.assertEqual(loaded["port"], 8765)
        self.assertEqual(loaded["bind"], "127.0.0.1")
        _write(path, json.dumps(good), 0o400)
        self.assertEqual(broker.load_config(str(path))["port"], 8765)
        for mode in (0o644, 0o700, 0o000):
            with self.subTest(mode=oct(mode)):
                _write(path, json.dumps(good), mode)
                with self.assertRaises(ValueError) as ctx:
                    broker.load_config(str(path))
                self.assertEqual(str(ctx.exception), "invalid broker config")
                self.assertNotIn(str(self.root), str(ctx.exception))
        link = self.root / "link.json"
        os.symlink(path, link)
        with self.assertRaises(ValueError) as ctx:
            broker.load_config(str(link))
        self.assertEqual(str(ctx.exception), "invalid broker config")
        with self.assertRaises(ValueError):
            broker.load_config(str(self.root))
        with self.assertRaises(ValueError):
            broker.load_config(str(self.root / "missing.json"))
        real = os.fstat

        def fake(fd: int) -> _Stat:
            info = real(fd)
            return _Stat(info.st_mode, info.st_uid ^ 1)

        _write(path, json.dumps(good), 0o600)
        with mock.patch.object(broker.os, "fstat", fake):
            with self.assertRaises(ValueError) as ctx:
                broker.load_config(str(path))
        self.assertEqual(str(ctx.exception), "invalid broker config")

    def test_unknown_missing_null_bool_and_duplicate(self) -> None:
        base = _config(self.providers)
        extra = dict(base)
        extra["admin_socket"] = "/tmp/admin.sock"
        self._refuse(extra, "invalid broker config")
        missing = dict(base)
        del missing["max_request_body_bytes"]
        self._refuse(missing, "invalid broker config")
        self._refuse(_config(self.providers, port=None), "port")
        self._refuse(_config(self.providers, port=True), "port")
        self._refuse(_config(self.providers, placeholder_ttl_seconds=True), "placeholder_ttl_seconds")
        path = self.root / "broker.json"
        text = json.dumps(_config(self.providers, port=8765))
        text = text.replace('"bind": "127.0.0.1"', '"bind": "127.0.0.1", "bind": "0.0.0.0"', 1)
        _write(path, text, 0o600)
        with self.assertRaises(ValueError) as ctx:
            broker.load_config(str(path))
        self.assertEqual(str(ctx.exception), "invalid broker config")
        _write(path, text.replace('"port": 8765', '"port": NaN', 1), 0o600)
        with self.assertRaises(ValueError):
            broker.load_config(str(path))

    def test_field_rules_and_port_zero(self) -> None:
        path = self.root / "broker.json"
        _write(path, json.dumps(_config(self.providers, port=0)), 0o600)
        with self.assertRaises(ValueError) as ctx:
            broker.load_config(str(path))
        self.assertIn("port", str(ctx.exception))
        cases = [
            (_config(self.providers, port=65536), "port"),
            (_config(self.providers, port="8765"), "port"),
            (_config("relative.json"), "providers"),
            (_config(self.providers, placeholder_ttl_seconds=0), "placeholder_ttl_seconds"),
            (_config(self.providers, upstream_timeout_seconds=-1), "upstream_timeout_seconds"),
            (_config(self.providers, max_request_body_bytes=0), "max_request_body_bytes"),
            (_config(self.providers, services=[]), "services"),
            (_config(self.providers, services=[_service(name="OpenRouter")]), "name"),
            (_config(self.providers, services=[_service(name="")]), "name"),
            (_config(self.providers, services=[_service(), _service()]), "name"),
            (_config(self.providers, services=[_service(methods=["get"])]), "methods"),
            (_config(self.providers, services=[_service(methods=[])]), "methods"),
            (_config(self.providers, services=[_service(header="Bad Header")]), "header"),
            (_config(self.providers, services=[_service(template="Bearer %s")]), "template"),
            (_config(self.providers, services=[_service(template="{secret}{secret}")]), "template"),
            (_config(self.providers, services=[_service(path_prefixes=["api/"])]), "path_prefixes"),
            (_config(self.providers, services=[_service(path_prefixes=[])]), "path_prefixes"),
            (_config(self.providers, services=[_service(upstream="http://openrouter.ai")]), "upstream"),
            (_config(self.providers, services=[_service(upstream="https://openrouter.ai/v1")]), "upstream"),
            (_config(self.providers, services=[_service(upstream="https://openrouter.ai/")]), "upstream"),
            (_config(self.providers, services=[_service(upstream="https://openrouter.ai?x=1")]), "upstream"),
            (_config(self.providers, services=[_service(upstream="https://openrouter.ai#f")]), "upstream"),
            (_config(self.providers, services=[_service(upstream="https://user:pass@openrouter.ai")]), "upstream"),
            (_config(self.providers, services=[_service(secret=1)]), "openrouter"),
        ]
        for config, fragment in cases:
            with self.subTest(fragment=fragment, secret=config["services"][0]["secret"] if config["services"] else None):
                self._refuse(config, fragment)

    def test_literal_and_malformed_secret_names_service_only(self) -> None:
        for secret in (CANARY, "", "not-a-reference", "secretref://", "secretref://nope/a/b"):
            with self.subTest(secret=secret[:12]):
                config = _config(self.providers, services=[_service(secret=secret)])
                self._refuse(config, "openrouter", absent=CANARY)
                text = ""
                created: list[object] = []

                def boom(*_a: object, **_k: object) -> object:
                    created.append(True)
                    raise AssertionError("socket")

                with mock.patch.object(broker.socket, "socket", boom):
                    try:
                        broker.BrokerServer(config, broker.PlaceholderStore(), lambda *_a: None)
                    except ValueError as exc:
                        text = str(exc)
                self.assertNotIn(CANARY, text)
                self.assertTrue(text.startswith("service openrouter:"))

    def test_resolution_failure_names_service_and_provider(self) -> None:
        root = self.root / "empty"
        root.mkdir()
        providers = _provider_tree(root, {"OTHER": "unused-value"})
        config = _config(providers, services=[_service()])
        self._refuse(config, "openrouter")
        created: list[object] = []

        def boom(*_a: object, **_k: object) -> object:
            created.append(True)
            raise AssertionError("socket")

        with mock.patch.object(broker.socket, "socket", boom):
            with self.assertRaises(ValueError) as ctx:
                broker.BrokerServer(config, broker.PlaceholderStore(), lambda *_a: None)
        message = str(ctx.exception)
        self.assertIn("service openrouter:", message)
        self.assertIn("provider file:", message)
        self.assertIn("missing key: provider=file source=lanes name=KEY", message)
        self.assertNotIn(SECRET, message)
        self.assertNotIn("unused-value", message)
        self.assertEqual(created, [])

    def test_non_ascii_and_empty_secret_rejected(self) -> None:
        for text, absent in (("KEY=\n", ""), ("KEY=caf\u00e9\n", "caf\u00e9")):
            root = Path(tempfile.mkdtemp(prefix="ak-broker-", dir=self.root))
            secret = root / "secrets.env"
            secret.write_bytes(text.encode("utf-8"))
            os.chmod(secret, 0o600)
            providers = root / "providers.json"
            _write(providers, json.dumps({"file": {"lanes": str(secret)}}), 0o600)
            config = _config(str(providers))
            self._refuse(config, "unresolved secret", absent=absent)

    def test_second_configure_and_ephemeral_bind(self) -> None:
        store = broker.PlaceholderStore()
        store.configure(["openrouter"], 10)
        created: list[object] = []

        def boom(*_a: object, **_k: object) -> object:
            created.append(True)
            raise AssertionError("socket")

        with mock.patch.object(broker.socket, "socket", boom):
            with self.assertRaises(ValueError):
                broker.BrokerServer(_config(self.providers), store, lambda *_a: None)
        self.assertEqual(created, [])
        server = broker.BrokerServer(_config(self.providers), broker.PlaceholderStore(), lambda *_a: None)
        self.addCleanup(server.shutdown)
        self.assertEqual(server._httpd.socket.getsockname()[0], "127.0.0.1")
        self.assertGreater(server.bound_port, 0)
        self.assertNotIn(SECRET, repr(server))
        with self.assertRaises(ValueError):
            server._state.store.configure(["openrouter"], 10)

    def test_main_failure_and_usage(self) -> None:
        path = self.root / "broker.json"
        _write(path, json.dumps(_config(self.providers, port=8765, services=[_service(secret=CANARY)])), 0o600)
        stderr = io.StringIO()
        created: list[object] = []

        def boom(*_a: object, **_k: object) -> object:
            created.append(True)
            raise AssertionError("socket")

        with mock.patch.object(broker.socket, "socket", boom):
            with contextlib.redirect_stderr(stderr):
                code = broker.main(["--config", str(path)])
        self.assertEqual(code, 1)
        text = stderr.getvalue()
        self.assertIn("openrouter", text)
        self.assertNotIn(CANARY, text)
        self.assertNotIn(SECRET, text)
        self.assertEqual(created, [])
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(broker.main([]), 2)
            self.assertEqual(broker.main(["--config"]), 2)
            self.assertEqual(broker.main(["--nope", "x"]), 2)
        self.assertIn("usage", stderr.getvalue())

    def test_example_config_and_readme(self) -> None:
        example = json.loads((BROKER / "config.example.json").read_text())
        checked = broker.validate_config(example)
        self.assertEqual(checked["bind"], "127.0.0.1")
        self.assertEqual(checked["max_request_body_bytes"], ONE_MIB)
        self.assertEqual(checked["services"][0]["name"], "openrouter")
        readme = (BROKER / "README.md").read_text()
        running = readme.split("## Running the broker", 1)
        self.assertEqual(len(running), 2)
        self.assertIn("secretref://exec/sops/openrouter_api_key", running[0])
        body = running[1]
        for field in (
            "bind",
            "port",
            "providers",
            "placeholder_ttl_seconds",
            "upstream_timeout_seconds",
            "max_request_body_bytes",
            "services",
            "name",
            "upstream",
            "header",
            "template",
            "secret",
            "methods",
            "path_prefixes",
        ):
            self.assertIn("`%s`" % field, body)
        self.assertIn("launchctl bootout gui/$(id -u)/com.peripety.ak-broker", body)
        self.assertIn("systemctl --user stop ak-broker", body)
        self.assertIn("systemctl --user disable ak-broker", body)
        self.assertIn("Stopping alone leaves the enablement", body)
        self.assertIn("Disabling alone leaves the current process", body)
        self.assertIn("curl -sS -m 2 http://127.0.0.1:8765/", body)
        self.assertIn("#193", body)
        # #188 ContractTests locks the whole README at exactly four "not run"
        # and rejects "run on ". These units stay unexecuted without that token.
        self.assertGreaterEqual(body.count("Status: not yet run"), 2)
        self.assertNotIn("Status: not run", body)
        self.assertIn("launchd", body)
        self.assertIn("systemd", body)


class _CaptureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _record(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        self.server.seen.append({
            "method": self.command,
            "path": self.path,
            "headers": list(self.headers.items()),
            "body": body,
        })

    def _reply(self) -> None:
        payload = getattr(self.server, "payload", b"fixture-body")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_GET(self) -> None:
        self._record()
        self._reply()

    def do_POST(self) -> None:
        self._record()
        self._reply()

    def log_message(self, _fmt: str, *_args: object) -> None:
        return


class _LoopAdapter:
    def __init__(self, resp: http.client.HTTPResponse, conn: http.client.HTTPConnection) -> None:
        self.status = resp.status
        self.headers = list(resp.getheaders())
        self._resp = resp
        self._conn = conn

    def read_chunk(self, max_bytes: int) -> bytes:
        return self._resp.read(max_bytes)


class _LoopUpstream:
    def __init__(self, port: int, timeout: object) -> None:
        self._conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)

    def request(self, method: str, target: str, headers: list, body_chunks: object) -> _LoopAdapter:
        body = b"".join(piece for piece in body_chunks if piece)
        self._conn.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
        for name, value in headers:
            self._conn.putheader(name, value)
        self._conn.endheaders()
        if body:
            self._conn.send(body)
        return _LoopAdapter(self._conn.getresponse(), self._conn)

    def close(self) -> None:
        self._conn.close()


class ProxyTests(_GuardedCase):
    def _harness(self, **kwargs: object) -> Harness:
        return Harness(self, **kwargs)

    def _logs(self) -> tuple:
        return _capture(self)

    def test_upstream_receives_secret_not_placeholder(self) -> None:
        harness = self._harness(upstream_timeout_seconds=7)
        cap, root_cap = self._logs()
        issued = harness.mint()
        placeholder = issued["openrouter"]
        raw = harness.exchange(
            "POST",
            "/openrouter/api/v1/chat?x=1%2e&y=2",
            harness.auth(placeholder) + [("X-Trace", "keep"), ("Connection", "close")],
            b"hello",
        )
        status, _headers, body, _raw = _parse_response(raw)
        self.assertEqual(status, 200)
        self.assertEqual(body, b"ok")
        self.assertEqual(len(harness.recorder.calls), 1)
        call = harness.recorder.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["target"], "/api/v1/chat?x=1%2e&y=2")
        self.assertEqual(call["body"], b"hello")
        blob = json.dumps(call["headers"]) + call["target"] + call["body"].decode("ascii")
        self.assertIn("Bearer " + SECRET, blob)
        self.assertNotIn(placeholder, blob)
        self.assertNotIn(SECRET, call["target"])
        names = [name.lower() for name, _value in call["headers"]]
        self.assertEqual(names.count("authorization"), 1)
        self.assertEqual(names.count("content-length"), 1)
        self.assertIn("host", names)
        host = [value for name, value in call["headers"] if name.lower() == "host"]
        self.assertEqual(host, ["openrouter.ai"])
        self.assertNotIn("connection", names)
        service, timeout = harness.recorder.factory_calls[0]
        self.assertEqual(timeout, 7)
        self.assertNotIn(SECRET, json.dumps(service))
        self.assertTrue(str(service["secret"]).startswith("secretref://"))
        obj = _one_log(self, cap)
        self.assertEqual(obj["service"], "openrouter")
        self.assertEqual(obj["method"], "POST")
        self.assertEqual(obj["prefix"], "/api/v1/")
        self.assertEqual(obj["status"], 200)
        self.assertEqual(obj["reason"], "-")
        _assert_absent(self, "\n".join(cap.lines + root_cap.lines), SECRET, "secret")
        _assert_absent(self, "\n".join(cap.lines + root_cap.lines), placeholder, "placeholder")

    def test_fixture_upstream_over_loopback(self) -> None:
        httpd = http.server.HTTPServer(("127.0.0.1", 0), _CaptureHandler)
        httpd.seen = []
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(_join_after_shutdown, httpd, thread)
        port = httpd.server_address[1]

        def factory(service_config: dict, timeout_seconds: object) -> _LoopUpstream:
            return _LoopUpstream(port, timeout_seconds)

        root = Path(tempfile.mkdtemp(prefix="ak-broker-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        providers = _provider_tree(root, {"KEY": SECRET})
        store = broker.PlaceholderStore()
        server = broker.BrokerServer(_config(providers), store, factory)
        serve = threading.Thread(target=server.serve_forever, daemon=True)
        serve.start()
        self.addCleanup(_join_after_shutdown, server, serve)
        placeholder = store.mint("task-1", ["openrouter"])["openrouter"]
        raw = _exchange(
            server.bound_port,
            _request_bytes("GET", "/openrouter/api/v1/models?q=1", [("Authorization", "Bearer " + placeholder)]),
        )
        status, _headers, body, whole = _parse_response(raw)
        self.assertEqual(status, 200)
        self.assertEqual(body, b"fixture-body")
        self.assertEqual(len(httpd.seen), 1)
        seen = httpd.seen[0]
        self.assertEqual(seen["method"], "GET")
        self.assertEqual(seen["path"], "/api/v1/models?q=1")
        auths = [value for name, value in seen["headers"] if name.lower() == "authorization"]
        self.assertEqual(auths, ["Bearer " + SECRET])
        captured = json.dumps(seen["headers"]) + seen["path"] + seen["body"].decode("ascii", "replace")
        self.assertNotIn(placeholder, captured)
        _assert_absent(self, whole, SECRET, "secret")
        _assert_absent(self, whole, placeholder, "placeholder")

    def test_prefix_boundary_and_repeated_slashes(self) -> None:
        harness = self._harness()
        cap, _root = self._logs()
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange("GET", "/openrouter/api/v1//x%2ey", harness.auth(placeholder))
        status, _headers, _body, _raw = _parse_response(raw)
        self.assertEqual(status, 200)
        self.assertEqual(harness.recorder.calls[0]["target"], "/api/v1//x%2ey")
        self.assertEqual(_one_log(self, cap)["prefix"], "/api/v1/")
        harness.recorder.calls.clear()
        harness.recorder.factory_calls.clear()
        for target in ("/openrouter/api/v1", "/openrouter/api/v1x", "/openrouter"):
            with self.subTest(target=target):
                raw = harness.exchange("GET", target, harness.auth(placeholder))
                _assert_error(self, raw, 403, "path_not_allowed")
        self.assertEqual(harness.recorder.factory_calls, [])

    def test_hop_by_hop_request_headers_dropped(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        headers = harness.auth(placeholder) + [
            ("X-Trace", "keepme"),
            ("Connection", "x-custom, close"),
            ("X-Custom", "drop-me"),
            ("Keep-Alive", "timeout=5"),
            ("Proxy-Authorization", "Basic eA=="),
            ("TE", "trailers"),
            ("Upgrade", "websocket"),
            ("Trailer", "X-Nope"),
        ]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", headers)
        self.assertEqual(_parse_response(raw)[0], 200)
        names = [name.lower() for name, _value in harness.recorder.calls[0]["headers"]]
        for dropped in ("connection", "x-custom", "keep-alive", "proxy-authorization", "te", "upgrade", "trailer"):
            self.assertNotIn(dropped, names)
        self.assertIn("x-trace", names)

    def test_case_insensitive_header_and_other_service(self) -> None:
        services = [
            _service(),
            _service(name="resend", upstream="https://api.resend.com", secret="secretref://file/lanes/OTHER"),
        ]
        harness = self._harness(services=services)
        issued = harness.mint("task-1", ["openrouter", "resend"])
        raw = harness.exchange(
            "GET",
            "/openrouter/api/v1/x",
            [("authorization", "Bearer " + issued["openrouter"])],
        )
        self.assertEqual(_parse_response(raw)[0], 200)
        auths = [value for name, value in harness.recorder.calls[0]["headers"] if name.lower() == "authorization"]
        self.assertEqual(auths, ["Bearer " + SECRET])
        harness.recorder.factory_calls.clear()
        raw = harness.exchange(
            "GET",
            "/openrouter/api/v1/x",
            [("Authorization", "Bearer " + issued["resend"])],
        )
        _assert_error(self, raw, 401, "bad_placeholder")
        self.assertEqual(harness.recorder.factory_calls, [])

    def test_refusal_body_is_exact_json(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        cases = [
            ("GET", "/openrouter/%zz-" + ECHO_TOKEN, harness.auth(placeholder), None, 400, "bad_request"),
            ("GET", "/" + ECHO_TOKEN + "/nope", [], None, 404, "unknown_service"),
            ("GET", "/openrouter/api/v1/x", [], None, 401, "missing_placeholder"),
            ("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + ECHO_TOKEN)], None, 401, "bad_placeholder"),
            ("DELETE", "/openrouter/api/v1/x", harness.auth(placeholder), None, 403, "method_not_allowed"),
            ("GET", "/openrouter/" + ECHO_TOKEN, harness.auth(placeholder), None, 403, "path_not_allowed"),
        ]
        for method, target, headers, body, status, code in cases:
            with self.subTest(code=code):
                before = len(harness.recorder.factory_calls)
                raw = harness.exchange(method, target, headers, body)
                _assert_error(self, raw, status, code)
                self.assertNotIn(ECHO_TOKEN.encode("ascii"), raw)
                self.assertEqual(len(harness.recorder.factory_calls), before)

    def test_refusal_precedence_and_zero_upstream(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange("GET", "/missing/api/v1/x", [])
        _assert_error(self, raw, 404, "unknown_service")
        raw = harness.exchange(
            "GET",
            "/openrouter/not-allowed",
            [("Authorization", "Bearer not-the-placeholder")],
        )
        _assert_error(self, raw, 401, "bad_placeholder")
        raw = harness.exchange(
            "GET",
            "/openrouter/api/v1/x",
            [("Authorization", "Bearer " + placeholder), ("Authorization", "Bearer " + placeholder)],
        )
        _assert_error(self, raw, 401, "missing_placeholder")
        raw = harness.exchange(
            "GET",
            "/openrouter/api/v1/x?" + placeholder,
            [("X-Leak", placeholder)],
        )
        _assert_error(self, raw, 401, "missing_placeholder")
        raw = harness.exchange("PUT", "/openrouter/not-allowed", harness.auth(placeholder))
        _assert_error(self, raw, 403, "method_not_allowed")
        self.assertEqual(harness.recorder.factory_calls, [])

    def test_placeholder_leak_locations(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        encoded = "".join("%%%02X" % ord(ch) for ch in placeholder)
        cases = [
            ("GET", "/openrouter/api/v1/x", harness.auth(placeholder) + [("X-Debug", placeholder)], None),
            ("GET", "/openrouter/api/v1/" + placeholder, harness.auth(placeholder), None),
            ("GET", "/openrouter/api/v1/x?q=" + placeholder, harness.auth(placeholder), None),
            ("GET", "/openrouter/api/v1/x?q=" + encoded, harness.auth(placeholder), None),
            ("POST", "/openrouter/api/v1/x", harness.auth(placeholder), b"prefix-" + placeholder.encode("ascii")),
        ]
        for method, target, headers, body in cases:
            with self.subTest(target=target[:40]):
                raw = harness.exchange(method, target, headers, body)
                _assert_error(self, raw, 403, "placeholder_leak")
                _assert_absent(self, raw, placeholder, "placeholder")
        self.assertEqual(harness.recorder.factory_calls, [])

    def test_placeholder_header_name_is_leak(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange(
            "GET",
            "/openrouter/api/v1/x",
            harness.auth(placeholder) + [(placeholder, "x")],
        )
        _assert_error(self, raw, 403, "placeholder_leak")
        _assert_absent(self, raw, placeholder, "placeholder")
        self.assertEqual(harness.recorder.factory_calls, [])
        self.assertEqual(harness.recorder.calls, [])
        self.assertEqual(harness.recorder.opened, 0)

    def test_body_size_boundary_for_leaks(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        small = b"a" * (ONE_MIB - 1 - len(placeholder)) + placeholder.encode("ascii")
        self.assertEqual(len(small), ONE_MIB - 1)
        raw = harness.exchange("POST", "/openrouter/api/v1/x", harness.auth(placeholder), small, timeout=20)
        _assert_error(self, raw, 403, "placeholder_leak")
        self.assertEqual(harness.recorder.factory_calls, [])
        big = b"a" * (ONE_MIB - len(placeholder)) + placeholder.encode("ascii")
        self.assertEqual(len(big), ONE_MIB)
        cap, _root = self._logs()
        raw = harness.exchange("POST", "/openrouter/api/v1/x", harness.auth(placeholder), big, timeout=20)
        self.assertNotIn(b'{"error":"placeholder_leak"}', raw)
        _assert_absent(self, raw, placeholder, "placeholder")
        _assert_absent(self, raw, SECRET, "secret")
        obj = _one_log(self, cap)
        self.assertEqual(obj["status"], "-")
        self.assertEqual(obj["reason"], "placeholder_leak")
        joined = b"".join(call["body"] for call in harness.recorder.calls)
        _assert_absent(self, joined, placeholder, "placeholder")

    def test_chunked_leak_aborts_without_refusal_body(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        chunk = placeholder.encode("ascii")
        payload = ("POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer %s\r\nTransfer-Encoding: chunked\r\n\r\n%x\r\n" % (placeholder, len(chunk))).encode("ascii")
        payload += chunk + b"\r\n0\r\n\r\n"
        cap, _root = self._logs()
        raw = _exchange(harness.port, payload, timeout=5)
        self.assertNotIn(b'{"error"', raw)
        obj = _one_log(self, cap)
        self.assertEqual(obj["status"], "-")
        self.assertEqual(obj["reason"], "placeholder_leak")
        self.assertGreaterEqual(harness.recorder.opened, 1)
        _assert_absent(self, raw, placeholder, "placeholder")

    def test_placeholder_split_across_chunks_is_refused(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        token = placeholder.encode("ascii")
        mid = len(token) // 2
        left, right = token[:mid], token[mid:]
        self.assertGreater(len(left), 0)
        self.assertGreater(len(right), 0)
        self.assertNotIn(token, left)
        self.assertNotIn(token, right)
        payload = (
            "POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            "Authorization: Bearer %s\r\nTransfer-Encoding: chunked\r\n\r\n" % placeholder
        ).encode("ascii")
        payload += b"%x\r\n" % len(left) + left + b"\r\n"
        payload += b"%x\r\n" % len(right) + right + b"\r\n"
        payload += b"0\r\n\r\n"
        cap, _root = self._logs()
        raw = _exchange(harness.port, payload, timeout=5)
        self.assertNotEqual(_parse_response(raw)[0], 200)
        _assert_absent(self, raw, placeholder, "placeholder")
        obj = _one_log(self, cap)
        self.assertEqual(obj["status"], "-")
        self.assertEqual(obj["reason"], "placeholder_leak")
        received = b"".join(call["body"] for call in harness.recorder.calls)
        self.assertEqual(received, b"")

    def test_encoded_dotdot_rejected_not_prefix_matched(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        for target in (
            "/openrouter/api/v1/%2e%2e/secret",
            "/openrouter/api/v1/%2E%2E/secret",
            "/openrouter/api/v1/%2fhidden",
            "/openrouter/api/v1/%5csecret",
            "/openrouter/api/v1/../x",
            "/openrouter/api/v1/./x",
            "/openrouter/api\\v1/x",
        ):
            with self.subTest(target=target):
                raw = harness.exchange("GET", target, harness.auth(placeholder))
                _assert_error(self, raw, 400, "bad_request")
        self.assertEqual(harness.recorder.factory_calls, [])
        raw = harness.exchange("GET", "/openrouter/api/v1/%252e%252e?q=%2f", harness.auth(placeholder))
        self.assertEqual(_parse_response(raw)[0], 200)
        self.assertEqual(harness.recorder.calls[-1]["target"], "/api/v1/%252e%252e?q=%2f")

    def test_response_streams_without_buffering_whole_body(self) -> None:
        harness = self._harness()
        gate = GateResponse()
        harness.recorder.response = gate
        placeholder = harness.mint()["openrouter"]

        def on_body(_body: bytes) -> None:
            gate.client_got_byte.set()

        raw = harness.exchange(
            "GET",
            "/openrouter/api/v1/x",
            harness.auth(placeholder),
            timeout=15,
            on_first_body=on_body,
        )
        self.assertTrue(gate.saw_client)
        self.assertIn(b"A" * 1024, raw)
        self.assertIn(b"B" * 1024, raw)
        _assert_absent(self, raw, SECRET, "secret")

    def test_large_body_is_byte_identical(self) -> None:
        harness = self._harness()
        payload = b"0123456789abcdef" * (5 * 1024 * 1024 // 16)
        self.assertGreaterEqual(len(payload), 5 * 1024 * 1024)
        self.assertNotIn(SECRET.encode("ascii"), payload)
        harness.recorder.response = BytesResponse(payload)
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder), timeout=60)
        _status, _headers, body, _raw = _parse_response(raw)
        if body != payload:
            self.fail("streamed body mismatch %d vs %d" % (len(body), len(payload)))

    def test_response_drops_secret_bearing_headers(self) -> None:
        harness = self._harness()
        harness.recorder.headers = [
            ("Content-Type", "text/plain"),
            ("Content-Length", "4"),
            ("Authorization", "Bearer " + SECRET),
            ("X-Echo", "prefix-" + SECRET),
            ("X-Ok", "visible"),
        ]
        harness.recorder.chunks = [b"safe"]
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        status, headers, body, _raw = _parse_response(raw)
        self.assertEqual(status, 200)
        self.assertEqual(body, b"safe")
        self.assertEqual(headers.get(b"x-ok"), [b"visible"])
        self.assertNotIn(b"authorization", headers)
        self.assertNotIn(b"x-echo", headers)
        _assert_absent(self, raw, SECRET, "secret")

    def test_secret_split_across_chunks_is_not_written(self) -> None:
        harness = self._harness()
        secret = "SECRETX"
        root = harness.root
        _write(root / "secrets.env", "KEY=%s\n" % secret, 0o600)
        # The harness already resolved SECRET. Build a dedicated server for this value.
        harness.stop()
        split = root / "split"
        split.mkdir()
        providers = _provider_tree(split, {"KEY": secret})
        store = broker.PlaceholderStore()
        recorder = Recorder()
        recorder.chunks = [b"SAFESEC", b"RETXrest"]
        recorder.headers = [("Content-Type", "text/plain")]
        server = broker.BrokerServer(_config(providers), store, recorder.factory)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(_join_after_shutdown, server, thread)
        placeholder = store.mint("task-split", ["openrouter"])["openrouter"]
        cap, _root = self._logs()
        raw = _exchange(
            server.bound_port,
            _request_bytes("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]),
        )
        _assert_absent(self, raw, secret, "secret")
        self.assertIn(b"SAFE", raw)
        self.assertNotIn(b"RETXrest", raw)
        obj = _one_log(self, cap)
        self.assertEqual(obj["status"], 200)
        self.assertEqual(obj["reason"], "secret_in_response")

    def test_secret_match_starts_in_carry_and_one_character(self) -> None:
        secret = "SECRETX"
        root = Path(tempfile.mkdtemp(prefix="ak-broker-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        providers = _provider_tree(root, {"KEY": secret})
        store = broker.PlaceholderStore()
        recorder = Recorder()
        recorder.chunks = [b"SAFESECRET", b"Xrest"]
        recorder.headers = [("Content-Type", "text/plain")]
        server = broker.BrokerServer(_config(providers), store, recorder.factory)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(_join_after_shutdown, server, thread)
        placeholder = store.mint("task-carry", ["openrouter"])["openrouter"]
        raw = _exchange(
            server.bound_port,
            _request_bytes("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]),
        )
        _assert_absent(self, raw, secret, "secret")
        self.assertIn(b"SAFE", raw)
        _join_after_shutdown(server, thread)

        tiny = "~"
        tiny_root = root / "tiny"
        tiny_root.mkdir()
        providers = _provider_tree(tiny_root, {"KEY": tiny})
        store = broker.PlaceholderStore()
        recorder = Recorder()
        recorder.chunks = [b"ab~cd"]
        recorder.headers = [("Content-Type", "text/plain"), ("Content-Length", "5")]
        server = broker.BrokerServer(_config(providers), store, recorder.factory)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(_join_after_shutdown, server, thread)
        placeholder = store.mint("task-tiny", ["openrouter"])["openrouter"]
        cap, _root = self._logs()
        raw = _exchange(
            server.bound_port,
            _request_bytes("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]),
        )
        _status, _headers, body, _raw = _parse_response(raw)
        self.assertEqual(body, b"ab")
        _assert_absent(self, raw, tiny, "secret")
        obj = _one_log(self, cap)
        self.assertEqual(obj["reason"], "secret_in_response")

        short_root = root / "short"
        short_root.mkdir()
        providers = _provider_tree(short_root, {"KEY": "LONGSECRETVALUE"})
        store = broker.PlaceholderStore()
        recorder = Recorder()
        recorder.chunks = [b"hello-tail"]
        server = broker.BrokerServer(_config(providers), store, recorder.factory)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(_join_after_shutdown, server, thread)
        placeholder = store.mint("task-short", ["openrouter"])["openrouter"]
        raw = _exchange(
            server.bound_port,
            _request_bytes("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]),
        )
        _status, _headers, body, _raw = _parse_response(raw)
        self.assertEqual(body, b"hello-tail")

    def test_each_injected_502_is_fixed_body(self) -> None:
        causes = [
            ("dns", socket.gaierror(8, "injected-dns-detail")),
            ("tls", ssl.SSLError("injected-tls-detail")),
            ("timeout", socket.timeout("injected-timeout-detail")),
            ("malformed", http.client.HTTPException("injected-malformed-detail")),
            ("connection", ConnectionError("injected-connection-detail")),
        ]
        for name, exc in causes:
            with self.subTest(cause=name):
                harness = self._harness()
                harness.recorder.fail = exc
                placeholder = harness.mint()["openrouter"]
                cap, root_cap = self._logs()
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
                _assert_error(self, raw, 502, "upstream_error")
                detail = str(exc)
                self.assertNotIn(detail.encode("utf-8", "replace"), raw)
                obj = _one_log(self, cap)
                self.assertEqual(obj["reason"], "upstream_error")
                self.assertEqual(obj["status"], 502)
                blob = "\n".join(cap.lines + root_cap.lines) + stderr.getvalue()
                self.assertNotIn("injected-", blob)
                _assert_absent(self, blob, SECRET, "secret")
                _assert_absent(self, blob, placeholder, "placeholder")

    def test_redirect_is_not_followed(self) -> None:
        httpd = http.server.HTTPServer(("127.0.0.1", 0), _CaptureHandler)
        httpd.seen = []
        httpd.payload = b"FOLLOWED-CANARY"
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(_join_after_shutdown, httpd, thread)
        fixture = httpd.server_address[1]
        harness = self._harness()
        harness.recorder.status = 302
        harness.recorder.headers = [
            ("Location", "http://127.0.0.1:%d/stolen" % fixture),
            ("Content-Type", "text/plain"),
            ("Content-Length", "15"),
        ]
        harness.recorder.chunks = [b"FOLLOWED-CANARY"]
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        _assert_error(self, raw, 502, "upstream_error")
        self.assertNotIn(b"FOLLOWED-CANARY", raw)
        self.assertEqual(httpd.seen, [])
        self.assertEqual(len(harness.recorder.factory_calls), 1)

    def test_head_no_body_and_framing_rules(self) -> None:
        harness = self._harness(services=[_service(methods=["GET", "POST", "HEAD"])])
        placeholder = harness.mint()["openrouter"]
        for status, phrase in ((204, "204"), (304, "304"), (100, "100")):
            with self.subTest(status=status):
                harness.recorder.status = status
                harness.recorder.headers = [("Content-Length", "5"), ("X-Ok", "yes")]
                harness.recorder.chunks = [b"CANARY"]
                raw = harness.exchange("GET" if status != 100 else "GET", "/openrouter/api/v1/x", harness.auth(placeholder))
                got, _headers, body, _raw = _parse_response(raw)
                self.assertEqual(got, status)
                self.assertEqual(body, b"")
                self.assertNotIn(b"CANARY", raw)
        harness.recorder.status = 200
        harness.recorder.headers = [("Content-Type", "text/plain"), ("Content-Length", "4"), ("X-Body", "hidden")]
        harness.recorder.chunks = [b"nope"]
        raw = harness.exchange("HEAD", "/openrouter/api/v1/x", harness.auth(placeholder))
        got, headers, body, _raw = _parse_response(raw)
        self.assertEqual(got, 200)
        self.assertEqual(body, b"")
        self.assertNotIn(b"nope", raw)
        self.assertEqual(headers.get(b"content-length"), [b"4"])
        harness.recorder.status = 101
        harness.recorder.headers = [("Content-Length", "5")]
        harness.recorder.chunks = [b"CANARY"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        _assert_error(self, raw, 502, "upstream_error")
        self.assertNotIn(b"CANARY", raw)
        harness.recorder.status = 200
        harness.recorder.headers = [("Content-Encoding", "gzip"), ("Content-Length", "5")]
        harness.recorder.chunks = [b"CANARY"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        _assert_error(self, raw, 502, "upstream_error")
        self.assertNotIn(b"CANARY", raw)
        harness.recorder.headers = [
            ("Content-Encoding", "identity"),
            ("Content-Type", "text/plain"),
            ("Content-Length", "5"),
        ]
        harness.recorder.chunks = [b"plain"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        got, headers, body, _raw = _parse_response(raw)
        self.assertEqual(got, 200)
        self.assertEqual(body, b"plain")
        self.assertEqual(headers.get(b"content-encoding"), [b"identity"])
        harness.recorder.headers = [
            ("Content-Type", "text/plain"),
            ("Connection", "x-drop"),
            ("X-Drop", "gone"),
            ("X-Keep", "stay"),
        ]
        harness.recorder.chunks = [b"hi"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        got, headers, body, _raw = _parse_response(raw)
        self.assertEqual(got, 200)
        self.assertEqual(body, b"hi")
        self.assertNotIn(b"x-drop", headers)
        self.assertNotIn(b"transfer-encoding", headers)
        self.assertEqual(headers.get(b"connection"), [b"close"])
        self.assertEqual(headers.get(b"x-keep"), [b"stay"])

    def test_truncated_content_length_is_upstream_error(self) -> None:
        harness = self._harness()
        harness.recorder.headers = [("Content-Type", "text/plain"), ("Content-Length", "5")]
        harness.recorder.chunks = [b"hi"]
        placeholder = harness.mint()["openrouter"]
        cap, _root = self._logs()
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        _status, headers, body, _raw = _parse_response(raw)
        self.assertEqual(headers.get(b"content-length"), [b"5"])
        self.assertLess(len(body), 5)
        self.assertNotIn(b'{"error"', raw)
        obj = _one_log(self, cap)
        self.assertEqual(obj["reason"], "upstream_error")
        self.assertEqual(obj["status"], 200)

    def test_runtime_error_after_head_writes_no_refusal(self) -> None:
        harness = self._harness()
        first = b"A" * 80
        harness.recorder.response = RaisingResponse(first, RuntimeError("injected-runtime-detail"))
        placeholder = harness.mint()["openrouter"]
        cap, root_cap = self._logs()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        _status, _headers, body, _raw = _parse_response(raw)
        self.assertIn(b"A" * 40, body)
        self.assertNotIn(b'{"error"', raw)
        self.assertNotIn(b"injected-runtime-detail", raw)
        obj = _one_log(self, cap)
        self.assertEqual(obj["reason"], "upstream_error")
        blob = "\n".join(cap.lines + root_cap.lines) + stderr.getvalue()
        self.assertNotIn("injected-runtime-detail", blob)

    def test_body_too_large(self) -> None:
        harness = self._harness(max_request_body_bytes=100)
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange(
            "GET",
            "/openrouter/not-allowed",
            harness.auth(placeholder) + [("Content-Length", "101")],
            shutdown=False,
            timeout=3,
        )
        _assert_error(self, raw, 403, "path_not_allowed")
        payload = (
            "POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            "Authorization: Bearer %s\r\nContent-Length: 101\r\n\r\n" % placeholder
        ).encode("ascii")
        raw = _exchange(harness.port, payload, timeout=3, shutdown=False)
        _assert_error(self, raw, 413, "body_too_large")
        self.assertEqual(harness.recorder.factory_calls, [])
        cap, _root = self._logs()
        chunked = (
            "POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            "Authorization: Bearer %s\r\nTransfer-Encoding: chunked\r\n\r\n"
            "3c\r\n%s\r\n3c\r\n%s\r\n0\r\n\r\n" % (placeholder, "a" * 60, "b" * 60)
        ).encode("ascii")
        raw = _exchange(harness.port, chunked, timeout=5)
        self.assertNotIn(b'{"error"', raw)
        obj = _one_log(self, cap)
        self.assertEqual(obj["status"], "-")
        self.assertEqual(obj["reason"], "body_too_large")

    def test_request_framing_and_malformed_syntax(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        auth = "Authorization: Bearer %s\r\n" % placeholder
        base = "POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n" + auth
        bad = [
            base + "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n",
            base + "Content-Length: 1\r\nContent-Length: 1\r\n\r\n",
            base + "Content-Length: -1\r\n\r\n",
            base + "Transfer-Encoding: gzip\r\n\r\n",
            "GET /openrouter/api/v1/x#frag HTTP/1.1\r\nHost: 127.0.0.1\r\n" + auth + "\r\n",
            "GET /openrouter/api/v1/x?q=%ZZ HTTP/1.1\r\nHost: 127.0.0.1\r\n" + auth + "\r\n",
            base + "Content-Length: 10\r\n\r\nhi",
        ]
        for payload in bad:
            with self.subTest(payload=payload.split("\r\n")[-3]):
                before = len(harness.recorder.factory_calls)
                raw = _exchange(harness.port, payload.encode("iso-8859-1"), timeout=3)
                _assert_error(self, raw, 400, "bad_request")
                self.assertEqual(len(harness.recorder.factory_calls), before)
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        self.assertEqual(_parse_response(raw)[0], 200)
        self.assertEqual(harness.recorder.calls[-1]["body"], b"")
        lengths = [value for name, value in harness.recorder.calls[-1]["headers"] if name.lower() == "content-length"]
        self.assertEqual(lengths, ["0"])

    def test_chunked_framing_abort(self) -> None:
        harness = self._harness()
        placeholder = harness.mint()["openrouter"]
        cap, _root = self._logs()
        payloads = [
            "5\r\nabc",
            "zz\r\n",
            "0\r\nNotAHeader\r\n",
        ]
        for body in payloads:
            del cap.lines[:]
            head = (
                "POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                "Authorization: Bearer %s\r\nTransfer-Encoding: chunked\r\n\r\n%s" % (placeholder, body)
            ).encode("ascii")
            raw = _exchange(harness.port, head, timeout=3)
            self.assertNotIn(b'{"error"', raw)
            obj = _one_log(self, cap)
            self.assertEqual(obj["status"], "-")
            self.assertEqual(obj["reason"], "bad_request")
        del cap.lines[:]
        head = (
            "POST /openrouter/api/v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\n"
            "Authorization: Bearer %s\r\nContent-Length: 1048576\r\n\r\nhi" % placeholder
        ).encode("ascii")
        raw = _exchange(harness.port, head, timeout=3)
        self.assertNotIn(b'{"error"', raw)
        obj = _one_log(self, cap)
        self.assertEqual(obj["status"], "-")
        self.assertEqual(obj["reason"], "bad_request")

    def test_malformed_request_is_json_not_html(self) -> None:
        harness = self._harness()
        cap, _root = self._logs()
        stderr = io.StringIO()
        samples = [
            b"NOT A REQUEST\r\n\r\n",
            b"GET /openrouter/api/v1/x HTTP/2\r\n\r\n",
            b"GET http://example.com/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            b"OPTIONS * HTTP/1.1\r\n\r\n",
            b"GET /openrouter/api/v1/x HTTP/1.1\r\nAuthorization Bearer x\r\n\r\n",
        ]
        with contextlib.redirect_stderr(stderr):
            for index, payload in enumerate(samples):
                del cap.lines[:]
                raw = _exchange(harness.port, payload, timeout=3)
                if b"\r\n\r\n" not in raw:
                    self.fail("sample %d yielded %r" % (index, raw[:180]))
                _assert_error(self, raw, 400, "bad_request")
                self.assertNotIn(payload.split(b"\r\n", 1)[0], raw)
                obj = _one_log(self, cap)
                self.assertEqual(obj["status"], 400)
                self.assertEqual(obj["reason"], "bad_request")
                self.assertNotIn("/", obj["service"])
        self.assertNotIn("GET /", stderr.getvalue())
        self.assertEqual(harness.recorder.factory_calls, [])

    def test_revoke_and_expiry_timing(self) -> None:
        clock = Clock(1000)
        harness = self._harness(clock=clock, placeholder_ttl_seconds=10)
        placeholder = harness.mint()["openrouter"]
        clock.now = 1009
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        self.assertEqual(_parse_response(raw)[0], 200)
        clock.now = 1010
        harness.recorder.factory_calls.clear()
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        _assert_error(self, raw, 401, "expired_placeholder")
        self.assertEqual(harness.recorder.factory_calls, [])
        clock.now = 1000
        fresh = harness.mint("task-2")["openrouter"]
        harness.store.revoke(fresh)
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(fresh))
        _assert_error(self, raw, 401, "revoked_placeholder")
        self.assertEqual(harness.recorder.factory_calls, [])
        leaked = fresh
        current = harness.mint("task-3")["openrouter"]
        raw = harness.exchange(
            "GET",
            "/openrouter/api/v1/x",
            harness.auth(current) + [("X-Old", leaked)],
        )
        _assert_error(self, raw, 403, "placeholder_leak")

        def revoke_late() -> None:
            harness.store.revoke(current)

        harness.recorder.on_request = revoke_late
        harness.recorder.factory_calls.clear()
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(current))
        self.assertEqual(_parse_response(raw)[0], 200)
        self.assertEqual(len(harness.recorder.factory_calls), 1)

    def test_restart_invalidates_placeholders_and_resolves_once(self) -> None:
        calls: list[tuple] = []
        real = broker.providers.resolve

        def wrapped(ref: tuple, config: dict, environ: object = None, config_path: object = None) -> str:
            calls.append(ref)
            return real(ref, config, environ=environ, config_path=config_path)

        root = Path(tempfile.mkdtemp(prefix="ak-broker-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        providers = _provider_tree(root, {"KEY": SECRET, "OTHER": OTHER_SECRET})
        services = [
            _service(),
            _service(name="resend", upstream="https://api.resend.com", secret="secretref://file/lanes/KEY"),
        ]
        with mock.patch.object(broker.providers, "resolve", wrapped):
            store = broker.PlaceholderStore()
            recorder = Recorder()
            server = broker.BrokerServer(_config(providers, services=services), store, recorder.factory)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(_join_after_shutdown, server, thread)
            placeholder = store.mint("task-1", ["openrouter"])["openrouter"]
            raw = _exchange(
                server.bound_port,
                _request_bytes("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]),
            )
            self.assertEqual(_parse_response(raw)[0], 200)
            self.assertEqual(len(calls), 1)
            port = server.bound_port
            _join_after_shutdown(server, thread)
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", port), timeout=2)
            store2 = broker.PlaceholderStore()
            recorder2 = Recorder()
            server2 = broker.BrokerServer(_config(providers, services=services), store2, recorder2.factory)
            thread2 = threading.Thread(target=server2.serve_forever, daemon=True)
            thread2.start()
            self.addCleanup(_join_after_shutdown, server2, thread2)
            raw = _exchange(
                server2.bound_port,
                _request_bytes("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer " + placeholder)]),
            )
            _assert_error(self, raw, 401, "bad_placeholder")
            self.assertEqual(recorder2.factory_calls, [])
            self.assertEqual(len(calls), 2)

    def test_other_service_secret_is_scanned(self) -> None:
        services = [
            _service(),
            _service(name="resend", upstream="https://api.resend.com", secret="secretref://file/lanes/OTHER"),
        ]
        harness = self._harness(services=services)
        harness.recorder.chunks = [b"prefix-" + OTHER_SECRET.encode("ascii")]
        harness.recorder.headers = [("Content-Type", "text/plain")]
        placeholder = harness.mint()["openrouter"]
        cap, _root = self._logs()
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        _assert_absent(self, raw, OTHER_SECRET, "secret")
        _assert_absent(self, raw, SECRET, "secret")
        obj = _one_log(self, cap)
        self.assertEqual(obj["reason"], "secret_in_response")

    def test_logs_cover_forward_refusal_and_502(self) -> None:
        clock = Clock(1000)
        harness = self._harness(clock=clock, placeholder_ttl_seconds=10)
        cap, root_cap = self._logs()
        stderr = io.StringIO()
        placeholder = harness.mint()["openrouter"]
        samples = []
        with contextlib.redirect_stderr(stderr):
            def run(method: str, target: str, headers: list, body: bytes | None = None) -> None:
                del cap.lines[:]
                del root_cap.lines[:]
                raw = harness.exchange(method, target, headers, body)
                obj = _one_log(self, cap)
                samples.append(obj)
                _assert_absent(self, raw, SECRET, "secret")
                _assert_absent(self, raw, placeholder, "placeholder")

            run("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
            run("GET", "/%zz", [])
            run("GET", "/missing/x", [])
            run("GET", "/openrouter/api/v1/x", [])
            run("GET", "/openrouter/api/v1/x", [("Authorization", "Bearer nope")])
            clock.now = 1010
            run("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
            clock.now = 1000
            fresh = harness.mint("task-log")["openrouter"]
            harness.store.revoke(fresh)
            run("GET", "/openrouter/api/v1/x", harness.auth(fresh))
            alive = harness.mint("task-alive")["openrouter"]
            run("GET", "/openrouter/api/v1/x", harness.auth(alive) + [("X-Leak", fresh)])
            run("DELETE", "/openrouter/api/v1/x", harness.auth(alive))
            run("GET", "/openrouter/nope", harness.auth(alive))
            harness.recorder.fail = socket.timeout("injected-timeout-detail")
            run("GET", "/openrouter/api/v1/x", harness.auth(alive))
        reasons = [item["reason"] for item in samples]
        self.assertEqual(reasons, [
            "-",
            "bad_request",
            "unknown_service",
            "missing_placeholder",
            "bad_placeholder",
            "expired_placeholder",
            "revoked_placeholder",
            "placeholder_leak",
            "method_not_allowed",
            "path_not_allowed",
            "upstream_error",
        ])
        blob = stderr.getvalue() + "\n".join(cap.lines + root_cap.lines)
        _assert_absent(self, blob, SECRET, "secret")
        _assert_absent(self, blob, placeholder, "placeholder")
        _assert_absent(self, blob, fresh, "placeholder")
        _assert_absent(self, blob, alive, "placeholder")
        self.assertNotIn("injected-", blob)

    def test_tls_verification_stays_on(self) -> None:
        text = (BROKER / "broker.py").read_text()
        for banned in ("CERT_NONE", "CERT_OPTIONAL", "_create_unverified_context", "check_hostname = False", "check_hostname=False"):
            self.assertNotIn(banned, text)
        upstream = broker.default_upstream_factory({"upstream": "https://openrouter.ai"}, 5)
        try:
            self.assertEqual(upstream.ssl_context.verify_mode, ssl.CERT_REQUIRED)
            self.assertIs(upstream.ssl_context.check_hostname, True)
        finally:
            upstream.close()
        tree = ast.parse(text)
        allowed = {
            "__future__", "json", "logging", "os", "re", "secrets", "socket", "ssl",
            "stat", "sys", "threading", "time", "urllib", "http", "providers", "refs",
        }
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertIn(alias.name.split(".")[0], allowed)
            elif isinstance(node, ast.ImportFrom):
                self.assertIn((node.module or "").split(".")[0], allowed)

    def test_shutdown_refuses_new_connections(self) -> None:
        harness = self._harness()
        port = harness.port
        placeholder = harness.mint()["openrouter"]
        raw = harness.exchange("GET", "/openrouter/api/v1/x", harness.auth(placeholder))
        self.assertEqual(_parse_response(raw)[0], 200)
        harness.stop()
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=2)


if __name__ == "__main__":
    unittest.main()
