"""Broker audit events on ``POST /api/ingest`` (#192). Stdlib only. Python 3.9.

One event per request the broker answers, when an ``audit`` block is
configured. Delivery runs on one daemon thread behind a bounded queue, so a
slow or dead ingest endpoint never delays or changes a proxied response.

An event carries only the fields in the #192 field table. It never carries a
header value, a placeholder, a body, a full path, a query, a secret, or the
audit token. Nothing here logs a reason, a URL, or a value.
"""
from __future__ import annotations

import http.client
import json
import logging
import queue
import socket
import ssl
import threading
import time
import urllib.parse

import providers
import refs

_LOG = logging.getLogger("ak.broker.audit")

QUEUE_MAX = 1000
TIMEOUT_SECONDS = 5.0
LOG_INTERVAL_SECONDS = 60.0
INGEST_PATH = "/api/ingest"
TOKEN_PREFIX = "akc_"
TOKEN_ERROR = "audit token must be an agent credential with only status:write"
_CONFIG_ERROR = "invalid broker config: audit"
_MAX_RESPONSE_BYTES = 65536

KIND_FORWARDED = "broker_forwarded"
KIND_REFUSED = "broker_refused"
TOP_KEYS = ("agent_id", "platform", "kind", "detail")
DETAIL_KEYS = ("task_id", "service", "method", "path_prefix", "status", "reason")

# Broker-generated refusals (C8 plus amendment A1). ``kind`` is broker_refused.
REFUSAL_REASONS = frozenset((
    "bad_request",
    "unknown_service",
    "missing_placeholder",
    "bad_placeholder",
    "expired_placeholder",
    "revoked_placeholder",
    "placeholder_leak",
    "method_not_allowed",
    "path_not_allowed",
    "body_too_large",
    "missing_task_context",
))
# The request reached the upstream. ``kind`` is broker_forwarded.
FORWARD_REASONS = frozenset(("upstream_error", "secret_in_response"))
REASONS = REFUSAL_REASONS | FORWARD_REASONS
_BLOCK_KEYS = frozenset(("url", "token"))


def _fail(message: str) -> None:
    exc = ValueError(message)
    try:
        raise exc from None
    finally:
        exc.__context__ = None


def agent_id() -> str:
    """The rule the dispatcher and hooks use: short hostname, lowercase."""
    return "broker-" + socket.gethostname().split(".")[0].lower()


def check_block(value: object) -> dict:
    """Validate ``{"url": <http(s) origin>, "token": <secretref>}``. Resolves nothing."""
    if not isinstance(value, dict) or set(value) != _BLOCK_KEYS:
        _fail(_CONFIG_ERROR)
    url = value["url"]
    if type(url) is not str or url == "" or not url.isascii() or any(ch.isspace() or ord(ch) < 33 for ch in url):
        _fail(_CONFIG_ERROR)
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        _fail(_CONFIG_ERROR)
    if (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or "@" in parts.netloc
        or parts.path != ""
        or parts.query
        or parts.fragment
        or "?" in url
        or "#" in url
    ):
        _fail(_CONFIG_ERROR)
    if port is not None and not 1 <= port <= 65535:
        _fail(_CONFIG_ERROR)
    token = value["token"]
    if type(token) is not str:
        _fail(_CONFIG_ERROR)
    try:
        refs.parse_reference(token)
    except ValueError:
        # The text is not echoed: a literal token here would be a credential.
        _fail(_CONFIG_ERROR)
    return {"url": url, "token": token}


def resolve_token(reference: str, providers_path: str) -> str:
    """Resolve the token reference. Only an ``akc_`` value is accepted.

    No environment variable is consulted for the token itself, and the error
    never contains any part of the resolved value.
    """
    try:
        ref = refs.parse_reference(reference)
    except ValueError:
        _fail(_CONFIG_ERROR)
    try:
        value = providers.resolve(ref, {}, environ=None, config_path=providers_path)
    except ValueError as exc:
        _fail("audit token: provider %s: %s" % (ref[0], exc))
    if (
        type(value) is not str
        or not value.startswith(TOKEN_PREFIX)
        or len(value) <= len(TOKEN_PREFIX)
        or not value.isascii()
        or not value.isprintable()
        or any(ch.isspace() for ch in value)
    ):
        _fail(TOKEN_ERROR)
    return value


