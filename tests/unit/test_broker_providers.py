#!/usr/bin/env python3
"""Secret-reference parser and file/exec providers.

Imports agents/broker the way tests/unit/test_child_env.py imports the
dispatcher: directory on sys.path, no package __init__.py. Fixture values
are not secrets. No test prints a resolved value.
"""
from __future__ import annotations

import ast
import contextlib
import io
import json
import logging
import os
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from collections.abc import Mapping
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
BROKER = ROOT / "agents" / "broker"
sys.path.insert(0, str(BROKER))
import providers  # noqa: E402
import refs  # noqa: E402

FIXTURE = "fixture-value-not-a-secret"
API_FIXTURE = "sk-fixture-not-a-secret-123"
LIMIT = 1048576

# The slim image has no /usr/bin/python3. Exec the stub with this interpreter.
_INTERPRETER = sys.executable
if not _INTERPRETER or not os.path.isabs(_INTERPRETER):
    raise RuntimeError(
        "sys.executable must be a non-empty absolute path to build the exec stub"
    )

_STUB = "#!" + _INTERPRETER + """
import json
import os
import signal
import sys
import time

mode = sys.argv[2] if len(sys.argv) > 2 else "ok"
if mode == "ok":
    sys.stdout.write("ok\\n")
elif mode == "empty":
    pass
elif mode == "nl":
    sys.stdout.write("hello\\n")
elif mode == "double":
    sys.stdout.write("hello\\n\\n")
elif mode == "trail":
    sys.stdout.write("hello \\n")
elif mode == "crlf":
    sys.stdout.buffer.write(b"hello\\r\\n")
elif mode == "plain":
    sys.stdout.write("hello")
elif mode == "sleep":
    time.sleep(5)
elif mode == "sleep30":
    time.sleep(30)
elif mode == "bad-sleep":
    sys.stdout.buffer.write(b"\\xff")
    sys.stdout.buffer.flush()
    time.sleep(5)
elif mode == "signal":
    os.kill(os.getpid(), signal.SIGTERM)
elif mode == "status":
    sys.stdout.write("fixture-value-not-a-secret\\n")
    raise SystemExit(4)
elif mode == "bigout":
    sys.stdout.buffer.write(b"MARKERBIG")
    sys.stdout.buffer.write(b"x" * 1048576)
    raise SystemExit(3)
elif mode == "bigerr":
    sys.stderr.buffer.write(b"MARKERBIG")
    sys.stderr.buffer.write(b"y" * 1048576)
    sys.stdout.write("ok\\n")
elif mode == "plusone":
    sys.stdout.buffer.write(b"x" * 1048577)
    raise SystemExit(3)
elif mode == "errplus":
    sys.stderr.buffer.write(b"y" * 1048577)
    sys.stdout.write("ok\\n")
elif mode == "exact":
    sys.stdout.buffer.write(b"x" * 1048576)
elif mode == "errexact":
    sys.stderr.buffer.write(b"y" * 1048576)
    sys.stdout.write("ok\\n")
elif mode == "badutf":
    sys.stdout.buffer.write(b"\\xff")
    raise SystemExit(3)
elif mode == "stderr-utf":
    sys.stderr.buffer.write(b"\\xff\\xfe")
    sys.stdout.write("ok\\n")
elif mode == "record":
    dest = sys.argv[3]
    payload = {"argv": sys.argv, "env": dict(os.environ)}
    with open(dest, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    sys.stderr.write("stub-stderr-marker\\n")
    sys.stderr.write(json.dumps(payload))
    sys.stdout.write("fixture-value-not-a-secret\\n")
elif mode == "envcheck":
    dest = sys.argv[3]
    with open(dest, "w", encoding="utf-8") as handle:
        handle.write("\\n".join(sorted(os.environ)))
elif mode == "close-sleep":
    for fd in (1, 2):
        try:
            os.close(fd)
        except OSError:
            pass
    time.sleep(20)
elif mode == "helper-sleep":
    pidfile = sys.argv[3]
    pid = os.fork()
    if pid == 0:
        with open(pidfile, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
        time.sleep(60)
        os._exit(0)
    for _ in range(500):
        if os.path.exists(pidfile) and os.path.getsize(pidfile) > 0:
            break
        time.sleep(0.01)
    os._exit(0)
else:
    raise SystemExit(2)
"""


def _drain_fd(fd: int) -> bytes:
    os.set_blocking(fd, False)
    chunks: list[bytes] = []
    while True:
        try:
            block = os.read(fd, 65536)
        except BlockingIOError:
            break
        if not block:
            break
        chunks.append(block)
    os.close(fd)
    return b"".join(chunks)


def _captured_stdio(fn):
    """Run ``fn`` while OS fds 1 and 2 point at pipes. Return captured bytes and ``fn()``."""
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    saved_out = os.dup(1)
    saved_err = os.dup(2)
    try:
        os.dup2(out_w, 1)
        os.dup2(err_w, 2)
        result = fn()
    finally:
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
        os.close(out_w)
        os.close(err_w)
        out = _drain_fd(out_r)
        err = _drain_fd(err_r)
    return out, err, result


class _CountingEnv(Mapping):
    """First lookup returns the seeded value. Later lookups return a different string."""

    def __init__(self, values: dict[str, object]) -> None:
        self.values = values
        self.reads: list[str] = []

    def __getitem__(self, key: str) -> object:
        self.reads.append(key)
        if key not in self.values:
            raise KeyError(key)
        if self.reads.count(key) == 1:
            return self.values[key]
        return "read-%d" % self.reads.count(key)

    def __iter__(self):
        return iter(self.values)

    def __len__(self) -> int:
        return len(self.values)


def _pid_dead(pid: int) -> bool:
    """True when ``pid`` is gone or is a zombie.

    A killed grandchild is reparented to PID 1. macOS init reaps it, so
    ``os.kill`` raises. The Python 3.9 CI container's shell does not, and
    the pid stays a zombie until the container exits. SIGKILL can still be
    pending for a moment after ``killpg`` returns, so callers retry.
    """
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    stat_path = "/proc/%d/stat" % pid
    try:
        with open(stat_path, encoding="ascii") as handle:
            raw = handle.read()
    except OSError:
        raw = ""
    if raw:
        state = raw.rsplit(")", 1)[-1].split()[0]
        return state == "Z"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def _assert_pid_dead(test: unittest.TestCase, pid: int) -> None:
    deadline = time.monotonic() + 2
    while True:
        if _pid_dead(pid):
            return
        if time.monotonic() >= deadline:
            test.fail("pid %s is still running" % pid)
        time.sleep(0.01)


def _expect(test: unittest.TestCase, fn, message: str) -> None:
    with test.assertRaises(ValueError) as caught:
        fn()
    exc = caught.exception
    test.assertEqual(str(exc), message)
    test.assertEqual(exc.args, (message,))
    test.assertIsNone(exc.__cause__)
    test.assertIsNone(exc.__context__)
    test.assertTrue(exc.__suppress_context__)
    test.assertNotIn(FIXTURE, str(exc))
    test.assertNotIn(API_FIXTURE, str(exc))


def _write(path: Path, data: str | bytes, mode: int) -> None:
    if isinstance(data, str):
        path.write_bytes(data.encode("utf-8"))
    else:
        path.write_bytes(data)
    os.chmod(path, mode)


