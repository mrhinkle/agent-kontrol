"""Resolve secret references through the file and exec providers. Stdlib only.

Production callers pass ``config_path`` so every resolve reopens the config.
Error text is one of the fixed sentences in the broker contract. Nothing
here logs, prints, or writes a resolved value, and no failure chains an
OSError (those messages carry paths).
"""
from __future__ import annotations

import json
import os
import re
import selectors
import signal
import stat
import subprocess
import time
from collections.abc import Mapping

import refs

_INVALID_CONFIG = "invalid provider config"
_OUTPUT_LIMIT = 1048576
_READ_CHUNK = 65536
_BASE_ENV = ("PATH", "HOME", "USER", "LANG", "TMPDIR")
_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_TOP_KEYS = frozenset(("file", "exec"))
_RECIPE_KEYS = frozenset(("argv", "env", "timeout_seconds"))
_OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    _OPEN_FLAGS |= os.O_CLOEXEC
if hasattr(os, "O_NONBLOCK"):
    # A FIFO would otherwise block in open before the regular-file check.
    _OPEN_FLAGS |= os.O_NONBLOCK


def _raise(message: str) -> None:
    """Raise a clean ValueError with no chained context.

    ``raise ... from None`` still stores the caller's handled exception on
    ``__context__``. Clear it before the exception leaves this function.
    """
    exc = ValueError(message)
    try:
        raise exc from None
    finally:
        exc.__context__ = None


def _fs_encodable(text: str) -> bool:
    failed = False
    try:
        os.fsencode(text)
    except UnicodeEncodeError:
        failed = True
    return not failed


def _close_fd(fd: int) -> None:
    try:
        os.close(fd)
    except OSError:
        return


def _stat_ok(st: os.stat_result) -> bool:
    # Exactly 0600 or 0400. type(mode) via S_IMODE drops the file-type bits.
    mode = stat.S_IMODE(st.st_mode)
    if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
        return False
    if st.st_uid != os.geteuid():
        return False
    return mode in (0o600, 0o400)


def _open_checked(path: str, safety_error: str) -> int:
    """Open ``path`` no-follow and return the fd only after fstat succeeds."""
    # os.open raises ValueError (not OSError) for an embedded NUL, and that
    # message includes the path. Reject it before the call.
    if type(path) is not str or path == "" or "\x00" in path or not _fs_encodable(path):
        _raise(safety_error)
    failed = False
    fd = -1
    try:
        fd = os.open(path, _OPEN_FLAGS)
    except (OSError, UnicodeEncodeError):
        failed = True
    if failed:
        _raise(safety_error)
    ok = False
    try:
        info = None
        try:
            info = os.fstat(fd)
        except OSError:
            info = None
        ok = info is not None and _stat_ok(info)
    finally:
        if not ok:
            _close_fd(fd)
    if not ok:
        _raise(safety_error)
    return fd


def _read_fd(fd: int, read_error: str) -> bytes:
    chunks: list[bytes] = []
    failed = False
    try:
        while True:
            block = os.read(fd, _READ_CHUNK)
            if not block:
                break
            chunks.append(block)
    except OSError:
        failed = True
    if failed:
        _raise(read_error)
    return b"".join(chunks)


def _read_text(path: str, safety_error: str, read_error: str) -> str:
    fd = _open_checked(path, safety_error)
    try:
        data = _read_fd(fd, read_error)
    finally:
        _close_fd(fd)
    failed = False
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        failed = True
    if failed:
        _raise(read_error)
    return text


def _reject_constant(_token: str) -> None:
    raise ValueError(_INVALID_CONFIG)


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(_INVALID_CONFIG)
        obj[key] = value
    return obj


