#!/usr/bin/env python3
"""Observe two launchd jobs, then run the shipped sweeper once.

Default is inert: a config with "enabled": false reads no secret, opens no
socket, and writes no state. Nothing in this file installs or loads a job.

An enabled tick takes one nonblocking flock(2), posts at most one
sweep.scheduler_job observation per allowlisted job, then runs sweep-once.sh
once. It never starts, stops, or rewrites a watched job, and it never registers
a queue or a consumer.

The credential is MC_TOKEN from an explicit secret file of literal assignments,
parsed by scripts/import-velocity.py. The token is not accepted on argv and is
not written to the plist, the log, or this source.

Each observation POST has one monotonic deadline for connect, headers, and
every body read. At that deadline the socket is shut down. A framed body
that http.client has already finished is complete; the closed descriptor is
not touched again, and a short Content-Length is not a successful body.
The sweep and launchctl children run in their own session. Pipe EOF does
not finish a leader that is still running; that leader is waited only until
the same deadline. A deadline then kills that process group, including
after the leader exits, and reading stops at a byte cap.
sweep-once.sh ignores ambient curl configuration, proxies, and redirects, and
it caps the response body before jq reads it.
"""
from __future__ import annotations

import argparse
import datetime as dt
import errno
import fcntl
import http.client
import importlib.util
import json
import os
import pathlib
import re
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

SOURCE = "mini-launchd"
AGENT_ID = "mini-observer"
STALE_AFTER_MINUTES = 30
DOMAIN = "user"
JOBS = (
    "com.missioncontrol.progress-collector",
    "com.peripety.neuro-independent-review",
)
INGEST_PATH = "/api/ingest"
LEDGER_VERSION = 1
SEAL_TEXT = "1\n"
MAX_CONFIG_BYTES = 64 * 1024
MAX_LEDGER_BYTES = 256 * 1024
MAX_LAUNCHCTL_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
MAX_SWEEP_CAPTURE = 256 * 1024
MAX_SUMMARY_LINES = 300
MAX_SUMMARY_LINE = 500
HTTP_TIMEOUT_DEFAULT = 20
HTTP_TIMEOUT_MAX = 20
LAUNCHCTL_TIMEOUT_DEFAULT = 10
LAUNCHCTL_TIMEOUT_MAX = 10
SWEEP_TIMEOUT_DEFAULT = 90
SWEEP_TIMEOUT_MAX = 90
SUCCESS_OUTCOMES = ("applied", "refreshed", "replay")
HALT_OUTCOMES = ("older",)
ALLOWED_KEYS = {
    "enabled",
    "target_origin",
    "agent_id",
    "source",
    "stale_after_minutes",
    "jobs",
    "domain",
    "secret_file",
    "state_dir",
    "sweep_once",
    "launchctl",
    "http_timeout_seconds",
    "launchctl_timeout_seconds",
    "sweep_timeout_seconds",
}
JOB_FIELDS = ("transition", "state", "paused_at", "observed_at", "pending", "halted", "halt_class")
HALT_CLASSES = (
    "older",
    "conflict",
    "rejected",
    "redirect-denied",
    "unknown-response",
    "invalid-response",
)
ISO_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$"
)
SERVICE_LINE = re.compile(r"^(\d+)\s+(\S+)\s+(\S+)$")
DISABLED_LINE = re.compile(r'^"([^"]+)"\s*=>\s*(enabled|disabled)$')
IDENT = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


class ConfigError(Exception):
    def __init__(self, category):
        self.category = category


class TickError(Exception):
    def __init__(self, category):
        self.category = category


def _velocity():
    path = pathlib.Path(__file__).resolve().with_name("import-velocity.py")
    spec = importlib.util.spec_from_file_location("ak_import_velocity", str(path))
    if spec is None or spec.loader is None:
        raise ConfigError("credential-unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(value):
        raise ValueError("non-finite")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)


def dump_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_iso(value):
    if not isinstance(value, str) or ISO_RE.fullmatch(value) is None:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    if not 2000 <= parsed.year <= 2100:
        return None
    return parsed


def exact_text(value, pattern=None):
    if not isinstance(value, str) or value == "" or len(value) > 1024:
        return None
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return None
    if pattern is not None and pattern.fullmatch(value) is None:
        return None
    return value


