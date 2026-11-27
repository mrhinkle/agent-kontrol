"""Short-lived GitHub App installation tokens for lanes (#190). Stdlib only. Python 3.9.

The App private key stays in this process. A lane receives an installation
token for its one repository, with the configured permissions, good for at
most an hour.

The key reaches ``openssl`` only through an inherited pipe (``/dev/fd/<n>``):
never argv, the environment, a log, or a file path on disk. Nothing here logs
a token, a JWT, a placeholder, or key material.
"""
from __future__ import annotations

import base64
import contextlib
import json
import logging
import math
import os
import re
import shutil
import socket
import ssl
import subprocess
import threading
import time
import urllib.parse
from datetime import datetime, timezone

import refs

_LOG = logging.getLogger("ak.broker")

DEFAULT_API = "https://api.github.com"
REFRESH_MARGIN_SECONDS = 300
MAX_LIFETIME_SECONDS = 3600
JWT_BACKDATE_SECONDS = 60
JWT_LIFETIME_SECONDS = 540
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_KEY_BYTES = 16 * 1024
OPENSSL_TIMEOUT_SECONDS = 10.0
# openssl is looked up on this fixed path, never the inherited PATH, and the
# child gets only this environment: no inherited variable can carry key text
# or redirect which program receives the key.
OPENSSL_PATH = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/sbin"
# The revoke runs inside the admin socket's 5-second request budget.
REVOKE_BUDGET_SECONDS = 3.0

_BLOCK_KEYS = frozenset(("app_id", "private_key", "permissions", "api"))
_REQUIRED_KEYS = frozenset(("app_id", "private_key", "permissions"))
_PERMISSION_NAME_RE = re.compile(r"[a-z_]+\Z")
_PERMISSION_VALUES = frozenset(("read", "write"))
OWNER_RE = re.compile(r"[A-Za-z0-9-]{1,39}\Z")
NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}\Z")
_RFC3339_RE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})\Z"
)
_PEM_RE = re.compile(
    r"-----BEGIN ((?:RSA )?PRIVATE KEY)-----\n[A-Za-z0-9+/=\n]+\n-----END \1-----\n?\Z"
)
_CONFIG_ERROR = "invalid broker config: github"


class GitHubUnavailable(Exception):
    """No token. The message is always ``github_unavailable``."""

    def __init__(self) -> None:
        super().__init__("github_unavailable")


class TokenRevoked(Exception):
    """The task's grant was revoked while its token was being minted."""


def _fail(message: str) -> None:
    exc = ValueError(message)
    try:
        raise exc from None
    finally:
        exc.__context__ = None


def _unavailable() -> None:
    exc = GitHubUnavailable()
    try:
        raise exc from None
    finally:
        exc.__context__ = None


# ---------------------------------------------------------------------------
# Strict helpers (C13). Broker-local; nothing is imported from agents/reviewer.

def _pairs(pairs: list) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate member")
        obj[key] = value
    return obj


def _constant(_token: str) -> None:
    raise ValueError("constant")


def strict_json(data: bytes) -> object:
    """UTF-8 JSON with no duplicate members and no NaN/Infinity. Raises ``ValueError``."""
    if type(data) is not bytes:
        _fail("not json")
    try:
        text = data.decode("utf-8")
        return json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        _fail("not json")
    return None


def parse_rfc3339(value: object) -> float:
    """Seconds since the epoch, UTC. ``Z`` and numeric offsets only. Raises ``ValueError``."""
    if type(value) is not str:
        _fail("bad timestamp")
    match = _RFC3339_RE.fullmatch(value)
    if match is None:
        _fail("bad timestamp")
    text = value
    fraction = match.group(7) or ""
    if fraction:
        # datetime takes at most six fraction digits.
        text = value.replace(fraction, (fraction + "000000")[:7], 1)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        _fail("bad timestamp")
    if parsed.tzinfo is None:
        _fail("bad timestamp")
    return parsed.astimezone(timezone.utc).timestamp()


def valid_repo(value: object) -> bool:
    """``<owner>/<name>`` under C8's grammar."""
    if type(value) is not str or value.count("/") != 1:
        return False
    owner, name = value.split("/")
    return (
        OWNER_RE.fullmatch(owner) is not None
        and NAME_RE.fullmatch(name) is not None
        and name not in (".", "..")
    )


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _compact(value: dict) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("ascii")


# ---------------------------------------------------------------------------
# Config (D5, G8, H5).

