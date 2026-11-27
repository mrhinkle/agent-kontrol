"""Loopback HTTP broker. Stdlib only. Python 3.9.

A lane calls ``http://127.0.0.1:<port>/<service>/...`` with an ``akp_``
placeholder. This process checks the placeholder and the allowlist, swaps in
the real secret, and forwards the request over verified TLS.

The secret and the placeholder must never reach the client, the upstream,
a log line, an exception message, or stderr.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import socket
import ssl
import stat
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import http.client

import audit
import providers
import refs

_LOG = logging.getLogger("ak.broker")

_ROOT_KEYS = frozenset((
    "admin_socket",
    "bind",
    "port",
    "providers",
    "placeholder_ttl_seconds",
    "upstream_timeout_seconds",
    "max_request_body_bytes",
    "services",
))
# Optional root key (#192). Absent means no audit events at all.
_AUDIT_KEY = "audit"
_SERVICE_KEYS = frozenset((
    "name",
    "upstream",
    "header",
    "template",
    "secret",
    "methods",
    "path_prefixes",
    "env_key",
    "env_base_url",
))
_TOKEN_RE = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+\Z")
_METHOD_RE = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Z]+\Z")
_NAME_RE = re.compile(r"[a-z0-9-]{1,40}\Z")
_PLACEHOLDER_RE = re.compile(r"akp_[A-Za-z0-9_-]+\Z")
_ENCODED_SLASH_RE = re.compile(r"%2f", re.IGNORECASE)
_ENCODED_BACKSLASH_RE = re.compile(r"%5c", re.IGNORECASE)
_HEX_RE = re.compile(r"[0-9A-Fa-f]+\Z")
_CL_RE = re.compile(r"[0-9]+\Z")
_ENV_NAME_RE = re.compile(r"[A-Z_][A-Z0-9_]*\Z")

# Admin socket (#194). One JSON object per line, newline included in the limit.
_ADMIN_MAX_LINE = 65536
_ADMIN_TIMEOUT = 5.0
_ADMIN_STALE_PROBE = 1.0
# sun_path is 104 bytes on macOS and 108 on Linux, including the NUL.
_ADMIN_MAX_PATH = 103
_ADMIN_ERRORS = frozenset(("malformed_json", "bad_request", "unknown_op", "unknown_service", "internal"))
# A placeholder is "akp_" plus token_urlsafe(32), which is 43 characters.
_PLACEHOLDER_LEN = 4 + 43

_SMALL_BODY = 1024 * 1024
_READ_CHUNK = 65536
_MAX_LINE = 65536
# Response Content-Length is not the request body limit. 19 digits covers
# any length that fits in a signed 64-bit integer. A longer digit string
# is malformed and is never passed to int().
_MAX_RESPONSE_LENGTH_DIGITS = 19

_REDIRECTS = frozenset((300, 301, 302, 303, 305, 307, 308))
_NO_BODY = frozenset((204, 304))
_REASONS = frozenset((
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
    "body_too_large",
    "secret_in_response",
    "missing_task_context",
))
_REQUEST_DROP = frozenset((
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    # Framing is generated from the body mode, so the inbound length is not copied.
    "content-length",
    # Replaced by Accept-Encoding: identity so the response scan can read the body (#194).
    "accept-encoding",
))
# Credential injection must not be able to replace framing or hop-by-hop fields.
_OWNED_HEADERS = frozenset((
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "proxy-connection",
    # The broker always sends Accept-Encoding: identity (#194).
    "accept-encoding",
))
_RESPONSE_HOP = frozenset((
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
))

_OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW
if hasattr(os, "O_CLOEXEC"):
    _OPEN_FLAGS |= os.O_CLOEXEC
if hasattr(os, "O_NONBLOCK"):
    _OPEN_FLAGS |= os.O_NONBLOCK


class _BadRequest(Exception):
    """A request that has not been forwarded. The message is the code only."""


class _Abort(Exception):
    """Streaming already started. ``reason`` is a fixed code, never payload."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class UpstreamError(Exception):
    """A classified upstream failure. The message is always ``upstream_error``."""

    def __init__(self, cause: str) -> None:
        super().__init__("upstream_error")
        self.cause = cause


def _fail(message: str) -> None:
    """Raise ``ValueError`` with no chained context (paths ride on OSError)."""
    _raise_clean(ValueError(message))


def _raise_clean(exc: BaseException) -> None:
    """Raise a sanitized error. ``__context__`` must not carry upstream text."""
    try:
        raise exc from None
    finally:
        exc.__context__ = None


def _fs_encodable(text: str) -> bool:
    try:
        os.fsencode(text)
    except UnicodeEncodeError:
        return False
    return True


def _close_fd(fd: int) -> None:
    try:
        os.close(fd)
    except OSError:
        return


def _stat_ok(info: os.stat_result) -> bool:
    mode = stat.S_IMODE(info.st_mode)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        return False
    if info.st_uid != os.geteuid():
        return False
    return mode in (0o600, 0o400)


def _read_config_text(path: str) -> str:
    if type(path) is not str or path == "" or "\x00" in path or not _fs_encodable(path):
        _fail("invalid broker config")
    fd = -1
    try:
        fd = os.open(path, _OPEN_FLAGS)
    except (OSError, UnicodeEncodeError, ValueError):
        _fail("invalid broker config")
    ok = False
    try:
        try:
            info = os.fstat(fd)
        except OSError:
            info = None
        ok = info is not None and _stat_ok(info)
        if not ok:
            _fail("invalid broker config")
        chunks: list[bytes] = []
        while True:
            block = os.read(fd, _READ_CHUNK)
            if not block:
                break
            chunks.append(block)
        data = b"".join(chunks)
    except ValueError:
        raise
    except OSError:
        _fail("invalid broker config")
    finally:
        if fd >= 0:
            _close_fd(fd)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        _fail("invalid broker config")
    _fail("invalid broker config")
    return ""


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("invalid broker config")
        obj[key] = value
    return obj


def _reject_constant(_token: str) -> None:
    raise ValueError("invalid broker config")