def _parse_json(text: str) -> object:
    failed = False
    data: object = None
    try:
        data = json.loads(
            text,
            object_pairs_hook=_no_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except (ValueError, TypeError, json.JSONDecodeError, RecursionError):
        failed = True
    if failed:
        _raise(_INVALID_CONFIG)
    return data


def _validate_recipe(recipe: object) -> None:
    if not isinstance(recipe, dict) or any(key not in _RECIPE_KEYS for key in recipe):
        _raise(_INVALID_CONFIG)
    if "argv" not in recipe:
        _raise(_INVALID_CONFIG)
    argv = recipe["argv"]
    if not isinstance(argv, list) or not argv:
        _raise(_INVALID_CONFIG)
    if any(type(part) is not str for part in argv):
        _raise(_INVALID_CONFIG)
    # bool is a subclass of int; type() is int rejects true/false.
    if argv[0] == "" or any("\x00" in part or not _fs_encodable(part) for part in argv):
        _raise(_INVALID_CONFIG)
    if not any("{name}" in part for part in argv):
        _raise(_INVALID_CONFIG)
    if "env" in recipe:
        env = recipe["env"]
        if not isinstance(env, list):
            _raise(_INVALID_CONFIG)
        for name in env:
            if type(name) is not str or _KEY_RE.fullmatch(name) is None:
                _raise(_INVALID_CONFIG)
    if "timeout_seconds" in recipe:
        timeout = recipe["timeout_seconds"]
        if type(timeout) is not int or not 1 <= timeout <= 300:
            _raise(_INVALID_CONFIG)


def _validate_config(data: object) -> None:
    if not isinstance(data, dict) or not data:
        _raise(_INVALID_CONFIG)
    if any(key not in _TOP_KEYS for key in data):
        _raise(_INVALID_CONFIG)
    if "file" in data:
        section = data["file"]
        if not isinstance(section, dict):
            _raise(_INVALID_CONFIG)
        for key, path in section.items():
            if type(key) is not str or _ID_RE.fullmatch(key) is None:
                _raise(_INVALID_CONFIG)
            if (
                type(path) is not str
                or "\x00" in path
                or not os.path.isabs(path)
                or not _fs_encodable(path)
            ):
                _raise(_INVALID_CONFIG)
    if "exec" in data:
        section = data["exec"]
        if not isinstance(section, dict):
            _raise(_INVALID_CONFIG)
        for key, recipe in section.items():
            if type(key) is not str or _ID_RE.fullmatch(key) is None:
                _raise(_INVALID_CONFIG)
            _validate_recipe(recipe)


def load_config(path: str) -> dict:
    """Read and validate a provider config. The file must pass the mode check."""
    if type(path) is not str:
        _raise(_INVALID_CONFIG)
    text = _read_text(path, _INVALID_CONFIG, _INVALID_CONFIG)
    data = _parse_json(text)
    _validate_config(data)
    if not isinstance(data, dict):
        _raise(_INVALID_CONFIG)
    return data


def _parse_env(text: str, error: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if line.strip() == "":
            continue
        if line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            _raise(error)
        raw_key, raw_value = line.split("=", 1)
        key = raw_key.strip()
        value = raw_value.strip()
        if _KEY_RE.fullmatch(key) is None or key in values:
            _raise(error)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def _checked_ref(ref: object) -> tuple[str, str, str]:
    if not isinstance(ref, tuple) or len(ref) != 3:
        _raise("invalid secret reference")
    provider, source, name = ref
    if type(provider) is not str or type(source) is not str or type(name) is not str:
        _raise("invalid secret reference")
    failed = False
    parsed: tuple[str, str, str] | None = None
    try:
        parsed = refs.parse_reference("secretref://" + provider + "/" + source + "/" + name)
    except ValueError:
        failed = True
    if failed or parsed != (provider, source, name):
        _raise("invalid secret reference")
    return provider, source, name


def _resolve_file(source: str, name: str, config: dict) -> str:
    files = config.get("file")
    if not isinstance(files, dict) or source not in files:
        _raise(_INVALID_CONFIG)
    path = files[source]
    if type(path) is not str or "\x00" in path or not os.path.isabs(path) or not _fs_encodable(path):
        _raise(_INVALID_CONFIG)
    safety = "unsafe file: provider=file source=%s" % source
    content = "invalid provider file: provider=file source=%s" % source
    text = _read_text(path, safety, content)
    values = _parse_env(text, content)
    if name not in values:
        _raise("missing key: provider=file source=%s name=%s" % (source, name))
    return values[name]


def _child_env(recipe: dict, environ: Mapping[str, str]) -> dict[str, str]:
    child: dict[str, str] = {}
    for key in _BASE_ENV:
        value = environ.get(key)
        if type(value) is str:
            child[key] = value
    for key in recipe.get("env", ()):
        if key in _BASE_ENV or key.startswith("MC_"):
            continue
        value = environ.get(key)
        if type(value) is str:
            child[key] = value
    return child


def _spawn(source: str, argv: list[str], env: dict[str, str]) -> subprocess.Popen:
    failed = False
    proc = None
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            env=env,
            bufsize=0,
            start_new_session=True,
        )
    except (OSError, ValueError):
        failed = True
    if failed or proc is None:
        _raise("exec failed: recipe=%s not found" % source)
    return proc


def _abort(proc: subprocess.Popen) -> None:
    """SIGKILL the recipe session, then reap the direct child.

    A grandchild can still be in the session after the direct child has
    exited. Do not return while this pid is unreaped.
    """
    pid = proc.pid
    if type(pid) is int and pid > 0:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    while proc.poll() is None:
        proc.wait()


def _close_pipes(proc: subprocess.Popen) -> None:
    for stream in (proc.stdout, proc.stderr, proc.stdin):
        if stream is None:
            continue
        try:
            stream.close()
        except OSError:
            pass


def _pump(
    proc: subprocess.Popen,
    stdout: bytearray,
    stderr: bytearray,
    deadline: float,
) -> tuple[bool, bool, bool]:
    """Read both pipes until EOF, the deadline, a cap, or a read failure.

    The third value is a selector or ``os.read`` failure. A zero-byte read
    is EOF. The cap is 1,048,576 bytes inclusive. Crossing it is
    ``bad output`` and outranks a timeout and a non-zero exit.
    """
    exceeded = False
    timed_out = False
    broken = False
    selector = None
    try:
        try:
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ, stdout)
            selector.register(proc.stderr, selectors.EVENT_READ, stderr)
        except OSError:
            broken = True
        if not broken and selector is not None:
            open_streams = 2
            while open_streams:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                events = selector.select(timeout=remaining)
                if not events:
                    timed_out = True
                    break
                for key, _mask in events:
                    try:
                        chunk = os.read(key.fd, _READ_CHUNK)
                    except OSError:
                        broken = True
                        break
                    if chunk == b"":
                        try:
                            selector.unregister(key.fileobj)
                        except (KeyError, ValueError):
                            pass
                        open_streams -= 1
                        continue
                    buf = key.data
                    if len(buf) + len(chunk) > _OUTPUT_LIMIT:
                        exceeded = True
                        break
                    buf.extend(chunk)
                if exceeded or broken:
                    break
    finally:
        if selector is not None:
            try:
                selector.close()
            except OSError:
                pass
    return exceeded, timed_out, broken