def exact_int(value, low, high):
    if type(value) is not int or not low <= value <= high:
        return None
    return value


def optional_path(value):
    if value is None:
        return None
    return exact_text(value)


def load_config(path):
    try:
        raw = path.read_bytes()
    except OSError:
        raise ConfigError("invalid-config")
    if not raw or len(raw) > MAX_CONFIG_BYTES:
        raise ConfigError("invalid-config")
    try:
        data = strict_json(raw)
    except (UnicodeError, ValueError, RecursionError, TypeError):
        raise ConfigError("invalid-config")
    if not isinstance(data, dict) or set(data) - ALLOWED_KEYS:
        raise ConfigError("invalid-config")
    enabled = data.get("enabled")
    if type(enabled) is not bool:
        raise ConfigError("invalid-config")
    origin_text = exact_text(data.get("target_origin"))
    if origin_text is None or data.get("agent_id") != AGENT_ID or data.get("source") != SOURCE:
        raise ConfigError("invalid-config")
    if data.get("domain") != DOMAIN or data.get("stale_after_minutes") != STALE_AFTER_MINUTES:
        raise ConfigError("invalid-config")
    if data.get("jobs") != list(JOBS):
        raise ConfigError("invalid-config")
    for job in JOBS:
        if IDENT.fullmatch(job) is None:
            raise ConfigError("invalid-config")
    http_timeout = data.get("http_timeout_seconds", HTTP_TIMEOUT_DEFAULT)
    launch_timeout = data.get("launchctl_timeout_seconds", LAUNCHCTL_TIMEOUT_DEFAULT)
    sweep_timeout = data.get("sweep_timeout_seconds", SWEEP_TIMEOUT_DEFAULT)
    if exact_int(http_timeout, 1, HTTP_TIMEOUT_MAX) is None:
        raise ConfigError("invalid-config")
    if exact_int(launch_timeout, 1, LAUNCHCTL_TIMEOUT_MAX) is None:
        raise ConfigError("invalid-config")
    if exact_int(sweep_timeout, 1, SWEEP_TIMEOUT_MAX) is None:
        raise ConfigError("invalid-config")
    secret = data.get("secret_file", None)
    state = data.get("state_dir", None)
    sweep = optional_path(data.get("sweep_once", None))
    launch = optional_path(data.get("launchctl", None))
    if sweep is None and "sweep_once" in data and data.get("sweep_once") is not None:
        raise ConfigError("invalid-config")
    if launch is None and "launchctl" in data and data.get("launchctl") is not None:
        raise ConfigError("invalid-config")
    if secret is not None and exact_text(secret) is None:
        raise ConfigError("invalid-config")
    if state is not None and exact_text(state) is None:
        raise ConfigError("invalid-config")
    if enabled and (secret is None or state is None):
        raise ConfigError("invalid-config")
    try:
        _velocity().origin(origin_text)
    except Exception:
        raise ConfigError("invalid-origin")
    return {
        "enabled": enabled,
        "target_origin": origin_text,
        "secret_file": secret,
        "state_dir": None if state is None else pathlib.Path(state),
        "sweep_once": sweep,
        "launchctl": launch if launch is not None else "/bin/launchctl",
        "http_timeout": http_timeout,
        "launch_timeout": launch_timeout,
        "sweep_timeout": sweep_timeout,
    }


def child_env(extra=None):
    env = {}
    for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"):
        if key in os.environ and os.environ[key] != "":
            env[key] = os.environ[key]
    if extra:
        env.update(extra)
    return env


def brace_delta(line):
    delta = 0
    in_string = False
    escape = False
    for ch in line:
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            delta += 1
        elif ch == "}":
            delta -= 1
    if in_string or escape:
        return None
    return delta


