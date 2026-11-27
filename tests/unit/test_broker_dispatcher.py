#!/usr/bin/env python3
"""Secret broker admin socket and dispatcher integration (#194). Stdlib unittest.

Part one drives the real ``BrokerServer`` through its admin socket and loopback
HTTP port, with an in-process upstream double. Part two drives
``mc_dispatcher.run_task`` against a scripted admin socket (and once against the
real broker), with no git, no network and no real CLI. Python 3.9 compatible.
Nothing here is a real secret.
"""
from __future__ import annotations

import builtins
import http.client
import json
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
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agents" / "broker"))
sys.path.insert(0, str(ROOT / "agents" / "dispatcher"))
import ak_pointers  # noqa: E402
import broker  # noqa: E402
import child_env  # noqa: E402
import mc_dispatcher as md  # noqa: E402

SECRET = "fixture-secret-VALUE-194"
REAL_KEY = "real-key-CANARY-194-must-not-reach-child"
PREFIX = "secret broker unavailable, no worker started"
REDACTED = "[broker-redacted]"
BLOCK = f'{ak_pointers.POINTERS_BEGIN}\n- a (1.0.0, aaaaaaa) — first. Fetch: get_skill {{"id":"a"}}\n{ak_pointers.POINTERS_END}'
MAX_LINE = 65536
REAL_RUN_CLI = md.run_cli


def _short_tmp(test: unittest.TestCase) -> Path:
    # AF_UNIX paths are limited to ~104 bytes; keep the directory short.
    base = "/tmp" if os.path.isdir("/tmp") else None
    path = Path(tempfile.mkdtemp(prefix="akbd-", dir=base))
    test.addCleanup(shutil.rmtree, str(path), True)
    return path


def _write(path: Path, data: str) -> None:
    path.write_text(data)
    os.chmod(path, 0o600)


def _service(name: str, env_key: str, env_base_url: str, upstream: str = "https://up.invalid") -> dict:
    return {
        "name": name,
        "upstream": upstream,
        "header": "Authorization",
        "template": "Bearer {secret}",
        "secret": "secretref://file/lanes/KEY",
        "methods": ["GET", "POST"],
        "path_prefixes": ["/v1/"],
        "env_key": env_key,
        "env_base_url": env_base_url,
    }


def _config(root: Path, **overrides: object) -> dict:
    secrets_file = root / "secrets.env"
    _write(secrets_file, "KEY=%s\n" % SECRET)
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
        "services": [
            _service("openrouter", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"),
            _service("resend", "RESEND_API_KEY", "RESEND_BASE_URL"),
        ],
    }
    data.update(overrides)
    return data


class _Resp:
    def __init__(self, status: int, headers: list, body: bytes) -> None:
        self.status = status
        self.headers = headers
        self._chunks = [body]

    def read_chunk(self, _n: int) -> bytes:
        return self._chunks.pop(0) if self._chunks else b""


class Upstream:
    """In-process upstream double. Records every forwarded request's headers."""

    def __init__(self) -> None:
        self.calls: list[list] = []
        self.headers: list | None = None
        self.body = b"ok"

    def factory(self, _service: dict, _timeout: object) -> object:
        outer = self

        class Conn:
            def request(self, method: str, target: str, headers: list, body_chunks: object) -> _Resp:
                for _piece in body_chunks:
                    pass
                outer.calls.append(list(headers))
                hdrs = outer.headers
                if hdrs is None:
                    hdrs = [("Content-Type", "text/plain"), ("Content-Length", str(len(outer.body)))]
                return _Resp(200, list(hdrs), outer.body)

            def close(self) -> None:
                return None

        return Conn()


def admin_conn(path: str, timeout: float = 5) -> socket.socket:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(path)
    except BaseException:
        sock.close()
        raise
    return sock


def read_line(sock: socket.socket) -> bytes:
    buf = b""
    while b"\n" not in buf:
        block = sock.recv(65536)
        if not block:
            return buf
        buf += block
    return buf


def admin_raw(path: str, raw: bytes) -> bytes:
    sock = admin_conn(path)
    try:
        sock.sendall(raw)
        return read_line(sock)
    finally:
        sock.close()


def admin(path: str, request: object) -> dict:
    line = admin_raw(path, json.dumps(request).encode("utf-8") + b"\n")
    return json.loads(line.decode("utf-8"))