def _tree(root: Path) -> list[tuple[str, bytes]]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        for name in filenames:
            path = Path(dirpath) / name
            found.append((str(path), path.read_bytes()))
    return found


def _install_stub(directory: Path) -> Path:
    path = directory / "stub.py"
    path.write_text(_STUB)
    os.chmod(path, 0o700)
    return path


def _recipe(argv: list[str], env: list[str] | None = None, timeout: int | None = None) -> dict:
    body: dict = {"argv": argv}
    if env is not None:
        body["env"] = env
    if timeout is not None:
        body["timeout_seconds"] = timeout
    return {"exec": {"recipe": body}}


class ParseReferenceTests(unittest.TestCase):
    def test_ac1_rejects_table(self) -> None:
        non_ascii = "secretref://file/a/caf" + "\u00e9"
        samples = [
            "",
            "http://x",
            "secretref://vault/a/b",
            "secretref://File/a/b",
            "secretref://file/a/../b",
            "secretref://file//b",
            "secretref://file/a/b/",
            "secretref://file/a/b?x",
            "secretref://file/a/b c",
            non_ascii,
            "secretref://file/" + ("a" * 65) + "/b",
            "secretref://file/a/" + ("b" * 201),
            API_FIXTURE,
            "secretref://file/a/./b",
            "secretref://file/a/b/../c",
            "secretref://file/a",
            "secretref://file/a/b\n",
            "secretref://file/a/b#c",
            "secretref://file/a/b%2e",
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                def check(value: str = sample) -> None:
                    refs.parse_reference(value)

                _expect(self, check, "invalid secret reference")
                if sample:
                    self.assertNotIn(sample, "invalid secret reference")

    def test_ac1_rejects_non_strings(self) -> None:
        for value in (None, b"secretref://file/a/b", 1):
            with self.subTest(value=type(value).__name__):
                _expect(self, lambda item=value: refs.parse_reference(item), "invalid secret reference")

    def test_context_cleared_inside_caller_handler(self) -> None:
        try:
            raise KeyError("marker")
        except KeyError:
            with self.assertRaises(ValueError) as caught:
                refs.parse_reference("bogus")
            exc = caught.exception
            self.assertEqual(str(exc), "invalid secret reference")
            self.assertIsNone(exc.__cause__)
            self.assertIsNone(exc.__context__)
            self.assertTrue(exc.__suppress_context__)
            with self.assertRaises(ValueError) as resolved:
                providers.resolve(("bogus",), {"file": {}}, environ={})
            failure = resolved.exception
            self.assertEqual(str(failure), "invalid secret reference")
            self.assertIsNone(failure.__cause__)
            self.assertIsNone(failure.__context__)
            self.assertTrue(failure.__suppress_context__)

    def test_ac1_accepts_grammar(self) -> None:
        cases = [
            ("secretref://file/a/b", ("file", "a", "b")),
            ("secretref://exec/recipe/name", ("exec", "recipe", "name")),
            ("secretref://file/src/a/b/c", ("file", "src", "a/b/c")),
            ("secretref://file/File/b", ("file", "File", "b")),
            ("secretref://exec/Ab_1-z/Foo.bar-baz_qux", ("exec", "Ab_1-z", "Foo.bar-baz_qux")),
            ("secretref://file/s/...", ("file", "s", "...")),
            ("secretref://file/s/..hidden", ("file", "s", "..hidden")),
            (
                "secretref://file/" + ("a" * 64) + "/" + ("b" * 200),
                ("file", "a" * 64, "b" * 200),
            ),
            (
                "secretref://exec/s/" + ("a/" * 99) + "bb",
                ("exec", "s", ("a/" * 99) + "bb"),
            ),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(refs.parse_reference(text), expected)
                self.assertEqual(len(expected[2]), len(expected[2]))
                self.assertLessEqual(len(expected[1]), 64)
                self.assertLessEqual(len(expected[2]), 200)


class LoadConfigTests(unittest.TestCase):
    def _load(self, raw: str, mode: int = 0o600) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            _write(path, raw, mode)
            return providers.load_config(str(path))

    def _reject(self, raw: str, mode: int = 0o600) -> None:
        def check() -> None:
            self._load(raw, mode)

        _expect(self, check, "invalid provider config")

    def test_ac6_mode_and_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "providers.json"
            _write(path, '{"file": {"src": "/tmp/unused"}}', 0o644)
            reads: list[int] = []
            real_read = os.read

            def spy(fd: int, size: int) -> bytes:
                reads.append(fd)
                return real_read(fd, size)

            with mock.patch.object(providers.os, "read", spy):
                _expect(
                    self,
                    lambda: providers.load_config(str(path)),
                    "invalid provider config",
                )
            self.assertEqual(reads, [])
            target = root / "target.json"
            _write(target, '{"file": {"src": "/tmp/unused"}}', 0o600)
            link = root / "link.json"
            os.symlink(target, link)
            _expect(self, lambda: providers.load_config(str(link)), "invalid provider config")
            _expect(
                self,
                lambda: providers.load_config(str(root)),
                "invalid provider config",
            )

    def test_ac6_unknown_key_top_and_nested(self) -> None:
        self._reject('{"file": {"src": "/tmp/x"}, "unknown-marker": 1}')
        self._reject(
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "unknown-marker": 1}}}'
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            _write(path, '{"file": {"src": "/tmp/x"}, "unknown-marker": 1}', 0o600)

            def check() -> None:
                providers.load_config(str(path))

            with self.assertRaises(ValueError) as caught:
                check()
            self.assertNotIn("unknown-marker", str(caught.exception))

    def test_ac6_relative_path(self) -> None:
        raw = '{"file": {"src": "relative-marker/secrets.env"}}'
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            _write(path, raw, 0o600)
            with self.assertRaises(ValueError) as caught:
                providers.load_config(str(path))
            self.assertEqual(str(caught.exception), "invalid provider config")
            self.assertNotIn("relative-marker", str(caught.exception))

    def test_ac6_argv_shape(self) -> None:
        self._reject('{"exec": {"recipe": {"argv": []}}}')
        self._reject('{"exec": {"recipe": {"argv": "echo {name}"}}}')
        self._reject('{"exec": {"recipe": {"argv": ["echo", 1]}}}')
        self._reject('{"exec": {"recipe": {"argv": ["echo", "hello"]}}}')
        self._reject('{"exec": {"recipe": {"argv": ["", "{name}"]}}}')
        self._reject('{"exec": {"recipe": {}}}')

    def test_ac6_env_name(self) -> None:
        self._reject('{"exec": {"recipe": {"argv": ["x", "{name}"], "env": ["1BAD"]}}}')
        self._reject('{"exec": {"recipe": {"argv": ["x", "{name}"], "env": ["HAS-DASH"]}}}')
        self._reject('{"exec": {"recipe": {"argv": ["x", "{name}"], "env": "PATH"}}}')
        self._reject('{"exec": {"recipe": {"argv": ["x", "{name}"], "env": [1]}}}')

    def test_ac6_timeout_bool(self) -> None:
        raw = (
            '{"exec": {"recipe": {"argv": ["' + API_FIXTURE + '", "{name}"], '
            '"timeout_seconds": true}}}'
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            _write(path, raw, 0o600)
            with self.assertRaises(ValueError) as caught:
                providers.load_config(str(path))
            self.assertEqual(str(caught.exception), "invalid provider config")
            self.assertNotIn(API_FIXTURE, str(caught.exception))

    def test_ac6_timeout_not_integer_or_out_of_range(self) -> None:
        bodies = [
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": 1.5}}}',
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": "10"}}}',
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": false}}}',
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": 0}}}',
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": -1}}}',
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": 301}}}',
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": null}}}',
        ]
        for raw in bodies:
            with self.subTest(raw=raw):
                self._reject(raw)

    def test_ac6_invalid_id(self) -> None:
        self._reject('{"file": {"bad.id": "/tmp/x"}}')
        self._reject('{"file": {"": "/tmp/x"}}')
        self._reject('{"file": {"' + ("a" * 65) + '": "/tmp/x"}}')
        self._reject('{"exec": {"a/b": {"argv": ["x", "{name}"]}}}')

    def test_c7_malformed_duplicate_and_non_finite(self) -> None:
        self._reject("{")
        self._reject("")
        self._reject("null")
        self._reject("[]")
        self._reject("{}")
        self._reject('{"file": {"src": "/tmp/a", "src": "/tmp/b"}}')
        self._reject(
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "argv": ["y", "{name}"]}}}'
        )
        self._reject('{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": NaN}}}')
        self._reject(
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": Infinity}}}'
        )
        self._reject(
            '{"exec": {"recipe": {"argv": ["x", "{name}"], "timeout_seconds": -Infinity}}}'
        )

    def test_c7_nul_in_path_and_argv(self) -> None:
        _expect(
            self,
            lambda: providers.resolve(
                ("file", "src", "KEY"),
                {"file": {"src": "/tmp/a\x00b"}},
                environ={},
            ),
            "invalid provider config",
        )
        self._reject('{"exec": {"recipe": {"argv": ["x\\u0000", "{name}"]}}}')
        self._reject('{"file": {"src": "/tmp/a\\u0000b"}}')

    def test_deep_json_nesting_is_invalid_config(self) -> None:
        raw = "[" * 200000
        self._reject(raw)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            _write(path, raw, 0o600)
            _expect(
                self,
                lambda: providers.resolve(
                    ("file", "src", "KEY"),
                    {},
                    environ={},
                    config_path=str(path),
                ),
                "invalid provider config",
            )

    def test_unencodable_argv_and_paths_are_invalid_config(self) -> None:
        self._reject('{"exec": {"recipe": {"argv": ["/bin/echo", "\\ud800{name}"]}}}')
        self._reject('{"file": {"src": "/tmp/\\ud800"}}')
        _expect(self, lambda: providers.load_config("/tmp/\ud800"), "invalid provider config")
        _expect(
            self,
            lambda: providers.resolve(
                ("file", "src", "KEY"),
                {"file": {"src": "/tmp/\ud800"}},
                environ={},
            ),
            "invalid provider config",
        )
        _expect(
            self,
            lambda: providers.resolve(
                ("exec", "recipe", "n"),
                {"exec": {"recipe": {"argv": ["/bin/echo", "\ud800{name}"]}}},
                environ={},
            ),
            "invalid provider config",
        )

    def test_accepts_minimal_and_bounds(self) -> None:
        loaded = self._load(
            json.dumps(
                {
                    "file": {"src": "/tmp/secrets.env"},
                    "exec": {
                        "recipe": {
                            "argv": ["{name}"],
                            "timeout_seconds": 1,
                        },
                        "other": {
                            "argv": ["tool", "pre-{name}-post"],
                            "env": [],
                            "timeout_seconds": 300,
                        },
                    },
                }
            )
        )
        self.assertEqual(loaded["exec"]["other"]["timeout_seconds"], 300)
        self.assertNotIn("env", loaded["exec"]["recipe"])

    def test_ac3_config_owner_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            _write(path, '{"file": {"src": "/tmp/x"}}', 0o600)
            real = os.fstat

            def fake(fd: int):
                info = real(fd)
                return _Stat(info.st_mode, info.st_uid ^ 1)

            with mock.patch.object(providers.os, "fstat", fake):
                _expect(
                    self,
                    lambda: providers.load_config(str(path)),
                    "invalid provider config",
                )

    def test_load_does_not_open_secret_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "secrets.env"
            _write(secret, "KEY=" + FIXTURE + "\n", 0o600)
            config = root / "providers.json"
            _write(config, json.dumps({"file": {"src": str(secret)}}), 0o600)
            opened: list[str] = []
            real = os.open

            def spy(path: str, flags: int, *args, **kwargs):
                opened.append(os.fsdecode(path))
                return real(path, flags, *args, **kwargs)

            with mock.patch.object(providers.os, "open", spy):
                providers.load_config(str(config))
            self.assertEqual(opened, [str(config)])