def parse_domain(text, uid):
    """Return loaded labels and explicitly disabled labels, or None.

    A None result is an unreadable domain: the caller must not invent a fact.
    Loaded means the label is in the services list, whatever its pid is.
    Explicitly disabled wins over loaded. A label in neither set is absent.
    """
    if "\x00" in text or len(text) > MAX_LAUNCHCTL_BYTES:
        return None
    lines = text.splitlines()
    if not lines or lines[0].strip() != "user/%d = {" % uid:
        return None
    depth = 0
    mode = None
    services = 0
    disabled_blocks = 0
    loaded = []
    disabled = {}
    for line in lines:
        stripped = line.strip()
        delta = brace_delta(line)
        if delta is None or abs(delta) > 1:
            return None
        opens = stripped.endswith("{") and delta == 1
        closes = stripped == "}" and delta == -1
        if delta != 0 and not opens and not closes:
            return None
        if opens:
            if mode in ("services", "disabled"):
                return None
            key = stripped[:-1].strip()
            if key.endswith("="):
                key = key[:-1].strip()
            if depth == 1 and key == "services":
                services += 1
                mode = "services"
            elif depth == 1 and key == "disabled services":
                disabled_blocks += 1
                mode = "disabled"
            depth += 1
            continue
        if closes:
            depth -= 1
            if depth < 0:
                return None
            if depth == 1 and mode in ("services", "disabled"):
                mode = None
            elif depth == 0:
                mode = None
            continue
        if depth == 0:
            if stripped:
                return None
            continue
        if mode == "services" and depth == 2:
            if stripped == "":
                continue
            matched = SERVICE_LINE.fullmatch(stripped)
            if matched is None:
                return None
            label = matched.group(3)
            if label in loaded:
                return None
            loaded.append(label)
        elif mode == "disabled" and depth == 2:
            if stripped == "":
                continue
            matched = DISABLED_LINE.fullmatch(stripped)
            if matched is None:
                return None
            label, value = matched.group(1), matched.group(2)
            if label in disabled:
                return None
            disabled[label] = value
    if depth != 0 or services != 1 or disabled_blocks > 1:
        return None
    explicit = {label for label, value in disabled.items() if value == "disabled"}
    return {"loaded": set(loaded), "disabled": explicit}


def classify(domain, job):
    if job in domain["disabled"]:
        return "paused"
    if job in domain["loaded"]:
        return "active"
    return "paused"


def _stop_group(proc):
    """Signal this invocation's process group, including after the leader exits.

    start_new_session makes proc.pid the process-group id. That id stays
    usable until the group is empty, and the leader's pid is not reused while
    it is still unreaped. This does not signal any other process group.
    """
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass


def _discard_pipes(streams, deadline):
    pending = [stream for stream in streams if stream is not None]
    while pending and time.monotonic() < deadline:
        wait = max(0.0, min(0.05, deadline - time.monotonic()))
        try:
            ready, _, _ = select.select(pending, [], [], wait)
        except (OSError, ValueError):
            break
        if not ready:
            continue
        for stream in ready:
            try:
                chunk = os.read(stream.fileno(), 65536)
            except OSError:
                pending.remove(stream)
                continue
            if not chunk:
                pending.remove(stream)


def capture_process(argv, timeout, limit, env):
    """Run argv in a new session and return (kind, stdout, stderr, code).

    kind is exited, timeout, oversize, or missing. Reading stops at limit
    bytes total. Pipe EOF does not finish a leader that is still running:
    that leader is waited only until the monotonic deadline. A deadline
    kills the process group, including after the leader has exited, then
    drains at most half a second without keeping those bytes.
    """
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            close_fds=True,
            start_new_session=True,
        )
    except OSError:
        return "missing", b"", b"", None
    for stream in (proc.stdout, proc.stderr):
        fd = stream.fileno()
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    deadline = time.monotonic() + timeout
    out = bytearray()
    err = bytearray()
    buffers = {proc.stdout: out, proc.stderr: err}
    oversize = False
    timed_out = False
    while buffers:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            break
        try:
            ready, _, _ = select.select(list(buffers), [], [], min(0.2, remaining))
        except (OSError, ValueError):
            timed_out = True
            break
        if not ready:
            if proc.poll() is not None:
                try:
                    ready, _, _ = select.select(list(buffers), [], [], 0)
                except (OSError, ValueError):
                    ready = []
                if not ready:
                    # A descendant can still hold the pipes after the leader
                    # exits. No queued bytes is not EOF. Keep the group until
                    # the pipes close or the deadline, then kill only that group.
                    continue
            else:
                continue
        for stream in ready:
            bucket = buffers.get(stream)
            if bucket is None:
                continue
            try:
                chunk = os.read(stream.fileno(), 16384)
            except OSError as exc:
                if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    continue
                buffers.pop(stream, None)
                continue
            if not chunk:
                buffers.pop(stream, None)
                continue
            room = limit - (len(out) + len(err))
            if room <= 0 or len(chunk) > room:
                if room > 0:
                    bucket.extend(chunk[:room])
                oversize = True
                buffers.clear()
                break
            bucket.extend(chunk)
    if not timed_out and not oversize and proc.poll() is None:
        # Both pipes are closed. The leader may still be exiting. Wait only
        # for the time still left, then classify a timeout if it is running.
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
        else:
            try:
                proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                timed_out = True
    _stop_group(proc)
    _discard_pipes([proc.stdout, proc.stderr], time.monotonic() + 0.5)
    for stream in (proc.stdout, proc.stderr):
        try:
            stream.close()
        except OSError:
            pass
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        _stop_group(proc)
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
    if timed_out:
        return "timeout", bytes(out), bytes(err), proc.returncode
    if oversize:
        return "oversize", bytes(out), bytes(err), proc.returncode
    return "exited", bytes(out), bytes(err), proc.returncode