def http_get(port: int, service: str, placeholder: str | None, extra: dict | None = None) -> tuple:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        headers = dict(extra or {})
        if placeholder is not None:
            headers["Authorization"] = "Bearer " + placeholder
        conn.request("GET", "/%s/v1/models" % service, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


class BrokerRun:
    """A real BrokerServer on an ephemeral port, polled until both endpoints answer."""

    def __init__(self, test: unittest.TestCase, root: Path | None = None, config: dict | None = None) -> None:
        self.root = root or _short_tmp(test)
        self.config = config or _config(self.root)
        self.path = self.config["admin_socket"]
        self.upstream = Upstream()
        self.store = broker.PlaceholderStore()
        self.server = broker.BrokerServer(self.config, self.store, self.upstream.factory)
        self.port = self.server.bound_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.stopped = False
        test.addCleanup(self.stop)
        self.wait_ready(test)

    def wait_ready(self, test: unittest.TestCase) -> None:
        # C14: poll both, 10-second deadline, no fixed sleep.
        deadline = time.monotonic() + 10
        admin_ok = http_ok = False
        pause = threading.Event()
        while time.monotonic() < deadline and not (admin_ok and http_ok):
            if not admin_ok:
                try:
                    admin_ok = admin(self.path, {"op": "health"}) == {"ok": True}
                except (OSError, ValueError):
                    admin_ok = False
            if not http_ok:
                try:
                    http_ok = http_get(self.port, "openrouter", None)[0] == 401
                except OSError:
                    http_ok = False
            pause.wait(0.01)
        test.assertTrue(admin_ok and http_ok, "broker never became ready")

    def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        self.server.shutdown()
        self.thread.join(5)


# ---------------------------------------------------------------------------
# Part one: the admin socket (AC1, C7, C9, C11, C12, C16, A2) and identity rule.


class TestBrokerAdminSocket(unittest.TestCase):
    def test_broker_socket_mode_and_owner(self) -> None:
        run = BrokerRun(self)
        info = os.lstat(run.path)
        self.assertTrue(stat.S_ISSOCK(info.st_mode))
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.geteuid())

    def test_broker_health_mint_revoke_across_concurrent_connections(self) -> None:
        run = BrokerRun(self)
        errors: list = []
        results: dict = {}

        def worker(index: int) -> None:
            try:
                sock = admin_conn(run.path)
                try:
                    # Several requests on one connection, one line each.
                    sock.sendall(b'{"op":"health"}\n')
                    self.assertEqual(json.loads(read_line(sock)), {"ok": True})
                    task = "task-%d" % index
                    sock.sendall(json.dumps({"op": "mint", "task_id": task, "services": ["resend", "openrouter"]}).encode() + b"\n")
                    results[index] = json.loads(read_line(sock))
                finally:
                    sock.close()
            except BaseException as exc:  # noqa: BLE001 - reported below
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(errors, [])
        seen: set = set()
        for index in range(8):
            resp = results[index]
            self.assertIs(resp["ok"], True)
            self.assertEqual([g["service"] for g in resp["grants"]], ["resend", "openrouter"])
            for grant in resp["grants"]:
                self.assertEqual(set(grant), {"service", "placeholder", "env_key", "env_base_url", "base_url"})
                self.assertRegex(grant["placeholder"], r"\Aakp_[A-Za-z0-9_-]{43}\Z")
                self.assertEqual(grant["base_url"], "http://127.0.0.1:%d/%s" % (run.port, grant["service"]))
                self.assertNotIn(grant["placeholder"], seen)
                seen.add(grant["placeholder"])
            self.assertEqual(resp["grants"][1]["env_key"], "OPENROUTER_API_KEY")
            self.assertEqual(resp["grants"][1]["env_base_url"], "OPENROUTER_BASE_URL")
        placeholder = results[0]["grants"][1]["placeholder"]
        self.assertEqual(http_get(run.port, "openrouter", placeholder)[0], 200)
        self.assertEqual(admin(run.path, {"op": "revoke_task", "task_id": "task-0"}), {"ok": True})
        self.assertEqual(admin(run.path, {"op": "revoke_task", "task_id": "task-0"}), {"ok": True})
        self.assertEqual(admin(run.path, {"op": "revoke_task", "task_id": "never-minted"}), {"ok": True})
        status, body = http_get(run.port, "openrouter", placeholder)
        self.assertEqual(status, 401)
        self.assertEqual(body, b'{"error":"revoked_placeholder"}')
        # Another task's grant is unaffected.
        self.assertEqual(http_get(run.port, "openrouter", results[1]["grants"][1]["placeholder"])[0], 200)

    def test_broker_error_codes_and_server_keeps_serving(self) -> None:
        run = BrokerRun(self)
        canary = "echo-canary-194"
        cases = [
            (b"{\n", "malformed_json"),
            (b'{"op":"health",}\n', "malformed_json"),
            (b'{"op": NaN}\n', "malformed_json"),
            (b"[1]\n", "bad_request"),
            (b'"health"\n', "bad_request"),
            (b"{}\n", "bad_request"),
            (b'{"op":1}\n', "bad_request"),
            (b'{"op":"health","x":"%s"}\n' % canary.encode(), "bad_request"),
            (b'{"op":"health","op":"health"}\n', "bad_request"),
            (b'{"op":"mint","task_id":"","services":["openrouter"]}\n', "bad_request"),
            (b'{"op":"mint","task_id":7,"services":["openrouter"]}\n', "bad_request"),
            (b'{"op":"mint","task_id":"t","services":[]}\n', "bad_request"),
            (b'{"op":"mint","task_id":"t","services":"openrouter"}\n', "bad_request"),
            (b'{"op":"mint","task_id":"t","services":["openrouter","openrouter"]}\n', "bad_request"),
            (b'{"op":"mint","task_id":"t","services":[1]}\n', "bad_request"),
            (b'{"op":"mint","task_id":"t","services":["openrouter"],"extra":1}\n', "bad_request"),
            (b'{"op":"mint","task_id":"t"}\n', "bad_request"),
            (b'{"op":"revoke_task"}\n', "bad_request"),
            (b'{"op":"revoke_task","task_id":""}\n', "bad_request"),
            (b'{"op":"revoke_task","task_id":"t","x":1}\n', "bad_request"),
            (b'{"op":"%s"}\n' % canary.encode(), "unknown_op"),
            (b'{"op":"mint","task_id":"t","services":["openrouter","%s"]}\n' % canary.encode(), "unknown_service"),
        ]
        for raw, code in cases:
            with self.subTest(raw=raw):
                line = admin_raw(run.path, raw)
                self.assertTrue(line.endswith(b"\n"))
                self.assertEqual(json.loads(line), {"ok": False, "error": code})
                self.assertNotIn(canary.encode(), line)
                self.assertEqual(admin(run.path, {"op": "health"}), {"ok": True})
        # unknown_service created nothing (C7, C12).
        self.assertEqual(run.store.known_placeholders(), ())
        # internal: an unexpected failure inside the store.
        with mock.patch.object(run.store, "mint", side_effect=RuntimeError("boom " + canary)):
            line = admin_raw(run.path, b'{"op":"mint","task_id":"t","services":["openrouter"]}\n')
        self.assertEqual(json.loads(line), {"ok": False, "error": "internal"})
        self.assertNotIn(canary.encode(), line)
        # Over-limit and invalid UTF-8: bad_request, then that connection closes.
        for raw in (b"x" * MAX_LINE + b"\n", b'{"op":"' + b"a" * (MAX_LINE - 9) + b'"}\n', b'{"op":"\xff"}\n'):
            with self.subTest(size=len(raw)):
                sock = admin_conn(run.path)
                try:
                    try:
                        sock.sendall(raw)
                    except OSError:
                        pass  # the server may answer and close before the last bytes are read
                    line = read_line(sock)
                    self.assertEqual(json.loads(line), {"ok": False, "error": "bad_request"})
                    # Closed: EOF, or on Linux a reset because the server left our extra bytes unread.
                    try:
                        tail = sock.recv(10)
                    except ConnectionResetError:
                        tail = b""
                    self.assertEqual(tail, b"")
                finally:
                    sock.close()
                self.assertEqual(admin(run.path, {"op": "health"}), {"ok": True})
        # A line exactly at the limit (newline included) is accepted and parsed.
        body = b'{"op":"health"}'
        exact = body + b" " * (MAX_LINE - len(body) - 1) + b"\n"
        self.assertEqual(len(exact), MAX_LINE)
        self.assertEqual(json.loads(admin_raw(run.path, exact)), {"ok": True})

    def test_broker_idle_request_times_out_and_server_keeps_serving(self) -> None:
        run = BrokerRun(self)
        with mock.patch.object(broker, "_ADMIN_TIMEOUT", 0.3):
            sock = admin_conn(run.path)
            try:
                sock.sendall(b'{"op":"hea')
                self.assertEqual(sock.recv(10), b"")  # closed by the server, no response
            finally:
                sock.close()
        self.assertEqual(admin(run.path, {"op": "health"}), {"ok": True})

    def test_broker_stale_socket_replaced_and_non_socket_refused(self) -> None:
        root = _short_tmp(self)
        path = root / "admin.sock"
        dead = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        dead.bind(str(path))
        dead.close()
        self.assertTrue(stat.S_ISSOCK(os.lstat(path).st_mode))
        run = BrokerRun(self, root=root)
        self.assertEqual(admin(run.path, {"op": "health"}), {"ok": True})
        run.stop()

        regular = _short_tmp(self)
        cfg = _config(regular)
        Path(cfg["admin_socket"]).write_text("not a socket")
        with self.assertRaises(ValueError) as ctx:
            broker.BrokerServer(cfg, broker.PlaceholderStore(), Upstream().factory)
        self.assertIn("admin_socket", str(ctx.exception))
        self.assertEqual(Path(cfg["admin_socket"]).read_text(), "not a socket")

        linked = _short_tmp(self)
        cfg = _config(linked)
        target = linked / "target.sock"
        holder = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        holder.bind(str(target))
        holder.close()
        os.symlink(str(target), cfg["admin_socket"])
        with self.assertRaises(ValueError):
            broker.BrokerServer(cfg, broker.PlaceholderStore(), Upstream().factory)
        self.assertTrue(os.path.islink(cfg["admin_socket"]))

        # A live socket is never unlinked (C11).
        live_root = _short_tmp(self)
        cfg = _config(live_root)
        live = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        live.bind(cfg["admin_socket"])
        live.listen(1)
        self.addCleanup(live.close)
        before = os.lstat(cfg["admin_socket"]).st_ino
        with self.assertRaises(ValueError):
            broker.BrokerServer(cfg, broker.PlaceholderStore(), Upstream().factory)
        self.assertEqual(os.lstat(cfg["admin_socket"]).st_ino, before)

    def test_broker_socket_owned_by_other_uid_refused(self) -> None:
        root = _short_tmp(self)
        cfg = _config(root)
        dead = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        dead.bind(cfg["admin_socket"])
        dead.close()
        real = os.lstat

        class Fake:
            def __init__(self, info: os.stat_result) -> None:
                self.st_mode = info.st_mode
                self.st_uid = info.st_uid ^ 1
                self.st_dev = info.st_dev
                self.st_ino = info.st_ino

        def fake(path: object, *a: object, **k: object) -> object:
            info = real(path, *a, **k)
            return Fake(info) if str(path) == cfg["admin_socket"] else info

        with mock.patch.object(broker.os, "lstat", fake):
            with self.assertRaises(ValueError) as ctx:
                broker.BrokerServer(cfg, broker.PlaceholderStore(), Upstream().factory)
        self.assertIn("another user", str(ctx.exception))
        self.assertTrue(os.path.exists(cfg["admin_socket"]))

    def _refuse_parent(self, cfg: dict) -> None:
        with self.assertRaises(ValueError) as ctx:
            broker.BrokerServer(cfg, broker.PlaceholderStore(), Upstream().factory)
        self.assertIn("parent directory", str(ctx.exception))
        self.assertFalse(os.path.lexists(cfg["admin_socket"]))

    def test_broker_parent_writable_by_group_or_other_refused(self) -> None:
        for mode in (0o720, 0o702, 0o777, 0o1777):
            with self.subTest(mode=oct(mode)):
                root = _short_tmp(self)
                cfg = _config(root)
                os.chmod(root, mode)
                self.addCleanup(os.chmod, str(root), 0o700)
                self._refuse_parent(cfg)

    def test_broker_parent_symlink_refused(self) -> None:
        root = _short_tmp(self)
        real = root / "real"
        real.mkdir(mode=0o700)
        link = root / "link"
        os.symlink(str(real), str(link))
        cfg = _config(root, admin_socket=str(link / "admin.sock"))
        self._refuse_parent(cfg)
        self.assertFalse(os.path.lexists(real / "admin.sock"))

    def test_broker_parent_owned_by_other_uid_refused(self) -> None:
        root = _short_tmp(self)
        cfg = _config(root)
        real = os.lstat
        parent = os.path.dirname(cfg["admin_socket"])

        class Fake:
            def __init__(self, info: os.stat_result) -> None:
                self.st_mode = info.st_mode
                self.st_uid = info.st_uid ^ 1
                self.st_dev = info.st_dev
                self.st_ino = info.st_ino

        def fake(path: object, *a: object, **k: object) -> object:
            info = real(path, *a, **k)
            return Fake(info) if str(path) == parent else info

        with mock.patch.object(broker.os, "lstat", fake):
            self._refuse_parent(cfg)

    def test_broker_private_parent_works(self) -> None:
        run = BrokerRun(self)
        parent = os.lstat(os.path.dirname(run.path))
        self.assertTrue(stat.S_ISDIR(parent.st_mode))
        self.assertEqual(stat.S_IMODE(parent.st_mode) & 0o022, 0)
        self.assertEqual(admin(run.path, {"op": "health"}), {"ok": True})

    def test_broker_shutdown_leaves_socket_when_parent_not_private(self) -> None:
        run = BrokerRun(self)
        parent = os.path.dirname(run.path)
        os.chmod(parent, 0o770)
        self.addCleanup(os.chmod, parent, 0o700)
        with self.assertLogs("ak.broker", level="WARNING") as logs:
            run.stop()
        self.assertTrue(os.path.lexists(run.path))
        self.assertTrue(any("parent_not_private" in line for line in logs.output))

    def test_broker_socket_removed_on_shutdown(self) -> None:
        run = BrokerRun(self)
        self.assertTrue(os.path.exists(run.path))
        run.stop()
        self.assertFalse(os.path.lexists(run.path))
        with self.assertRaises(OSError):
            admin_conn(run.path)

    def test_broker_grants_isolated_by_task(self) -> None:
        # C9: A's placeholder is refused on B's service route; revoking A leaves B working.
        run = BrokerRun(self)
        a = admin(run.path, {"op": "mint", "task_id": "A", "services": ["openrouter"]})["grants"][0]["placeholder"]
        b = admin(run.path, {"op": "mint", "task_id": "B", "services": ["resend"]})["grants"][0]["placeholder"]
        status, body = http_get(run.port, "resend", a)
        self.assertEqual((status, body), (401, b'{"error":"bad_placeholder"}'))
        self.assertEqual(http_get(run.port, "resend", b)[0], 200)
        admin(run.path, {"op": "revoke_task", "task_id": "A"})
        self.assertEqual(http_get(run.port, "openrouter", a)[0], 401)
        self.assertEqual(http_get(run.port, "resend", b)[0], 200)

    def test_broker_mint_live_task_refused_then_fresh_after_revoke(self) -> None:
        # A2.
        run = BrokerRun(self)
        first = admin(run.path, {"op": "mint", "task_id": "7", "services": ["openrouter"]})["grants"][0]["placeholder"]
        known = run.store.known_placeholders()
        again = admin(run.path, {"op": "mint", "task_id": "7", "services": ["openrouter", "resend"]})
        self.assertEqual(again, {"ok": False, "error": "bad_request"})
        self.assertEqual(run.store.known_placeholders(), known)
        self.assertEqual(http_get(run.port, "openrouter", first)[0], 200)
        self.assertEqual(admin(run.path, {"op": "revoke_task", "task_id": "7"}), {"ok": True})
        fresh = admin(run.path, {"op": "mint", "task_id": "7", "services": ["openrouter"]})
        self.assertIs(fresh["ok"], True)
        second = fresh["grants"][0]["placeholder"]
        self.assertNotEqual(second, first)
        self.assertEqual(http_get(run.port, "openrouter", first)[0], 401)
        self.assertEqual(http_get(run.port, "openrouter", second)[0], 200)
        # The second set is revoked by the next revoke_task as well.
        admin(run.path, {"op": "revoke_task", "task_id": "7"})
        self.assertEqual(http_get(run.port, "openrouter", second)[0], 401)

    def test_broker_failed_mint_leaves_no_task_state(self) -> None:
        # C7: unknown service anywhere in the list creates nothing, and the id stays usable.
        run = BrokerRun(self)
        resp = admin(run.path, {"op": "mint", "task_id": "9", "services": ["openrouter", "nope"]})
        self.assertEqual(resp, {"ok": False, "error": "unknown_service"})
        self.assertEqual(run.store.known_placeholders(), ())
        self.assertIs(admin(run.path, {"op": "mint", "task_id": "9", "services": ["openrouter"]})["ok"], True)

    def test_broker_restart_invalidates_placeholders(self) -> None:
        # C16: placeholders live only in memory.
        root = _short_tmp(self)
        run = BrokerRun(self, root=root)
        old = admin(run.path, {"op": "mint", "task_id": "1", "services": ["openrouter"]})["grants"][0]["placeholder"]
        run.stop()
        cfg = dict(run.config)
        cfg["port"] = 0
        run2 = BrokerRun(self, root=root, config=cfg)
        status, body = http_get(run2.port, "openrouter", old)
        self.assertEqual((status, body), (401, b'{"error":"bad_placeholder"}'))

    def test_broker_forwards_accept_encoding_identity(self) -> None:
        # Owner decision: every forwarded request carries Accept-Encoding: identity.
        run = BrokerRun(self)
        placeholder = admin(run.path, {"op": "mint", "task_id": "1", "services": ["openrouter"]})["grants"][0]["placeholder"]
        status, _ = http_get(run.port, "openrouter", placeholder, {"Accept-Encoding": "gzip, br"})
        self.assertEqual(status, 200)
        sent = run.upstream.calls[-1]
        values = [v for n, v in sent if n.lower() == "accept-encoding"]
        self.assertEqual(values, ["identity"])
        status, _ = http_get(run.port, "openrouter", placeholder)
        self.assertEqual([v for n, v in run.upstream.calls[-1] if n.lower() == "accept-encoding"], ["identity"])

    def test_broker_compressed_response_is_502(self) -> None:
        run = BrokerRun(self)
        placeholder = admin(run.path, {"op": "mint", "task_id": "1", "services": ["openrouter"]})["grants"][0]["placeholder"]
        run.upstream.headers = [("Content-Encoding", "gzip"), ("Content-Length", "2")]
        status, body = http_get(run.port, "openrouter", placeholder)
        self.assertEqual((status, body), (502, b'{"error":"upstream_error"}'))

    def test_broker_config_requires_admin_socket_and_env_fields(self) -> None:
        root = _short_tmp(self)
        base = _config(root)

        def refuse(cfg: dict, fragment: str) -> None:
            made: list = []

            def boom(*_a: object, **_k: object) -> object:
                made.append(True)
                raise AssertionError("socket created")

            with mock.patch.object(broker.socket, "socket", boom):
                with self.assertRaises(ValueError) as ctx:
                    broker.BrokerServer(cfg, broker.PlaceholderStore(), Upstream().factory)
            self.assertEqual(made, [])
            self.assertIn(fragment, str(ctx.exception))

        missing = dict(base)
        del missing["admin_socket"]
        refuse(missing, "invalid broker config")
        for bad in ("admin.sock", "", None, "/" + "a" * 200, "/tmp/a\x00b"):
            with self.subTest(admin_socket=bad):
                refuse(dict(base, admin_socket=bad), "admin_socket")
        for field in ("env_key", "env_base_url"):
            for bad in ("lower", "MC_KEY", "1KEY", "A-B", "", None):
                with self.subTest(field=field, bad=bad):
                    cfg = json.loads(json.dumps(base))
                    cfg["services"][0][field] = bad
                    refuse(cfg, field)
            # Unique across all services and both fields.
            cfg = json.loads(json.dumps(base))
            cfg["services"][1][field] = "OPENROUTER_API_KEY"
            refuse(cfg, field)
            cfg = json.loads(json.dumps(base))
            del cfg["services"][0][field]
            refuse(cfg, "services")
        same = json.loads(json.dumps(base))
        same["services"][0]["env_base_url"] = same["services"][0]["env_key"]
        refuse(same, "env_base_url")
        header = json.loads(json.dumps(base))
        header["services"][0]["header"] = "Accept-Encoding"
        refuse(header, "header")