def build_event(
    agent: str,
    task_id: object,
    service: object,
    method: object,
    methods: tuple,
    path_prefix: object,
    status: object,
    reason: object,
) -> dict:
    """Map one broker outcome to the #192 event. Raises ``ValueError`` on an unknown reason.

    ``task_id`` and ``service`` are the broker's trusted internal values, never
    request data. ``method`` is reported only when it is one of the service's
    configured methods; anything else is ``OTHER``.
    """
    if reason in ("-", None):
        reason = None
    elif reason not in REASONS:
        _fail("unknown audit reason")
    if type(status) is not int or isinstance(status, bool):
        status = None
    if reason in REFUSAL_REASONS:
        kind = KIND_REFUSED
    else:
        kind = KIND_FORWARDED
        if status is None:
            _fail("forwarded audit event without status")
        if reason is None and status >= 500:
            reason = "upstream_error"
    if type(task_id) is not str or task_id == "":
        task_id = None
    if type(service) is not str or service == "":
        service = None
    if type(path_prefix) is not str or path_prefix in ("", "-"):
        path_prefix = None
    if service is not None and type(method) is str and method in methods:
        reported_method = method
    else:
        reported_method = "OTHER"
    return {
        "agent_id": agent,
        "platform": "other",
        "kind": kind,
        "detail": {
            "task_id": task_id,
            "service": service,
            "method": reported_method,
            "path_prefix": path_prefix,
            "status": status,
            "reason": reason,
        },
    }