def read_launchctl(path, uid, timeout):
    kind, out, _err, code = capture_process(
        [path, "print", "user/%d" % uid],
        timeout,
        MAX_LAUNCHCTL_BYTES,
        child_env(),
    )
    if kind != "exited" or code != 0 or len(out) > MAX_LAUNCHCTL_BYTES:
        return None
    try:
        text = out.decode("utf-8")
    except UnicodeError:
        return None
    return parse_domain(text, uid)


def credential(config):
    velocity = _velocity()
    try:
        url, token = velocity.configured_values(pathlib.Path(config["secret_file"]), {})
        target = velocity.origin(config["target_origin"])
        secret_origin = velocity.origin(url)
    except velocity.SafeImportError:
        raise TickError("credential-unavailable")
    except Exception:
        raise TickError("credential-unavailable")
    if target[1] != secret_origin[1]:
        raise TickError("origin-mismatch")
    return target[0], token


def _capturing_connection(base, box):
    class Capture(base):
        def connect(self):
            super().connect()
            box["sock"] = self.sock

    return Capture


def request_opener():
    """Direct opener: no proxy, no redirect, and a socket the deadline can close."""
    velocity = _velocity()
    box = {}

    class Handler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(_capturing_connection(http.client.HTTPConnection, box), req)

    class HandlerS(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(
                _capturing_connection(http.client.HTTPSConnection, box),
                req,
                context=self._context,
                check_hostname=self._check_hostname,
            )

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        velocity.NoRedirect(),
        Handler(),
        HandlerS(),
    )
    opener._ak_sock_box = box
    return opener


def _response_socket(response):
    current = response
    for _ in range(4):
        if current is None:
            return None
        raw = getattr(current, "raw", None)
        if raw is not None:
            sock = getattr(raw, "_sock", None)
            if sock is not None and hasattr(sock, "settimeout"):
                return sock
        sock = getattr(current, "_sock", None)
        if sock is not None and hasattr(sock, "settimeout"):
            return sock
        current = getattr(current, "fp", None)
    return None


def _pull(response, size):
    if hasattr(response, "read1"):
        return response.read1(size)
    fp = getattr(response, "fp", None)
    if fp is not None and hasattr(fp, "read1"):
        return fp.read1(size)
    if hasattr(response, "read"):
        return response.read(1)
    return b""


def _interrupt_socket(sock):
    """Unblock a read on sock. close() alone does not stop a buffered recv."""
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def _socket_open(sock):
    """True when fileno is still valid. A closed socket raises EBADF on settimeout."""
    try:
        fileno = sock.fileno()
    except OSError:
        return False
    return isinstance(fileno, int) and fileno >= 0


def _framed_body_complete(response):
    """True when http.client has already consumed a complete framed body.

    length 0 is a satisfied Content-Length, including one whose final read
    closed the socket. A chunked body is complete only after the zero chunk
    closes the reader. An open reader, or a positive length still owed, is
    not done.
    """
    length = getattr(response, "length", None)
    if length == 0:
        return True
    if getattr(response, "chunked", False) and getattr(response, "fp", None) is None:
        return True
    return False