def check_api(value: object) -> str:
    if type(value) is not str or value == "" or not value.isascii() or any(ch.isspace() or ord(ch) < 33 for ch in value):
        _fail(_CONFIG_ERROR)
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        _fail(_CONFIG_ERROR)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or "@" in parts.netloc
        or parts.path != ""
        or parts.query
        or parts.fragment
        or "?" in value
        or "#" in value
    ):
        _fail(_CONFIG_ERROR)
    if port is not None and not 1 <= port <= 65535:
        _fail(_CONFIG_ERROR)
    return value


def check_block(value: object) -> dict:
    """Validate the optional ``github`` block. Resolves nothing."""
    if not isinstance(value, dict) or not _REQUIRED_KEYS <= set(value) or not set(value) <= _BLOCK_KEYS:
        _fail(_CONFIG_ERROR)
    app_id = value["app_id"]
    if type(app_id) is not int or app_id < 1:
        _fail(_CONFIG_ERROR)
    private_key = value["private_key"]
    if type(private_key) is not str or private_key == "":
        _fail(_CONFIG_ERROR)
    try:
        refs.parse_reference(private_key)
    except ValueError:
        # Not echoed: a literal key pasted here is key material.
        _fail(_CONFIG_ERROR)
    permissions = value["permissions"]
    if not isinstance(permissions, dict) or not permissions:
        _fail(_CONFIG_ERROR)
    checked_permissions: dict = {}
    for name, level in permissions.items():
        if type(name) is not str or _PERMISSION_NAME_RE.fullmatch(name) is None:
            _fail(_CONFIG_ERROR)
        if type(level) is not str or level not in _PERMISSION_VALUES:
            _fail(_CONFIG_ERROR)
        checked_permissions[name] = level
    api = check_api(value["api"]) if "api" in value else DEFAULT_API
    return {
        "app_id": app_id,
        "private_key": private_key,
        "permissions": checked_permissions,
        "api": api,
    }


def normalize_key(value: object) -> bytes:
    """The resolved key as PEM bytes. A single-line value may use literal ``\\n`` escapes."""
    if type(value) is not str or value == "" or not value.isascii():
        _fail("github: provider returned an unusable private key")
    text = value.replace("\r\n", "\n")
    if "\n" not in text.strip("\n") and "\\n" in text:
        text = text.replace("\\n", "\n")
    text = text.strip("\n") + "\n"
    if _PEM_RE.fullmatch(text) is None or len(text) > MAX_KEY_BYTES:
        _fail("github: provider returned an unusable private key")
    return text.encode("ascii")


# ---------------------------------------------------------------------------
# JWT (AC1, H1). The PEM goes through an inherited pipe only.

def signing_input(app_id: int, now: float) -> bytes:
    issued = math.floor(now)
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {"iss": app_id, "iat": issued - JWT_BACKDATE_SECONDS, "exp": issued + JWT_LIFETIME_SECONDS}
    return (b64url(_compact(header)) + "." + b64url(_compact(claims))).encode("ascii")


def _openssl_env() -> dict:
    return {"PATH": OPENSSL_PATH, "LC_ALL": "C"}


def sign_jwt(app_id: int, key_pem: bytes, now: float, openssl: str = "openssl") -> str:
    """``header.claims.signature``. Raises ``GitHubUnavailable`` on any openssl failure."""
    data = signing_input(app_id, now)
    if type(key_pem) is not bytes or not key_pem or len(key_pem) > MAX_KEY_BYTES:
        _unavailable()
    # A bare name is resolved on OPENSSL_PATH; an absolute path is used as given (test seam).
    if type(openssl) is not str or openssl == "":
        _unavailable()
    program = shutil.which(openssl, path=OPENSSL_PATH) if "/" not in openssl else openssl
    if not program or not os.path.isabs(program):
        _unavailable()
    try:
        read_fd, write_fd = os.pipe()
    except OSError:
        _unavailable()
    try:
        try:
            # The key is far below the pipe buffer, so this write cannot block.
            written = os.write(write_fd, key_pem)
        except OSError:
            written = -1
        os.close(write_fd)
        write_fd = -1
        if written != len(key_pem):
            _unavailable()
        try:
            proc = subprocess.run(
                [program, "dgst", "-sha256", "-sign", "/dev/fd/%d" % read_fd],
                input=data,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                pass_fds=(read_fd,),
                close_fds=True,
                env=_openssl_env(),
                timeout=OPENSSL_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError, ValueError):
            _unavailable()
    finally:
        if write_fd >= 0:
            os.close(write_fd)
        os.close(read_fd)
    if proc.returncode != 0 or not proc.stdout:
        _unavailable()
    return data.decode("ascii") + "." + b64url(proc.stdout)