class TestBrokerStoreRemint(unittest.TestCase):
    def test_broker_store_remint_after_revoke_only(self) -> None:
        store = broker.PlaceholderStore()
        store.configure(["openrouter"], 3600)
        first = store.mint("7", ["openrouter"])["openrouter"]
        with self.assertRaises(ValueError) as ctx:
            store.mint("7", ["openrouter"])
        self.assertEqual(str(ctx.exception), "duplicate task id")
        store.revoke_task("7")
        second = store.mint("7", ["openrouter"])["openrouter"]
        self.assertNotEqual(first, second)
        self.assertEqual(store.check(first, "openrouter"), "revoked")
        self.assertEqual(store.check(second, "openrouter"), "ok")
        store.revoke_task("7")
        self.assertEqual(store.check(second, "openrouter"), "revoked")


# ---------------------------------------------------------------------------
# Part two: the dispatcher (AC2-AC7, C8, C10, C13, C14).


class FakeBroker:
    """Scripted admin socket. ``script[op]`` is a dict, raw bytes, or "hang"."""

    def __init__(self, test: unittest.TestCase, events: list, lock: threading.Lock) -> None:
        self.root = _short_tmp(test)
        self.path = str(self.root / "fake.sock")
        self.events = events
        self.lock = lock
        self.requests: list[dict] = []
        self.script: dict = {}
        self.grants: list | None = None
        self.stop = threading.Event()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(16)
        self.listener.settimeout(0.05)
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        test.addCleanup(self.close)

    def close(self) -> None:
        self.stop.set()
        self.thread.join(2)
        self.listener.close()

    def default_grants(self, services: list) -> list:
        return [
            {
                "service": name,
                "placeholder": "akp_FAKE-%s-placeholder-194" % name,
                "env_key": "%s_API_KEY" % name.upper(),
                "env_base_url": "%s_BASE_URL" % name.upper(),
                "base_url": "http://127.0.0.1:45678/%s" % name,
            }
            for name in services
        ]

    def ops(self) -> list:
        return [r.get("op") for r in self.requests]

    def _loop(self) -> None:
        while not self.stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn: socket.socket) -> None:
        with conn:
            conn.settimeout(5)
            try:
                line = read_line(conn)
            except OSError:
                return
            if not line:
                return
            request = json.loads(line)
            with self.lock:
                self.requests.append(request)
                self.events.append(("broker", request.get("op")))
            op = request.get("op")
            action = self.script.get(op)
            if action == "hang":
                self.stop.wait(3)
                return
            if action is None:
                if op == "mint":
                    action = {"ok": True, "grants": self.grants if self.grants is not None else self.default_grants(request["services"])}
                else:
                    action = {"ok": True}
            data = action if isinstance(action, bytes) else json.dumps(action).encode() + b"\n"
            try:
                conn.sendall(data)
            except OSError:
                return