class _Stat:
    def __init__(self, mode: int, uid: int) -> None:
        self.st_mode = mode
        self.st_uid = uid


class FileProviderTests(unittest.TestCase):
    def _resolve(
        self,
        text: str | bytes,
        name: str = "KEY",
        mode: int = 0o600,
        source: str = "src",
        snapshot: bool = False,
    ) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "secrets.env"
            _write(secret, text, mode)
            body = {"file": {source: str(secret)}}
            config_path = root / "providers.json"
            _write(config_path, json.dumps(body), 0o600)
            ref = ("file", source, name)
            if snapshot:
                return providers.resolve(ref, body, environ={})
            return providers.resolve(ref, body, environ={}, config_path=str(config_path))

    def test_ac2_parses_lines(self) -> None:
        text = "\n  # comment = ignored\n#KEY=hidden\n  KEY = \"fixture-value-not-a-secret\"  \nOTHER='kept'\nEMPTY=\nPLAIN=a # b\n_OK=1\nA1=2\n"
        self.assertEqual(self._resolve(text, "KEY"), FIXTURE)
        self.assertEqual(self._resolve(text, "OTHER"), "kept")
        self.assertEqual(self._resolve(text, "EMPTY"), "")
        self.assertEqual(self._resolve(text, "PLAIN"), "a # b")
        self.assertEqual(self._resolve(text, "_OK"), "1")
        self.assertEqual(self._resolve(text, "A1"), "2")
        spaced = 'KEY=" a b "\n'
        self.assertEqual(self._resolve(spaced, "KEY"), " a b ")
        self.assertEqual(self._resolve("KEY=\"'inner'\"\n", "KEY"), "'inner'")
        self.assertEqual(self._resolve("KEY='mix\"\n", "KEY"), "'mix\"")
        self.assertEqual(self._resolve('KEY="only\n', "KEY"), '"only')
        self.assertEqual(self._resolve("KEY=VALUE=MORE\n", "KEY"), "VALUE=MORE")
        self.assertEqual(self._resolve("FOO=a\nfoo=b\n", "foo"), "b")

    def test_form_feed_does_not_split_env_lines(self) -> None:
        text = "A=abc\x0cB=x\n"
        self.assertEqual(self._resolve(text, "A"), "abc\x0cB=x")
        _expect(
            self,
            lambda: self._resolve(text, name="B"),
            "missing key: provider=file source=src name=B",
        )
        self.assertEqual(self._resolve("KEY=hello\r\n", "KEY"), "hello")

    def test_ac2_invalid_lines(self) -> None:
        cases = [
            "NOEQUALS\n",
            "=novalue\n",
            "BAD-KEY=x\n",
            "1KEY=x\n",
            "DUP=a\nDUP=b\n",
            "FOO=a\n  FOO =b\n",
            "GOOD=1\n" + API_FIXTURE + "\n",
            "GOOD=" + FIXTURE + "\nGOOD=other\n",
        ]
        for text in cases:
            with self.subTest(text=text):
                _expect(
                    self,
                    lambda body=text: self._resolve(body),
                    "invalid provider file: provider=file source=src",
                )

    def test_ac2_missing_key(self) -> None:
        _expect(
            self,
            lambda: self._resolve("KEY=value\n", name="OTHER"),
            "missing key: provider=file source=src name=OTHER",
        )
        _expect(
            self,
            lambda: self._resolve("# only\n\n", name="KEY"),
            "missing key: provider=file source=src name=KEY",
        )
        _expect(
            self,
            lambda: self._resolve("", name="a/b"),
            "missing key: provider=file source=src name=a/b",
        )

    def test_c6_utf8_and_read_failure(self) -> None:
        _expect(
            self,
            lambda: self._resolve(b"KEY=value\n\xff\n"),
            "invalid provider file: provider=file source=src",
        )
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "secrets.env"
            _write(secret, "KEY=value\n", 0o600)
            body = {"file": {"src": str(secret)}}
            real = os.read

            def boom(fd: int, size: int) -> bytes:
                info = os.fstat(fd)
                if info.st_ino == secret.stat().st_ino:
                    raise OSError("read failed")
                return real(fd, size)

            with mock.patch.object(providers.os, "read", boom):
                _expect(
                    self,
                    lambda: providers.resolve(("file", "src", "KEY"), body, environ={}),
                    "invalid provider file: provider=file source=src",
                )

    def test_ac3_modes(self) -> None:
        self.assertEqual(self._resolve("KEY=" + FIXTURE + "\n", mode=0o600), FIXTURE)
        self.assertEqual(self._resolve("KEY=" + FIXTURE + "\n", mode=0o400), FIXTURE)
        for mode in (0o644, 0o700, 0o404, 0o640, 0o4600):
            with self.subTest(mode=oct(mode)):
                _expect(
                    self,
                    lambda bits=mode: self._resolve("KEY=" + FIXTURE + "\n", mode=bits),
                    "unsafe file: provider=file source=src",
                )

    def test_ac3_bad_mode_does_not_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "pathmarker.env"
            _write(secret, "KEY=" + FIXTURE + "\n", 0o644)
            body = {"file": {"src": str(secret)}}
            reads: list[int] = []
            real = os.read

            def spy(fd: int, size: int) -> bytes:
                reads.append(fd)
                return real(fd, size)

            with mock.patch.object(providers.os, "read", spy):
                with self.assertRaises(ValueError) as caught:
                    providers.resolve(("file", "src", "KEY"), body, environ={})
            self.assertEqual(reads, [])
            self.assertEqual(str(caught.exception), "unsafe file: provider=file source=src")
            self.assertNotIn(FIXTURE, str(caught.exception))
            self.assertNotIn("pathmarker", str(caught.exception))

    def test_fstat_oserror_is_unsafe_or_invalid_config(self) -> None:
        def boom(fd: int):
            raise OSError("fstat failed")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "secrets.env"
            _write(secret, "KEY=value\n", 0o600)
            body = {"file": {"src": str(secret)}}
            with mock.patch.object(providers.os, "fstat", boom):
                _expect(
                    self,
                    lambda: providers.resolve(("file", "src", "KEY"), body, environ={}),
                    "unsafe file: provider=file source=src",
                )
            config = root / "providers.json"
            _write(config, json.dumps(body), 0o600)
            with mock.patch.object(providers.os, "fstat", boom):
                _expect(
                    self,
                    lambda: providers.load_config(str(config)),
                    "invalid provider config",
                )
                _expect(
                    self,
                    lambda: providers.resolve(
                        ("file", "src", "KEY"),
                        body,
                        environ={},
                        config_path=str(config),
                    ),
                    "invalid provider config",
                )

    def test_close_oserror_does_not_mask_or_escape(self) -> None:
        real_close = os.close

        def boom_close(fd: int) -> None:
            real_close(fd)
            raise OSError("close failed")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "secrets.env"
            _write(secret, "KEY=" + FIXTURE + "\n", 0o600)
            body = {"file": {"src": str(secret)}}
            with mock.patch.object(providers.os, "close", boom_close):
                self.assertEqual(
                    providers.resolve(("file", "src", "KEY"), body, environ={}),
                    FIXTURE,
                )
            _write(secret, "KEY=" + FIXTURE + "\n", 0o644)
            with mock.patch.object(providers.os, "close", boom_close):
                _expect(
                    self,
                    lambda: providers.resolve(("file", "src", "KEY"), body, environ={}),
                    "unsafe file: provider=file source=src",
                )
            _write(secret, "KEY=value\n", 0o600)
            real_read = os.read

            def boom_read(fd: int, size: int) -> bytes:
                if stat.S_ISREG(os.fstat(fd).st_mode):
                    raise OSError("read failed")
                return real_read(fd, size)

            with mock.patch.object(providers.os, "read", boom_read):
                with mock.patch.object(providers.os, "close", boom_close):
                    _expect(
                        self,
                        lambda: providers.resolve(("file", "src", "KEY"), body, environ={}),
                        "invalid provider file: provider=file source=src",
                    )
            config = root / "providers.json"
            _write(config, json.dumps({"file": {"src": "/tmp/x"}}), 0o600)
            with mock.patch.object(providers.os, "close", boom_close):
                loaded = providers.load_config(str(config))
                self.assertEqual(loaded["file"]["src"], "/tmp/x")
            _write(config, json.dumps({"file": {"src": "/tmp/x"}}), 0o644)
            with mock.patch.object(providers.os, "close", boom_close):
                _expect(
                    self,
                    lambda: providers.load_config(str(config)),
                    "invalid provider config",
                )

    def test_ac3_symlink_directory_and_nofollow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "target.env"
            _write(target, "KEY=" + FIXTURE + "\n", 0o600)
            link = root / "link.env"
            os.symlink(target, link)
            body = {"file": {"src": str(link)}}
            _expect(
                self,
                lambda: providers.resolve(("file", "src", "KEY"), body, environ={}),
                "unsafe file: provider=file source=src",
            )
            directory = root / "dir.env"
            directory.mkdir()
            os.chmod(directory, 0o700)
            _expect(
                self,
                lambda: providers.resolve(
                    ("file", "src", "KEY"),
                    {"file": {"src": str(directory)}},
                    environ={},
                ),
                "unsafe file: provider=file source=src",
            )
            fifo = root / "fifo.env"
            os.mkfifo(fifo)
            os.chmod(fifo, 0o600)
            _expect(
                self,
                lambda: providers.resolve(
                    ("file", "src", "KEY"),
                    {"file": {"src": str(fifo)}},
                    environ={},
                ),
                "unsafe file: provider=file source=src",
            )
            flags: list[int] = []
            real_open = os.open

            def spy(path: str, flag: int, *args, **kwargs):
                flags.append(flag)
                return real_open(path, flag, *args, **kwargs)

            secret = root / "direct.env"
            _write(secret, "KEY=value\n", 0o600)
            with mock.patch.object(providers.os, "open", spy):
                with mock.patch.object(providers.os, "stat", side_effect=AssertionError("stat")):
                    value = providers.resolve(
                        ("file", "src", "KEY"),
                        {"file": {"src": str(secret)}},
                        environ={},
                    )
            self.assertEqual(value, "value")
            self.assertTrue(flags)
            self.assertTrue(all(flag & os.O_NOFOLLOW for flag in flags))

    def test_ac3_owner_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            secret = Path(tmp) / "secrets.env"
            _write(secret, "KEY=value\n", 0o600)
            ino = secret.stat().st_ino
            real = os.fstat

            def fake(fd: int):
                info = real(fd)
                if info.st_ino == ino:
                    return _Stat(stat.S_IFREG | 0o600, info.st_uid ^ 1)
                return info

            with mock.patch.object(providers.os, "fstat", fake):
                _expect(
                    self,
                    lambda: providers.resolve(
                        ("file", "src", "KEY"),
                        {"file": {"src": str(secret)}},
                        environ={},
                    ),
                    "unsafe file: provider=file source=src",
                )

    def test_ac3_rechecks_secret_on_every_resolve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "secrets.env"
            _write(secret, "KEY=one\n", 0o600)
            body = {"file": {"src": str(secret)}}
            self.assertEqual(
                providers.resolve(("file", "src", "KEY"), body, environ={}),
                "one",
            )
            _write(secret, "KEY=two\n", 0o644)
            _expect(
                self,
                lambda: providers.resolve(("file", "src", "KEY"), body, environ={}),
                "unsafe file: provider=file source=src",
            )

    def test_c5_snapshot_versus_config_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "one.env"
            second = root / "two.env"
            _write(first, "KEY=one\n", 0o600)
            _write(second, "KEY=two\n", 0o600)
            config = root / "providers.json"
            _write(config, json.dumps({"file": {"src": str(first)}}), 0o600)
            loaded = providers.load_config(str(config))
            _write(config, json.dumps({"file": {"src": str(second)}}), 0o600)
            self.assertEqual(
                providers.resolve(("file", "src", "KEY"), loaded, environ={}),
                "one",
            )
            self.assertEqual(
                providers.resolve(
                    ("file", "src", "KEY"),
                    {"file": {"ignored": "/tmp/ignored"}},
                    environ={},
                    config_path=str(config),
                ),
                "two",
            )
            os.chmod(config, 0o644)
            self.assertEqual(
                providers.resolve(("file", "src", "KEY"), loaded, environ={}),
                "one",
            )
            _expect(
                self,
                lambda: providers.resolve(
                    ("file", "src", "KEY"),
                    loaded,
                    environ={},
                    config_path=str(config),
                ),
                "invalid provider config",
            )

    def test_snapshot_is_not_mutated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            secret = Path(tmp) / "secrets.env"
            _write(secret, "KEY=value\n", 0o600)
            body = {"file": {"src": str(secret)}}
            before = json.dumps(body)
            providers.resolve(("file", "src", "KEY"), body, environ={})
            self.assertEqual(json.dumps(body), before)

    def test_unknown_source_and_bad_ref(self) -> None:
        _expect(
            self,
            lambda: providers.resolve(("file", "missing", "KEY"), {"file": {}}, environ={}),
            "invalid provider config",
        )
        opened: list[str] = []
        real = os.open

        def spy(path: str, flags: int, *args, **kwargs):
            opened.append(os.fsdecode(path))
            return real(path, flags, *args, **kwargs)

        with mock.patch.object(providers.os, "open", spy):
            _expect(
                self,
                lambda: providers.resolve(("vault", "a", "b"), {"file": {"a": "/tmp/x"}}, environ={}),
                "invalid secret reference",
            )
        self.assertEqual(opened, [])

    def test_hard_link_is_a_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "target.env"
            _write(target, "KEY=linked\n", 0o600)
            link = root / "link.env"
            os.link(target, link)
            value = providers.resolve(
                ("file", "src", "KEY"),
                {"file": {"src": str(link)}},
                environ={},
            )
            self.assertEqual(value, "linked")