def _read_limited(response, limit, deadline, box):
    """Read at most limit+1 bytes. Each recv's timeout is the time still left.

    Recognize a finished frame before touching the socket. Newer http.client
    closes the descriptor when read1 takes the last Content-Length byte, and
    settimeout on that descriptor is EBADF, not a deadline.
    """
    if time.monotonic() >= deadline:
        raise TimeoutError
    sock = _response_socket(response)
    if isinstance(box, dict) and sock is not None:
        box["read_sock"] = sock
    chunks = []
    total = 0
    while total <= limit:
        if _framed_body_complete(response):
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        if sock is not None:
            if not _socket_open(sock):
                if _framed_body_complete(response):
                    break
                raise TimeoutError
            try:
                sock.settimeout(max(0.01, remaining))
            except OSError:
                if _framed_body_complete(response):
                    break
                raise TimeoutError
        try:
            chunk = _pull(response, min(8192, limit + 1 - total))
        except (socket.timeout, TimeoutError):
            raise TimeoutError
        except OSError:
            if _framed_body_complete(response):
                break
            raise TimeoutError
        if not chunk:
            length = getattr(response, "length", None)
            if isinstance(length, int) and length > 0:
                raise TimeoutError
            break
        chunks.append(chunk)
        total += len(chunk)
    if time.monotonic() >= deadline:
        raise TimeoutError
    return b"".join(chunks)


def _classify_http(code):
    if code in (301, 302, 303, 307, 308):
        return "redirect-denied"
    if code == 409:
        return "conflict"
    if code in (408, 429) or 500 <= code <= 599:
        return "lost-response"
    if 400 <= code <= 499:
        return "rejected"
    return "lost-response"


def post_observation(endpoint, body, token, timeout, opener):
    deadline = time.monotonic() + timeout
    box = getattr(opener, "_ak_sock_box", None)
    stop = threading.Event()
    expired = threading.Event()

    def watchdog():
        while time.monotonic() < deadline:
            if stop.wait(min(0.05, max(0.0, deadline - time.monotonic()))):
                return
        expired.set()
        if isinstance(box, dict):
            for key in ("sock", "read_sock"):
                _interrupt_socket(box.get(key))

    watcher = threading.Thread(target=watchdog, daemon=True)
    watcher.start()
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        try:
            remaining = max(0.01, deadline - time.monotonic())
            with opener.open(request, timeout=remaining) as response:
                if expired.is_set() or time.monotonic() >= deadline:
                    return "lost-response"
                status = response.getcode()
                final = response.geturl()
                payload = _read_limited(response, MAX_RESPONSE_BYTES + 1, deadline, box)
                if expired.is_set() or time.monotonic() >= deadline:
                    return "lost-response"
        except urllib.error.HTTPError as exc:
            code = exc.code if type(exc.code) is int else 0
            try:
                exc.close()
            except Exception:
                pass
            return _classify_http(code)
        except Exception:
            return "lost-response"
    finally:
        stop.set()
        watcher.join(0.2)
    if type(status) is int and status in (301, 302, 303, 307, 308):
        return "redirect-denied"
    if status != 200 or final != endpoint:
        return "redirect-denied" if final != endpoint else "unknown-response"
    if not isinstance(payload, bytes) or len(payload) > MAX_RESPONSE_BYTES or not payload:
        return "invalid-response"
    try:
        data = strict_json(payload)
    except (UnicodeError, ValueError, RecursionError, TypeError):
        return "unknown-response"
    if not isinstance(data, dict) or data.get("ok") is not True or data.get("kind") != "sweep.scheduler_job":
        return "unknown-response"
    outcome = data.get("outcome")
    if outcome in SUCCESS_OUTCOMES:
        if not isinstance(data.get("observation_id"), str) or not data["observation_id"].isdigit():
            return "invalid-response"
        if parse_iso(data.get("received_at")) is None:
            return "invalid-response"
        safe = dump_json({
            "outcome": outcome,
            "observation_id": data["observation_id"],
            "received_at": data["received_at"],
        })
        if token in safe or token in outcome:
            return "invalid-response"
        return outcome
    if outcome in HALT_OUTCOMES:
        return outcome
    return "unknown-response"


