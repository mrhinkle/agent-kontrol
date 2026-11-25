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
import stat
import subprocess
import sys
import tempfile
import unittest
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

_STUB = """#!/usr/bin/python3
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
else:
    raise SystemExit(2)
"""


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
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            value = self._run("status") if False else None
            try:
                self._run("ok")
            except ValueError:
                pass
            value = self._run("nl")
        self.assertEqual(value, "hello")
        self.assertNotIn("hello", stdout.getvalue())
        self.assertNotIn("hello", stderr.getvalue())
        self.assertNotIn(FIXTURE, stdout.getvalue())
        self.assertNotIn(FIXTURE, stderr.getvalue())

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
            real = providers._run_exec

            def wrap(source: str, argv: list[str], env: dict[str, str], timeout: int) -> str:
                seen["timeout"] = timeout
                seen["env"] = dict(env)
                return real(source, argv, env, timeout)

            dest = root / "keys.txt"
            config = _recipe([str(stub), "{name}", "envcheck", str(dest)])
            with mock.patch.object(providers, "_run_exec", wrap):
                providers.resolve(("exec", "recipe", "n"), config, environ=None)
            self.assertEqual(seen["timeout"], 10)
            keys = set(seen["env"])
            self.assertTrue(keys)
            self.assertTrue(keys <= {"PATH", "HOME", "USER", "LANG", "TMPDIR"})
            self.assertFalse(any(key.startswith("MC_") for key in keys))
            self.assertNotIn(FIXTURE, json.dumps(seen["env"]))

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
        self.assertLess(build, text.index('python-version: "3.9"'))
        self.assertIn(
            "python3.9 -m unittest discover -s tests/unit -p 'test_broker*.py' -v",
            text,
        )
        self.assertIn("python3.9 -m py_compile agents/broker/*.py", text)

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