class ExecProviderTests(unittest.TestCase):
    def _run(
        self,
        mode: str,
        name: str = "n",
        extra: list[str] | None = None,
        env: list[str] | None = None,
        timeout: int | None = None,
        environ: dict[str, str] | None = None,
        argv0: str | None = None,
    ) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stub = _install_stub(root)
            argv = [argv0 or str(stub), "{name}", mode]
            if extra:
                argv.extend(extra)
            config = _recipe(argv, env=env, timeout=timeout)
            if environ is None:
                environ = {
                    "PATH": "/usr/bin:/bin",
                    "HOME": "/tmp/broker-home",
                    "USER": "tester",
                    "LANG": "C",
                    "TMPDIR": "/tmp",
                }
            return providers.resolve(("exec", "recipe", name), config, environ=environ)

    def test_ac4_strips_one_newline(self) -> None:
        self.assertEqual(self._run("nl"), "hello")
        self.assertEqual(self._run("double"), "hello\n")
        self.assertEqual(self._run("trail"), "hello ")
        self.assertEqual(self._run("crlf"), "hello\r")
        self.assertEqual(self._run("plain"), "hello")
        self.assertEqual(self._run("empty"), "")
        self.assertEqual(self._run("ok"), "ok")

    def test_ac4_status_timeout_not_found_and_bad_output(self) -> None:
        _expect(
            self,
            lambda: self._run("status"),
            "exec failed: recipe=recipe status=4",
        )
        _expect(
            self,
            lambda: self._run("signal"),
            "exec failed: recipe=recipe status=-15",
        )
        _expect(
            self,
            lambda: self._run("sleep", timeout=1),
            "exec failed: recipe=recipe timeout",
        )
        _expect(
            self,
            lambda: self._run("ok", argv0="/no/such/broker-bin"),
            "exec failed: recipe=recipe not found",
        )
        with tempfile.TemporaryDirectory() as tmp:
            stub = _install_stub(Path(tmp))
            os.chmod(stub, 0o600)
            _expect(
                self,
                lambda: self._run("ok", argv0=str(stub)),
                "exec failed: recipe=recipe not found",
            )
        _expect(self, lambda: self._run("plusone"), "exec failed: recipe=recipe bad output")
        _expect(self, lambda: self._run("errplus"), "exec failed: recipe=recipe bad output")
        _expect(self, lambda: self._run("bigout"), "exec failed: recipe=recipe bad output")
        _expect(self, lambda: self._run("bigerr"), "exec failed: recipe=recipe bad output")
        _expect(self, lambda: self._run("badutf"), "exec failed: recipe=recipe bad output")
        self.assertEqual(self._run("exact"), "x" * LIMIT)
        self.assertEqual(len(self._run("exact")), LIMIT)
        self.assertEqual(self._run("errexact"), "ok")
        self.assertEqual(self._run("stderr-utf"), "ok")

    def test_c8_bad_output_beats_timeout_and_status(self) -> None:
        _expect(
            self,
            lambda: self._run("bad-sleep", timeout=1),
            "exec failed: recipe=recipe bad output",
        )
        _expect(self, lambda: self._run("badutf"), "exec failed: recipe=recipe bad output")
        _expect(self, lambda: self._run("bigout"), "exec failed: recipe=recipe bad output")

    def test_ac4_streams_are_not_forwarded(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()

        def run() -> str:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                _expect(
                    self,
                    lambda: self._run("status"),
                    "exec failed: recipe=recipe status=4",
                )
                self.assertEqual(self._run("ok"), "ok")
                return self._run("nl")

        fd_out, fd_err, value = _captured_stdio(run)
        self.assertEqual(value, "hello")
        self.assertNotIn("hello", stdout.getvalue())
        self.assertNotIn("hello", stderr.getvalue())
        self.assertNotIn(FIXTURE, stdout.getvalue())
        self.assertNotIn(FIXTURE, stderr.getvalue())
        self.assertNotIn(b"hello", fd_out)
        self.assertNotIn(b"hello", fd_err)
        self.assertNotIn(FIXTURE.encode("utf-8"), fd_out)
        self.assertNotIn(FIXTURE.encode("utf-8"), fd_err)
        self.assertNotIn(b"stub-stderr-marker", fd_err)

    def test_ac4_environment_and_substitution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / "work"
            output = root / "output"
            work.mkdir()
            output.mkdir()
            stub = _install_stub(work)
            record = output / "record.json"
            name = "alpha/beta.gamma-1"
            config = _recipe(
                [str(stub), "pre-{name}-post", "record", str(record)],
                env=["EXTRA_OK", "MC_TOKEN", "PATH", "MISSING_VAR"],
            )
            environ = {
                "PATH": "/usr/bin:/bin",
                "HOME": "/tmp/broker-home",
                "USER": "tester",
                "LANG": "C",
                "TMPDIR": "/tmp",
                "EXTRA_OK": "extra-ok-value",
                "MC_TOKEN": FIXTURE,
                "NOT_LISTED": FIXTURE,
            }
            before = _tree(work)
            calls: list[dict] = []
            real_popen = subprocess.Popen

            class Recording(subprocess.Popen):
                def __init__(self, args, **kwargs):
                    calls.append({"argv": list(args), "kwargs": kwargs})
                    real_popen.__init__(self, args, **kwargs)

            cwd = os.getcwd()
            os.chdir(work)
            try:
                with mock.patch.object(providers.subprocess, "Popen", Recording):
                    value = providers.resolve(
                        ("exec", "recipe", name),
                        config,
                        environ=environ,
                    )
            finally:
                os.chdir(cwd)
            self.assertEqual(value, FIXTURE)
            self.assertEqual(_tree(work), before)
            payload = json.loads(record.read_text())
            self.assertEqual(
                payload["argv"][1],
                "pre-alpha/beta.gamma-1-post",
            )
            self.assertNotIn("{name}", "".join(payload["argv"]))
            self.assertNotIn(FIXTURE, json.dumps(payload["argv"]))
            # The contract is the dict passed to execve. A Python child then
            # adds interpreter keys (CPATH, SDKROOT, and others) to os.environ.
            child_env = calls[0]["kwargs"]["env"]
            self.assertEqual(
                sorted(child_env),
                ["EXTRA_OK", "HOME", "LANG", "PATH", "TMPDIR", "USER"],
            )
            self.assertEqual(child_env["PATH"], "/usr/bin:/bin")
            self.assertEqual(child_env["EXTRA_OK"], "extra-ok-value")
            self.assertNotIn("MC_TOKEN", child_env)
            self.assertNotIn("NOT_LISTED", child_env)
            self.assertNotIn("MISSING_VAR", child_env)
            self.assertNotIn(FIXTURE, json.dumps(child_env))
            self.assertEqual(len(calls), 1)
            self.assertIs(calls[0]["kwargs"].get("shell", False), False)
            self.assertIsInstance(calls[0]["argv"], list)
            self.assertIsNot(calls[0]["kwargs"]["env"], os.environ)
            self.assertNotIn(FIXTURE, json.dumps(calls[0]["argv"]))
            self.assertNotIn(FIXTURE, json.dumps(calls[0]["kwargs"]["env"]))

    def test_default_timeout_and_environ(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stub = _install_stub(root)
            seen: dict = {}

            def wrap(source: str, argv: list[str], env: dict[str, str], timeout: int) -> str:
                seen["timeout"] = timeout
                seen["env"] = dict(env)
                return "ok"

            parent = {
                "PATH": "/usr/bin:/bin",
                "HOME": "/tmp/broker-home",
                "USER": "tester",
                "LANG": "C",
                "TMPDIR": "/tmp",
                "MC_TOKEN": FIXTURE,
                "NOT_LISTED": FIXTURE,
            }
            config = _recipe([str(stub), "{name}", "envcheck", str(root / "keys.txt")])
            with mock.patch.object(providers.os, "environ", parent):
                with mock.patch.object(providers, "_run_exec", wrap):
                    providers.resolve(("exec", "recipe", "n"), config, environ=None)
            self.assertEqual(seen["timeout"], 10)
            self.assertEqual(
                seen["env"],
                {
                    "PATH": "/usr/bin:/bin",
                    "HOME": "/tmp/broker-home",
                    "USER": "tester",
                    "LANG": "C",
                    "TMPDIR": "/tmp",
                },
            )
            self.assertNotIn(FIXTURE, json.dumps(seen["env"]))
            seen.clear()
            empty_parent = {"MC_TOKEN": FIXTURE, "NOT_LISTED": FIXTURE}
            with mock.patch.object(providers.os, "environ", empty_parent):
                with mock.patch.object(providers, "_run_exec", wrap):
                    self.assertEqual(
                        providers.resolve(("exec", "recipe", "n"), config, environ=None),
                        "ok",
                    )
            self.assertEqual(seen["env"], {})
            self.assertNotIn(FIXTURE, json.dumps(seen["env"]))

    def test_launch_encoding_errors_are_not_found(self) -> None:
        base = {
            "HOME": "/tmp/broker-home",
            "USER": "tester",
            "LANG": "C",
            "TMPDIR": "/tmp",
        }
        _expect(
            self,
            lambda: self._run("ok", environ=dict(base, PATH="/usr/bin\x00")),
            "exec failed: recipe=recipe not found",
        )
        _expect(
            self,
            lambda: self._run("ok", environ=dict(base, PATH="\ud800")),
            "exec failed: recipe=recipe not found",
        )
        _expect(
            self,
            lambda: self._run(
                "ok",
                env=["CUSTOM"],
                environ=dict(base, PATH="/usr/bin", CUSTOM="a\x00b"),
            ),
            "exec failed: recipe=recipe not found",
        )

    def test_pipe_read_error_is_bad_output(self) -> None:
        real_read = os.read
        real_popen = subprocess.Popen
        pipe_fds: set[int] = set()
        seen = {"pipes": 0}

        class Track(subprocess.Popen):
            def __init__(self, args, **kwargs):
                real_popen.__init__(self, args, **kwargs)
                if self.stdout is not None:
                    pipe_fds.add(self.stdout.fileno())
                if self.stderr is not None:
                    pipe_fds.add(self.stderr.fileno())

        def flaky(fd: int, size: int) -> bytes:
            if fd in pipe_fds:
                seen["pipes"] += 1
                if seen["pipes"] == 1:
                    return b"partial-value"
                raise OSError("pipe read failed")
            return real_read(fd, size)

        with mock.patch.object(providers.subprocess, "Popen", Track):
            with mock.patch.object(providers.os, "read", flaky):
                with self.assertRaises(ValueError) as caught:
                    self._run("ok")
        self.assertEqual(str(caught.exception), "exec failed: recipe=recipe bad output")
        self.assertNotIn("partial-value", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertGreaterEqual(seen["pipes"], 2)

    def test_selector_setup_error_is_bad_output(self) -> None:
        pids: list[int] = []
        real_popen = subprocess.Popen

        class Remember(subprocess.Popen):
            def __init__(self, args, **kwargs):
                real_popen.__init__(self, args, **kwargs)
                pids.append(self.pid)

        def boom(*_args, **_kwargs):
            raise OSError("selector failed")

        started = time.monotonic()
        with mock.patch.object(providers.subprocess, "Popen", Remember):
            with mock.patch.object(providers.selectors, "DefaultSelector", boom):
                _expect(
                    self,
                    lambda: self._run("sleep", timeout=2),
                    "exec failed: recipe=recipe bad output",
                )
        self.assertLess(time.monotonic() - started, 4)
        self.assertTrue(pids)
        with self.assertRaises(ChildProcessError):
            os.waitpid(pids[0], os.WNOHANG)

    def test_timeout_kills_helper_process_group(self) -> None:
        helper = None
        try:
            with tempfile.TemporaryDirectory() as tmp:
                pidfile = Path(tmp) / "helper.pid"

                def run() -> None:
                    self._run("helper-sleep", timeout=1, extra=[str(pidfile)])

                _expect(self, run, "exec failed: recipe=recipe timeout")
                helper = int(pidfile.read_text())
                _assert_pid_dead(self, helper)
        finally:
            if helper is not None:
                try:
                    os.kill(helper, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(helper, os.WNOHANG)
                except ChildProcessError:
                    pass

    def test_closed_stdio_sleep_is_timeout(self) -> None:
        started = time.monotonic()
        _expect(
            self,
            lambda: self._run("close-sleep", timeout=1),
            "exec failed: recipe=recipe timeout",
        )
        self.assertLess(time.monotonic() - started, 8)

    def test_abort_reaps_direct_child(self) -> None:
        real_popen = subprocess.Popen

        def remember(pids: list[int]):
            class Remember(subprocess.Popen):
                def __init__(self, args, **kwargs):
                    real_popen.__init__(self, args, **kwargs)
                    pids.append(self.pid)

            return Remember

        timeout_pids: list[int] = []
        with mock.patch.object(providers.subprocess, "Popen", remember(timeout_pids)):
            _expect(
                self,
                lambda: self._run("sleep", timeout=1),
                "exec failed: recipe=recipe timeout",
            )
        self.assertTrue(timeout_pids)
        with self.assertRaises(ChildProcessError):
            os.waitpid(timeout_pids[0], os.WNOHANG)

        output_pids: list[int] = []
        with mock.patch.object(providers.subprocess, "Popen", remember(output_pids)):
            _expect(
                self,
                lambda: self._run("plusone"),
                "exec failed: recipe=recipe bad output",
            )
        self.assertTrue(output_pids)
        with self.assertRaises(ChildProcessError):
            os.waitpid(output_pids[0], os.WNOHANG)

    def test_killpg_permission_error_bounds_reap(self) -> None:
        real_popen = subprocess.Popen
        pids: list[int] = []

        def remember():
            class Remember(subprocess.Popen):
                def __init__(self, args, **kwargs):
                    real_popen.__init__(self, args, **kwargs)
                    pids.append(self.pid)

            return Remember

        def deny_killpg(pid: int, sig: int) -> None:
            raise PermissionError(pid)

        started = time.monotonic()
        try:
            with mock.patch.object(providers.os, "killpg", deny_killpg):
                with mock.patch.object(providers.subprocess, "Popen", remember()):
                    _expect(
                        self,
                        lambda: self._run("sleep30", timeout=1),
                        "exec failed: recipe=recipe timeout",
                    )
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 1 + providers._ABORT_REAP_SECONDS + 2)
            self.assertTrue(pids)
            with self.assertRaises(ChildProcessError):
                os.waitpid(pids[0], os.WNOHANG)
        finally:
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass

    def test_kill_denied_reap_is_bounded(self) -> None:
        pids: list[int] = []

        def deny_killpg(pid: int, sig: int) -> None:
            raise PermissionError(pid)

        def deny_kill(self: subprocess.Popen) -> None:
            if type(self.pid) is int:
                pids.append(self.pid)
            raise PermissionError(self.pid)

        started = time.monotonic()
        try:
            with mock.patch.object(providers.os, "killpg", deny_killpg):
                with mock.patch.object(subprocess.Popen, "kill", deny_kill):
                    _expect(
                        self,
                        lambda: self._run("sleep30", timeout=1),
                        "exec failed: recipe=recipe timeout",
                    )
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 1 + providers._ABORT_REAP_SECONDS + 2)
            self.assertTrue(pids)
        finally:
            for pid in pids:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass

    def test_child_env_reads_each_key_once(self) -> None:
        counting = _CountingEnv(
            {
                "PATH": 5,
                "EXTRA": "once-value",
                "MC_TOKEN": FIXTURE,
            }
        )
        seen: dict = {}

        def wrap(source: str, argv: list[str], env: dict[str, str], timeout: int) -> str:
            seen["env"] = dict(env)
            return "ok"

        with tempfile.TemporaryDirectory() as tmp:
            stub = _install_stub(Path(tmp))
            config = _recipe([str(stub), "{name}"], env=["EXTRA", "MC_TOKEN", "PATH"])
            with mock.patch.object(providers, "_run_exec", wrap):
                self.assertEqual(
                    providers.resolve(("exec", "recipe", "n"), config, environ=counting),
                    "ok",
                )
        self.assertNotIn("PATH", seen["env"])
        self.assertEqual(seen["env"].get("EXTRA"), "once-value")
        self.assertNotIn("MC_TOKEN", seen["env"])
        self.assertEqual(counting.reads.count("PATH"), 1)
        self.assertEqual(counting.reads.count("EXTRA"), 1)
        self.assertEqual(counting.reads.count("MC_TOKEN"), 0)
        self.assertNotIn(FIXTURE, json.dumps(seen["env"]))

    def test_duplicate_env_name_is_read_once(self) -> None:
        counting = _CountingEnv({"DUP": "first", "LATER": "second"})
        seen: dict = {}

        def wrap(source: str, argv: list[str], env: dict[str, str], timeout: int) -> str:
            seen["env"] = env
            return "ok"

        with mock.patch.object(providers, "_run_exec", wrap):
            providers.resolve(
                ("exec", "recipe", "n"),
                _recipe(["/bin/echo", "{name}"], env=["DUP", "LATER", "DUP"]),
                environ=counting,
            )
        self.assertEqual(
            (counting.reads.count("DUP"), seen["env"]["DUP"], list(seen["env"])),
            (1, "first", ["DUP", "LATER"]),
        )

    def test_missing_recipe_is_invalid_config(self) -> None:
        _expect(
            self,
            lambda: providers.resolve(
                ("exec", "missing", "n"),
                {"exec": {}},
                environ={},
            ),
            "invalid provider config",
        )

    def test_no_fd_leak(self) -> None:
        def count() -> int:
            return len(os.listdir("/dev/fd"))

        before = count()
        for _ in range(8):
            self.assertEqual(self._run("ok"), "ok")
        self.assertEqual(count(), before)


class RedactionTests(unittest.TestCase):
    def test_ac5_file_and_exec(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work = root / "work"
            output = root / "output"
            work.mkdir()
            output.mkdir()
            secret = work / "secrets.env"
            _write(secret, "KEY=" + FIXTURE + "\n", 0o600)
            file_config = {"file": {"src": str(secret)}}
            stub = _install_stub(work)
            record = output / "record.json"
            exec_config = _recipe(
                [str(stub), "{name}", "record", str(record)],
                env=["MC_TOKEN", "EXTRA_OK"],
            )
            environ = {
                "PATH": "/usr/bin:/bin",
                "HOME": "/tmp/broker-home",
                "USER": "tester",
                "LANG": "C",
                "TMPDIR": "/tmp",
                "EXTRA_OK": "extra-ok-value",
                "MC_TOKEN": FIXTURE,
                "NOT_LISTED": FIXTURE,
            }
            log_stream = io.StringIO()
            handler = logging.StreamHandler(log_stream)
            handler.setLevel(logging.DEBUG)
            root_logger = logging.getLogger()
            previous = root_logger.level
            root_logger.setLevel(logging.DEBUG)
            root_logger.addHandler(handler)
            parent_out = io.StringIO()
            parent_err = io.StringIO()
            stderr_bytes = bytearray()
            calls: list[dict] = []
            real_popen = subprocess.Popen
            real_read = os.read
            stderr_fd: dict[str, int] = {}

            class Recording(subprocess.Popen):
                def __init__(self, args, **kwargs):
                    calls.append({"argv": list(args), "env": dict(kwargs.get("env") or {})})
                    real_popen.__init__(self, args, **kwargs)
                    if self.stderr is not None:
                        stderr_fd["fd"] = self.stderr.fileno()

            def spy_read(fd: int, size: int) -> bytes:
                data = real_read(fd, size)
                if fd == stderr_fd.get("fd"):
                    stderr_bytes.extend(data)
                return data

            before = _tree(work)
            cwd = os.getcwd()
            os.chdir(work)
            try:
                with contextlib.redirect_stdout(parent_out), contextlib.redirect_stderr(parent_err):
                    with mock.patch.object(providers.subprocess, "Popen", Recording):
                        with mock.patch.object(providers.os, "read", spy_read):
                            file_value = providers.resolve(
                                ("file", "src", "KEY"),
                                file_config,
                                environ=environ,
                            )
                            exec_value = providers.resolve(
                                ("exec", "recipe", "n"),
                                exec_config,
                                environ=environ,
                            )
            finally:
                os.chdir(cwd)
                root_logger.removeHandler(handler)
                root_logger.setLevel(previous)
            self.assertEqual(file_value, FIXTURE)
            self.assertEqual(exec_value, FIXTURE)
            self.assertEqual(_tree(work), before)
            self.assertNotIn(FIXTURE, log_stream.getvalue())
            self.assertNotIn(FIXTURE, parent_out.getvalue())
            self.assertNotIn(FIXTURE, parent_err.getvalue())
            self.assertNotIn("stub-stderr-marker", parent_err.getvalue())
            self.assertIn(b"stub-stderr-marker", bytes(stderr_bytes))
            self.assertNotIn(FIXTURE.encode("utf-8"), bytes(stderr_bytes))
            self.assertTrue(calls)
            for call in calls:
                self.assertNotIn(FIXTURE, json.dumps(call["argv"]))
                self.assertNotIn(FIXTURE, json.dumps(call["env"]))
                self.assertNotIn("MC_TOKEN", call["env"])
                self.assertNotIn("NOT_LISTED", call["env"])
                self.assertEqual(call["env"].get("EXTRA_OK"), "extra-ok-value")
            payload = json.loads(record.read_text())
            self.assertNotIn(FIXTURE, json.dumps(payload["argv"]))
            self.assertNotIn(FIXTURE, json.dumps(payload["env"]))
            self.assertTrue(str(record).startswith(str(output)))


class ContractTests(unittest.TestCase):
    def test_readme_and_example(self) -> None:
        readme = (BROKER / "README.md").read_text()
        self.assertEqual(readme.count("not run"), 4)
        self.assertNotIn("run on ", readme)
        self.assertIn('op read "op://{name}"', readme)
        self.assertIn(
            "security find-generic-password -s <service> -a <account> -w",
            readme,
        )
        self.assertIn("""sops -d --extract '["{name}"]' <file>""", readme)
        self.assertGreaterEqual(readme.lower().count("operator substitution"), 3)
        self.assertIn("install -m 600 /dev/null /var/lib/agent-kontrol/secrets.env", readme)
        self.assertIn("secretref://file/default/OPENROUTER_API_KEY", readme)
        self.assertIn("secretref://exec/onepassword/Prod/OpenRouter/credential", readme)
        self.assertIn("secretref://exec/keychain/openrouter-api-key", readme)
        self.assertIn("secretref://exec/sops/openrouter_api_key", readme)
        self.assertIn(
            "The name grammar allows a leading `-`, so a recipe should put `--` before `{name}` wherever the target command accepts it.",
            readme,
        )
        example = json.loads((BROKER / "providers.example.json").read_text())
        self.assertEqual(example["exec"]["onepassword"]["argv"], ["op", "read", "op://{name}"])
        self.assertEqual(example["exec"]["onepassword"]["env"], ["OP_SERVICE_ACCOUNT_TOKEN"])
        self.assertEqual(
            example["exec"]["keychain"]["argv"],
            ["security", "find-generic-password", "-s", "<service>", "-a", "{name}", "-w"],
        )
        self.assertEqual(
            example["exec"]["sops"]["argv"],
            ["sops", "-d", "--extract", '["{name}"]', "<file>"],
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "providers.json"
            _write(path, json.dumps(example), 0o600)
            loaded = providers.load_config(str(path))
            self.assertEqual(loaded["file"]["default"], "/var/lib/agent-kontrol/secrets.env")

    def test_ci_steps_follow_build(self) -> None:
        text = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        build = text.index("pnpm run build")
        self.assertLess(text.index('python-version: "3.12"'), build)
        after = text[build:]
        self.assertIn("python:3.9-slim", after)
        self.assertIn('--user "$(id -u):$(id -g)"', after)
        self.assertIn(
            "python3.9 -m unittest discover -s tests/unit -p 'test_broker*.py' -v",
            after,
        )
        self.assertIn("python3.9 -m py_compile agents/broker/*.py", after)
        self.assertNotIn('python-version: "3.9"', text)

    def test_stdlib_only_and_no_package_init(self) -> None:
        self.assertFalse((BROKER / "__init__.py").exists())
        allowed = {
            "__future__",
            "os",
            "stat",
            "json",
            "re",
            "subprocess",
            "selectors",
            "time",
            "refs",
            "collections",
            "signal",
        }
        for name in ("refs.py", "providers.py"):
            tree = ast.parse((BROKER / name).read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertIn(alias.name.split(".")[0], allowed)
                elif isinstance(node, ast.ImportFrom):
                    self.assertEqual(node.level, 0)
                    self.assertIsNotNone(node.module)
                    assert node.module is not None
                    self.assertIn(node.module.split(".")[0], allowed)
                elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                    self.assertNotEqual(node.func.id, "print")
                elif isinstance(node, ast.keyword) and node.arg == "shell":
                    self.assertIsInstance(node.value, ast.Constant)
                    self.assertIs(node.value.value, False)


if __name__ == "__main__":
    unittest.main()