def observation_body(job, state, transition, observed_at, paused_at):
    observation = {
        "source": SOURCE,
        "job_id": job,
        "state": state,
        "transition": transition,
        "observed_at": observed_at,
        "stale_after_minutes": STALE_AFTER_MINUTES,
    }
    if state == "paused":
        observation["paused_at"] = paused_at
    return dump_json({"agent_id": AGENT_ID, "kind": "sweep.scheduler_job", "observation": observation})


def valid_record(job, record):
    if not isinstance(record, dict) or set(record) != set(JOB_FIELDS):
        return False
    transition = record["transition"]
    if type(transition) is not int or transition < 1:
        return False
    if record["state"] not in ("active", "paused"):
        return False
    if parse_iso(record["observed_at"]) is None:
        return False
    paused = record["paused_at"]
    if paused is not None and parse_iso(paused) is None:
        return False
    if record["state"] == "active" and paused is not None:
        return False
    pending = record["pending"]
    if pending is not None and (not isinstance(pending, str) or len(pending) > 8192):
        return False
    if type(record["halted"]) is not bool:
        return False
    halt = record["halt_class"]
    if halt is not None and halt not in HALT_CLASSES:
        return False
    if record["halted"] and halt is None:
        return False
    if not record["halted"] and halt is not None:
        return False
    if pending is not None:
        try:
            body = strict_json(pending.encode("utf-8"))
        except (UnicodeError, ValueError, TypeError):
            return False
        if not isinstance(body, dict):
            return False
        obs = body.get("observation")
        if body.get("agent_id") != AGENT_ID or body.get("kind") != "sweep.scheduler_job":
            return False
        if not isinstance(obs, dict) or obs.get("job_id") != job or obs.get("source") != SOURCE:
            return False
        if obs.get("state") != record["state"] or obs.get("transition") != transition:
            return False
        if obs.get("observed_at") != record["observed_at"]:
            return False
    return True