class Auditor:
    """Bounded queue plus one daemon delivery thread. No retry, no drain on close."""

    def __init__(
        self,
        url: str,
        token: str,
        timeout: float = TIMEOUT_SECONDS,
        clock: object = time.monotonic,
        agent: str | None = None,
    ) -> None:
        parts = urllib.parse.urlsplit(url)
        self._https = parts.scheme == "https"
        self._host = parts.hostname
        self._port = parts.port
        self._token = token
        self._timeout = float(timeout)
        self._clock = clock
        self.agent_id = agent if agent is not None else agent_id()
        self._queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
        self._lock = threading.Lock()
        self._sent = 0
        self._dropped_full = 0
        self._delivery_failed = 0
        self._last_log: float | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._ssl = ssl.create_default_context() if self._https else None

    def __repr__(self) -> str:
        return "<broker auditor>"

    # Request path -----------------------------------------------------

    def record(
        self,
        task_id: object,
        service: object,
        method: object,
        methods: tuple,
        path_prefix: object,
        status: object,
        reason: object,
    ) -> None:
        """One enqueue attempt. Never blocks and never raises."""
        try:
            event = build_event(self.agent_id, task_id, service, method, methods, path_prefix, status, reason)
        except Exception:
            self._bump("delivery_failed")
            return
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            self._bump("dropped_full")

    # Counters ---------------------------------------------------------

    def _bump(self, name: str) -> None:
        with self._lock:
            if name == "sent":
                self._sent += 1
            elif name == "dropped_full":
                self._dropped_full += 1
            else:
                self._delivery_failed += 1

    def stats(self) -> dict:
        with self._lock:
            return {
                "queued": self._queue.qsize(),
                "sent": self._sent,
                "dropped_full": self._dropped_full,
                "delivery_failed": self._delivery_failed,
            }

    def reset_stats(self) -> None:
        with self._lock:
            self._sent = 0
            self._dropped_full = 0
            self._delivery_failed = 0
            self._last_log = None

    def maybe_log(self) -> None:
        """At most one line a minute, counters only, when either is non-zero."""
        with self._lock:
            dropped = self._dropped_full
            failed = self._delivery_failed
            if not dropped and not failed:
                return
            now = self._clock()
            if self._last_log is not None and now - self._last_log < LOG_INTERVAL_SECONDS:
                return
            self._last_log = now
        _LOG.warning("%s", json.dumps(
            {"audit": "degraded", "dropped_full": dropped, "delivery_failed": failed},
            separators=(",", ":"),
        ))

    # Worker -----------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="ak-broker-audit", daemon=True)
        self._thread.start()

    def close(self) -> None:
        """Stop the worker. Queued events are discarded, not drained."""
        self._stop.set()

    def alive(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                try:
                    event = self._queue.get(timeout=0.2)
                except queue.Empty:
                    event = None
                if event is not None and not self._stop.is_set():
                    if self._deliver(event):
                        self._bump("sent")
                    else:
                        self._bump("delivery_failed")
            except BaseException:
                # A failure inside delivery or bookkeeping never ends the worker.
                self._bump("delivery_failed")
            try:
                self.maybe_log()
            except BaseException:
                pass

    @staticmethod
    def _remaining(deadline: float) -> float:
        """Time left on the one delivery deadline. Zero or less is a timeout."""
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout("audit delivery deadline")
        return remaining

    def _connect(self, port: int, deadline: float) -> socket.socket:
        """Try each resolved address in turn, all inside the one deadline.

        ``socket.create_connection`` gives every address its own full timeout,
        so a blackholed first address could spend the budget several times.
        """
        infos = socket.getaddrinfo(self._host, port, 0, socket.SOCK_STREAM)
        if not infos:
            raise OSError("no address")
        failure: BaseException = OSError("no address")
        for family, socktype, proto, _canon, address in infos:
            remaining = self._remaining(deadline)
            sock = socket.socket(family, socktype, proto)
            try:
                sock.settimeout(remaining)
                sock.connect(address)
            except Exception as exc:
                sock.close()
                failure = exc
                continue
            except BaseException:
                sock.close()
                raise
            return sock
        raise failure

    def _open(self, deadline: float) -> http.client.HTTPConnection:
        """Connect (and for https, handshake) inside the same deadline as the exchange."""
        remaining = self._remaining(deadline)
        if self._https:
            conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                self._host, self._port, timeout=remaining, context=self._ssl,
            )
        else:
            conn = http.client.HTTPConnection(self._host, self._port, timeout=remaining)
        port = self._port or (443 if self._https else 80)
        sock = self._connect(port, deadline)
        try:
            if self._https:
                sock.settimeout(self._remaining(deadline))
                sock = self._ssl.wrap_socket(sock, server_hostname=self._host)
        except BaseException:
            sock.close()
            raise
        # http.client sends on an existing socket and does not reconnect.
        conn.sock = sock
        return conn

    def _deliver(self, event: dict) -> bool:
        """POST once. True only for a 2xx with a JSON object body inside one deadline.

        That deadline covers connect, the TLS handshake, the send, the headers
        and the body. A name lookup is the resolver's own call and is not
        interruptible here.
        """
        deadline = time.monotonic() + self._timeout
        body = json.dumps(event, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        try:
            conn = self._open(deadline)
        except Exception:
            return False
        try:
            if not self._arm(conn, deadline):
                return False
            conn.request(
                "POST",
                INGEST_PATH,
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + self._token,
                },
            )
            if not self._arm(conn, deadline):
                return False
            resp = conn.getresponse()
            if not 200 <= resp.status <= 299:
                return False
            data = bytearray()
            while True:
                if not self._arm(conn, deadline):
                    return False
                # read1 makes at most one socket read, so the deadline is checked between reads.
                block = resp.read1(min(8192, _MAX_RESPONSE_BYTES + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
                if len(data) > _MAX_RESPONSE_BYTES:
                    return False
            if time.monotonic() > deadline:
                return False
            try:
                parsed = json.loads(bytes(data).decode("utf-8"))
            except (ValueError, UnicodeDecodeError, RecursionError):
                return False
            return isinstance(parsed, dict)
        except Exception:
            return False
        finally:
            try:
                conn.close()
            except Exception:
                pass

    @staticmethod
    def _arm(conn: http.client.HTTPConnection, deadline: float) -> bool:
        """Shrink the socket timeout to what is left of the one deadline."""
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        sock = conn.sock
        if sock is not None:
            sock.settimeout(remaining)
        return True


def from_config(block: dict, providers_path: str) -> Auditor:
    """Resolve the token and build a stopped auditor. Raises before any network use."""
    token = resolve_token(block["token"], providers_path)
    return Auditor(block["url"], token)