def _parse_json(text: str) -> object:
    try:
        return json.loads(
            text,
            object_pairs_hook=_no_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except (ValueError, TypeError, json.JSONDecodeError, RecursionError):
        _fail("invalid broker config")
    return None


def _positive(value: object, field: str) -> int:
    if type(value) is not int or value < 1:
        _fail("invalid broker config: %s" % field)
    return value


def _check_upstream(value: object) -> str:
    if type(value) is not str or not value.isascii() or any(ch.isspace() for ch in value):
        _fail("invalid broker config: upstream")
    parts = urllib.parse.urlsplit(value)
    if (
        parts.scheme != "https"
        or parts.username is not None
        or parts.password is not None
        or "@" in parts.netloc
        or parts.path not in ("",)
        or parts.query
        or parts.fragment
        or not parts.hostname
    ):
        _fail("invalid broker config: upstream")
    try:
        port = parts.port
    except ValueError:
        _fail("invalid broker config: upstream")
    if port is not None and not 1 <= port <= 65535:
        _fail("invalid broker config: upstream")
    return value


def _check_env_name(value: object, field: str, env_seen: set[str]) -> str:
    if (
        type(value) is not str
        or _ENV_NAME_RE.fullmatch(value) is None
        or value.startswith("MC_")
        or value in env_seen
    ):
        _fail("invalid broker config: %s" % field)
    env_seen.add(value)
    return value


def _check_admin_socket(value: object) -> str:
    if (
        type(value) is not str
        or not os.path.isabs(value)
        or "\x00" in value
        or not _fs_encodable(value)
        or len(os.fsencode(value)) > _ADMIN_MAX_PATH
    ):
        _fail("invalid broker config: admin_socket")
    return value


def _check_service(service: object, seen: set[str], env_seen: set[str]) -> dict:
    if not isinstance(service, dict) or set(service) != _SERVICE_KEYS:
        _fail("invalid broker config: services")
    name = service["name"]
    if type(name) is not str or _NAME_RE.fullmatch(name) is None or name in seen:
        _fail("invalid broker config: name")
    seen.add(name)
    upstream = _check_upstream(service["upstream"])
    header = service["header"]
    if type(header) is not str or _TOKEN_RE.fullmatch(header) is None:
        _fail("invalid broker config: header")
    lowered_header = header.lower()
    if lowered_header in _OWNED_HEADERS or lowered_header.startswith("proxy-"):
        _fail("invalid broker config: header")
    template = service["template"]
    if type(template) is not str or template.count("{secret}") != 1:
        _fail("invalid broker config: template")
    secret = service["secret"]
    # The reference is not echoed. Validation of its shape happens at resolve.
    if type(secret) is not str:
        _fail("service %s: invalid secret reference" % name)
    methods = service["methods"]
    if (
        not isinstance(methods, (list, tuple))
        or not methods
        or any(type(item) is not str or _METHOD_RE.fullmatch(item) is None for item in methods)
    ):
        _fail("invalid broker config: methods")
    prefixes = service["path_prefixes"]
    if (
        not isinstance(prefixes, (list, tuple))
        or not prefixes
        or any(type(item) is not str or not item.startswith("/") or "\x00" in item for item in prefixes)
    ):
        _fail("invalid broker config: path_prefixes")
    env_key = _check_env_name(service["env_key"], "env_key", env_seen)
    env_base_url = _check_env_name(service["env_base_url"], "env_base_url", env_seen)
    return {
        "name": name,
        "upstream": upstream,
        "header": header,
        "template": template,
        "secret": secret,
        "methods": tuple(methods),
        "path_prefixes": tuple(prefixes),
        "env_key": env_key,
        "env_base_url": env_base_url,
    }


def validate_config(data: object, port_zero_ok: bool = False) -> dict:
    """Validate a decoded broker config. Does not resolve secrets or bind."""
    if not isinstance(data, dict) or set(data) not in (_ROOT_KEYS, _ROOT_KEYS | {_AUDIT_KEY}):
        _fail("invalid broker config")
    bind = data["bind"]
    if bind != "127.0.0.1":
        _fail("invalid broker config: bind")
    port = data["port"]
    if type(port) is not int:
        _fail("invalid broker config: port")
    if port_zero_ok and port == 0:
        checked_port = 0
    elif type(port) is int and 1 <= port <= 65535:
        checked_port = port
    else:
        _fail("invalid broker config: port")
    providers_path = data["providers"]
    if (
        type(providers_path) is not str
        or not os.path.isabs(providers_path)
        or "\x00" in providers_path
        or not _fs_encodable(providers_path)
    ):
        _fail("invalid broker config: providers")
    ttl = _positive(data["placeholder_ttl_seconds"], "placeholder_ttl_seconds")
    timeout = _positive(data["upstream_timeout_seconds"], "upstream_timeout_seconds")
    max_body = _positive(data["max_request_body_bytes"], "max_request_body_bytes")
    services = data["services"]
    if not isinstance(services, (list, tuple)) or not services:
        _fail("invalid broker config: services")
    seen: set[str] = set()
    env_seen: set[str] = set()
    checked = [_check_service(item, seen, env_seen) for item in services]
    admin_socket = _check_admin_socket(data["admin_socket"])
    checked_config = {
        "admin_socket": admin_socket,
        "bind": "127.0.0.1",
        "port": checked_port,
        "providers": providers_path,
        "placeholder_ttl_seconds": ttl,
        "upstream_timeout_seconds": timeout,
        "max_request_body_bytes": max_body,
        "services": tuple(checked),
    }
    if _AUDIT_KEY in data:
        checked_config[_AUDIT_KEY] = audit.check_block(data[_AUDIT_KEY])
    return checked_config


def load_config(path: str) -> dict:
    """Read a broker config. The file must be mode 0600 or 0400 and not a symlink.

    ``port`` 0 is rejected here. Tests that need an ephemeral port pass an
    in-memory config to ``BrokerServer``.
    """
    text = _read_config_text(path)
    data = _parse_json(text)
    return validate_config(data, port_zero_ok=False)


class PlaceholderStore:
    """In-memory placeholders. Expired and revoked entries stay known until exit."""

    def __init__(self, clock: object = time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._configured = False
        self._services: frozenset[str] = frozenset()
        self._ttl = 0
        self._entries: dict[str, dict] = {}
        self._by_task: dict[str, list[str]] = {}
        self._tasks: set[str] = set()

    def configure(self, known_services: object, ttl_seconds: object) -> None:
        """Call exactly once before ``mint``. A second call raises."""
        if not isinstance(known_services, (list, tuple, set, frozenset)) or not known_services:
            _fail("invalid placeholder store")
        names = []
        for name in known_services:
            if type(name) is not str or _NAME_RE.fullmatch(name) is None or name in names:
                _fail("invalid placeholder store")
            names.append(name)
        if type(ttl_seconds) is not int or ttl_seconds < 1:
            _fail("invalid placeholder store")
        with self._lock:
            if self._configured:
                _fail("invalid placeholder store")
            self._services = frozenset(names)
            self._ttl = ttl_seconds
            self._configured = True

    def mint(self, task_id: object, services: object) -> dict[str, str]:
        """Return ``{service: placeholder}``. Placeholders are ``akp_`` plus 32 url-safe bytes."""
        if type(task_id) is not str or task_id == "":
            _fail("invalid task id")
        if not isinstance(services, (list, tuple)) or not services:
            _fail("invalid service name")
        requested = []
        for name in services:
            if type(name) is not str or name == "" or name in requested:
                _fail("invalid service name")
            requested.append(name)
        with self._lock:
            if not self._configured:
                _fail("invalid placeholder store")
            # A task id may be minted again once none of its grants is live (#194 A2).
            if self._has_live_grant(task_id):
                _fail("duplicate task id")
            for name in requested:
                if name not in self._services:
                    _fail("unknown service")
            minted_at = self._clock()
            issued: dict[str, str] = {}
            created: list[str] = []
            for name in requested:
                placeholder = self._new_placeholder()
                self._entries[placeholder] = {
                    "service": name,
                    "task_id": task_id,
                    "minted_at": minted_at,
                    "revoked": False,
                }
                created.append(placeholder)
                issued[name] = placeholder
            self._by_task.setdefault(task_id, []).extend(created)
            self._tasks.add(task_id)
            return issued

    def _has_live_grant(self, task_id: str) -> bool:
        # Called with the lock held. Live: neither revoked nor expired.
        now = self._clock()
        for placeholder in self._by_task.get(task_id, ()):
            entry = self._entries.get(placeholder)
            if entry is None or entry["revoked"]:
                continue
            if now >= entry["minted_at"] + self._ttl:
                continue
            return True
        return False

    def _new_placeholder(self) -> str:
        # Called with the lock held. A collision only retries; the value is not logged.
        while True:
            placeholder = "akp_" + secrets.token_urlsafe(32)
            if _PLACEHOLDER_RE.fullmatch(placeholder) and placeholder not in self._entries:
                return placeholder

    def revoke(self, placeholder: object) -> None:
        """Idempotent. Unknown placeholders are ignored and stay out of the known set."""
        if type(placeholder) is not str:
            return
        with self._lock:
            entry = self._entries.get(placeholder)
            if entry is not None:
                entry["revoked"] = True

    def revoke_task(self, task_id: object) -> None:
        """Idempotent. Revokes every placeholder minted for ``task_id``."""
        if type(task_id) is not str:
            return
        with self._lock:
            for placeholder in self._by_task.get(task_id, ()):
                entry = self._entries.get(placeholder)
                if entry is not None:
                    entry["revoked"] = True

    def check(self, placeholder: str, service: str) -> str:
        """Return ``ok``, ``missing``, ``wrong_service``, ``expired``, or ``revoked``.

        Expiry is ``clock() >= minted_at + ttl`` at this call. A later revoke
        does not change the result the caller already received.
        """
        with self._lock:
            entry = self._entries.get(placeholder)
            if entry is None:
                return "missing"
            if entry["service"] != service:
                return "wrong_service"
            if self._clock() >= entry["minted_at"] + self._ttl:
                return "expired"
            if entry["revoked"]:
                return "revoked"
            return "ok"

    def task_of(self, placeholder: object) -> str | None:
        """The task id minted with ``placeholder``, read-only (#192). Call after ``check`` returned ``ok``."""
        if type(placeholder) is not str:
            return None
        with self._lock:
            entry = self._entries.get(placeholder)
            if entry is None:
                return None
            task_id = entry.get("task_id")
        return task_id if type(task_id) is str and task_id != "" else None

    def known_placeholders(self) -> tuple[str, ...]:
        """Every minted placeholder, including expired and revoked ones."""
        with self._lock:
            return tuple(self._entries)


def _percent_decode(text: str) -> bytes:
    """Decode percent-escapes exactly once. Reject a malformed escape."""
    out = bytearray()
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char == "%":
            if index + 2 >= length:
                raise _BadRequest()
            pair = text[index + 1:index + 3]
            if len(pair) != 2 or any(c not in "0123456789abcdefABCDEF" for c in pair):
                raise _BadRequest()
            out.append(int(pair, 16))
            index += 3
            continue
        code = ord(char)
        if code > 255:
            raise _BadRequest()
        out.append(code)
        index += 1
    return bytes(out)


def _has_controls(data: bytes) -> bool:
    for byte in data:
        if byte < 0x20 or byte == 0x7F:
            return True
    return False


class _ParsedTarget:
    def __init__(
        self,
        service: str,
        raw_remainder: str,
        raw_query: str,
        normalized: str,
        decoded_path: str,
        decoded_query: str,
        raw_target: str,
    ) -> None:
        self.service = service
        self.raw_remainder = raw_remainder
        self.raw_query = raw_query
        self.normalized = normalized
        self.decoded_path = decoded_path
        self.decoded_query = decoded_query
        self.raw_target = raw_target


def _parse_target(target: str) -> _ParsedTarget:
    """Origin-form only. Normalization rejects traversal; forwarding keeps raw bytes."""
    if (
        type(target) is not str
        or not target.startswith("/")
        or target.startswith("//")
        or "#" in target
        or "\\" in target
        or "\x00" in target
    ):
        raise _BadRequest()
    raw_path, question, raw_query = target.partition("?")
    if not question:
        raw_query = ""
    if "\\" in raw_path or "\\" in raw_query:
        raise _BadRequest()
    if _ENCODED_SLASH_RE.search(raw_path) or _ENCODED_BACKSLASH_RE.search(raw_path):
        raise _BadRequest()
    if _ENCODED_BACKSLASH_RE.search(raw_query):
        raise _BadRequest()
    try:
        decoded_path_bytes = _percent_decode(raw_path)
        decoded_query_bytes = _percent_decode(raw_query)
    except _BadRequest:
        raise
    except ValueError:
        _raise_clean(_BadRequest())
    if _has_controls(decoded_path_bytes) or _has_controls(decoded_query_bytes):
        raise _BadRequest()
    if b"\\" in decoded_path_bytes or b"\\" in decoded_query_bytes:
        raise _BadRequest()
    decoded_path = decoded_path_bytes.decode("latin-1")
    decoded_query = decoded_query_bytes.decode("latin-1")
    for segment in decoded_path.split("/"):
        if segment in (".", ".."):
            raise _BadRequest()
    parts = decoded_path.split("/")
    if len(parts) < 2 or parts[1] == "":
        raise _BadRequest()
    service = parts[1]
    slash = raw_path.find("/", 1)
    raw_remainder = "/" if slash == -1 else raw_path[slash:]
    norm_slash = decoded_path.find("/", 1)
    normalized = "/" if norm_slash == -1 else decoded_path[norm_slash:]
    return _ParsedTarget(
        service,
        raw_remainder,
        raw_query,
        normalized,
        decoded_path,
        decoded_query,
        target,
    )


def _match_prefix(path: str, prefixes: tuple) -> str:
    best = ""
    for prefix in prefixes:
        if path.startswith(prefix) and len(prefix) > len(best):
            best = prefix
    return best


def _header_items(headers: http.client.HTTPMessage) -> list[tuple[str, str]]:
    return [(name, value) for name, value in headers.items()]


def _values(headers: http.client.HTTPMessage, name: str) -> list[str]:
    found = headers.get_all(name)
    if not found:
        return []
    return list(found)


def _fill(template: str, secret: str) -> str:
    pre, post = template.split("{secret}", 1)
    return pre + secret + post


def _extract_placeholder(template: str, value: str) -> str:
    pre, post = template.split("{secret}", 1)
    if not value.startswith(pre):
        return ""
    if post:
        if not value.endswith(post) or len(value) < len(pre) + len(post):
            return ""
        middle = value[len(pre):-len(post)]
    else:
        middle = value[len(pre):]
    if pre + middle + post != value:
        return ""
    if _PLACEHOLDER_RE.fullmatch(middle) is None:
        return ""
    return middle


def _contains_text(haystack: str, needles: tuple) -> bool:
    for needle in needles:
        if needle and needle in haystack:
            return True
    return False


def _contains_bytes(haystack: bytes, needles: tuple) -> bool:
    for needle in needles:
        if needle and needle.encode("ascii") in haystack:
            return True
    return False


def _read_exact(rfile: object, length: int) -> bytes:
    buf = bytearray()
    while len(buf) < length:
        block = rfile.read(min(_READ_CHUNK, length - len(buf)))
        if not block:
            raise _BadRequest()
        buf.extend(block)
    return bytes(buf)


def _read_chunk_line(rfile: object) -> bytes:
    line = rfile.readline(_MAX_LINE + 1)
    if line is None:
        raise _Abort("bad_request")
    if len(line) > _MAX_LINE or not line.endswith(b"\r\n"):
        raise _Abort("bad_request")
    return line


def _iter_chunked(rfile: object, max_bytes: int, placeholders: object):
    """Yield decoded chunk bytes. Raises ``_Abort`` on a framing or size failure."""
    total = 0
    while True:
        line = _read_chunk_line(rfile)
        size_text = line[:-2].split(b";", 1)[0]
        if not size_text or _HEX_RE.fullmatch(size_text.decode("ascii", "replace")) is None:
            raise _Abort("bad_request")
        try:
            size = int(size_text, 16)
        except ValueError:
            _raise_clean(_Abort("bad_request"))
        if size < 0:
            raise _Abort("bad_request")
        if size == 0:
            _read_trailers(rfile, placeholders)
            return
        if size > max_bytes - total:
            raise _Abort("body_too_large")
        data = rfile.read(size)
        if len(data) != size:
            raise _Abort("bad_request")
        terminator = rfile.read(2)
        if terminator != b"\r\n":
            raise _Abort("bad_request")
        total += size
        if data:
            yield data


def _read_trailers(rfile: object, placeholders: object) -> None:
    known = placeholders()
    while True:
        line = _read_chunk_line(rfile)
        if line == b"\r\n":
            return
        if b":" not in line:
            raise _Abort("bad_request")
        raw_name, raw_value = line[:-2].split(b":", 1)
        name = raw_name
        if not name or _TOKEN_RE.fullmatch(name.decode("latin-1")) is None:
            raise _Abort("bad_request")
        if _has_controls(raw_value):
            raise _Abort("bad_request")
        if _contains_bytes(raw_value, known):
            raise _Abort("placeholder_leak")


class _PlaceholderScan:
    """Carry ``len(placeholder) - 1`` so a match split across chunks is still found."""

    def __init__(self, placeholders_fn: object) -> None:
        self._placeholders_fn = placeholders_fn
        self.carry = b""

    def feed(self, chunk: bytes) -> bytes:
        data = self.carry + chunk
        needles = self._placeholders_fn()
        if _contains_bytes(data, needles):
            raise _Abort("placeholder_leak")
        hold = 0
        for needle in needles:
            if needle:
                hold = max(hold, len(needle) - 1)
        if hold <= 0:
            self.carry = b""
            return data
        if len(data) <= hold:
            self.carry = data
            return b""
        self.carry = data[-hold:]
        return data[:-hold]

    def finish(self) -> bytes:
        needles = self._placeholders_fn()
        if _contains_bytes(self.carry, needles):
            raise _Abort("placeholder_leak")
        tail = self.carry
        self.carry = b""
        return tail


class _SecretScan:
    """Hold back ``len(secret) - 1`` bytes. Flush the tail only when it does not match."""

    def __init__(self, secrets_tuple: tuple) -> None:
        self._needles = tuple(secret.encode("ascii") for secret in secrets_tuple if secret)
        self._hold = 0
        for needle in self._needles:
            self._hold = max(self._hold, len(needle) - 1)
        self.carry = b""

    def _find(self, data: bytes) -> int:
        earliest = -1
        for needle in self._needles:
            pos = data.find(needle)
            if pos >= 0 and (earliest < 0 or pos < earliest):
                earliest = pos
        return earliest

    def feed(self, chunk: bytes) -> tuple:
        data = self.carry + chunk
        found = self._find(data)
        if found >= 0:
            self.carry = b""
            return data[:found], True
        if self._hold <= 0:
            self.carry = b""
            return data, False
        if len(data) <= self._hold:
            self.carry = data
            return b"", False
        self.carry = data[-self._hold:]
        return data[:-self._hold], False

    def finish(self) -> tuple:
        found = self._find(self.carry)
        if found >= 0:
            safe = self.carry[:found]
            self.carry = b""
            return safe, True
        safe = self.carry
        self.carry = b""
        return safe, False


def _classify(exc: BaseException) -> str:
    if isinstance(exc, socket.gaierror):
        return "dns"
    if isinstance(exc, ssl.SSLError):
        return "tls"
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(exc, http.client.HTTPException):
        return "malformed"
    return "connection"


def default_ssl_context() -> ssl.SSLContext:
    """The process-wide verification policy: default trust, hostname on."""
    return ssl.create_default_context()


class TLSUpstream:
    """Verified HTTPS connection. Tests substitute ``upstream_factory`` instead."""

    def __init__(self, service_config: dict, timeout_seconds: object) -> None:
        parts = urllib.parse.urlsplit(service_config["upstream"])
        self.host = parts.hostname
        self.port = parts.port or 443
        self.timeout = timeout_seconds
        self.ssl_context = default_ssl_context()
        self._conn: http.client.HTTPSConnection | None = None

    def request(self, method: str, target: str, headers: list, body_chunks: object):
        conn = http.client.HTTPSConnection(
            self.host,
            self.port,
            timeout=self.timeout,
            context=self.ssl_context,
        )
        self._conn = conn
        chunked = False
        try:
            conn.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
            for name, value in headers:
                conn.putheader(name, value)
                if name.lower() == "transfer-encoding" and str(value).lower() == "chunked":
                    chunked = True
            conn.endheaders()
            if chunked:
                for piece in body_chunks:
                    if not piece:
                        continue
                    conn.send(b"%x\r\n" % len(piece) + piece + b"\r\n")
                conn.send(b"0\r\n\r\n")
            else:
                for piece in body_chunks:
                    if piece:
                        conn.send(piece)
            resp = conn.getresponse()
        except _Abort:
            self.close()
            raise
        except Exception as exc:
            self.close()
            _raise_clean(UpstreamError(_classify(exc)))
        return _LiveResponse(resp, self)

    def close(self) -> None:
        conn = self._conn
        self._conn = None
        if conn is not None:
            try:
                conn.close()
            except OSError:
                return


class _LiveResponse:
    def __init__(self, resp: http.client.HTTPResponse, upstream: TLSUpstream) -> None:
        self.status = resp.status
        self.headers = list(resp.getheaders())
        self._resp = resp
        self._upstream = upstream

    def read_chunk(self, max_bytes: int) -> bytes:
        try:
            return self._resp.read(max_bytes)
        except Exception as exc:
            _raise_clean(UpstreamError(_classify(exc)))


def default_upstream_factory(service_config: dict, timeout_seconds: object) -> TLSUpstream:
    return TLSUpstream(service_config, timeout_seconds)


def _authority(upstream: str) -> str:
    parts = urllib.parse.urlsplit(upstream)
    host = parts.hostname or ""
    port = parts.port
    if port is None or port == 443:
        return host
    if ":" in host:
        return "[%s]:%d" % (host, port)
    return "%s:%d" % (host, port)


def _connection_tokens(headers: list) -> set[str]:
    names: set[str] = set()
    for name, value in headers:
        if name.lower() != "connection":
            continue
        for part in value.split(","):
            token = part.strip().lower()
            if token:
                names.add(token)
    return names


def _log_value(value: object, secret_values: tuple) -> str:
    if type(value) is not str or value == "":
        return "-"
    if "akp_" in value:
        return "-"
    for secret in secret_values:
        if secret and secret in value:
            return "-"
    return value


# One outcome record per request on the HTTP port (#192). Each request runs on
# its own server thread, so the record is thread-local. ``_emit`` fills the
# result; ``_note`` adds the trusted values the broker itself established.
_OUTCOME = threading.local()


def _note(**values: object) -> None:
    record = getattr(_OUTCOME, "record", None)
    if record is not None:
        record.update(values)


def _emit(service: object, method: object, prefix: object, status: object, reason: object, secret_values: tuple) -> None:
    record = getattr(_OUTCOME, "record", None)
    if record is not None and not record.get("emitted"):
        record["emitted"] = True
        record["method"] = method
        record["status"] = status
        record["reason"] = reason
    safe_service = _log_value(service, secret_values)
    safe_method = _log_value(method, secret_values)
    if safe_method != "-" and _METHOD_RE.fullmatch(safe_method) is None:
        safe_method = "-"
    safe_prefix = _log_value(prefix, secret_values)
    safe_reason = reason if reason in _REASONS else "-"
    safe_reason = _log_value(safe_reason, secret_values)
    if type(status) is int:
        safe_status: object = status
    elif status == "-":
        safe_status = "-"
    else:
        safe_status = "-"
    payload = {
        "service": safe_service,
        "method": safe_method,
        "prefix": safe_prefix,
        "status": safe_status,
        "reason": safe_reason,
    }
    _LOG.info("%s", json.dumps(payload, separators=(",", ":")))


def _close_writer(handler: BaseHTTPRequestHandler) -> None:
    handler.close_connection = True
    try:
        handler.wfile.flush()
    except (OSError, ValueError):
        pass
    try:
        handler.connection.shutdown(socket.SHUT_WR)
    except (OSError, AttributeError):
        pass


def _send_json(handler: BaseHTTPRequestHandler, status: int, reason: str) -> None:
    # A rejected request line never reaches the assignment of request_version.
    # send_response_only reads that attribute and would otherwise raise.
    if getattr(handler, "request_version", None) not in ("HTTP/1.0", "HTTP/1.1"):
        handler.request_version = "HTTP/1.1"
    body = ('{"error":"%s"}' % reason).encode("ascii")
    try:
        handler.send_response_only(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.wfile.write(body)
        handler.wfile.flush()
    except (OSError, ValueError):
        pass
    _close_writer(handler)


class _State:
    def __init__(self, config: dict, store: PlaceholderStore, secret_map: dict, upstream_factory: object) -> None:
        self.config = config
        self.store = store
        self.secrets = secret_map
        self.upstream_factory = upstream_factory
        self.services = {service["name"]: service for service in config["services"]}
        self.audit = None

    def __repr__(self) -> str:
        return "<broker state>"

    def secret_values(self) -> tuple:
        return tuple(self.secrets.values())


def _resolve_secrets(config: dict) -> dict[str, str]:
    cache: dict[tuple, str] = {}
    resolved: dict[str, str] = {}
    for service in config["services"]:
        name = service["name"]
        text = service["secret"]
        try:
            ref = refs.parse_reference(text)
        except ValueError as exc:
            message = "service %s: %s" % (name, exc)
            if text and text in message:
                message = "service %s: invalid secret reference" % name
            _fail(message)
        if ref not in cache:
            try:
                value = providers.resolve(ref, {}, environ=None, config_path=config["providers"])
            except ValueError as exc:
                message = "service %s: provider %s: %s" % (name, ref[0], exc)
                _fail(message)
            if type(value) is not str or value == "" or not value.isascii() or not value.isprintable():
                _fail("service %s: provider %s: unresolved secret" % (name, ref[0]))
            cache[ref] = value
        resolved[name] = cache[ref]
    return resolved


class _HeaderBlock:
    """Remember the line ``parse_headers`` stopped on. It also stops at EOF.

    Every header line must end in CRLF. A bare LF raises before the next
    byte is read, so a following body is not consumed.
    """

    def __init__(self, rfile: object) -> None:
        self._rfile = rfile
        self.terminator = b""

    def readline(self, size: int = -1) -> bytes:
        line = self._rfile.readline(size)
        self.terminator = line
        if line and not line.endswith(b"\r\n"):
            raise _BadRequest()
        return line


def _read_request(handler: BaseHTTPRequestHandler):
    try:
        line = handler.rfile.readline(_MAX_LINE + 1)
    except (socket.timeout, TimeoutError, OSError):
        return None
    if not line:
        return None
    if len(line) > _MAX_LINE or not line.endswith(b"\r\n"):
        raise _BadRequest()
    try:
        text = line.decode("iso-8859-1").rstrip("\r\n")
    except UnicodeDecodeError:
        _raise_clean(_BadRequest())
    parts = text.split(" ")
    if len(parts) != 3:
        raise _BadRequest()
    method, target, version = parts
    if version not in ("HTTP/1.0", "HTTP/1.1"):
        raise _BadRequest()
    if _TOKEN_RE.fullmatch(method) is None:
        raise _BadRequest()
    # parse_headers keeps its own line-size and header-count limits and stops
    # at the first blank line. It does not read the body. Every header line
    # must end in CRLF. EOF and a bare LF are not a terminated header block.
    reader = _HeaderBlock(handler.rfile)
    try:
        headers = http.client.parse_headers(reader)
    except (http.client.LineTooLong, http.client.HTTPException, socket.timeout, TimeoutError, OSError):
        _raise_clean(_BadRequest())
    if reader.terminator != b"\r\n":
        raise _BadRequest()
    if getattr(headers, "defects", None):
        raise _BadRequest()
    for name, value in headers.items():
        if _TOKEN_RE.fullmatch(name) is None:
            raise _BadRequest()
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise _BadRequest()
    return method, target, version, headers


def _decimal_length(raw: str, limit_digits: int) -> int | None:
    """Parse a decimal length. ``None`` means do not call ``int``.

    Leading zeros are stripped first. An all-zero string is 0. A remaining
    digit count above ``limit_digits`` is already over the caller's limit, and
    ``int`` of thousands of digits can raise ``ValueError``.
    """
    stripped = raw.lstrip("0")
    if not stripped:
        return 0
    if len(stripped) > limit_digits:
        return None
    return int(stripped)


def _body_mode(headers: http.client.HTTPMessage, max_body: int) -> tuple:
    lengths = _values(headers, "content-length")
    codings = _values(headers, "transfer-encoding")
    if lengths and codings:
        raise _BadRequest()
    if len(lengths) > 1:
        raise _BadRequest()
    if len(codings) > 1:
        raise _BadRequest()
    if codings:
        coding = codings[0].strip().lower()
        if coding != "chunked":
            raise _BadRequest()
        return "chunked", None
    if not lengths:
        return "empty", 0
    raw = lengths[0].strip()
    if _CL_RE.fullmatch(raw) is None:
        raise _BadRequest()
    parsed = _decimal_length(raw, len(str(max_body)))
    if parsed is None:
        # Known over the limit. The caller emits 413 without reading a body.
        return "length", max_body + 1
    return "length", parsed


def _outbound_headers(items: list, service: dict, secret: str, length: int | None, chunked: bool) -> list:
    drop = set(_REQUEST_DROP)
    drop.update(_connection_tokens(items))
    header_name = service["header"]
    kept = []
    for name, value in items:
        if name.lower() in drop or name.lower() == header_name.lower():
            continue
        kept.append((name, value))
    kept.append(("Host", _authority(service["upstream"])))
    # Upstream bodies must arrive uncompressed so the secret scan can read them.
    kept.append(("Accept-Encoding", "identity"))
    kept.append((header_name, _fill(service["template"], secret)))
    if chunked:
        kept.append(("Transfer-Encoding", "chunked"))
    else:
        kept.append(("Content-Length", str(0 if length is None else length)))
    return kept


def _forward_target(parsed: _ParsedTarget) -> str:
    if parsed.raw_query:
        return parsed.raw_remainder + "?" + parsed.raw_query
    return parsed.raw_remainder


def _response_plan(response: object, service: dict, secret_values: tuple):
    status = getattr(response, "status", None)
    if type(status) is not int or not 100 <= status <= 599:
        raise UpstreamError("malformed")
    if status == 101 or status in _REDIRECTS:
        raise UpstreamError("malformed")
    raw_headers = list(getattr(response, "headers", ()) or ())
    connection_names = _connection_tokens(raw_headers)
    encodings = []
    content_lengths = []
    filtered = []
    for name, value in raw_headers:
        if type(name) is not str or type(value) is not str:
            raise UpstreamError("malformed")
        if _TOKEN_RE.fullmatch(name) is None:
            raise UpstreamError("malformed")
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
            raise UpstreamError("malformed")
        lname = name.lower()
        if lname == "content-encoding":
            encodings.append(value)
            continue
        if lname == "content-length":
            content_lengths.append(value)
            continue
        if lname in _RESPONSE_HOP or lname.startswith("proxy-") or lname in connection_names:
            continue
        if lname == service["header"].lower():
            continue
        if _contains_text(name, secret_values) or _contains_text(value, secret_values):
            continue
        filtered.append((name, value))
    if encodings and (len(encodings) != 1 or encodings[0].strip().lower() != "identity"):
        raise UpstreamError("malformed")
    if len(encodings) == 1 and not _contains_text(encodings[0], secret_values):
        filtered.append(("Content-Encoding", encodings[0].strip()))
    valid_length = None
    if len(content_lengths) == 1 and _CL_RE.fullmatch(content_lengths[0].strip()) is not None:
        if not _contains_text(content_lengths[0], secret_values):
            raw_length = content_lengths[0].strip()
            parsed_length = _decimal_length(raw_length, _MAX_RESPONSE_LENGTH_DIGITS)
            if parsed_length is None:
                raise UpstreamError("malformed")
            valid_length = str(parsed_length)
    elif content_lengths:
        raise UpstreamError("malformed")
    return status, filtered, valid_length


def _send_upstream_head(handler: BaseHTTPRequestHandler, status: int, headers: list, valid_length: str | None) -> None:
    handler.send_response_only(status)
    for name, value in headers:
        handler.send_header(name, value)
    if valid_length is not None:
        handler.send_header("Content-Length", valid_length)
    else:
        handler.send_header("Connection", "close")
    handler.end_headers()
    handler.wfile.flush()


def _write_bytes(handler: BaseHTTPRequestHandler, data: bytes) -> None:
    if not data:
        return
    handler.wfile.write(data)
    handler.wfile.flush()


def _write_limited(handler: BaseHTTPRequestHandler, data: bytes, written: int, limit: int | None) -> int:
    """Write ``data`` and return the new total. Never pass a declared length."""
    if not data:
        return written
    if limit is None:
        _write_bytes(handler, data)
        return written + len(data)
    room = limit - written
    if room <= 0:
        return written
    if len(data) > room:
        data = data[:room]
    _write_bytes(handler, data)
    return written + len(data)


def _stream_response(handler: BaseHTTPRequestHandler, response: object, secret_values: tuple, limit: int | None) -> bool:
    """Return True when a secret was found in the bytes the client was owed.

    A Content-Length the upstream does not fill raises ``UpstreamError`` after
    the bytes that did arrive. Nothing past that length is written.
    """
    scanner = _SecretScan(secret_values)
    written = 0

    def take(safe: bytes, hit: bool) -> bool | None:
        nonlocal written
        room = None if limit is None else limit - written
        secret_in_window = hit and (room is None or len(safe) < room)
        written = _write_limited(handler, safe, written, limit)
        if secret_in_window:
            return True
        if limit is not None and written >= limit:
            return False
        return None

    while True:
        chunk = response.read_chunk(_READ_CHUNK)
        if not chunk:
            break
        outcome = take(*scanner.feed(chunk))
        if outcome is not None:
            return outcome
    outcome = take(*scanner.finish())
    if outcome is not None:
        return outcome
    if limit is not None and written < limit:
        raise UpstreamError("malformed")
    return False


def _serve_one(handler: BaseHTTPRequestHandler) -> None:
    state: _State = handler.server.state
    secrets = state.secret_values()
    handler.close_connection = True
    try:
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except (OSError, AttributeError):
        pass
    logged = False
    service_name = "-"
    prefix = "-"
    try:
        parsed_request = _read_request(handler)
        if parsed_request is None:
            return
        method, target, version, headers = parsed_request
        handler.command = method
        handler.request_version = version
        handler.protocol_version = version
        service_name = "-"
        prefix = "-"
        try:
            mode, length = _body_mode(headers, state.config["max_request_body_bytes"])
            parsed = _parse_target(target)
        except _BadRequest:
            _emit("-", method, "-", 400, "bad_request", secrets)
            logged = True
            _send_json(handler, 400, "bad_request")
            return
        service = state.services.get(parsed.service)
        if service is None:
            _emit("-", method, "-", 404, "unknown_service", secrets)
            logged = True
            _send_json(handler, 404, "unknown_service")
            return
        service_name = service["name"]
        _note(service=service_name)
        outcome = _authorize(headers, service, state)
        if outcome != "ok":
            _emit(service_name, method, "-", outcome[0], outcome[1], secrets)
            logged = True
            _send_json(handler, outcome[0], outcome[1])
            return
        known = state.store.known_placeholders()
        if _request_leak(parsed, headers, service, known):
            _emit(service_name, method, "-", 403, "placeholder_leak", secrets)
            logged = True
            _send_json(handler, 403, "placeholder_leak")
            return
        if method not in service["methods"]:
            _emit(service_name, method, "-", 403, "method_not_allowed", secrets)
            logged = True
            _send_json(handler, 403, "method_not_allowed")
            return
        prefix = _match_prefix(parsed.normalized, service["path_prefixes"])
        _note(prefix=prefix)
        if not prefix:
            _emit(service_name, method, "-", 403, "path_not_allowed", secrets)
            logged = True
            _send_json(handler, 403, "path_not_allowed")
            return
        max_body = state.config["max_request_body_bytes"]
        if mode == "length" and length is not None and length > max_body:
            _emit(service_name, method, prefix, 413, "body_too_large", secrets)
            logged = True
            _send_json(handler, 413, "body_too_large")
            return
        secret = state.secrets[service_name]
        logged = _forward(
            handler, state, service, secret, secrets, parsed,
            headers, method, mode, length, prefix, service_name,
        )
    except _BadRequest:
        if getattr(handler, "_ak_head_sent", False):
            _upstream_failure_after_head(handler, service_name, prefix, secrets, logged)
        elif not logged:
            _emit("-", getattr(handler, "command", "-"), "-", 400, "bad_request", secrets)
            logged = True
            _send_json(handler, 400, "bad_request")
    except Exception:
        if getattr(handler, "_ak_head_sent", False):
            _upstream_failure_after_head(handler, service_name, prefix, secrets, logged)
        elif not logged:
            _emit("-", getattr(handler, "command", "-"), "-", 502, "upstream_error", secrets)
            _send_json(handler, 502, "upstream_error")
    finally:
        handler.close_connection = True


def _upstream_failure_after_head(handler: BaseHTTPRequestHandler, service_name: str, prefix: str, secrets: tuple, logged: bool) -> None:
    """The status line is already on the wire. Close; do not write a refusal."""
    if not logged:
        _emit(
            service_name,
            getattr(handler, "command", "-"),
            prefix,
            getattr(handler, "_ak_upstream_status", 502),
            "upstream_error",
            secrets,
        )
    _close_writer(handler)


def _authorize(headers: http.client.HTTPMessage, service: dict, state: _State):
    name = service["header"]
    values = _values(headers, name)
    if len(values) != 1:
        return (401, "missing_placeholder")
    placeholder = _extract_placeholder(service["template"], values[0])
    if not placeholder:
        return (401, "bad_placeholder")
    kind = state.store.check(placeholder, service["name"])
    if kind in ("missing", "wrong_service"):
        return (401, "bad_placeholder")
    if kind == "expired":
        return (401, "expired_placeholder")
    if kind == "revoked":
        return (401, "revoked_placeholder")
    # The task id comes only from the store's record (#192 C5), never the request.
    task_id = state.store.task_of(placeholder)
    if task_id is None:
        return (401, "missing_task_context")
    _note(task_id=task_id)
    return "ok"


def _request_leak(parsed: _ParsedTarget, headers: http.client.HTTPMessage, service: dict, known: tuple) -> bool:
    if _contains_text(parsed.raw_target, known):
        return True
    if _contains_text(parsed.decoded_path, known):
        return True
    if _contains_text(parsed.decoded_query, known):
        return True
    header_name = service["header"].lower()
    for name, value in _header_items(headers):
        if _contains_text(name, known):
            return True
        if name.lower() == header_name:
            continue
        if _contains_text(value, known):
            return True
    return False


def _close_upstream(upstream: object) -> None:
    closer = getattr(upstream, "close", None)
    if closer is None:
        return
    try:
        closer()
    except OSError:
        return


def _forward(
    handler: BaseHTTPRequestHandler,
    state: _State,
    service: dict,
    secret: str,
    secrets: tuple,
    parsed: _ParsedTarget,
    headers: http.client.HTTPMessage,
    method: str,
    mode: str,
    length: int | None,
    prefix: str,
    service_name: str,
) -> bool:
    """Return whether a log line was written."""
    items = _header_items(headers)
    small = mode == "length" and length is not None and length < _SMALL_BODY
    body_holder: list[bytes] = []
    if mode == "empty" or (mode == "length" and length == 0):
        chunks: object = iter(())
        out_len: int | None = 0
        chunked = False
    elif small:
        body = _read_exact(handler.rfile, int(length))
        known = state.store.known_placeholders()
        if _contains_bytes(body, known):
            _emit(service_name, method, prefix, 403, "placeholder_leak", secrets)
            _send_json(handler, 403, "placeholder_leak")
            return True
        body_holder.append(body)
        chunks = iter(body_holder)
        out_len = len(body)
        chunked = False
    elif mode == "length":
        out_len = length
        chunked = False
        chunks = _length_stream(handler.rfile, int(length), state.store.known_placeholders)
    else:
        out_len = None
        chunked = True
        chunks = _chunked_stream(handler.rfile, state.config["max_request_body_bytes"], state.store.known_placeholders)

    out_headers = _outbound_headers(items, service, secret, out_len, chunked)
    target = _forward_target(parsed)
    # Small bodies are scanned above, before any upstream object exists.
    upstream = state.upstream_factory(service, state.config["upstream_timeout_seconds"])
    try:
        return _forward_open(
            handler, upstream, service, secrets, parsed, method, mode, small,
            chunked, chunks, out_headers, target, prefix, service_name,
        )
    finally:
        _close_upstream(upstream)


def _forward_open(
    handler: BaseHTTPRequestHandler,
    upstream: object,
    service: dict,
    secrets: tuple,
    parsed: _ParsedTarget,
    method: str,
    mode: str,
    small: bool,
    chunked: bool,
    chunks: object,
    out_headers: list,
    target: str,
    prefix: str,
    service_name: str,
) -> bool:
    if mode == "length" and not small:
        chunks = _scanned(chunks, handler.server.state.store.known_placeholders)
    elif chunked:
        chunks = _scanned(chunks, handler.server.state.store.known_placeholders)
    try:
        response = upstream.request(method, target, out_headers, chunks)
    except _Abort as abort:
        _emit(service_name, method, prefix, "-", abort.reason, secrets)
        _close_writer(handler)
        return True
    except Exception:
        _emit(service_name, method, prefix, 502, "upstream_error", secrets)
        _send_json(handler, 502, "upstream_error")
        return True
    try:
        status, filtered, valid_length = _response_plan(response, service, secrets)
    except UpstreamError:
        _emit(service_name, method, prefix, 502, "upstream_error", secrets)
        _send_json(handler, 502, "upstream_error")
        return True
    try:
        _send_upstream_head(handler, status, filtered, valid_length)
    except (OSError, ValueError):
        _emit(service_name, method, prefix, status, "-", secrets)
        _close_writer(handler)
        return True
    handler._ak_head_sent = True
    handler._ak_upstream_status = status
    send_body = method != "HEAD" and status >= 200 and status not in _NO_BODY
    if not send_body:
        _emit(service_name, method, prefix, status, "-", secrets)
        _close_writer(handler)
        return True
    limit = int(valid_length) if valid_length is not None else None
    try:
        hit = _stream_response(handler, response, secrets, limit)
    except UpstreamError:
        _emit(service_name, method, prefix, status, "upstream_error", secrets)
        _close_writer(handler)
        return True
    except (OSError, ValueError):
        _emit(service_name, method, prefix, status, "upstream_error", secrets)
        _close_writer(handler)
        return True
    if hit:
        _emit(service_name, method, prefix, status, "secret_in_response", secrets)
        _close_writer(handler)
        return True
    _emit(service_name, method, prefix, status, "-", secrets)
    _close_writer(handler)
    return True


def _length_stream(rfile: object, length: int, _placeholders: tuple):
    remaining = length
    while remaining:
        block = rfile.read(min(_READ_CHUNK, remaining))
        if not block:
            raise _Abort("bad_request")
        remaining -= len(block)
        yield block


def _chunked_stream(rfile: object, max_bytes: int, placeholders_fn_source: object):
    # ``known_placeholders`` is called again per trailer so a mint during the
    # upload is still visible. The caller wraps the iterator with a scanner.
    def current() -> tuple:
        return placeholders_fn_source() if callable(placeholders_fn_source) else tuple(placeholders_fn_source)

    yield from _iter_chunked(rfile, max_bytes, current)


def _scanned(chunks: object, placeholders_source: object):
    def current() -> tuple:
        if callable(placeholders_source):
            return placeholders_source()
        return tuple(placeholders_source)

    scanner = _PlaceholderScan(current)
    for chunk in chunks:
        safe = scanner.feed(chunk)
        if safe:
            yield safe
    tail = scanner.finish()
    if tail:
        yield tail


class BrokerHandler(BaseHTTPRequestHandler):
    """One request per connection. The stdlib HTML error page and request log are not used."""

    protocol_version = "HTTP/1.1"
    server_version = "ak-broker"
    sys_version = ""

    def handle_one_request(self) -> None:
        self.close_connection = True
        _OUTCOME.record = {}
        try:
            _serve_one(self)
        finally:
            record = _OUTCOME.record
            _OUTCOME.record = None
            _audit_outcome(getattr(self.server, "state", None), record)

    def handle_error(self, request: object, client_address: object) -> None:
        return

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def log_error(self, fmt: str, *args: object) -> None:
        return

    def log_request(self, code: object = "-", size: object = "-") -> None:
        return

    def send_error(self, code: int, message: object = None, explain: object = None) -> None:
        self.command = getattr(self, "command", "") or ""
        self.request_version = getattr(self, "request_version", "HTTP/1.1") or "HTTP/1.1"
        state = getattr(self.server, "state", None)
        secrets = state.secret_values() if state is not None else ()
        _emit("-", self.command or "-", "-", 400, "bad_request", secrets)
        self._ak_logged = True
        _send_json(self, 400, "bad_request")


def _audit_outcome(state: object, record: dict) -> None:
    """The one audit call site (#192). Runs after the response is closed; never raises."""
    auditor = getattr(state, "audit", None)
    if auditor is None or not record.get("emitted"):
        return
    try:
        service = record.get("service")
        config = state.services.get(service) if type(service) is str else None
        auditor.record(
            record.get("task_id"),
            service if config is not None else None,
            record.get("method"),
            config["methods"] if config is not None else (),
            record.get("prefix"),
            record.get("status"),
            record.get("reason"),
        )
    except Exception:
        return


class _BoundServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 32

    def handle_error(self, request: object, client_address: object) -> None:
        return


class _AdminBadRequest(Exception):
    """A decoded admin request with a duplicate key. Maps to ``bad_request``."""


def _admin_pairs(pairs: list) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise _AdminBadRequest()
        obj[key] = value
    return obj


def _admin_constant(_token: str) -> None:
    raise ValueError("constant")


def _admin_error(code: str) -> dict:
    return {"ok": False, "error": code if code in _ADMIN_ERRORS else "internal"}


def _admin_line(payload: dict) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("ascii") + b"\n"


def _valid_task_id(value: object) -> bool:
    return type(value) is str and value != ""


def _admin_parent_ok(path: str) -> bool:
    """The socket's directory: a real directory, ours, with no group or other write bit.

    POSIX has no unlink-by-inode, so the check-then-unlink below is safe only
    when no other user can rename entries in this directory.
    """
    try:
        info = os.lstat(os.path.dirname(path))
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return False
    if info.st_uid != os.geteuid():
        return False
    return stat.S_IMODE(info.st_mode) & 0o022 == 0


def _prepare_admin_path(path: str) -> None:
    """Refuse a symlink, a non-socket, or another user's socket. Remove only a dead socket we own."""
    if not _admin_parent_ok(path):
        _fail("admin_socket: parent directory must be a real directory owned by this user with no group or other write")
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    except OSError:
        _fail("admin_socket: path cannot be inspected")
    if stat.S_ISLNK(info.st_mode):
        _fail("admin_socket: path is a symlink")
    if not stat.S_ISSOCK(info.st_mode):
        _fail("admin_socket: path exists and is not a socket")
    if info.st_uid != os.geteuid():
        _fail("admin_socket: socket is owned by another user")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(_ADMIN_STALE_PROBE)
        try:
            probe.connect(path)
        except OSError:
            live = False
        else:
            live = True
    finally:
        probe.close()
    if live:
        _fail("admin_socket: another process is serving this socket")
    try:
        again = os.lstat(path)
    except FileNotFoundError:
        return
    if (again.st_dev, again.st_ino) != (info.st_dev, info.st_ino) or not stat.S_ISSOCK(again.st_mode):
        _fail("admin_socket: path changed during startup")
    os.unlink(path)


class _AdminServer:
    """Unix socket for the dispatcher: health, mint and revoke_task (#194).

    Responses carry placeholders only to the socket's owner. Requests are never
    echoed and nothing here is logged.
    """

    def __init__(self, path: str, state: _State, port_fn: object) -> None:
        self.path = path
        self._state = state
        self._port_fn = port_fn
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._conns: set = set()
        self._conns_lock = threading.Lock()
        _prepare_admin_path(path)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old_mask = os.umask(0o177)
        try:
            try:
                listener.bind(path)
            except OSError:
                listener.close()
                _fail("admin_socket: bind failed")
        finally:
            os.umask(old_mask)
        try:
            os.chmod(path, 0o600)
            info = os.lstat(path)
            if (
                not stat.S_ISSOCK(info.st_mode)
                or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                _fail("admin_socket: unexpected mode or owner")
            self._ident = (info.st_dev, info.st_ino)
            listener.listen(16)
            listener.settimeout(0.1)
        except BaseException:
            listener.close()
            self._unlink_any()
            raise
        self._listener = listener

    def _unlink_any(self) -> None:
        try:
            os.unlink(self.path)
        except OSError:
            return

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._accept_loop, name="ak-broker-admin", daemon=True)
        self._thread.start()

    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _addr = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if self._stop.is_set():
                    return
                time.sleep(0.05)
                continue
            with self._conns_lock:
                self._conns.add(conn)
            worker = threading.Thread(target=self._serve_conn, args=(conn,), daemon=True)
            worker.start()

    def _serve_conn(self, conn: socket.socket) -> None:
        try:
            buf = b""
            while not self._stop.is_set():
                deadline = time.monotonic() + _ADMIN_TIMEOUT
                line = None
                while line is None:
                    newline = buf.find(b"\n")
                    if newline >= 0:
                        if newline + 1 > _ADMIN_MAX_LINE:
                            self._send(conn, _admin_error("bad_request"))
                            return
                        line, buf = buf[:newline], buf[newline + 1:]
                        break
                    if len(buf) >= _ADMIN_MAX_LINE:
                        self._send(conn, _admin_error("bad_request"))
                        return
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return
                    conn.settimeout(remaining)
                    try:
                        block = conn.recv(_READ_CHUNK)
                    except (socket.timeout, OSError):
                        return
                    if not block:
                        return
                    buf += block
                try:
                    response, close = self._handle(line)
                except Exception:
                    response, close = _admin_error("internal"), False
                if not self._send(conn, response) or close:
                    return
        finally:
            with self._conns_lock:
                self._conns.discard(conn)
            try:
                conn.close()
            except OSError:
                pass

    def _send(self, conn: socket.socket, payload: dict) -> bool:
        data = _admin_line(payload)
        if len(data) > _ADMIN_MAX_LINE:
            data = _admin_line(_admin_error("internal"))
        try:
            conn.settimeout(_ADMIN_TIMEOUT)
            conn.sendall(data)
        except OSError:
            return False
        return True

    def _handle(self, raw: bytes) -> tuple:
        """Return ``(response, close_connection)``."""
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return _admin_error("bad_request"), True
        try:
            request = json.loads(text, object_pairs_hook=_admin_pairs, parse_constant=_admin_constant)
        except _AdminBadRequest:
            return _admin_error("bad_request"), False
        except (ValueError, RecursionError):
            return _admin_error("malformed_json"), False
        if not isinstance(request, dict):
            return _admin_error("bad_request"), False
        op = request.get("op")
        if type(op) is not str:
            return _admin_error("bad_request"), False
        if op == "health":
            if set(request) != {"op"}:
                return _admin_error("bad_request"), False
            return {"ok": True}, False
        if op == "mint":
            return self._mint(request), False
        if op == "revoke_task":
            if set(request) != {"op", "task_id"} or not _valid_task_id(request["task_id"]):
                return _admin_error("bad_request"), False
            self._state.store.revoke_task(request["task_id"])
            return {"ok": True}, False
        return _admin_error("unknown_op"), False

    def _grant(self, name: str, placeholder: str, port: int) -> dict:
        service = self._state.services[name]
        return {
            "service": name,
            "placeholder": placeholder,
            "env_key": service["env_key"],
            "env_base_url": service["env_base_url"],
            "base_url": "http://127.0.0.1:%d/%s" % (port, name),
        }

    def _mint(self, request: dict) -> dict:
        if set(request) != {"op", "task_id", "services"}:
            return _admin_error("bad_request")
        task_id = request["task_id"]
        services = request["services"]
        if not _valid_task_id(task_id) or type(services) is not list or not services:
            return _admin_error("bad_request")
        names: list[str] = []
        for name in services:
            if type(name) is not str or name == "" or name in names:
                return _admin_error("bad_request")
            names.append(name)
        # The whole list is checked before anything is created (C7).
        for name in names:
            if name not in self._state.services:
                return _admin_error("unknown_service")
        port = int(self._port_fn())
        sizing = {"ok": True, "grants": [self._grant(name, "x" * _PLACEHOLDER_LEN, port) for name in names]}
        if len(_admin_line(sizing)) > _ADMIN_MAX_LINE:
            return _admin_error("bad_request")
        try:
            issued = self._state.store.mint(task_id, names)
        except ValueError as exc:
            if str(exc) == "duplicate task id":
                return _admin_error("bad_request")
            return _admin_error("internal")
        return {"ok": True, "grants": [self._grant(name, issued[name], port) for name in names]}

    def close(self) -> None:
        self._stop.set()
        try:
            self._listener.close()
        except OSError:
            pass
        thread = self._thread
        if thread is not None:
            thread.join(2)
        with self._conns_lock:
            conns = list(self._conns)
        for conn in conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        # Remove the socket file only when it is still the one this server bound,
        # and only while no other user can swap entries in its directory.
        if not _admin_parent_ok(self.path):
            _LOG.warning("%s", json.dumps({"admin_socket": "left in place", "reason": "parent_not_private"}))
            return
        try:
            info = os.lstat(self.path)
        except OSError:
            return
        if stat.S_ISSOCK(info.st_mode) and (info.st_dev, info.st_ino) == self._ident:
            self._unlink_any()


class BrokerServer:
    """Validate, resolve secrets, then bind ``127.0.0.1`` only."""

    def __init__(self, config: object, store: PlaceholderStore, upstream_factory: object = None) -> None:
        if not isinstance(store, PlaceholderStore):
            _fail("invalid placeholder store")
        # Validation and resolution finish before the listening socket exists.
        checked = validate_config(config, port_zero_ok=True)
        # The audit token resolves before any secret, socket, or delivery thread.
        auditor = audit.from_config(checked["audit"], checked["providers"]) if "audit" in checked else None
        secret_map = _resolve_secrets(checked)
        store.configure(
            tuple(service["name"] for service in checked["services"]),
            checked["placeholder_ttl_seconds"],
        )
        factory = default_upstream_factory if upstream_factory is None else upstream_factory
        self._state = _State(checked, store, secret_map, factory)
        self._state.audit = auditor
        self._httpd = _BoundServer((checked["bind"], checked["port"]), BrokerHandler)
        self._httpd.state = self._state
        self._serving = False
        port = int(self._httpd.server_address[1])
        try:
            self._admin = _AdminServer(checked["admin_socket"], self._state, lambda: port)
        except BaseException:
            self._httpd.server_close()
            self._httpd = None
            raise

    @property
    def bound_port(self) -> int:
        return int(self._httpd.server_address[1])

    def serve_forever(self) -> None:
        httpd = self._httpd
        self._serving = True
        if self._state.audit is not None:
            self._state.audit.start()
        self._admin.start()
        try:
            httpd.serve_forever(poll_interval=0.1)
        finally:
            self._serving = False

    def shutdown(self) -> None:
        httpd = self._httpd
        if httpd is None:
            return
        self._httpd = None
        try:
            # shutdown() waits for serve_forever. Skip that wait when it never started.
            if self._serving:
                httpd.shutdown()
            httpd.server_close()
        finally:
            if self._state.audit is not None:
                # Not drained: queued events are discarded (#192 AC4).
                self._state.audit.close()
            self._admin.close()

    def __repr__(self) -> str:
        return "<broker 127.0.0.1:%s>" % self.bound_port


def _configure_cli_logging() -> None:
    """Give the CLI process a stderr log. Embedding code is not touched.

    Called from ``main`` only, and only when ``ak.broker`` has no handlers, so
    a host that already configured logging keeps that configuration.
    """
    log = logging.getLogger("ak.broker")
    if log.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


def main(argv: list[str] | None = None) -> int:
    """``python3 agents/broker/broker.py --config PATH``. Non-zero before bind on failure."""
    if argv is None:
        argv = sys.argv[1:]
    if len(argv) != 2 or argv[0] != "--config" or type(argv[1]) is not str or argv[1] == "":
        sys.stderr.write("usage: broker.py --config PATH\n")
        return 2
    try:
        config = load_config(argv[1])
        store = PlaceholderStore()
        server = BrokerServer(config, store)
    except Exception as exc:
        sys.stderr.write("%s\n" % exc)
        return 1
    _configure_cli_logging()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