def load_ledger(state_dir):
    ledger_path = state_dir / "ledger.json"
    seal_path = state_dir / "ledger.seal"
    ledger_fd = None
    try:
        ledger_fd = os.open(str(ledger_path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        if exc.errno != errno.ENOENT:
            return "ledger-corrupt"
        seal_exists = seal_path.exists()
        if seal_path.is_symlink():
            return "ledger-corrupt"
        if seal_exists:
            return "ledger-missing"
        return {}
    try:
        raw = os.read(ledger_fd, MAX_LEDGER_BYTES + 1)
    finally:
        os.close(ledger_fd)
    if not raw or len(raw) > MAX_LEDGER_BYTES:
        return "ledger-corrupt"
    try:
        data = strict_json(raw)
    except (UnicodeError, ValueError, RecursionError, TypeError):
        return "ledger-corrupt"
    if not isinstance(data, dict) or set(data) != {"version", "jobs"} or data.get("version") != LEDGER_VERSION:
        return "ledger-corrupt"
    jobs = data.get("jobs")
    if not isinstance(jobs, dict) or set(jobs) - set(JOBS):
        return "ledger-corrupt"
    for job, record in jobs.items():
        if not valid_record(job, record):
            return "ledger-corrupt"
    if seal_path.is_symlink():
        return "ledger-corrupt"
    if not seal_path.exists():
        if not write_bytes(seal_path, SEAL_TEXT.encode("ascii")):
            return "state-unavailable"
    else:
        try:
            if seal_path.read_text(encoding="ascii") != SEAL_TEXT:
                return "ledger-corrupt"
        except (OSError, UnicodeError):
            return "ledger-corrupt"
    return jobs


def write_bytes(path, data):
    if path.is_symlink():
        return False
    tmp = path.with_name("." + path.name + ".%d.tmp" % os.getpid())
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(str(tmp), flags, 0o600)
    except OSError:
        return False
    try:
        view = data
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    except OSError:
        os.close(fd)
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
        return False
    os.close(fd)
    try:
        os.replace(str(tmp), str(path))
    except OSError:
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
        return False
    try:
        dirfd = os.open(str(path.parent), os.O_RDONLY)
    except OSError:
        return True
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)
    return True


def save_ledger(state_dir, jobs):
    payload = dump_json({"version": LEDGER_VERSION, "jobs": jobs}).encode("ascii") + b"\n"
    if not write_bytes(state_dir / "ledger.json", payload):
        return False
    seal = state_dir / "ledger.seal"
    if seal.exists() and not seal.is_symlink():
        return True
    return write_bytes(seal, SEAL_TEXT.encode("ascii"))


def append_summary(state_dir, line):
    path = state_dir / "summaries.log"
    if path.is_symlink():
        return
    previous = ""
    if path.exists():
        try:
            fd = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError:
            return
        try:
            raw = os.read(fd, 64 * 1024)
        finally:
            os.close(fd)
        try:
            previous = raw.decode("utf-8", "replace")
        except UnicodeError:
            previous = ""
    lines = [item for item in previous.splitlines() if item] + [line]
    lines = lines[-MAX_SUMMARY_LINES:]
    write_bytes(path, ("\n".join(lines) + "\n").encode("utf-8"))


def acquire_lock(path):
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(str(path), flags, 0o600)
    except OSError:
        return None
    os.set_inheritable(fd, False)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        os.close(fd)
        if exc.errno in (errno.EAGAIN, errno.EACCES):
            return "busy"
        return None
    return fd


def run_sweep(config, origin, token):
    if config["sweep_once"] is not None:
        script = pathlib.Path(config["sweep_once"])
    else:
        script = pathlib.Path(__file__).resolve().with_name("sweep-once.sh")
    if script.is_symlink() or not script.is_file():
        return "missing"
    kind, _out, _err, code = capture_process(
        [str(script)],
        config["sweep_timeout"],
        MAX_SWEEP_CAPTURE,
        child_env({"MC_URL": origin, "MC_TOKEN": token}),
    )
    if kind == "missing":
        return "missing"
    if kind == "timeout":
        return "timeout"
    if kind == "oversize":
        return "oversize"
    if code == 0:
        return "0"
    if code == 2:
        return "2"
    return "failed"


def fresh_record(job, state, previous):
    observed = now_iso()
    if previous is None:
        transition = 1
        paused_at = None
    elif state == previous["state"]:
        transition = previous["transition"]
        paused_at = previous["paused_at"]
        if parse_iso(observed) <= parse_iso(previous["observed_at"]):
            return "clock-not-advanced"
    else:
        transition = previous["transition"] + 1
        paused_at = observed if state == "paused" else None
    if state == "active":
        paused_at = None
    body = observation_body(job, state, transition, observed, paused_at)
    return {
        "transition": transition,
        "state": state,
        "paused_at": paused_at,
        "observed_at": observed,
        "pending": body,
        "halted": False,
        "halt_class": None,
    }


def result_class(category):
    if category in SUCCESS_OUTCOMES:
        return category
    if category == "lost-response":
        return "lost-response"
    if category in HALT_CLASSES or category in ("clock-not-advanced", "unreadable-domain", "ledger-corrupt", "ledger-missing"):
        return category
    return "fault"


def run_enabled(config):
    state_dir = config["state_dir"]
    if state_dir.is_symlink() or (state_dir.exists() and not state_dir.is_dir()):
        sys.stderr.write("observe-scheduler: state-unavailable\n")
        return 1
    try:
        state_dir.mkdir(mode=0o700, exist_ok=True)
        os.chmod(str(state_dir), 0o700)
    except OSError:
        sys.stderr.write("observe-scheduler: state-unavailable\n")
        return 1
    lock = acquire_lock(state_dir / "observer.flock")
    if lock == "busy":
        sys.stderr.write("observe-scheduler: lock-busy\n")
        return 1
    if lock is None:
        sys.stderr.write("observe-scheduler: state-unavailable\n")
        return 1
    exit_code = 1
    try:
        exit_code = run_locked(config, state_dir)
    finally:
        os.close(lock)
    return exit_code


def run_locked(config, state_dir):
    try:
        origin, token = credential(config)
    except TickError as exc:
        line = "observe-scheduler: %s" % exc.category
        sys.stderr.write(line + "\n")
        append_summary(state_dir, line)
        return 1
    endpoint = origin + INGEST_PATH
    loaded = load_ledger(state_dir)
    summaries = []
    job_fault = False
    if isinstance(loaded, str):
        summaries.append("ledger=" + loaded)
        job_fault = True
    else:
        jobs = loaded
        domain = None
        domain_failed = False
        opener = request_opener()
        for job in JOBS:
            record = jobs.get(job)
            if record is not None and record["halted"]:
                summaries.append("%s=halt:%s:t%d" % (job, record["halt_class"], record["transition"]))
                job_fault = True
                continue
            if record is not None and record["pending"] is not None:
                category = deliver(jobs, job, record, endpoint, token, config, opener, state_dir)
                summaries.append("%s=%s:t%d" % (job, result_class(category), jobs[job]["transition"]))
                if category not in SUCCESS_OUTCOMES:
                    job_fault = True
                continue
            if domain is None and not domain_failed:
                domain = read_launchctl(config["launchctl"], os.getuid(), config["launch_timeout"])
                if domain is None:
                    domain_failed = True
            if domain_failed:
                summaries.append("%s=unreadable-domain" % job)
                job_fault = True
                continue
            built = fresh_record(job, classify(domain, job), record)
            if built == "clock-not-advanced":
                summaries.append("%s=clock-not-advanced:t%d" % (job, record["transition"]))
                job_fault = True
                continue
            proposed = dict(jobs)
            proposed[job] = built
            if not save_ledger(state_dir, proposed):
                summaries.append("%s=state-unavailable" % job)
                job_fault = True
                continue
            jobs[job] = built
            category = deliver(jobs, job, built, endpoint, token, config, opener, state_dir)
            summaries.append("%s=%s:%s:t%d" % (job, jobs[job]["state"], result_class(category), jobs[job]["transition"]))
            if category not in SUCCESS_OUTCOMES:
                job_fault = True
    sweep = run_sweep(config, origin, token)
    return finish(state_dir, summaries, sweep, job_fault)


def deliver(jobs, job, record, endpoint, token, config, opener, state_dir):
    body = record["pending"].encode("utf-8")
    category = post_observation(endpoint, body, token, config["http_timeout"], opener)
    if category in SUCCESS_OUTCOMES:
        jobs[job] = {
            "transition": record["transition"],
            "state": record["state"],
            "paused_at": record["paused_at"],
            "observed_at": record["observed_at"],
            "pending": None,
            "halted": False,
            "halt_class": None,
        }
        if not save_ledger(state_dir, jobs):
            return "state-unavailable"
        return category
    if category == "lost-response":
        jobs[job] = dict(record, halted=False, halt_class=None)
        save_ledger(state_dir, jobs)
        return category
    jobs[job] = dict(record, halted=True, halt_class=category if category in HALT_CLASSES else "unknown-response")
    save_ledger(state_dir, jobs)
    return jobs[job]["halt_class"]


def finish(state_dir, summaries, sweep, job_fault):
    line = "observe-scheduler tick " + " ".join(summaries + ["sweep=" + sweep])
    if len(line) > MAX_SUMMARY_LINE:
        line = line[:MAX_SUMMARY_LINE]
    sys.stderr.write(line + "\n")
    append_summary(state_dir, line)
    if job_fault:
        return 1
    if sweep == "0":
        return 0
    if sweep == "2":
        return 2
    return 1


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "observe-scheduler: invalid arguments\n")


def main(argv):
    parser = SafeArgumentParser(prog="observe-scheduler", add_help=False)
    parser.add_argument("--config", dest="config")
    parser.add_argument("--help", action="store_true")
    args = parser.parse_args(argv)
    if args.help:
        sys.stdout.write(
            "Usage: observe-scheduler.py --config FILE\n"
            "Default config enabled=false does not read a secret, open a socket, or write state.\n"
        )
        return 0
    if not args.config:
        sys.stderr.write("observe-scheduler: invalid arguments\n")
        return 2
    try:
        config = load_config(pathlib.Path(args.config))
    except ConfigError as exc:
        sys.stderr.write("observe-scheduler: %s\n" % exc.category)
        return 2
    if not config["enabled"]:
        sys.stderr.write("observe-scheduler: disabled\n")
        return 0
    return run_enabled(config)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception:
        sys.stderr.write("observe-scheduler: fault\n")
        raise SystemExit(1)