class DispatchHarness(unittest.TestCase):
    """run_task with no git: project, git dir, git and the CLI are doubles."""

    platform = "claude-code"

    def setUp(self) -> None:
        self.events: list = []
        self.lock = threading.Lock()
        self.base = _short_tmp(self)
        self.wt = self.base / "wt"
        self.wt.mkdir()
        self.git_dir = self.base / "gitdir"
        self.git_dir.mkdir()
        self.fake = FakeBroker(self, self.events, self.lock)
        self.calls: list = []
        self.api_fail: dict = {}
        self.cli_calls: list = []
        self.worker = None
        self.reviewer = None
        self.ingests: list = []
        self.ingest_fail = False
        env = {
            "MC_BROKER_SOCKET": self.fake.path,
            "MC_BROKER_SERVICES": "openrouter, resend",
            "ANTHROPIC_FIXTURE": "a", "OPENAI_FIXTURE": "o",
            "OPENROUTER_API_KEY": REAL_KEY,
            "MC_CHILD_ENV_ALLOW": "OPENROUTER_API_KEY",
        }
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        for p in (
            mock.patch.object(md, "resolve_project", side_effect=lambda project, workdir: self.wt),
            mock.patch.object(md, "linked_worktree_git_dir", side_effect=lambda cwd: self.git_dir),
            mock.patch.object(md, "git", side_effect=self.fake_git),
            mock.patch.object(md, "api", side_effect=self.fake_api),
            mock.patch.object(md, "ingest", side_effect=self.fake_ingest),
            mock.patch.object(md, "run_cli", side_effect=self.fake_cli),
            mock.patch.object(md, "BROKER_TIMEOUT", 0.5),
            mock.patch.object(md.shutil, "which", return_value="/usr/bin/true"),
        ):
            p.start()
            self.addCleanup(p.stop)
        real_inject = ak_pointers.inject

        def inject(cwd: Path, block: str) -> object:
            self.record(("inject",))
            return real_inject(cwd, block)

        p = mock.patch.object(ak_pointers, "inject", side_effect=inject)
        p.start()
        self.addCleanup(p.stop)

    def record(self, item: tuple) -> None:
        with self.lock:
            self.events.append(item)

    def fake_git(self, cwd: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.CompletedProcess(["git", *args], 1, "", "")

    def fake_api(self, path: str, body: object = None, method: str = "POST", max_bytes: object = None) -> dict:
        self.calls.append((path, body, method))
        self.record(("api", method, path, (body or {}).get("status") if isinstance(body, dict) else None))
        if path.startswith("/api/skills/pointers"):
            if "pointers" in self.api_fail:
                raise self.api_fail["pointers"]
            return {"demo": False, "lane": "proj", "runtime": "claude", "empty": False, "block": BLOCK}
        status = body.get("status") if isinstance(body, dict) else None
        if status in self.api_fail:
            raise self.api_fail[status]
        return {}

    def fake_ingest(self, *args: object, **kwargs: object) -> None:
        self.ingests.append((args, kwargs))
        self.record(("ingest",))
        if self.ingest_fail:
            raise RuntimeError("ingest down")

    def fake_cli(self, platform: str, prompt: str, cwd: Path, review: bool = False, task_id: object = None, **kw: object) -> tuple:
        self.cli_calls.append({"platform": platform, "prompt": prompt, "cwd": cwd, "review": review, "task_id": task_id, "kw": kw})
        self.record(("cli", review))
        fn = self.reviewer if review else self.worker
        if fn is not None:
            return fn(kw.get("env_overlay"))
        return (True, "RESULT: ok\nVERDICT: APPROVE", None) if review else (True, "RESULT: ok", None)

    def dispatch(self, **extra: object) -> dict:
        sem = threading.Semaphore(1)
        sem.acquire()
        task = {"id": 7, "title": "t", "project": "proj", **extra}
        md.run_task(task, self.platform, sem)
        self.assertTrue(sem.acquire(blocking=False), "semaphore not released")
        self.assert_unlocked()
        return self.final()

    def assert_unlocked(self) -> None:
        lock = md.WorktreeLock(self.git_dir)
        lock.acquire(self.wt)  # raises DispatchRefused if still held
        lock.release()

    def final(self) -> dict:
        patches = [c[1] for c in self.calls if c[2] == "PATCH"]
        return patches[-1]

    def revokes(self) -> list:
        return [r for r in self.fake.requests if r.get("op") == "revoke_task"]

    def assert_one_revoke(self) -> None:
        self.assertEqual(self.revokes(), [{"op": "revoke_task", "task_id": "7"}])
        self.assertEqual(self.fake.ops().count("mint"), 1)


class TestBrokerDispatchOrder(DispatchHarness):
    def test_broker_health_and_mint_once_before_pointers_and_cli(self) -> None:
        # AC2, and the revoke after the result patch (step 9).
        def contained(cmd: list, cwd: Path, timeout: float, *, env: dict) -> tuple:
            self.record(("run_contained",))
            return 0, '{"type":"result","result":"RESULT: ok","is_error":false}', ""

        real_acquire, real_release = md.WorktreeLock.acquire, md.WorktreeLock.release

        def acquire(lock: object, worktree: Path) -> None:
            real_acquire(lock, worktree)
            self.record(("lock",))

        def release(lock: object) -> None:
            self.record(("unlock",))
            real_release(lock)

        with mock.patch.object(md, "run_cli", REAL_RUN_CLI), \
                mock.patch.object(md, "run_contained", side_effect=contained), \
                mock.patch.object(md.WorktreeLock, "acquire", acquire), \
                mock.patch.object(md.WorktreeLock, "release", release):
            body = self.dispatch(reviewer_platform="codex")
        kinds = [e[0] if e[0] != "broker" else "broker:" + e[1] for e in self.events]
        self.assertEqual(kinds.count("broker:health"), 1)
        self.assertEqual(kinds.count("broker:mint"), 1)
        health, mint = kinds.index("broker:health"), kinds.index("broker:mint")
        first_api = next(i for i, e in enumerate(self.events) if e[0] == "api")
        self.assertLess(health, mint)
        self.assertLess(kinds.index("lock"), health)
        self.assertLess(kinds.index("broker:revoke_task"), kinds.index("unlock"))
        self.assertLess(mint, first_api)
        self.assertEqual(self.events[first_api][2].split("?")[0], "/api/skills/pointers")
        self.assertLess(mint, kinds.index("inject"))
        self.assertLess(mint, kinds.index("ingest"))
        self.assertLess(mint, kinds.index("run_contained"))
        running = next(i for i, e in enumerate(self.events) if e[0] == "api" and e[3] == "running")
        self.assertLess(mint, running)
        self.assertEqual(kinds.count("run_contained"), 2)  # worker and reviewer, one mint
        last_patch = max(i for i, e in enumerate(self.events) if e[0] == "api" and e[1] == "PATCH")
        self.assertGreater(kinds.index("broker:revoke_task"), last_patch)
        self.assert_one_revoke()
        self.assertIn(body["status"], ("done", "failed"))


class TestBrokerChildEnv(DispatchHarness):
    def test_broker_worker_and_reviewer_get_same_grants_and_own_platform_env(self) -> None:
        # AC3, C5.
        seen: list = []

        def contained(cmd: list, cwd: Path, timeout: float, *, env: dict) -> tuple:
            seen.append((cmd[0], env))
            return 0, '{"type":"result","result":"RESULT: ok","is_error":false}', ""

        before = dict(os.environ)
        with mock.patch.object(md, "run_cli", REAL_RUN_CLI), mock.patch.object(md, "run_contained", side_effect=contained):
            self.dispatch(reviewer_platform="codex")
        self.assertEqual(dict(os.environ), before)
        self.assertEqual([c for c, _ in seen], ["claude", "codex"])
        grants = self.fake.default_grants(["openrouter", "resend"])
        overlay = {}
        for g in grants:
            overlay[g["env_key"]] = g["placeholder"]
            overlay[g["env_base_url"]] = g["base_url"]
        for (cli, env), platform in zip(seen, ("claude-code", "codex")):
            with self.subTest(platform=platform):
                self.assertEqual({k: env[k] for k in overlay}, overlay)
                rest = {k: v for k, v in env.items() if k not in overlay}
                expected = {k: v for k, v in child_env.build_child_env(platform).items() if k not in overlay}
                self.assertEqual(rest, expected)
                self.assertNotIn(REAL_KEY, env.values())
                self.assertEqual(env["OPENROUTER_API_KEY"], "akp_FAKE-openrouter-placeholder-194")
                self.assertFalse(any(k.startswith("MC_BROKER") for k in env))
        self.assertIn("ANTHROPIC_FIXTURE", seen[0][1])
        self.assertNotIn("ANTHROPIC_FIXTURE", seen[1][1])
        self.assertIn("OPENAI_FIXTURE", seen[1][1])
        self.assertEqual(seen[0][1]["OPENROUTER_API_KEY"], seen[1][1]["OPENROUTER_API_KEY"])

    def test_broker_unset_or_empty_uses_build_child_env_and_opens_no_socket(self) -> None:
        # AC6, C10 (services ignored when disabled).
        for value in (None, "", "   "):
            with self.subTest(value=value):
                seen: list = []

                def contained(cmd: list, cwd: Path, timeout: float, *, env: dict) -> tuple:
                    seen.append(env)
                    return 0, '{"type":"result","result":"RESULT: ok","is_error":false}', ""

                env_patch = {"MC_BROKER_SERVICES": "openrouter,,openrouter"}
                with mock.patch.dict(os.environ, env_patch):
                    if value is None:
                        os.environ.pop("MC_BROKER_SOCKET", None)
                    else:
                        os.environ["MC_BROKER_SOCKET"] = value
                    with mock.patch.object(socket, "socket", side_effect=AssertionError("socket opened")), \
                            mock.patch.object(md, "run_cli", REAL_RUN_CLI), \
                            mock.patch.object(md, "run_contained", side_effect=contained):
                        body = self.dispatch()
                    expected = child_env.build_child_env("claude-code")
                self.assertEqual(body["status"], "done")
                self.assertEqual(seen, [expected])
                self.assertEqual(expected["OPENROUTER_API_KEY"], REAL_KEY)  # today's behaviour, unchanged
        self.assertEqual(self.fake.requests, [])

    def test_broker_enabled_without_services_runs_health_only(self) -> None:
        # C10.
        seen: list = []

        def contained(cmd: list, cwd: Path, timeout: float, *, env: dict) -> tuple:
            seen.append(env)
            return 0, '{"type":"result","result":"RESULT: ok","is_error":false}', ""

        with mock.patch.dict(os.environ, {"MC_BROKER_SERVICES": "  "}), \
                mock.patch.object(md, "run_cli", REAL_RUN_CLI), \
                mock.patch.object(md, "run_contained", side_effect=contained):
            body = self.dispatch()
            expected = child_env.build_child_env("claude-code")
        self.assertEqual(body["status"], "done")
        self.assertEqual(self.fake.ops(), ["health"])
        self.assertEqual(seen, [expected])


class TestBrokerRevoke(DispatchHarness):
    def test_broker_revoke_once_on_worker_success(self) -> None:
        body = self.dispatch()
        self.assertEqual(body["status"], "done")
        self.assert_one_revoke()

    def test_broker_revoke_once_on_worker_failure(self) -> None:
        self.worker = lambda _o: (False, "it broke", None)
        self.assertEqual(self.dispatch()["status"], "failed")
        self.assert_one_revoke()

    def test_broker_revoke_once_when_run_cli_raises_timeout(self) -> None:
        def boom(_o: object) -> tuple:
            raise subprocess.TimeoutExpired(["claude"], 1)

        self.worker = boom
        body = self.dispatch()
        self.assertEqual(body["status"], "failed")
        self.assertTrue(body["result"].startswith("dispatcher error"))
        self.assert_one_revoke()

    def test_broker_revoke_once_on_timed_out_result(self) -> None:
        self.worker = lambda _o: (False, "timed out after 1s", None)
        self.assertEqual(self.dispatch()["status"], "failed")
        self.assert_one_revoke()

    def test_broker_revoke_once_on_reviewer_failure(self) -> None:
        self.reviewer = lambda _o: (False, "reviewer crashed", None)
        body = self.dispatch(reviewer_platform="codex")
        self.assertEqual(body["status"], "failed")
        self.assertEqual(len(self.cli_calls), 2)
        self.assert_one_revoke()

    def test_broker_revoke_once_on_pointer_cleanup_failure(self) -> None:
        with mock.patch.object(ak_pointers, "cleanup", side_effect=ak_pointers.PointerFileError("cleanup failed")):
            body = self.dispatch()
        self.assertEqual(body["status"], "failed")
        self.assertIn("AGENTS.md cleanup failed", body["result"])
        self.assert_one_revoke()

    def test_broker_revoke_once_when_result_patch_raises(self) -> None:
        self.api_fail["done"] = RuntimeError("patch failed")
        body = self.dispatch()
        self.assertTrue(body["result"].startswith("dispatcher error"))
        self.assert_one_revoke()

    def test_broker_revoke_once_on_malformed_mint_response(self) -> None:
        self.fake.script["mint"] = b"not json\n"
        body = self.dispatch()
        self.assertTrue(body["result"].startswith(PREFIX))
        self.assertEqual(self.cli_calls, [])
        self.assert_one_revoke()

    def test_broker_revoke_once_on_step_failures(self) -> None:
        # C14: pointer fetch, HEAD read, injection, running patch, ingest.
        cases = {
            "pointers": lambda: self.api_fail.__setitem__("pointers", RuntimeError("pointers down")),
            "head": lambda: setattr(self, "_git_raise", True),
            "inject": lambda: setattr(self, "_inject_raise", True),
            "running": lambda: self.api_fail.__setitem__("running", RuntimeError("running patch failed")),
            "ingest": lambda: setattr(self, "ingest_fail", True),
        }
        for name, arrange in cases.items():
            with self.subTest(step=name):
                self.fake.requests.clear()
                self.calls.clear()
                self.cli_calls.clear()
                self.api_fail.clear()
                self.ingest_fail = False
                self._git_raise = False
                self._inject_raise = False
                arrange()

                def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
                    if self._git_raise:
                        raise OSError("git missing")
                    return subprocess.CompletedProcess(["git"], 1, "", "")

                def inject(cwd: Path, block: str) -> object:
                    raise ak_pointers.PointerFileError("no write")

                with mock.patch.object(md, "git", side_effect=git), \
                        mock.patch.object(ak_pointers, "inject", side_effect=inject if self._inject_raise else ak_pointers.inject):
                    body = self.dispatch()
                self.assertEqual(body["status"], "failed")
                self.assertEqual(self.cli_calls, [])
                self.assert_one_revoke()

    def test_broker_malformed_mint_responses_fail_closed_with_one_revoke(self) -> None:
        # C14 and AC5: non-object, wrong types, extra/duplicate/missing grants, empty fields, no response.
        good = self.fake.default_grants(["openrouter", "resend"])

        def mutate(fn) -> list:
            grants = json.loads(json.dumps(good))
            fn(grants)
            return grants

        cases = {
            "non_object": [1, 2],
            "ok_false": {"ok": False, "error": "unknown_service"},
            "ok_not_bool": {"ok": 1, "grants": good},
            "extra_field": {"ok": True, "grants": good, "x": 1},
            "missing_service": {"ok": True, "grants": good[:1]},
            "extra_grant": {"ok": True, "grants": good + good[:1]},
            "duplicate_service": {"ok": True, "grants": [good[0], good[0]]},
            "wrong_order": {"ok": True, "grants": [good[1], good[0]]},
            "empty_placeholder": {"ok": True, "grants": mutate(lambda g: g[0].__setitem__("placeholder", ""))},
            "empty_env_key": {"ok": True, "grants": mutate(lambda g: g[1].__setitem__("env_key", ""))},
            "int_placeholder": {"ok": True, "grants": mutate(lambda g: g[0].__setitem__("placeholder", 5))},
            "missing_field": {"ok": True, "grants": mutate(lambda g: g[0].pop("base_url"))},
            "extra_grant_field": {"ok": True, "grants": mutate(lambda g: g[0].__setitem__("x", "y"))},
            "mc_env_key": {"ok": True, "grants": mutate(lambda g: g[0].__setitem__("env_key", "MC_TOKEN"))},
            "dup_env_names": {"ok": True, "grants": mutate(lambda g: g[1].__setitem__("env_key", "OPENROUTER_API_KEY"))},
            "dup_placeholder": {"ok": True, "grants": mutate(lambda g: g[1].__setitem__("placeholder", g[0]["placeholder"]))},
            "remote_base_url": {"ok": True, "grants": mutate(lambda g: g[0].__setitem__("base_url", "https://evil.invalid/openrouter"))},
            "no_response": "hang",
        }
        for name, response in cases.items():
            with self.subTest(case=name):
                self.fake.requests.clear()
                self.calls.clear()
                self.cli_calls.clear()
                before = dict(os.environ)
                self.fake.script["mint"] = response
                body = self.dispatch()
                self.assertTrue(body["result"].startswith(PREFIX), body["result"])
                self.assertEqual(body["status"], "failed")
                self.assertEqual(self.cli_calls, [])
                self.assertEqual(dict(os.environ), before)
                self.assertNotIn("placeholder-194", json.dumps(self.calls))
                self.assert_one_revoke()


class TestBrokerFailClosed(DispatchHarness):
    def _assert_closed(self, mint_sent: bool) -> None:
        before = dict(os.environ)
        contained = mock.Mock(side_effect=AssertionError("CLI started"))
        with mock.patch.object(md, "run_cli", REAL_RUN_CLI), mock.patch.object(md, "run_contained", contained):
            body = self.dispatch()
        self.assertEqual(body["status"], "failed")
        self.assertTrue(body["result"].startswith(PREFIX), body["result"])
        contained.assert_not_called()
        self.assertEqual(dict(os.environ), before)
        self.assertEqual([c for c in self.calls if c[0].startswith("/api/skills")], [])
        self.assertEqual([c for c in self.calls if isinstance(c[1], dict) and c[1].get("status") == "running"], [])
        self.assertEqual(self.ingests, [])
        self.assertEqual(len(self.revokes()), 1 if mint_sent else 0)

    def test_broker_missing_socket_fails_closed(self) -> None:
        with mock.patch.dict(os.environ, {"MC_BROKER_SOCKET": str(self.base / "absent.sock")}):
            self._assert_closed(False)

    def test_broker_refused_connection_fails_closed(self) -> None:
        dead = str(self.base / "dead.sock")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(dead)
        s.close()
        with mock.patch.dict(os.environ, {"MC_BROKER_SOCKET": dead}):
            self._assert_closed(False)

    def test_broker_health_timeout_fails_closed(self) -> None:
        self.fake.script["health"] = "hang"
        self._assert_closed(False)

    def test_broker_failed_health_fails_closed(self) -> None:
        for response in ({"ok": False, "error": "internal"}, {"ok": 1}, {"ok": True, "x": 1}, b"[]\n"):
            with self.subTest(response=response):
                self.fake.requests.clear()
                self.calls.clear()
                self.fake.script["health"] = response
                self._assert_closed(False)

    def test_broker_mint_refused_fails_closed(self) -> None:
        self.fake.script["mint"] = {"ok": False, "error": "unknown_service"}
        self._assert_closed(True)

    def test_broker_partial_grant_fails_closed(self) -> None:
        self.fake.grants = self.fake.default_grants(["openrouter"])
        self._assert_closed(True)

    def test_broker_empty_grant_field_fails_closed(self) -> None:
        grants = self.fake.default_grants(["openrouter", "resend"])
        grants[1]["base_url"] = ""
        self.fake.grants = grants
        self._assert_closed(True)

    def test_broker_relative_socket_fails_closed(self) -> None:
        # Run from the fake broker's directory, so the relative path would connect if it were used.
        old_cwd = os.getcwd()
        os.chdir(self.fake.root)
        self.addCleanup(os.chdir, old_cwd)
        for value in ("fake.sock", " ./fake.sock "):
            with self.subTest(value=value):
                self.calls.clear()
                with mock.patch.dict(os.environ, {"MC_BROKER_SOCKET": value}):
                    self._assert_closed(False)
                self.assertIn("absolute path", self.final()["result"])
        self.assertEqual(self.fake.requests, [])

    def test_broker_bad_services_setting_fails_closed(self) -> None:
        for value in ("openrouter,,resend", "openrouter, ", "openrouter,openrouter", " resend , resend"):
            with self.subTest(value=value):
                self.calls.clear()
                with mock.patch.dict(os.environ, {"MC_BROKER_SERVICES": value}):
                    self._assert_closed(False)
        self.assertEqual(self.fake.requests, [])

    def test_broker_settings_parse(self) -> None:
        self.assertIsNone(md.broker_settings({}))
        self.assertIsNone(md.broker_settings({"MC_BROKER_SOCKET": "  ", "MC_BROKER_SERVICES": ",,"}))
        self.assertEqual(md.broker_settings({"MC_BROKER_SOCKET": " /s.sock ", "MC_BROKER_SERVICES": " b , a "}), ("/s.sock", ["b", "a"]))
        self.assertEqual(md.broker_settings({"MC_BROKER_SOCKET": "/s.sock"}), ("/s.sock", []))


class TestBrokerRedaction(DispatchHarness):
    def _captured(self, printed: list) -> str:
        cli = [{k: v for k, v in c.items() if k != "kw"} for c in self.cli_calls]
        cli_kw = [{k: v for k, v in c["kw"].items() if k != "env_overlay"} for c in self.cli_calls]
        return json.dumps([self.calls, self.ingests, printed, cli, cli_kw], default=str)

    def _run(self, **extra: object) -> tuple:
        printed: list = []

        def capture(*args: object, **kwargs: object) -> None:
            printed.append((args, {k: v for k, v in kwargs.items() if k != "file"}))

        with mock.patch.object(builtins, "print", side_effect=capture):
            body = self.dispatch(**extra)
        return body, self._captured(printed), printed

    def _echo(self, overlay: object) -> str:
        assert isinstance(overlay, dict) and overlay
        return "env dump: " + " ".join("%s=%s" % kv for kv in sorted(overlay.items()))

    def _assert_clean(self, blob: str, body: dict) -> None:
        for grant in self.fake.default_grants(["openrouter", "resend"]):
            self.assertNotIn(grant["placeholder"], blob)
            self.assertNotIn(grant["base_url"], blob)
            self.assertNotIn(grant["placeholder"], body["result"])
            self.assertNotIn(grant["base_url"], body["result"])
        self.assertNotIn("akp_", blob)
        self.assertNotIn("127.0.0.1:45678", blob)
        self.assertIn(REDACTED, body["result"])

    def test_broker_redaction_on_worker_failure(self) -> None:
        # AC7.
        self.worker = lambda o: (False, "RESULT: failed. " + self._echo(o), None)
        body, blob, _ = self._run()
        self.assertEqual(body["status"], "failed")
        self._assert_clean(blob, body)
        self.assertIsNotNone(self.cli_calls[0]["kw"].get("env_overlay"))

    def test_broker_redaction_on_reviewer_failure(self) -> None:
        self.worker = lambda o: (True, "RESULT: done. " + self._echo(o), None)
        self.reviewer = lambda o: (False, "reviewer saw " + self._echo(o) + "\nVERDICT: REQUEST_CHANGES - leaked", None)
        body, blob, _ = self._run(reviewer_platform="codex")
        self.assertEqual(body["status"], "failed")
        self._assert_clean(blob, body)
        # The reviewer's prompt (argv) does not carry the worker's echoed grant.
        self.assertNotIn("akp_", self.cli_calls[1]["prompt"])

    def test_broker_redaction_on_revoke_failure(self) -> None:
        self.fake.script["revoke_task"] = {"ok": False, "error": "internal"}
        self.worker = lambda o: (True, "RESULT: ok " + self._echo(o), None)
        body, blob, printed = self._run()
        self.assertEqual(body["status"], "done")  # a revoke failure changes no outcome
        self._assert_clean(blob, body)
        lines = [" ".join(str(a) for a in args) for args, _ in printed]
        self.assertTrue(any("revoke_task failed for task #7" in line and "internal" in line for line in lines), lines)

    def test_broker_redaction_of_exception_text(self) -> None:
        # C13: exception text is redacted; base_url before placeholder.
        grants = self.fake.default_grants(["openrouter", "resend"])
        self.api_fail["done"] = RuntimeError("upstream said %s and %s" % (grants[0]["base_url"], grants[1]["placeholder"]))
        self.worker = lambda o: (True, "RESULT: " + self._echo(o), None)
        body, blob, _ = self._run()
        self.assertTrue(body["result"].startswith("dispatcher error"))
        self._assert_clean(blob, body)
        self.assertEqual(md.redact_broker({"k": ["x http://127.0.0.1:45678/openrouter y"]},
                                          md._overlay_needles_from(grants)),
                         {"k": ["x %s y" % REDACTED]})

    def test_broker_run_cli_redacts_own_telemetry(self) -> None:
        overlay = {"OPENROUTER_API_KEY": "akp_TELEMETRY-194", "OPENROUTER_BASE_URL": "http://127.0.0.1:45678/openrouter"}
        sent: list = []

        def contained(cmd: list, cwd: Path, timeout: float, *, env: dict) -> tuple:
            return 0, json.dumps({"type": "result", "result": "RESULT: akp_TELEMETRY-194 http://127.0.0.1:45678/openrouter",
                                  "is_error": False}), ""

        def build_detail(**kwargs: object) -> dict:
            return {"note": "akp_TELEMETRY-194 at http://127.0.0.1:45678/openrouter"}

        with mock.patch.object(md, "run_contained", side_effect=contained), \
                mock.patch.object(md, "build_detail", side_effect=build_detail), \
                mock.patch.object(md, "ingest", side_effect=lambda *a, **k: sent.append(a)):
            REAL_RUN_CLI("claude-code", "p", self.wt, env_overlay=overlay)
        self.assertEqual(sent[0][4], {"note": "%s at %s" % (REDACTED, REDACTED)})


class TestBrokerEndToEnd(unittest.TestCase):
    def test_broker_real_broker_child_env_has_placeholders_and_revokes(self) -> None:
        run = BrokerRun(self)
        base = _short_tmp(self)
        wt = base / "wt"
        wt.mkdir()
        gd = base / "gd"
        gd.mkdir()
        seen: list = []

        def contained(cmd: list, cwd: Path, timeout: float, *, env: dict) -> tuple:
            seen.append(dict(env))
            status = http_get(run.port, "openrouter", env["OPENROUTER_API_KEY"])[0]
            return 0, json.dumps({"type": "result", "result": "RESULT: proxy %d" % status, "is_error": False}), ""

        def fake_api(path: str, body: object = None, method: str = "POST", max_bytes: object = None) -> dict:
            if path.startswith("/api/skills/pointers"):
                return {"demo": False, "lane": "proj", "runtime": "claude", "empty": True, "block": ""}
            return {}

        api = mock.Mock(side_effect=fake_api)
        with mock.patch.dict(os.environ, {"MC_BROKER_SOCKET": run.path, "MC_BROKER_SERVICES": "openrouter",
                                          "OPENROUTER_API_KEY": REAL_KEY, "MC_CHILD_ENV_ALLOW": "OPENROUTER_API_KEY"}), \
                mock.patch.object(md, "resolve_project", return_value=wt), \
                mock.patch.object(md, "linked_worktree_git_dir", return_value=gd), \
                mock.patch.object(md, "git", return_value=subprocess.CompletedProcess(["git"], 1, "", "")), \
                mock.patch.object(md, "api", api), mock.patch.object(md, "ingest"), \
                mock.patch.object(md, "run_contained", side_effect=contained):
            sem = threading.Semaphore(1)
            sem.acquire()
            md.run_task({"id": 42, "title": "noop", "project": "proj"}, "claude-code", sem)
        env = seen[0]
        self.assertRegex(env["OPENROUTER_API_KEY"], r"\Aakp_")
        self.assertNotIn(REAL_KEY, env.values())
        self.assertEqual(env["OPENROUTER_BASE_URL"], "http://127.0.0.1:%d/openrouter" % run.port)
        final = api.call_args_list[-1][0][1]
        self.assertEqual(final["status"], "done")
        self.assertIn("proxy 200", final["result"])
        # Revoked at task end.
        self.assertEqual(http_get(run.port, "openrouter", env["OPENROUTER_API_KEY"])[0], 401)
        # Broker stopped: the next task fails closed.
        run.stop()
        seen.clear()
        with mock.patch.dict(os.environ, {"MC_BROKER_SOCKET": run.path, "MC_BROKER_SERVICES": "openrouter"}), \
                mock.patch.object(md, "resolve_project", return_value=wt), \
                mock.patch.object(md, "linked_worktree_git_dir", return_value=gd), \
                mock.patch.object(md, "api", api), mock.patch.object(md, "ingest"), \
                mock.patch.object(md, "run_contained", side_effect=contained):
            sem = threading.Semaphore(1)
            sem.acquire()
            md.run_task({"id": 43, "title": "noop", "project": "proj"}, "claude-code", sem)
        self.assertEqual(seen, [])
        self.assertTrue(api.call_args_list[-1][0][1]["result"].startswith(PREFIX))


if __name__ == "__main__":
    unittest.main()