def _wait_until(proc: subprocess.Popen, deadline: float) -> bool:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return True
    timed_out = False
    try:
        proc.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        timed_out = True
    return timed_out


def _finish(
    source: str,
    stdout: bytes,
    exceeded: bool,
    timed_out: bool,
    returncode: int | None,
) -> str:
    if exceeded:
        _raise("exec failed: recipe=%s bad output" % source)
    failed = False
    text = ""
    try:
        text = stdout.decode("utf-8")
    except UnicodeDecodeError:
        failed = True
    if failed:
        _raise("exec failed: recipe=%s bad output" % source)
    if timed_out:
        _raise("exec failed: recipe=%s timeout" % source)
    if returncode is None:
        _raise("exec failed: recipe=%s timeout" % source)
    if returncode != 0:
        # A signal is already negative (for example -15). Do not wrap it.
        _raise("exec failed: recipe=%s status=%s" % (source, returncode))
    # One trailing newline only. rstrip() would eat trailing whitespace.
    if text.endswith("\n"):
        text = text[:-1]
    return text


def _run_exec(source: str, argv: list[str], env: dict[str, str], timeout: int) -> str:
    proc = _spawn(source, argv, env)
    stdout = bytearray()
    stderr = bytearray()
    deadline = time.monotonic() + timeout
    exceeded = False
    timed_out = False
    broken = False
    try:
        exceeded, timed_out, broken = _pump(proc, stdout, stderr, deadline)
        if not exceeded and not timed_out and not broken:
            timed_out = _wait_until(proc, deadline)
    finally:
        if exceeded or timed_out or broken or proc.poll() is None:
            _abort(proc)
        _close_pipes(proc)
    if broken or exceeded:
        _raise("exec failed: recipe=%s bad output" % source)
    code = proc.returncode if type(proc.returncode) is int else None
    return _finish(source, bytes(stdout), False, timed_out, code)


def _resolve_exec(source: str, name: str, config: dict, environ: Mapping[str, str]) -> str:
    recipes = config.get("exec")
    if not isinstance(recipes, dict) or source not in recipes:
        _raise(_INVALID_CONFIG)
    recipe = recipes[source]
    if not isinstance(recipe, dict):
        _raise(_INVALID_CONFIG)
    argv = [part.replace("{name}", name) for part in recipe["argv"]]
    env = _child_env(recipe, environ)
    timeout = recipe["timeout_seconds"] if "timeout_seconds" in recipe else 10
    return _run_exec(source, argv, env, timeout)


def resolve(
    ref: tuple[str, str, str],
    config: dict,
    environ: Mapping[str, str] | None = None,
    config_path: str | None = None,
) -> str:
    """Return the value for ``ref``. Pass ``config_path`` outside tests.

    With ``config_path``, the config file is reopened, checked, and parsed
    before use. Without it, ``config`` is treated as an immutable snapshot.
    """
    provider, source, name = _checked_ref(ref)
    if environ is None:
        environ = os.environ
    elif not isinstance(environ, Mapping):
        _raise(_INVALID_CONFIG)
    if config_path is not None:
        config = load_config(config_path)
    else:
        _validate_config(config)
    if provider == "file":
        return _resolve_file(source, name, config)
    return _resolve_exec(source, name, config, environ)