# ---------------------------------------------------------------------------
# HTTP transport (G3, H8, H16). One monotonic deadline per call, covering name
# resolution, every address, connect, TLS, send, headers and body. No proxy
# variable is consulted and no redirect is followed.

def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise socket.timeout("deadline")
    return left


def _resolve(host: str, port: int, deadline: float) -> list:
    box: dict = {}

    def run() -> None:
        try:
            box["addrs"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except Exception as exc:  # noqa: BLE001 - reported as a failure below
            box["error"] = exc

    worker = threading.Thread(target=run, name="ak-broker-github-dns", daemon=True)
    worker.start()
    worker.join(_remaining(deadline))
    if worker.is_alive() or "addrs" not in box:
        raise socket.timeout("resolve")
    return box["addrs"]


def _connect(host: str, port: int, deadline: float) -> socket.socket:
    last: BaseException | None = None
    for family, socktype, proto, _canon, addr in _resolve(host, port, deadline):
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(_remaining(deadline))
            sock.connect(addr)
            return sock
        except socket.timeout:
            sock.close()
            raise
        except OSError as exc:
            sock.close()
            last = exc
    raise OSError("connect") from last


def _recv_until(sock: socket.socket, deadline: float, limit: int) -> bytes:
    """Read to EOF, or until a complete Content-Length body, within the deadline."""
    buf = b""
    head_end = -1
    want = None
    while True:
        if head_end < 0:
            head_end = buf.find(b"\r\n\r\n")
            if head_end >= 0:
                want = _content_length(buf[:head_end])
        if want is not None and len(buf) >= head_end + 4 + want:
            return buf
        if len(buf) > limit:
            raise ValueError("response too large")
        sock.settimeout(_remaining(deadline))
        block = sock.recv(65536)
        if not block:
            return buf
        buf += block


def _content_length(head: bytes) -> int | None:
    lengths = []
    for line in head.split(b"\r\n")[1:]:
        name, sep, value = line.partition(b":")
        if sep and name.strip().lower() == b"content-length":
            lengths.append(value.strip())
    if len(lengths) != 1 or not lengths[0].isdigit() or len(lengths[0]) > 12:
        return None
    return int(lengths[0])


def _dechunk(body: bytes) -> bytes:
    out = b""
    rest = body
    while True:
        line, sep, rest = rest.partition(b"\r\n")
        if not sep:
            raise ValueError("bad chunk")
        size_text = line.split(b";", 1)[0].strip()
        if not size_text or len(size_text) > 8 or any(c not in b"0123456789abcdefABCDEF" for c in size_text):
            raise ValueError("bad chunk")
        size = int(size_text, 16)
        if size == 0:
            return out
        if len(rest) < size + 2 or rest[size:size + 2] != b"\r\n":
            raise ValueError("bad chunk")
        out += rest[:size]
        rest = rest[size + 2:]


def parse_response(raw: bytes) -> tuple:
    """``(status, {lower-name: value}, body)``. Raises ``ValueError`` on bad framing."""
    head_end = raw.find(b"\r\n\r\n")
    if head_end < 0:
        raise ValueError("no header end")
    lines = raw[:head_end].split(b"\r\n")
    parts = lines[0].split(b" ", 2)
    if len(parts) < 2 or parts[0] not in (b"HTTP/1.0", b"HTTP/1.1") or not parts[1].isdigit() or len(parts[1]) != 3:
        raise ValueError("bad status line")
    status = int(parts[1])
    headers: dict = {}
    for line in lines[1:]:
        name, sep, value = line.partition(b":")
        if not sep or not name or name != name.strip():
            raise ValueError("bad header")
        key = name.decode("latin-1").lower()
        if key in headers and key in ("content-length", "transfer-encoding", "content-type", "location"):
            raise ValueError("duplicate header")
        headers[key] = value.strip().decode("latin-1")
    body = raw[head_end + 4:]
    if headers.get("transfer-encoding", "").lower() == "chunked":
        body = _dechunk(body)
    elif "transfer-encoding" in headers:
        raise ValueError("unsupported transfer-encoding")
    elif "content-length" in headers:
        length = _content_length(raw[:head_end])
        if length is None or len(body) < length:
            raise ValueError("short body")
        body = body[:length]
    return status, headers, body


class GitHubAPI:
    """Minimal HTTPS client for the three App endpoints."""

    def __init__(self, api: str, timeout_seconds: float, ssl_context: ssl.SSLContext | None = None,
                 _plaintext_loopback: bool = False) -> None:
        parts = urllib.parse.urlsplit(api)
        if _plaintext_loopback:
            # Test-only seam (C11): an http fixture on 127.0.0.1. Config never reaches it.
            if parts.scheme != "http" or parts.hostname != "127.0.0.1":
                _fail(_CONFIG_ERROR)
            self._tls = None
        else:
            if parts.scheme != "https":
                _fail(_CONFIG_ERROR)
            self._tls = ssl_context if ssl_context is not None else ssl.create_default_context()
        self.host = parts.hostname or ""
        self.port = parts.port or (443 if self._tls is not None else 80)
        self.timeout = float(timeout_seconds)
        self._authority = self.host if parts.port is None else "%s:%d" % (self.host, parts.port)

    def __repr__(self) -> str:
        return "<github api %s>" % self._authority

    def request(self, method: str, path: str, bearer: str, body: dict | None = None,
                budget: float | None = None) -> tuple:
        """``(status, body bytes)``. Raises ``GitHubUnavailable`` on any transport failure."""
        deadline = time.monotonic() + (self.timeout if budget is None else min(self.timeout, budget))
        payload = b"" if body is None else _compact(body)
        lines = [
            "%s %s HTTP/1.1" % (method, path),
            "Host: %s" % self._authority,
            "Authorization: Bearer %s" % bearer,
            "Accept: application/vnd.github+json",
            "X-GitHub-Api-Version: 2022-11-28",
            "User-Agent: agent-kontrol-broker",
            "Accept-Encoding: identity",
            "Connection: close",
        ]
        if body is not None:
            lines.append("Content-Type: application/json")
        if body is not None or method in ("POST", "PUT", "PATCH", "DELETE"):
            lines.append("Content-Length: %d" % len(payload))
        request = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + payload
        sock = None
        try:
            sock = _connect(self.host, self.port, deadline)
            if self._tls is not None:
                plain = sock
                sock = self._tls.wrap_socket(plain, server_hostname=self.host, do_handshake_on_connect=False)
                sock.settimeout(_remaining(deadline))
                sock.do_handshake()
            sock.settimeout(_remaining(deadline))
            sock.sendall(request)
            raw = _recv_until(sock, deadline, MAX_RESPONSE_BYTES)
            status, _headers, data = parse_response(raw)
        except GitHubUnavailable:
            raise
        except Exception:  # noqa: BLE001 - every transport failure is the same code
            _unavailable()
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
        return status, data


def default_client_factory(api: str, timeout_seconds: float) -> GitHubAPI:
    return GitHubAPI(api, timeout_seconds)


# ---------------------------------------------------------------------------
# Token service (AC1-AC3, H2, H3).

class TokenService:
    """Mints and caches one installation token per task. Thread-safe."""

    def __init__(self, block: dict, key_pem: bytes, client: object, wall_clock: object = time.time,
                 openssl: str = "openssl") -> None:
        self._app_id = block["app_id"]
        self._permissions = dict(block["permissions"])
        self._key = key_pem
        self._client = client
        self._clock = wall_clock
        self._openssl = openssl
        self._cache_lock = threading.Lock()
        self._cache: dict = {}
        self._mint_locks: dict = {}

    def __repr__(self) -> str:
        return "<github token service>"

    @contextlib.contextmanager
    def _mint_lock(self, task_id: str):
        """The task's lock. The entry is dropped once nobody holds or waits for it and
        no token is cached, so revoked tasks leave nothing behind."""
        with self._cache_lock:
            slot = self._mint_locks.get(task_id)
            if slot is None:
                slot = [threading.Lock(), 0]
                self._mint_locks[task_id] = slot
            slot[1] += 1
        try:
            with slot[0]:
                yield
        finally:
            with self._cache_lock:
                slot[1] -= 1
                if slot[1] == 0 and self._mint_locks.get(task_id) is slot and task_id not in self._cache:
                    del self._mint_locks[task_id]

    def serve(self, task_id: str, repo: str, is_live: object, send: object) -> None:
        """Choose this task's token and hand it to ``send(token, expires_at)``.

        The task's lock is held from the choice until ``send`` has written the
        response, and ``revoke_task`` takes the same lock (#190 I5). ``is_live``
        is checked under that lock just before ``send``: a grant revoked before
        the response is committed gets no token, cached or fresh, whatever the
        DELETE did. Raises ``GitHubUnavailable`` or ``TokenRevoked``.
        """
        with self._mint_lock(task_id):
            if not is_live():
                raise TokenRevoked()
            with self._cache_lock:
                entry = self._cache.get(task_id)
                if entry is None or entry["repo"] != repo or self._clock() >= entry["expires"] - REFRESH_MARGIN_SECONDS:
                    entry = None
                    self._cache.pop(task_id, None)
            if entry is None:
                token, expires_at, expires = self._mint(repo)
                entry = {"token": token, "expires_at": expires_at, "expires": expires, "repo": repo}
                with self._cache_lock:
                    self._cache[task_id] = entry
            self._chosen(task_id)
            if not is_live():
                # The token stays cached: the pending revoke_task pops and DELETEs it.
                raise TokenRevoked()
            send(entry["token"], entry["expires_at"])

    def _chosen(self, task_id: str) -> None:
        """Test seam: runs under the task lock after the token is chosen, before the liveness check."""
        return

    def _mint(self, repo: str) -> tuple:
        owner, name = repo.split("/")
        now = self._clock()
        jwt = sign_jwt(self._app_id, self._key, now, self._openssl)
        quoted = "/repos/%s/%s/installation" % (urllib.parse.quote(owner, safe=""), urllib.parse.quote(name, safe=""))
        status, data = self._client.request("GET", quoted, jwt)
        if not 200 <= status < 300:
            _unavailable()
        try:
            install = strict_json(data)
        except ValueError:
            _unavailable()
        if not isinstance(install, dict):
            _unavailable()
        install_id = install.get("id")
        if type(install_id) is not int or install_id < 1:
            _unavailable()
        body = {"repositories": [name], "permissions": dict(self._permissions)}
        status, data = self._client.request("POST", "/app/installations/%d/access_tokens" % install_id, jwt, body)
        if not 200 <= status < 300:
            _unavailable()
        try:
            result = strict_json(data)
        except ValueError:
            _unavailable()
        if not isinstance(result, dict):
            _unavailable()
        token = result.get("token")
        expires_at = result.get("expires_at")
        # Documented extras are checked against what was asked for; other keys are ignored (H2 says
        # "a strict object containing", not "exactly"). A wider grant than requested is refused.
        if not self._scope_ok(result, name):
            if type(token) is str and token:
                self._delete(token)
            _unavailable()
        if type(token) is not str or token == "" or not token.isascii() or not token.isprintable() or any(ch.isspace() for ch in token):
            _unavailable()
        try:
            expires = parse_rfc3339(expires_at)
        except ValueError:
            # A token was issued: revoke it before refusing.
            self._delete(token)
            _unavailable()
        current = self._clock()
        if not current < expires <= current + MAX_LIFETIME_SECONDS:
            self._delete(token)
            _unavailable()
        return token, expires_at, expires

    def _scope_ok(self, result: dict, name: str) -> bool:
        if "repository_selection" in result and result["repository_selection"] != "selected":
            return False
        if "repositories" in result:
            repos = result["repositories"]
            if (
                not isinstance(repos, list)
                or len(repos) != 1
                or not isinstance(repos[0], dict)
                or type(repos[0].get("name")) is not str
                or repos[0]["name"].lower() != name.lower()
            ):
                return False
        if "permissions" in result:
            granted = result["permissions"]
            if not isinstance(granted, dict):
                return False
            granted = dict(granted)
            # GitHub adds metadata:read to every installation token; it may be present or absent.
            if "metadata" not in self._permissions and granted.get("metadata") == "read":
                del granted["metadata"]
            # Exactly the configured set: nothing wider, nothing missing, no other level.
            if granted != self._permissions:
                return False
        return True

    def forget(self, task_id: str) -> None:
        """Clear a task's cache after a failed fetch (the token stays valid upstream until it expires)."""
        with self._cache_lock:
            self._cache.pop(task_id, None)

    def revoke_task(self, task_id: object) -> None:
        """Clear the task's cache and DELETE its token. Never raises.

        Takes the task's lock, so it waits for an in-flight response to be
        written (I5); the store has already revoked the placeholder, so a
        request still waiting for the lock is refused.
        """
        if type(task_id) is not str:
            return
        with self._mint_lock(task_id):
            with self._cache_lock:
                entry = self._cache.pop(task_id, None)
        if entry is not None and not self._delete(entry["token"]):
            _LOG.warning("%s", json.dumps({"github": "github_revoke_failed"}, separators=(",", ":")))

    def _delete(self, token: str) -> bool:
        try:
            status, _data = self._client.request("DELETE", "/installation/token", token, budget=REVOKE_BUDGET_SECONDS)
        except Exception:  # noqa: BLE001
            return False
        return 200 <= status < 300
