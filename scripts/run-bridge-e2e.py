#!/usr/bin/env python3
"""Bridge end-to-end proof (#213, epic #62): issue -> task -> lane -> work event -> safe stop.

Runs the real ``dispatch_ready_bridge.run_once`` against a running Agent Kontrol
API backed by a real Postgres, then the real ``agents/dispatcher/mc_dispatcher.py``
as a subprocess with ``MC_BRIDGE_ENABLED=1`` and a fake ``claude`` on PATH. It
changes no runtime code and stubs no route.

Modes:
  (default)                      run the scenarios and write $REPORT_DIR/report.json
  --snapshot LABEL               optional host tooling: five host snapshots, recorded, never fatal
  --record-pid PID PIDFILE       optional host tooling: record a session leader's identity at launch
  --stop-tree PIDFILE            optional host tooling: stop a setsid tree whose launch identity still matches
  --sanitize-file SRC DST        publish a redacted copy of SRC at DST (never the raw bytes)
  --finalize-host                optional host tooling: normalised snapshot diff and cleanup proof

close_ready (owner decision on #213, 2026-11-28: AC4 dropped, CI is the proof) is true
exactly when AC1, AC2 and AC3 pass with every scenario run, no fault injection, BASE_SHA an
ancestor of HEAD, and every cleanup check passing. The CI bridge-e2e-report artifact is the
evidence. The host modes are optional and nothing requires them.

Inputs (environment): MC_URL, MC_TOKEN, DATABASE_URL, RUN_ID, REPORT_DIR, and
optionally BASE_SHA and BRIDGE_E2E_SCENARIOS (a comma list, for local debugging;
any subset leaves close_ready false).


Safety:
  * MC_URL and DATABASE_URL must resolve only to 127.0.0.1 or ::1; DATABASE_URL may
    carry only the disposable ``postgres:<password>`` userinfo. Redirects are not followed.
  * The dispatcher gets an explicit environment and HOME inside the scenario root,
    so it never reads ~/.claude/mission-control.env or any other operator file.
  * Every string written as evidence goes through the redactor first (L11).
  * No process is signalled after it was reaped. The runner signals only the
    dispatcher it started (SIGTERM) and its own sentinel's process group.
Stdlib only; Python 3.9 compatible.
"""
from __future__ import annotations

import copy
import datetime as _dt
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
import pwd
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parent.parent
DISPATCHER_DIR = REPO / "agents" / "dispatcher"
sys.path.insert(0, str(DISPATCHER_DIR))

import dispatch_ready_bridge as drb  # noqa: E402  (the real module under test, K13)

# The dependency head from the refreshed overlap receipt on #213 (2026-11-28T18:10Z):
# main after #212 (PR #215) merged. M3's literal 35287c5 is the pre-squash #215 head,
# which is not an ancestor of main; the receipt is the definition M3 names.
BASE_SHA_DEFAULT = "2fc1fde966ba4e2619df7a7b22cfa6d756c6669e"
RUN_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
WAIT_SECONDS = 60.0
POLL_SECONDS = 1
REPO_NAME = "mrhinkle/agent-kontrol"
PROJECT = "bridge-62"
PLATFORM = "claude-code"
FIXTURE_DIR = REPO / "tests" / "fixtures" / "bridge-62"
QUERY_HELPER = REPO / "scripts" / "bridge-e2e-query.mjs"
LIST_FIELDS = "id,title,description,project,platform,machine,priority,reviewer_platform,created_by,status"
LIST_LIMIT = 200
ALL_SCENARIOS = ("normal", "safe_stop", "competing", "no_child_stop", "lost_reply", "two_in_sequence", "bad_input")
EXPECTED_EXIT = {"normal": 0, "safe_stop": 3, "competing": 0, "no_child_stop": 0, "two_in_sequence": 0}
SNAPSHOT_COMMANDS = (
    ("ss", ["ss", "-lntup"]),
    ("docker_ps", ["docker", "ps", "--no-trunc"]),
    ("ps", ["ps", "-eo", "pid,ppid,pgid,user,stat,args"]),
    ("crontab", ["crontab", "-l"]),
    ("systemctl_user", ["systemctl", "--user", "list-units", "--all", "--no-legend"]),
)
# Fault injections for the mutation table (BRIDGE_E2E_MUTATION). Each one makes the system under
# test misbehave in one way the runner claims to catch; the run must then fail. Unset in CI.
# close_ready_forced injects the extra work event AND makes the decision function claim
# close_ready; the independent consistency guard must turn the run red.
MUTATIONS = ("close_ready_forced", "dispatcher_spawn_fail", "escape_then_fail", "dispatcher_ignores_sigterm",
             "extra_work_event", "demo_true", "claim_unfiltered", "mc_token_present", "escaped_grandchild",
             "second_post", "extra_bridge_task")
MUTATION: str | None = None
HOP_BY_HOP = {"connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate",
              "te", "trailer", "transfer-encoding", "upgrade", "host"}


def machine_identity() -> str:
    """The dispatcher's own algorithm (L3), never the HOSTNAME bind setting."""
    return socket.gethostname().split(".")[0].lower()


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Failure(Exception):
    """A hard failure: an assertion, a timeout, or an unsafe input. Never normalised to a pass."""

    def __init__(self, code: str, **detail) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


class Interrupted(BaseException):
    """SIGTERM/SIGINT to the runner: unwind through every finally, then exit nonzero."""


# ---------------------------------------------------------------------------
# Redaction (L11)

_URL_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]{1,15}://[^\s\"'<>)]+")
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[^\s\"',]+")
_KV_RE = re.compile(r"(?i)\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*=\s*|:\s+)(\"[^\"]*\"|'[^']*'|[^\s\"',;]+)")
_KEYLIKE_RE = re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|sk-ant|xai|akc|akp|glpat|xox[abpr]|AKIA)[-_A-Za-z0-9]{12,}")
_LONG_RE = re.compile(r"[A-Za-z0-9_\-+=]{32,}")
_HEX_RE = re.compile(r"(?:drb1-)?[0-9a-f]{40}(?:[0-9a-f]{24})?")


class Redactor:
    def __init__(self) -> None:
        self.exact: list[tuple[str, str]] = []

    def add(self, value: str | None, label: str) -> None:
        if value and len(value) >= 4:
            self.exact.append((value, f"<{label}>"))
            self.exact.sort(key=lambda item: -len(item[0]))

    def text(self, value: str) -> str:
        for secret, label in self.exact:
            value = value.replace(secret, label)
        value = _URL_RE.sub("<url-redacted>", value)
        value = _BEARER_RE.sub("Bearer <redacted>", value)
        value = _KV_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}<redacted>", value)
        value = _KEYLIKE_RE.sub("<key-redacted>", value)

        def long(m: re.Match) -> str:
            s = m.group(0)
            if _HEX_RE.fullmatch(s):
                return s  # commit SHAs and derived idempotency digests are not secrets
            if any(c.isdigit() for c in s) and any(c.isupper() for c in s) and any(c.islower() for c in s):
                return "<redacted>"  # base64-shaped: mixed case and digits
            return s

        return _LONG_RE.sub(long, value)

    def walk(self, value):
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {self.text(str(k)): self.walk(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.walk(v) for v in value]
        return value


REDACT = Redactor()


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(REDACT.walk(payload), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(REDACT.text(text), encoding="utf-8")


def publish_log(raw: Path, dst: Path) -> dict:
    """Publish a sanitized copy of a raw log that lives outside REPORT_DIR. The raw bytes are never copied.

    If the raw log cannot be read or the sanitized copy cannot be written, a note says so and no log is published.
    """
    try:
        text = raw.read_text(encoding="utf-8", errors="replace")
        write_text(dst, text)
        return {"published": True, "path": dst.name}
    except OSError as e:
        try:
            if dst.exists():
                dst.unlink()
            write_text(dst.with_name(dst.name + ".unavailable.txt"),
                       f"sanitized log not published: {type(e).__name__}\n")
        except OSError:
            pass
        return {"published": False, "error": type(e).__name__}


def work_event_violations(rows: list, expected: int) -> list[str]:
    """Rows matched by the work-event signature (numeric task_id and exact title), with no principal filter.

    The count must be exact, and every matching row must carry the server-populated legacy principal,
    so an extra unauthenticated event with the same signature fails the run.
    """
    problems = []
    if len(rows) != expected:
        problems.append(f"count {len(rows)} != {expected}")
    for row in rows:
        if row.get("principal_kind") != "legacy" or row.get("principal_id") != "mc-token":
            problems.append(f"event {row.get('id')} principal {row.get('principal_kind')}/{row.get('principal_id')}")
    return problems


# ---------------------------------------------------------------------------
# Endpoint validation (loopback only)

_LOOPBACK = {ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")}


def resolve_loopback(host: str, port: int, what: str) -> list[str]:
    if not host:
        raise Failure("endpoint_not_loopback", endpoint=what, reason="no host")
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError:
        raise Failure("endpoint_not_loopback", endpoint=what, reason="does not resolve") from None
    addrs = sorted({info[4][0].split("%")[0] for info in infos})
    if not addrs or any(ipaddress.ip_address(a) not in _LOOPBACK for a in addrs):
        raise Failure("endpoint_not_loopback", endpoint=what, reason="resolves outside 127.0.0.1/::1")
    return addrs


def check_mc_url(raw: str) -> urllib.parse.SplitResult:
    url = urllib.parse.urlsplit(raw)
    if url.scheme != "http" or url.username is not None or url.password is not None or "@" in url.netloc:
        raise Failure("endpoint_not_loopback", endpoint="MC_URL", reason="must be http:// with no userinfo")
    if url.path not in ("", "/") or url.query or url.fragment or url.port is None:
        raise Failure("endpoint_not_loopback", endpoint="MC_URL", reason="must be a bare origin with a port")
    resolve_loopback(url.hostname or "", url.port, "MC_URL")
    return url


def check_database_url(raw: str) -> urllib.parse.SplitResult:
    url = urllib.parse.urlsplit(raw)
    if url.scheme not in ("postgres", "postgresql"):
        raise Failure("endpoint_not_loopback", endpoint="DATABASE_URL", reason="not a postgres URL")
    if url.username != "postgres" or not url.password or url.netloc.count("@") != 1:
        raise Failure("endpoint_not_loopback", endpoint="DATABASE_URL", reason="only the disposable postgres:<pw> userinfo is allowed")
    if url.query or url.fragment or url.port is None:
        raise Failure("endpoint_not_loopback", endpoint="DATABASE_URL", reason="no query string; explicit port required")
    resolve_loopback(url.hostname or "", url.port, "DATABASE_URL")
    return url


def non_loopback_address() -> str | None:
    """This host's primary non-loopback address, or None. A UDP connect sends no packet."""
    for target in (("192.0.2.1", 9), ("2001:db8::1", 9)):
        family = socket.AF_INET6 if ":" in target[0] else socket.AF_INET
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect(target)
                addr = s.getsockname()[0]
        except OSError:
            continue
        if ipaddress.ip_address(addr.split("%")[0]) not in _LOOPBACK and not ipaddress.ip_address(addr.split("%")[0]).is_loopback:
            return addr
    return None


def check_not_exposed(port: int) -> dict:
    """The API must not answer on a non-loopback address of this host (bind check)."""
    addr = non_loopback_address()
    if addr is None:
        raise Failure("bind_check_unavailable")  # a guard that cannot run fails
    family = socket.AF_INET6 if ":" in addr else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.settimeout(3)
        rc = s.connect_ex((addr, port))
    if rc == 0:
        raise Failure("api_exposed_off_loopback", port=port)
    return {"checked": True, "reachable_off_loopback": False, "errno": rc}


# ---------------------------------------------------------------------------
# HTTP (http.client: no redirect is ever followed)


def http_send(base: urllib.parse.SplitResult, method: str, path: str, headers: dict, body: bytes | None,
              timeout: float = 30.0) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection(base.hostname, base.port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def has_demo_true(value) -> bool:
    if isinstance(value, dict):
        return value.get("demo") is True or any(has_demo_true(v) for v in value.values())
    if isinstance(value, list):
        return any(has_demo_true(v) for v in value)
    return False


class Api:
    """Runner control calls against the origin API (M5). Any demo:true reply is a hard failure."""

    def __init__(self, base: urllib.parse.SplitResult, token: str) -> None:
        self.base = base
        self.token = token
        self.calls: list[dict] = []

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        raw = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        status, data = http_send(self.base, method, path, headers, raw)
        try:
            payload = json.loads(data.decode("utf-8") or "{}")
        except ValueError:
            payload = None
        self.calls.append({"method": method, "path": path.split("?")[0], "status": status})
        if has_demo_true(payload):
            raise Failure("demo_response", method=method, path=path.split("?")[0])
        if not 200 <= status < 300 or not isinstance(payload, dict):
            raise Failure("api_error", method=method, path=path.split("?")[0], status=status)
        return payload


class TaskTransport:
    """The run_once task transport (F6, K9, L6).

    create_task: POST /api/tasks with Authorization, Content-Type and the derived
    Idempotency-Key. list_tasks: GET /api/tasks with status=all, limit=200, the
    allowlisted fields, and a URL-encoded cursor; the page must be
    {tasks: [...], next_cursor: ...} and never demo:true. ``send`` is injectable
    for the deterministic unit test.
    """

    def __init__(self, base: urllib.parse.SplitResult, token: str, send=None) -> None:
        self.base = base
        self.token = token
        self.send = send or (lambda method, path, headers, body: http_send(self.base, method, path, headers, body))
        self.posts = 0
        self.lists = 0
        self.lost = 0
        self.demo_seen = False
        self.requests: list[dict] = []

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}

    def create_task(self, body, idempotency_key):
        headers = self._headers()
        headers["Idempotency-Key"] = idempotency_key
        raw = json.dumps(body).encode("utf-8")
        self.posts += 1
        self.requests.append({"method": "POST", "path": "/api/tasks", "idempotency_key": idempotency_key})
        try:
            status, data = self.send("POST", "/api/tasks", headers, raw)
        except (http.client.RemoteDisconnected, http.client.IncompleteRead, http.client.BadStatusLine,
                ConnectionResetError, BrokenPipeError):
            self.lost += 1
            raise drb.LostTaskReply() from None
        try:
            payload = json.loads(data.decode("utf-8"))
        except ValueError:
            payload = None
        if has_demo_true(payload):
            self.demo_seen = True
        if not 200 <= status < 300:
            raise drb.TaskHttpError(status, payload if isinstance(payload, dict) else None)
        return payload

    def list_path(self, query) -> str:
        if query.get("status") != "all" or query.get("limit") != LIST_LIMIT or query.get("fields") != LIST_FIELDS:
            raise ValueError("unexpected list query")
        path = f"/api/tasks?status=all&limit={LIST_LIMIT}&fields={LIST_FIELDS}"
        cursor = query.get("cursor")
        if cursor is not None:
            path += "&cursor=" + urllib.parse.quote(str(cursor), safe="")
        return path

    def list_tasks(self, query):
        path = self.list_path(query)
        self.lists += 1
        self.requests.append({"method": "GET", "path": "/api/tasks", "cursor": query.get("cursor") is not None})
        status, data = self.send("GET", path, {"Authorization": f"Bearer {self.token}"}, None)
        payload = json.loads(data.decode("utf-8"))
        if has_demo_true(payload):
            self.demo_seen = True
            raise ValueError("demo listing")
        if status != 200 or not isinstance(payload, dict) or not isinstance(payload.get("tasks"), list) \
                or "next_cursor" not in payload:
            raise ValueError("malformed listing")
        return payload


class IssueTransport:
    """read_issues(repo) returns the fixture unchanged; ``sequence`` gives one snapshot per read."""

    def __init__(self, snapshot=None, sequence=None) -> None:
        self.sequence = list(sequence) if sequence is not None else None
        self.snapshot = snapshot
        self.reads: list[str] = []

    def read_issues(self, repo):
        self.reads.append(repo)
        if repo != REPO_NAME:
            return {"complete": False, "issues": []}
        if self.sequence is not None:
            index = min(len(self.reads) - 1, len(self.sequence) - 1)
            return copy.deepcopy(self.sequence[index])
        return copy.deepcopy(self.snapshot)


# ---------------------------------------------------------------------------
# Loopback recorder proxy (L4, M5) and the lost-reply proxy (K2)


class RecorderProxy:
    """Forwards method, path, query, body and application headers unchanged; drops Host and hop-by-hop headers.

    mode "record": every response is relayed. mode "drop_create": the first
    POST /api/tasks is forwarded, its upstream response is read in full and
    recorded, and the client connection is closed without any response.
    """

    def __init__(self, origin: urllib.parse.SplitResult, token: str, mode: str = "record") -> None:
        self.origin = origin
        self.expected_auth = f"Bearer {token}"
        self.mode = mode
        self.records: list[dict] = []
        self.lock = threading.Lock()
        self.dropped = 0
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _forward(self):
                proxy._forward(self)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _forward

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=10)

    def _forward(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        body = handler.rfile.read(length) if length else b""
        headers = [(k, v) for k, v in handler.headers.items() if k.lower() not in HOP_BY_HOP]
        auth = handler.headers.get("Authorization")
        record = {
            "t": utc_now(), "method": handler.command, "path": handler.path.split("?")[0],
            "query": handler.path.partition("?")[2], "header_names": sorted(k.lower() for k, _ in headers),
            "authorization": "preserved" if auth == self.expected_auth else ("missing" if auth is None else "altered"),
            "body_sha256": hashlib.sha256(body).hexdigest(), "body_bytes": len(body),
        }
        try:
            record["body"] = json.loads(body.decode("utf-8")) if body else None
        except ValueError:
            record["body"] = "<non-json>"
        if MUTATION == "claim_unfiltered" and record["path"] == "/api/tasks/claim" and isinstance(record["body"], dict):
            body = json.dumps({k: v for k, v in record["body"].items() if k not in ("task_id", "project")}).encode()
            headers = [(k, str(len(body)) if k.lower() == "content-length" else v) for k, v in headers]
        conn = http.client.HTTPConnection(self.origin.hostname, self.origin.port, timeout=40)
        try:
            conn.putrequest(handler.command, handler.path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", self.origin.netloc)
            for k, v in headers:
                conn.putheader(k, v)
            conn.endheaders(body if body else None)
            resp = conn.getresponse()
            data = resp.read()
            status, reason, resp_headers = resp.status, resp.reason, resp.getheaders()
        except Exception as e:  # recorded; the client sees a 502
            record["upstream_error"] = type(e).__name__
            with self.lock:
                self.records.append(record)
            handler.send_error(502)
            return
        finally:
            conn.close()
        record["upstream_status"] = status
        try:
            payload = json.loads(data.decode("utf-8"))
            if (MUTATION == "demo_true" and record["path"] == "/api/ingest" and isinstance(record["body"], dict)
                    and record["body"].get("kind") == "heartbeat" and isinstance(payload, dict)):
                payload["demo"] = True
                data = json.dumps(payload).encode()
            record["demo_true"] = has_demo_true(payload)
        except ValueError:
            payload = None
            record["demo_true"] = False
        drop = (self.mode == "drop_create" and handler.command == "POST" and record["path"] == "/api/tasks"
                and self.dropped == 0)
        record["dropped_response"] = drop
        if drop and isinstance(payload, dict) and isinstance(payload.get("task"), dict):
            record["upstream_task_id"] = str(payload["task"].get("id"))
        with self.lock:
            if drop:
                self.dropped += 1
            self.records.append(record)
        if drop:
            handler.close_connection = True
            return  # the committed create's response never reaches the client
        handler.send_response(status, reason)
        for k, v in resp_headers:
            if k.lower() not in HOP_BY_HOP and k.lower() != "content-length":
                handler.send_header(k, v)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.wfile.write(data)

    def snapshot(self) -> list[dict]:
        with self.lock:
            return copy.deepcopy(self.records)


# ---------------------------------------------------------------------------
# Query helper (L5): one JSON request per invocation


class Db:
    def __init__(self, database_url: str) -> None:
        self.env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "DATABASE_URL": database_url,
                    "HOME": os.environ.get("HOME", "/tmp")}
        self.log: list[dict] = []

    def query(self, name: str, parameters: list) -> list[dict]:
        request = json.dumps({"query": name, "parameters": [str(p) for p in parameters]})
        try:
            out = subprocess.run(["node", str(QUERY_HELPER)], input=request, capture_output=True, text=True,
                                 timeout=WAIT_SECONDS, cwd=str(REPO), env=self.env)
        except subprocess.TimeoutExpired:
            raise Failure("query_timeout", query=name) from None
        try:
            reply = json.loads(out.stdout)
        except ValueError:
            reply = {"ok": False, "error": "unparseable_helper_output"}
        entry = {"query": name, "parameters": [str(p) for p in parameters], "exit_code": out.returncode,
                 "ok": reply.get("ok") is True, "sql": reply.get("sql"), "row_count": reply.get("row_count"),
                 "rows": reply.get("rows"), "error": reply.get("error")}
        self.log.append(entry)
        if reply.get("ok") is not True or out.returncode != 0 or not isinstance(reply.get("rows"), list):
            raise Failure("query_failed", query=name, error=reply.get("error"))
        return reply["rows"]


# ---------------------------------------------------------------------------
# Processes (K7, L9): /proc on Linux, ps elsewhere


def process_table() -> dict[int, dict]:
    table: dict[int, dict] = {}
    if Path("/proc/self/stat").exists():
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat", "rb") as f:
                    raw = f.read().decode("ascii", "replace")
            except OSError:
                continue  # exited between listdir and read: it is gone either way
            fields = raw[raw.rindex(")") + 2:].split()
            table[int(entry)] = {"ppid": int(fields[1]), "pgid": int(fields[2]), "state": fields[0],
                                 "start": fields[19]}
        return table
    out = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], capture_output=True, text=True,
                         timeout=10, env={"PATH": "/bin:/usr/bin", "LC_ALL": "C"})
    if out.returncode != 0:
        raise Failure("process_table_unavailable")
    for line in out.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5:
            table[int(parts[0])] = {"ppid": int(parts[1]), "pgid": int(parts[2]), "state": parts[3],
                                    "start": parts[4].strip()}
    return table


def descendants(table: dict[int, dict], root: int) -> list[int]:
    found: set[int] = set()
    frontier = [root]
    while frontier:
        parent = frontier.pop()
        for pid, row in table.items():
            if row["ppid"] == parent and pid not in found and pid != root:
                found.add(pid)
                frontier.append(pid)
    return sorted(found)


def start_identity(pid: int) -> str | None:
    row = process_table().get(pid)
    return None if row is None else row["start"]


def gone_check(pids: dict[int, str | None], pgids: list[int]) -> dict:
    """Every recorded pid absent (ProcessLookupError) and every recorded group empty. Reuse is a failure."""
    table = process_table()
    result = {"survivors": [], "reused": [], "group_members": {}, "checked_pids": sorted(pids)}
    for pid, start in sorted(pids.items()):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            pass
        row = table.get(pid)
        if row is not None and start is not None and row["start"] != start:
            result["reused"].append(pid)
        else:
            result["survivors"].append(pid)
    for pgid in pgids:
        members = sorted(p for p, row in table.items() if row["pgid"] == pgid)
        if members:
            result["group_members"][str(pgid)] = members
    result["ok"] = not result["survivors"] and not result["reused"] and not result["group_members"]
    return result


def wait_for(predicate, what: str, timeout: float = WAIT_SECONDS, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise Failure("timeout", waiting_for=what, seconds=timeout)
        time.sleep(interval)


def flock_free(path: Path) -> bool | None:
    """True when an exclusive non-blocking flock can be taken (and is released at once); None if absent."""
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    finally:
        os.close(fd)


# ---------------------------------------------------------------------------
# Scenario workspace (L2) and the fake CLI (L8)

FAKE_CLAUDE = r'''#!{python} -I
import json, os, sys, time
MARKER = {marker!r}
GO_DIR = {go_dir!r}
MODE = {mode!r}
FORCE_TOKEN = {force_token!r}
ESCAPE = {escape!r}
args = sys.argv[1:]
if ESCAPE:
    import subprocess
    subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(25)"], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
argv_ok = (len(args) == 6 and args[0] == "-p" and isinstance(args[1], str) and args[1] != ""
           and args[2:] == ["--output-format", "json", "--permission-mode", "acceptEdits"])
record = {{"pid": os.getpid(), "pgid": os.getpgrp(), "ppid": os.getppid(),
          "mc_token_present": "MC_TOKEN" in os.environ or FORCE_TOKEN, "argv_ok": argv_ok, "mode": MODE}}
tmp = MARKER + ".tmp." + str(os.getpid())
with open(tmp, "w") as f:
    json.dump(record, f)
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, MARKER)
if not argv_ok:
    sys.stderr.write("fake claude: unexpected argv\n")
    sys.exit(2)
deadline = time.monotonic() + 180
if MODE == "normal":
    go = os.path.join(GO_DIR, "go-" + str(os.getpid()))
    while not os.path.exists(go):
        if time.monotonic() > deadline:
            sys.exit(4)
        time.sleep(0.05)
    sys.stdout.write(json.dumps({{"type": "result", "result": "bridge-62 completed", "is_error": False}}))
    sys.stdout.flush()
    sys.exit(0)
while time.monotonic() < deadline:
    time.sleep(0.5)
sys.exit(5)
'''


def git(cwd: Path, *args: str, env: dict) -> str:
    out = subprocess.run(["git", "-c", "user.name=bridge-62", "-c", "user.email=bridge-62@invalid",
                          "-c", "commit.gpgsign=false", *args], cwd=str(cwd), env=env, capture_output=True,
                         text=True, timeout=WAIT_SECONDS)
    if out.returncode != 0:
        raise Failure("git_failed", args=list(args), stderr=out.stderr[-500:])
    return out.stdout.strip()


class Workspace:
    def __init__(self, run_root: Path, run_id: str, scenario: str, scenario_dir: Path) -> None:
        self.slug = scenario.replace("_", "-")
        self.root = Path(tempfile.mkdtemp(prefix=f"{self.slug}-", dir=str(run_root))).resolve()
        self.main = self.root / "main"
        self.worktree = self.root / PROJECT
        self.ledger = self.root / "ledger"
        self.stop_file = self.root / "stop"
        self.home = self.root / "home"
        self.bin = self.root / "bin"
        self.go_dir = self.root / "go"
        self.config_path = self.root / "bridge-config.json"
        self.marker = scenario_dir / "started.json"
        self.authority = f"bridge-62-{run_id}-{self.slug}"
        self.git_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.home),
                        "GIT_CONFIG_NOSYSTEM": "1", "LC_ALL": "C"}

    def create(self, mode: str) -> None:
        # A marker left by an earlier run in the same REPORT_DIR must never be read as this child's.
        for stale in [self.marker, *self.marker.parent.glob("started*.json")]:
            if stale.exists():
                stale.unlink()
        for d in (self.home, self.bin, self.go_dir, self.main):
            d.mkdir(mode=0o700)
        git(self.main, "init", "-q", "-b", "main", env=self.git_env)
        (self.main / "README.md").write_text("bridge-62 throwaway repository\n")
        git(self.main, "add", "README.md", env=self.git_env)
        git(self.main, "commit", "-q", "-m", "bridge-62 throwaway", env=self.git_env)
        git(self.main, "worktree", "add", "-q", "-b", f"lane-{self.slug}", str(self.worktree), env=self.git_env)
        self.write_fake(mode)

    def write_fake(self, mode: str) -> None:
        fake = self.bin / "claude"
        fake.write_text(FAKE_CLAUDE.format(python=sys.executable, marker=str(self.marker),
                                           go_dir=str(self.go_dir), mode=mode,
                                           force_token=MUTATION == "mc_token_present",
                                           escape=MUTATION in ("escaped_grandchild", "escape_then_fail")))
        fake.chmod(0o700)

    def config(self, machine: str) -> dict:
        return {
            "enabled": True,
            "authority": self.authority,
            "actor_id": self.authority,
            "ledger_dir": str(self.ledger),
            "workdir": str(self.root),
            "stop_file": str(self.stop_file),
            "repos": [{"repo": REPO_NAME, "project": PROJECT, "platform": PLATFORM, "machine": machine,
                       "ready_labels": ["dispatch-ready"], "blocked_labels": []}],
        }

    def worktree_lock(self) -> Path:
        return self.main / ".git" / "worktrees" / PROJECT / "ak-dispatch.lock"

    def destroy(self) -> dict:
        shutil.rmtree(self.root, ignore_errors=True)
        return {"root_removed": not self.root.exists()}


# ---------------------------------------------------------------------------
# The dispatcher subprocess


_IGNORE_SIGTERM_WRAPPER = (
    "import signal, subprocess, sys; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    "sys.exit(subprocess.call(sys.argv[1:]))"
)


class Dispatcher:
    def __init__(self, ws: Workspace, proxy_url: str, token: str, publish_path: Path) -> None:
        self.ws = ws
        # Raw output stays in the scenario root, outside REPORT_DIR (the public artifact).
        self.log_path = ws.root / "dispatcher.raw.log"
        self.publish_path = publish_path
        self.env = {
            "PATH": f"{ws.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(ws.home),
            "LANG": "C.UTF-8",
            "TMPDIR": str(ws.root),
            "PYTHONDONTWRITEBYTECODE": "1",
            "MC_URL": proxy_url,
            "MC_TOKEN": token,
            "MC_BRIDGE_ENABLED": "1",
            "MC_BRIDGE_CONFIG": str(ws.config_path),
            "MC_WORKDIR": str(ws.root),
            "MC_MAX_CONCURRENT": "1",
            "MC_PLATFORMS": PLATFORM,
            "MC_POLL_SECONDS": str(POLL_SECONDS),
            "MC_TASK_TIMEOUT": "300",
        }
        self.proc: subprocess.Popen | None = None
        self.start: str | None = None
        self.exit_code: int | None = None
        self.started_at: str | None = None
        self.sigterm_at: str | None = None

    def launch(self) -> None:
        argv = [sys.executable, str(DISPATCHER_DIR / "mc_dispatcher.py")]
        if MUTATION == "dispatcher_spawn_fail":
            argv[0] = "/nonexistent/bridge-62/python3"
        elif MUTATION == "dispatcher_ignores_sigterm":
            argv = [sys.executable, "-I", "-c", _IGNORE_SIGTERM_WRAPPER, *argv]
        log = open(self.log_path, "wb")
        try:
            self.proc = subprocess.Popen(argv, cwd=str(REPO), env=self.env, stdin=subprocess.DEVNULL, stdout=log,
                                         stderr=log, start_new_session=True)
        except OSError as e:
            raise Failure("dispatcher_launch_failed", error=type(e).__name__) from None
        finally:
            log.close()
        self.started_at = utc_now()
        self.start = wait_for(lambda: start_identity(self.proc.pid), "dispatcher start identity", 10)

    @property
    def pid(self) -> int | None:
        return self.proc.pid if self.proc is not None else None

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def terminate(self) -> int:
        """SIGTERM only while unreaped (no pid reuse), then a bounded wait. Never SIGKILL (no remediation)."""
        if self.proc is None:
            return None
        if self.proc.poll() is None:
            self.sigterm_at = utc_now()
            self.proc.send_signal(signal.SIGTERM)
        try:
            self.exit_code = self.proc.wait(timeout=WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            raise Failure("dispatcher_did_not_exit", seconds=WAIT_SECONDS) from None
        return self.exit_code

    def evidence(self) -> dict:
        return {"pid": self.pid, "start_identity": self.start, "started_at": self.started_at,
                "sigterm_at": self.sigterm_at, "exit_code": self.exit_code,
                "env_names": sorted(self.env), "argv": ["python3", "agents/dispatcher/mc_dispatcher.py"]}


class Sentinel:
    """A process outside the dispatcher's tree, same uid, its own session (K8)."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(600)"],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
        self.pid = self.proc.pid
        self.pgid = self.pid
        try:
            self.start = wait_for(lambda: start_identity(self.pid), "sentinel start identity", 10)
        except BaseException:
            # Not yet registered with the run: reap our own sentinel before giving up.
            if self.proc.poll() is None:
                os.killpg(self.pgid, signal.SIGKILL)
            self.proc.wait(timeout=10)
            raise

    def alive_unchanged(self) -> bool:
        return self.proc.poll() is None and start_identity(self.pid) == self.start

    def cleanup(self) -> dict:
        """M2: terminate and reap the sentinel's own group, then prove pid and pgid gone."""
        if self.proc.poll() is None:
            os.killpg(self.pgid, signal.SIGTERM)  # the leader is unreaped, so the group id is ours
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            return {"ok": False, "reason": "sentinel did not exit"}
        result = gone_check({self.pid: self.start}, [self.pgid])
        return {"ok": result["ok"], "check": result}


# ---------------------------------------------------------------------------
# One run


class Run:
    def __init__(self, env: dict) -> None:
        self.env = env
        self.report_dir = Path(env["REPORT_DIR"]).resolve()
        self.run_id = env["RUN_ID"]
        self.token = env["MC_TOKEN"]
        self.origin = check_mc_url(env["MC_URL"])
        self.db_url = check_database_url(env["DATABASE_URL"])
        self.api = Api(self.origin, self.token)
        self.db = Db(env["DATABASE_URL"])
        self.machine = machine_identity()
        self.fixture_one = json.loads((FIXTURE_DIR / "issue.json").read_text())
        self.fixture_two = json.loads((FIXTURE_DIR / "two-issues.json").read_text())
        self.run_root = Path(tempfile.mkdtemp(prefix=f"bridge-62-{self.run_id}-")).resolve()
        self.sentinels: list[Sentinel] = []
        self.markers: list[dict] = []  # every fake-CLI marker read in the current scenario
        self.incident: dict | None = None  # a run-owned process survived teardown: stop, keep evidence
        self.dispatchers: list[Dispatcher] = []
        self.workspaces: list[Workspace] = []
        self.proxies: list[RecorderProxy] = []

    # -- shared steps ---------------------------------------------------------

    def scenario_dir(self, name: str) -> Path:
        d = self.report_dir / "scenarios" / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def bind(self, ctx: dict, result: dict, ws: Workspace, snapshot: dict, node: str) -> dict:
        """K3: record (authority, issue_node_id, task_id, task_title) when the handoff binds."""
        task_id = result.get("task_id")
        title = next(i["title"] for i in snapshot["issues"] if i["node_id"] == node)
        if result.get("outcome") not in ("handed_off", "reconciled") or type(task_id) is not int:
            raise Failure("handoff_not_bound", result=result)
        if result.get("issue_node_id") != node:
            raise Failure("handoff_wrong_issue", result=result, expected=node)
        bound = {"authority": ws.authority, "issue_node_id": node, "task_id": task_id, "task_title": title}
        ctx.setdefault("bound", []).append(bound)
        return bound

    def bridge_tasks(self, authority: str, node: str) -> list[dict]:
        """Every bridge task on the lane whose v2 description names this authority and node. Title not filtered."""
        rows = self.db.query("task", [drb.CREATED_BY, PROJECT])
        mine = []
        for row in rows:
            decoded = drb.decode_issue_content(row["description"] or "")
            if decoded and decoded.get("authority") == authority and decoded.get("issue_node_id") == node:
                mine.append({**row, "decoded": decoded})
        return mine

    def assert_task(self, ctx: dict, bound: dict, issue: dict, status: str) -> None:
        """L7 plus K14: the exact bound task, its create_task event and its idempotency row."""
        mine = self.bridge_tasks(bound["authority"], bound["issue_node_id"])
        check(ctx, "exactly_one_bridge_task", len(mine) == 1, count=len(mine))
        task = mine[0]
        d = task["decoded"]
        expect = {
            "id": str(bound["task_id"]), "title": bound["task_title"], "project": PROJECT, "platform": PLATFORM,
            "machine": self.machine, "priority": 2, "created_by": drb.CREATED_BY, "reviewer_platform": None,
            "status": status,
        }
        got = {k: task[k] for k in expect}
        check(ctx, "task_fields_exact", got == expect, expected=expect, got=got)
        frozen = {"authority": bound["authority"], "issue_node_id": bound["issue_node_id"],
                  "issue_number": issue["number"], "repository": REPO_NAME, "title": issue["title"],
                  "body": issue["body"], "url": issue["url"]}
        check(ctx, "description_v2_fields_exact", all(d.get(k) == v for k, v in frozen.items()),
              decoded={k: d.get(k) for k in frozen})
        events = self.db.query("create_event", [str(bound["task_id"])])
        check(ctx, "exactly_one_create_task_event",
              len(events) == 1 and events[0]["title"] == f"Task #{bound['task_id']} queued",
              count=len(events))
        key = drb._idempotency_key(bound["authority"], bound["issue_node_id"])
        idem = self.db.query("idempotency", [key])
        check(ctx, "exactly_one_idempotency_row",
              len(idem) == 1 and idem[0]["completed"] is True and idem[0]["task_id"] == str(bound["task_id"]),
              count=len(idem), rows=idem)

    def work_events(self, bound: dict) -> list[dict]:
        """Rows with the work-event signature, whatever their principal."""
        return self.db.query("work_event", [str(bound["task_id"]), bound["task_title"]])

    def assert_work_events(self, ctx: dict, name: str, bound: dict, expected: int) -> list[dict]:
        rows = self.work_events(bound)
        problems = work_event_violations(rows, expected)
        check(ctx, name, not problems, problems=problems, rows=rows)
        return rows

    def task_status(self, task_id: int) -> str:
        rows = self.db.query("status", [str(task_id)])
        if len(rows) != 1:
            raise Failure("status_row_count", task_id=task_id, count=len(rows))
        return rows[0]["status"]

    def wait_status(self, task_id: int, status: str) -> None:
        wait_for(lambda: self.task_status(task_id) == status, f"task {task_id} status {status}", interval=0.5)

    def read_marker(self, ws: Workspace) -> dict:
        def load():
            try:
                data = json.loads(ws.marker.read_text())
            except (OSError, ValueError):
                return None
            return data

        data = wait_for(load, "fake CLI started.json")
        ok = (isinstance(data, dict) and type(data.get("pid")) is int and type(data.get("pgid")) is int
              and data.get("mc_token_present") is False and data.get("argv_ok") is True)
        if isinstance(data, dict) and type(data.get("pid")) is int and type(data.get("pgid")) is int:
            self.markers.append(data)  # cleanup checks it even when the marker is rejected
        if not ok:
            raise Failure("bad_started_marker", marker=data)
        return data

    def tree_evidence(self, ctx: dict, disp: Dispatcher, marker: dict, label: str) -> dict:
        """K7, L9: the CLI pid is in the dispatcher's transitive /proc descendant set; its group holds it."""
        table = process_table()
        if table.get(disp.pid, {}).get("start") != disp.start:
            raise Failure("dispatcher_identity_changed", label=label)
        desc = descendants(table, disp.pid)
        cli = marker["pid"]
        group = sorted(p for p, row in table.items() if row["pgid"] == marker["pgid"])
        snap = {"label": label, "t": utc_now(), "dispatcher_pid": disp.pid, "descendants": desc,
                "descendant_starts": {str(p): table[p]["start"] for p in desc}, "cli_pid": cli,
                "cli_pgid": marker["pgid"], "cli_group_members": group}
        check(ctx, f"cli_in_dispatcher_tree_{label}", cli in desc and cli in group and marker["pgid"] == cli
              and marker.get("ppid") == disp.pid,
              snapshot=snap)
        ctx.setdefault("tree_snapshots", []).append(snap)
        return snap

    def shutdown_tree(self, ctx: dict, disp: Dispatcher) -> dict:
        table = process_table()
        desc = descendants(table, disp.pid) if disp.alive() else []
        snap = {"label": "before_shutdown", "t": utc_now(), "dispatcher_pid": disp.pid, "descendants": desc,
                "descendant_starts": {str(p): table[p]["start"] for p in desc if p in table}}
        ctx.setdefault("tree_snapshots", []).append(snap)
        return snap

    def final_gone(self, ctx: dict, disp: Dispatcher, cli_markers: list[dict]) -> None:
        pids: dict[int, str | None] = {disp.pid: disp.start}
        for snap in ctx.get("tree_snapshots", []):
            for p, start in snap.get("descendant_starts", {}).items():
                pids[int(p)] = start
        pgids = []
        for m in cli_markers:
            pids.setdefault(m["pid"], None)
            pgids.append(m["pgid"])
        result = gone_check(pids, pgids)
        check(ctx, "no_survivor_no_pid_reuse", result["ok"], check=result)

    def locks_released(self, ctx: dict, ws: Workspace, worktree_used: bool = True) -> None:
        """Each lock file exists and can be taken. Absent counts only for a worktree lock never reached."""
        locks = {"ledger/dispatcher.lock": flock_free(ws.ledger / "dispatcher.lock"),
                 "ledger/bridge.lock": flock_free(ws.ledger / "bridge.lock"),
                 "worktree/ak-dispatch.lock": flock_free(ws.worktree_lock())}
        ok = locks["ledger/dispatcher.lock"] is True and locks["ledger/bridge.lock"] is True and (
            locks["worktree/ak-dispatch.lock"] is True if worktree_used else locks["worktree/ak-dispatch.lock"] is not False)
        check(ctx, "locks_released", ok, locks=locks, worktree_used=worktree_used)

    def ledger_files(self, ws: Workspace, sdir: Path) -> dict:
        out = {}
        for name in ("handoff.json", "dispatcher-done.json", "dispatcher-stop.json"):
            p = ws.ledger / name
            if p.exists():
                try:
                    out[name] = json.loads(p.read_text())
                    write_json(sdir / f"ledger-{name}", out[name])  # redacted copy, never the raw file
                except (OSError, ValueError) as e:
                    out[name] = "<unparseable>"
                    write_json(sdir / f"ledger-{name}", {"unparseable": True, "error": type(e).__name__})
            else:
                out[name] = "absent"
        return out

    def done_ids(self, ws: Workspace) -> list[int]:
        """Absent is empty. Present but unreadable is a failure, never an empty record."""
        p = ws.ledger / "dispatcher-done.json"
        if not p.exists():
            return []
        try:
            return [item["task_id"] for item in json.loads(p.read_text())["done"]]
        except (OSError, ValueError, KeyError, TypeError):
            raise Failure("done_record_unreadable") from None

    def claim_checks(self, ctx: dict, proxy: RecorderProxy, expected_ids: list[int]) -> list[dict]:
        """L4: every claim names the exact task_id, project, platform and machine, with Authorization preserved."""
        records = proxy.snapshot()
        claims = [r for r in records if r["method"] == "POST" and r["path"] == "/api/tasks/claim"]
        ids = [r["body"].get("task_id") if isinstance(r["body"], dict) else None for r in claims]
        exact = all(
            isinstance(r["body"], dict) and type(r["body"].get("task_id")) is int
            and r["body"].get("project") == PROJECT and r["body"].get("platform") == PLATFORM
            and r["body"].get("machine") == self.machine and r["authorization"] == "preserved"
            and r.get("upstream_status") == 200
            for r in claims)
        check(ctx, "claims_exact_and_authorized", exact and ids == expected_ids, claim_task_ids=ids,
              expected=expected_ids)
        check(ctx, "all_requests_authorized", all(r["authorization"] == "preserved" for r in records),
              requests=len(records))
        check(ctx, "no_demo_response", not any(r.get("demo_true") for r in records))
        return claims

    def patches(self, proxy: RecorderProxy, task_id: int) -> list[str]:
        return [r["body"].get("status") for r in proxy.snapshot()
                if r["method"] == "PATCH" and r["path"] == f"/api/tasks/{task_id}" and isinstance(r["body"], dict)]

    def new_proxy(self, mode: str = "record") -> RecorderProxy:
        proxy = RecorderProxy(self.origin, self.token, mode)
        self.proxies.append(proxy)
        return proxy

    def new_workspace(self, name: str, mode: str) -> Workspace:
        ws = Workspace(self.run_root, self.run_id, name, self.scenario_dir(name))
        self.workspaces.append(ws)
        ws.create(mode)
        return ws

    def handoff(self, ctx: dict, ws: Workspace, snapshot: dict, transport=None, label: str = "run_once") -> dict:
        config = ws.config(self.machine)
        ws.config_path.write_text(json.dumps(config, indent=2))
        tasks = transport or TaskTransport(self.origin, self.token)
        issues = IssueTransport(snapshot)
        result = drb.run_once(config, issues, tasks)
        if tasks.demo_seen:
            raise Failure("demo_response", during=label)
        ctx.setdefault("run_once", []).append({"label": label, "result": result, "posts": tasks.posts,
                                               "lists": tasks.lists, "issue_reads": len(issues.reads)})
        return result

    def start_dispatcher(self, ctx: dict, ws: Workspace, proxy: RecorderProxy, sdir: Path) -> Dispatcher:
        config = json.loads(ws.config_path.read_text())
        check(ctx, "config_workdir_equals_MC_WORKDIR", config["workdir"].encode() == str(ws.root).encode())
        check(ctx, "config_enabled_is_not_the_switch",
              config["enabled"] is True and drb.parse_bridge_config(dict(config, enabled=False)) != "invalid_config")
        disp = Dispatcher(ws, proxy.url, self.token, sdir / "dispatcher.log")
        check(ctx, "dispatcher_env_switch", disp.env["MC_BRIDGE_ENABLED"] == "1"
              and disp.env["MC_WORKDIR"] == config["workdir"] and disp.env["MC_MAX_CONCURRENT"] == "1")
        self.dispatchers.append(disp)
        disp.launch()
        ctx["dispatcher"] = disp.evidence()
        return disp

    def stop_dispatcher(self, ctx: dict, disp: Dispatcher, expected: int) -> None:
        self.shutdown_tree(ctx, disp)
        code = disp.terminate()
        ctx["dispatcher"] = disp.evidence()
        check(ctx, "dispatcher_exit_code", code == expected, exit_code=code, expected=expected)

    # -- scenarios -----------------------------------------------------------------

    def s_normal(self, ctx: dict, name: str = "normal", competitor: bool = False) -> None:
        sdir = self.scenario_dir(name)
        ws = self.new_workspace(name, "normal")
        issue = self.fixture_one["issues"][0]
        comp_id = None
        if competitor:
            comp = self.api.call("POST", "/api/tasks", {
                "title": f"bridge-62 competitor {self.run_id}", "description": "competing task, never claimed",
                "project": PROJECT, "platform": PLATFORM, "machine": self.machine, "priority": 1,
                "created_by": "bridge-62-competitor"})
            comp_id = drb.canonical_task_id(comp["task"]["id"])
            ctx["competitor"] = {"task_id": comp_id, "priority": 1}
        result = self.handoff(ctx, ws, self.fixture_one)
        bound = self.bind(ctx, result, ws, self.fixture_one, issue["node_id"])
        if MUTATION == "extra_bridge_task":
            handoff = json.loads((ws.ledger / "handoff.json").read_text())["handoffs"][issue["node_id"]]
            self.api.call("POST", "/api/tasks", handoff["body"])
        self.assert_task(ctx, bound, issue, "queued")
        proxy = self.new_proxy()
        disp = self.start_dispatcher(ctx, ws, proxy, sdir)
        marker = self.read_marker(ws)
        self.tree_evidence(ctx, disp, marker, "after_child_start")
        if MUTATION == "escape_then_fail":
            raise Failure("injected_early_failure")  # before final_gone: only cleanup can see the survivor
        wait_for(lambda: len(self.work_events(bound)) >= 1, "work event before release")
        (ws.go_dir / f"go-{marker['pid']}").write_text("go\n")
        self.wait_status(bound["task_id"], "done")
        wait_for(lambda: bound["task_id"] in self.done_ids(ws), "dispatcher-done.json entry")
        wait_for(lambda: not (ws.ledger / "dispatcher-stop.json").exists(), "stop journal cleared")
        if MUTATION in ("extra_work_event", "close_ready_forced"):
            self.api.call("POST", "/api/ingest", {"agent_id": f"{PLATFORM}-{self.machine}", "kind": "status",
                                                  "title": f"Running task #{bound['task_id']}: {bound['task_title']}",
                                                  "detail": {"task_id": bound["task_id"]}})
        self.stop_dispatcher(ctx, disp, EXPECTED_EXIT[name])
        self.final_gone(ctx, disp, [marker])
        self.assert_task(ctx, bound, issue, "done")
        self.assert_work_events(ctx, "exactly_one_work_event", bound, 1)
        self.claim_checks(ctx, proxy, [bound["task_id"]])
        check(ctx, "phase_patches", self.patches(proxy, bound["task_id"]) == ["running", "done"],
              patches=self.patches(proxy, bound["task_id"]))
        ledger = self.ledger_files(ws, sdir)
        check(ctx, "done_record_lists_task", self.done_ids(ws) == [bound["task_id"]], done=self.done_ids(ws))
        check(ctx, "journal_cleared", ledger["dispatcher-stop.json"] == "absent")
        self.locks_released(ctx, ws)
        if competitor:
            check(ctx, "competitor_still_queued", self.task_status(comp_id) == "queued")
            check(ctx, "competitor_never_claimed", comp_id not in [
                r["body"].get("task_id") for r in proxy.snapshot()
                if r["path"] == "/api/tasks/claim" and isinstance(r["body"], dict)])
        ctx["requests"] = proxy.snapshot()

    def s_competing(self, ctx: dict) -> None:
        self.s_normal(ctx, "competing", competitor=True)

    def s_safe_stop(self, ctx: dict) -> None:
        name = "safe_stop"
        sdir = self.scenario_dir(name)
        ws = self.new_workspace(name, "sleep")
        issue = self.fixture_one["issues"][0]
        result = self.handoff(ctx, ws, self.fixture_one)
        bound = self.bind(ctx, result, ws, self.fixture_one, issue["node_id"])
        sentinel = Sentinel()
        self.sentinels.append(sentinel)
        ctx["sentinel"] = {"pid": sentinel.pid, "pgid": sentinel.pgid, "start": sentinel.start,
                           "recorded_before_dispatcher": True}
        proxy = self.new_proxy()
        disp = self.start_dispatcher(ctx, ws, proxy, sdir)
        marker = self.read_marker(ws)
        self.tree_evidence(ctx, disp, marker, "after_child_start")
        wait_for(lambda: self.work_events(bound), "work event before stop")
        self.assert_work_events(ctx, "exactly_one_work_event_before_stop", bound, 1)
        check(ctx, "lock_held_while_cli_runs", flock_free(ws.worktree_lock()) is False)
        ws.stop_file.write_text("stop\n")
        ctx["stop_written_at"] = utc_now()
        order: list[dict] = []

        def settled():
            # Lock first, then the group: a group still present after the lock was seen free is a real
            # ordering defect; the reverse order could pair an old group sample with a new lock state.
            lock = flock_free(ws.worktree_lock())
            table = process_table()
            group = sorted(p for p, row in table.items() if row["pgid"] == marker["pgid"])
            order.append({"t": utc_now(), "group_live": bool(group), "lock_free": lock})
            if lock and group:
                raise Failure("lock_released_before_group_gone", sample=order[-1])
            return not group and lock is True

        wait_for(settled, "CLI group gone and lock released", interval=0.05)
        ctx["stop_ordering_samples"] = {"count": len(order), "first": order[:3], "last": order[-3:]}
        journal = wait_for(lambda: self.ledger_files(ws, sdir)["dispatcher-stop.json"] != "absent"
                           and self.ledger_files(ws, sdir)["dispatcher-stop.json"], "halt recorded in journal")
        check(ctx, "halt_is_stop_requested", isinstance(journal, dict) and isinstance(journal.get("halt"), dict)
              and journal["halt"].get("code") == "stop_requested" and journal["halt"].get("task_id") == bound["task_id"],
              halt=journal.get("halt") if isinstance(journal, dict) else journal)
        check(ctx, "dispatcher_alive_holding_halt", disp.alive())
        self.stop_dispatcher(ctx, disp, EXPECTED_EXIT[name])
        self.final_gone(ctx, disp, [marker])
        check(ctx, "sentinel_alive_after_cleanup", sentinel.alive_unchanged(), pid=sentinel.pid)
        ctx["sentinel_cleanup"] = sentinel.cleanup()
        check(ctx, "sentinel_cleanup", ctx["sentinel_cleanup"]["ok"], result=ctx["sentinel_cleanup"])
        self.assert_task(ctx, bound, issue, "running")
        self.assert_work_events(ctx, "exactly_one_work_event", bound, 1)
        self.claim_checks(ctx, proxy, [bound["task_id"]])
        check(ctx, "no_completion_patch", self.patches(proxy, bound["task_id"]) == ["running"],
              patches=self.patches(proxy, bound["task_id"]))
        ledger = self.ledger_files(ws, sdir)
        check(ctx, "no_done_entry", bound["task_id"] not in self.done_ids(ws),
              done=ledger["dispatcher-done.json"])
        self.locks_released(ctx, ws)
        ctx["requests"] = proxy.snapshot()

    def s_no_child_stop(self, ctx: dict) -> None:
        name = "no_child_stop"
        sdir = self.scenario_dir(name)
        ws = self.new_workspace(name, "normal")
        issue = self.fixture_one["issues"][0]
        result = self.handoff(ctx, ws, self.fixture_one)
        bound = self.bind(ctx, result, ws, self.fixture_one, issue["node_id"])
        ws.stop_file.write_text("stop\n")
        sentinel = Sentinel()
        self.sentinels.append(sentinel)
        ctx["sentinel"] = {"pid": sentinel.pid, "pgid": sentinel.pgid, "start": sentinel.start}
        proxy = self.new_proxy()
        disp = self.start_dispatcher(ctx, ws, proxy, sdir)
        # The dispatcher's first act is its heartbeat; then each poll sees the stop and claims nothing.
        def heartbeat_ok(r: dict) -> bool:
            return (r["method"] == "POST" and r["path"] == "/api/ingest" and isinstance(r["body"], dict)
                    and r["body"].get("kind") == "heartbeat" and r["authorization"] == "preserved"
                    and r.get("upstream_status") == 200 and r.get("demo_true") is False)

        wait_for(lambda: any(heartbeat_ok(r) for r in proxy.snapshot()), "authenticated non-demo heartbeat")
        t0 = utc_now()
        time.sleep(3 * POLL_SECONDS + 1)
        ctx["observed_window"] = {"from": t0, "to": utc_now(), "poll_seconds": POLL_SECONDS}
        check(ctx, "dispatcher_alive_during_window", disp.alive())
        self.stop_dispatcher(ctx, disp, EXPECTED_EXIT[name])
        self.final_gone(ctx, disp, [])
        claims = [r for r in proxy.snapshot() if r["path"] == "/api/tasks/claim"]
        check(ctx, "no_claim_request", not claims, claims=len(claims))
        check(ctx, "no_cli_started", not ws.marker.exists())
        check(ctx, "task_still_queued", self.task_status(bound["task_id"]) == "queued")
        check(ctx, "no_patch", self.patches(proxy, bound["task_id"]) == [])
        self.assert_work_events(ctx, "no_work_event", bound, 0)
        ledger = self.ledger_files(ws, sdir)
        check(ctx, "no_stop_journal", ledger["dispatcher-stop.json"] == "absent")
        check(ctx, "sentinel_untouched", sentinel.alive_unchanged())
        ctx["sentinel_cleanup"] = sentinel.cleanup()
        check(ctx, "sentinel_cleanup", ctx["sentinel_cleanup"]["ok"], result=ctx["sentinel_cleanup"])
        self.assert_task(ctx, bound, issue, "queued")
        self.locks_released(ctx, ws, worktree_used=False)
        ctx["requests"] = proxy.snapshot()

    def s_lost_reply(self, ctx: dict) -> None:
        name = "lost_reply"
        self.scenario_dir(name)
        ws = self.new_workspace(name, "normal")
        issue = self.fixture_one["issues"][0]
        proxy = self.new_proxy("drop_create")
        via_proxy = TaskTransport(urllib.parse.urlsplit(proxy.url), self.token)
        direct2 = TaskTransport(self.origin, self.token)
        direct3 = TaskTransport(self.origin, self.token)
        r1 = self.handoff(ctx, ws, self.fixture_one, via_proxy, "through_proxy")
        if MUTATION == "second_post":
            (ws.ledger / "handoff.json").unlink()
        r2 = self.handoff(ctx, ws, self.fixture_one, direct2, "recovery_direct")
        r3 = self.handoff(ctx, ws, self.fixture_one, direct3, "third_direct")
        records = proxy.snapshot()
        posts = [r for r in records if r["method"] == "POST" and r["path"] == "/api/tasks"]
        ctx["outcomes"] = [r1, r2, r3]
        ctx["observed_post_count"] = {"proxy": len(posts), "direct": direct2.posts + direct3.posts}
        check(ctx, "first_is_lost_reply", r1.get("outcome") == "deferred" and r1.get("reason") == "lost_reply"
              and r1.get("posted") is True and via_proxy.lost == 1, result=r1)
        check(ctx, "proxy_forwarded_one_post_and_dropped_reply",
              len(posts) == 1 and posts[0]["dropped_response"] and posts[0].get("upstream_status") == 200
              and posts[0]["authorization"] == "preserved" and "idempotency-key" in posts[0]["header_names"],
              posts=posts)
        check(ctx, "recovery_reconciles_without_post", r2.get("outcome") == "reconciled" and direct2.posts == 0
              and direct2.lists >= 2, result=r2, lists=direct2.lists)
        check(ctx, "third_call_posts_nothing", direct3.posts == 0 and r3.get("outcome") == "no_eligible_issue",
              result=r3)
        bound = self.bind(ctx, r2, ws, self.fixture_one, issue["node_id"])
        check(ctx, "bound_id_is_committed_create", posts and posts[0].get("upstream_task_id") == str(bound["task_id"]))
        self.assert_task(ctx, bound, issue, "queued")
        ctx["requests"] = records

    def s_two_in_sequence(self, ctx: dict) -> None:
        name = "two_in_sequence"
        sdir = self.scenario_dir(name)
        ws = self.new_workspace(name, "normal")
        issues = {i["node_id"]: i for i in self.fixture_two["issues"]}
        ra = self.handoff(ctx, ws, self.fixture_two, label="run_once_a")
        bound_a = self.bind(ctx, ra, ws, self.fixture_two, "I_bridge62_a")
        proxy = self.new_proxy()
        disp = self.start_dispatcher(ctx, ws, proxy, sdir)
        markers = []
        for label, bound in (("a", bound_a), ("b", None)):
            if bound is None:
                rb = self.handoff(ctx, ws, self.fixture_two, label="run_once_b")
                check(ctx, "dispatcher_still_running_for_b", disp.alive())
                bound = self.bind(ctx, rb, ws, self.fixture_two, "I_bridge62_b")
            marker = self.read_marker(ws)
            self.tree_evidence(ctx, disp, marker, f"after_child_start_{label}")
            wait_for(lambda: len(self.work_events(bound)) >= 1, f"work event {label}")
            (ws.go_dir / f"go-{marker['pid']}").write_text("go\n")
            self.wait_status(bound["task_id"], "done")
            wait_for(lambda: bound["task_id"] in self.done_ids(ws), f"dispatcher-done.json entry {label}")
            wait_for(lambda: not (ws.ledger / "dispatcher-stop.json").exists(), f"stop journal cleared {label}")
            os.replace(ws.marker, ws.marker.with_name(f"started-{label}.json"))
            markers.append(marker)
            ctx.setdefault("done_at", {})[label] = utc_now()
        claims_before = len([r for r in proxy.snapshot() if r["path"] == "/api/tasks/claim"])
        window_start = utc_now()
        time.sleep(2 * POLL_SECONDS + 1)  # M1: two complete poll intervals, dispatcher alive throughout
        claims_after = len([r for r in proxy.snapshot() if r["path"] == "/api/tasks/claim"])
        ctx["idle_window"] = {"from": window_start, "to": utc_now(), "poll_seconds": POLL_SECONDS,
                              "dispatcher_pid": disp.pid, "dispatcher_start": disp.start,
                              "alive": disp.alive(), "claims_before": claims_before, "claims_after": claims_after}
        check(ctx, "no_claim_after_b", disp.alive() and claims_after == claims_before == 2)
        self.stop_dispatcher(ctx, disp, EXPECTED_EXIT[name])
        self.final_gone(ctx, disp, markers)
        bounds = ctx["bound"]
        self.claim_checks(ctx, proxy, [b["task_id"] for b in bounds])
        for b in bounds:
            self.assert_task(ctx, b, issues[b["issue_node_id"]], "done")
            self.assert_work_events(ctx, f"exactly_one_work_event_{b['issue_node_id']}", b, 1)
        check(ctx, "done_in_order", self.done_ids(ws) == [b["task_id"] for b in bounds], done=self.done_ids(ws))
        ledger = self.ledger_files(ws, sdir)
        check(ctx, "journal_cleared", ledger["dispatcher-stop.json"] == "absent")
        self.locks_released(ctx, ws)
        ctx["requests"] = proxy.snapshot()

    def s_bad_input(self, ctx: dict) -> None:
        base = self.fixture_one
        issue = base["issues"][0]
        changed = copy.deepcopy(base)
        changed["issues"][0]["title"] = "bridge-62 proof one (edited between reads)"
        dup = copy.deepcopy(base)
        second = copy.deepcopy(issue)
        second.update({"number": 9004, "url": "https://github.com/mrhinkle/agent-kontrol/issues/9004"})
        dup["issues"].append(second)
        cases = [
            ("empty", [{"complete": True, "issues": []}], "no_eligible_issue", None),
            ("incomplete", [dict(copy.deepcopy(base), complete=False)], "incomplete_read", None),
            ("dupnode", [dup], "incomplete_read", None),
            ("changed", [base, changed], "revalidation_failed", None),
        ]
        ctx["cases"] = []
        for case, sequence, outcome, _ in cases:
            name = f"bad_input_{case}"
            ws = self.new_workspace(name, "normal")
            config = ws.config(self.machine)
            ws.config_path.write_text(json.dumps(config, indent=2))
            tasks = TaskTransport(self.origin, self.token)
            issues = IssueTransport(sequence=sequence)
            result = drb.run_once(config, issues, tasks)
            found = self.bridge_tasks(ws.authority, issue["node_id"])
            handoff = ws.ledger / "handoff.json"
            rows = json.loads(handoff.read_text())["handoffs"] if handoff.exists() else {}
            idem = self.db.query("idempotency", [drb._idempotency_key(ws.authority, issue["node_id"])])
            entry = {"case": case, "authority": ws.authority, "result": result, "posts": tasks.posts,
                     "issue_reads": len(issues.reads), "tasks_found": len(found), "handoff_rows": len(rows),
                     "idempotency_rows": len(idem), "reason": result.get("reason") or result.get("outcome")}
            ctx["cases"].append(entry)
            check(ctx, f"{case}_no_task", result.get("outcome") == outcome and tasks.posts == 0 and not found
                  and not rows and not idem and not tasks.demo_seen and len(issues.reads) >= 1, entry=entry)

    # -- driver -----------------------------------------------------------------

    def preflight(self) -> dict:
        """K4: the server writes to the declared database. Marker excluded from every scenario count."""
        agent = f"bridge-62-marker-{self.run_id}-{secrets.token_hex(4)}"
        marker = secrets.token_hex(16)
        resp = self.api.call("POST", "/api/ingest", {"agent_id": agent, "kind": "status",
                                                     "title": "bridge-62 database marker", "detail": {"marker": marker}})
        rows = self.db.query("marker", [agent, marker])
        if resp.get("ok") is not True or len(rows) != 1:
            raise Failure("server_database_mismatch", rows=len(rows))
        pointers = self.api.call("GET", f"/api/skills/pointers?lane={PROJECT}&runtime=claude")
        return {"marker_agent_id": agent, "marker_rows": len(rows), "principal_kind": rows[0]["principal_kind"],
                "pointers_demo": pointers.get("demo"), "bind": check_not_exposed(self.origin.port)}

    def run_scenario(self, name: str) -> dict:
        ctx: dict = {"scenario": name, "started_at": utc_now(), "assertions": []}
        self.markers = []
        before = len(self.db.log)
        try:
            getattr(self, f"s_{name}")(ctx)
            ctx["result"] = "pass"
        except Failure as f:
            ctx["result"] = "fail"
            ctx["failure"] = {"code": f.code, "detail": f.detail}
        except Exception as e:
            ctx["result"] = "fail"
            ctx["failure"] = {"code": "runner_error", "detail": {"type": type(e).__name__,
                                                                 "trace": traceback.format_exc()[-2000:]}}
        finally:
            ctx["cleanup"] = self.cleanup_scenario(ctx)
            ctx["raw_queries"] = self.db.log[before:]
            ctx["finished_at"] = utc_now()
            if not ctx["cleanup"]["ok"]:
                ctx["result"] = "fail"
            write_json(self.scenario_dir(name) / "scenario.json", ctx)
        return ctx

    def cleanup_scenario(self, ctx: dict) -> dict:
        """Stop what the scenario started and prove every recorded process gone, also on the failure path.

        Survivors (a dispatcher that ignores SIGTERM, a descendant that outlived it) are an incident:
        nothing is force-killed, the workspace and registry are kept as evidence, and the run stops.
        """
        if self.incident is not None:
            return {"ok": False, "code": self.incident["code"], "retained": True, "note": "incident already open"}
        out: dict = {"dispatchers": [], "sentinels": [], "workspaces": [], "proxies": 0}
        ok = True
        pids: dict[int, str | None] = {}
        pgids: list[int] = []
        survived = []
        for disp in self.dispatchers:
            if disp.proc is None:
                out["dispatchers"].append({"pid": None, "launched": False})
                continue
            pids[disp.pid] = disp.start
            if disp.alive():
                table = process_table()
                for p in descendants(table, disp.pid):
                    pids.setdefault(p, table[p]["start"])
            try:
                disp.terminate()
            except Failure:
                survived.append(disp.pid)
            out["dispatchers"].append({"pid": disp.pid, "exit_code": disp.proc.returncode})
        for snap in ctx.get("tree_snapshots", []):
            for p, start in snap.get("descendant_starts", {}).items():
                pids.setdefault(int(p), start)
        for m in self.markers:
            pids.setdefault(m["pid"], None)
            pgids.append(m["pgid"])
        out["process_check"] = gone_check(pids, sorted(set(pgids))) if pids or pgids else {"ok": True, "checked_pids": []}
        if survived or not out["process_check"]["ok"]:
            out["code"] = "dispatcher_survived_teardown" if survived else "cleanup_survivor"
            out["survived_dispatchers"] = survived
            out["retained"] = {"workspaces": [str(ws.root) for ws in self.workspaces]}
            out["ok"] = False
            self.incident = {"code": out["code"], "scenario": ctx.get("scenario"), "at": utc_now()}
            # The sentinel is the runner's own control process, not evidence: reap it (M2) even here.
            out["sentinels"] = [sen.cleanup() for sen in self.sentinels]
            self.sentinels = []
            return out  # keep dispatchers, workspaces, proxies and the registry: stop-and-reconcile, no retry
        for disp in self.dispatchers:
            out.setdefault("logs", []).append(publish_log(disp.log_path, disp.publish_path))
        for s in self.sentinels:
            res = s.cleanup()
            out["sentinels"].append(res)
            ok = ok and res["ok"]
        for p in self.proxies:
            p.close()
            out["proxies"] += 1
        for ws in self.workspaces:
            res = ws.destroy()
            out["workspaces"].append(res)
            ok = ok and res["root_removed"]
        self.dispatchers, self.sentinels, self.proxies, self.workspaces = [], [], [], []
        out["ok"] = ok
        return out


def check(ctx: dict, name: str, ok: bool, **evidence) -> None:
    ctx["assertions"].append({"name": name, "ok": bool(ok), "evidence": evidence})
    if not ok:
        raise Failure(f"assertion_failed:{name}", **evidence)


def git_head() -> str:
    return subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True,
                          timeout=30).stdout.strip()


def base_ancestry(base: str) -> dict:
    rc = subprocess.run(["git", "-C", str(REPO), "merge-base", "--is-ancestor", base, "HEAD"],
                        capture_output=True, text=True, timeout=30).returncode
    return {"base_sha": base, "is_ancestor": rc == 0, "exit_code": rc}


def acceptance(scenarios: dict) -> dict:
    def passed(*names):
        return all(scenarios.get(n, {}).get("result") == "pass" for n in names)

    return {
        "AC1": passed("normal"),
        "AC2": passed("safe_stop"),
        "AC3": passed("competing", "no_child_stop", "lost_reply", "two_in_sequence", "bad_input"),
    }


def close_ready_decision(report: dict) -> tuple[bool, str]:
    """True exactly when AC1-AC3 pass on a complete, unmutated, cleanly torn-down run."""
    acc = report.get("acceptance") or {}
    cleanup = report.get("final_cleanup") or {}
    scenarios = report.get("scenarios") or {}
    checks = {
        "AC1": acc.get("AC1") is True,
        "AC2": acc.get("AC2") is True,
        "AC3": acc.get("AC3") is True,
        "all_scenarios_ran": report.get("all_scenarios_ran") is True and set(scenarios) == set(ALL_SCENARIOS),
        "every_scenario_pass": bool(scenarios) and all(v.get("result") == "pass" for v in scenarios.values()),
        "no_fault_injection": report.get("mutation") is None,
        "base_is_ancestor": (report.get("base") or {}).get("is_ancestor") is True,
        "cleanup": cleanup.get("ok") is True and cleanup.get("run_root_removed") is True,
        "no_runner_failure": "failure" not in report,
    }
    if MUTATION == "close_ready_forced":
        return True, "FORCED by fault injection"
    failed = [k for k, v in checks.items() if not v]
    return (not failed), ("AC1-AC3 passed; CI artifact is the evidence" if not failed
                          else "not close-ready: " + ",".join(failed))


def close_ready_consistent(report: dict) -> bool:
    """Independent guard: close_ready may never be true beside a failed AC, scenario, mutation or cleanup."""
    if report.get("close_ready") is not True:
        return True
    acc = report.get("acceptance") or {}
    scen = report.get("scenarios") or {}
    return (all(acc.get(k) is True for k in ("AC1", "AC2", "AC3"))
            and set(scen) == set(ALL_SCENARIOS) and all(v.get("result") == "pass" for v in scen.values())
            and report.get("mutation") is None and "failure" not in report
            and (report.get("final_cleanup") or {}).get("ok") is True
            and (report.get("final_cleanup") or {}).get("run_root_removed") is True)


def run_main() -> int:
    env = os.environ
    missing = [k for k in ("MC_URL", "MC_TOKEN", "DATABASE_URL", "RUN_ID", "REPORT_DIR") if not env.get(k)]
    report_dir = Path(env.get("REPORT_DIR") or "bridge-e2e-report").resolve()
    report: dict = {"spec": "mrhinkle/agent-kontrol#213 (epic #62)", "started_at": utc_now(),
                    "tested_sha": git_head(), "machine": machine_identity(), "user": pwd.getpwuid(os.getuid()).pw_name,
                    "uid": os.getuid(), "python": sys.version.split()[0], "lane_user": "not used: the #193 sudoers rule is not approved",
                    "network_claim": "application traffic only: every API and database endpoint resolved to loopback; no claim about host-wide outbound traffic",
                    "scenarios": {}, "close_ready": False}
    REDACT.add(env.get("MC_TOKEN"), "token")
    REDACT.add(env.get("DATABASE_URL"), "database-url")
    REDACT.add(env.get("MC_URL"), "mc-url")
    try:
        REDACT.add(urllib.parse.urlsplit(env.get("DATABASE_URL", "")).password, "db-password")
    except ValueError:
        pass
    run = None
    code = 1
    global MUTATION
    MUTATION = env.get("BRIDGE_E2E_MUTATION") or None
    report["mutation"] = MUTATION

    def interrupted(signum, _frame):
        raise Interrupted(signum)

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        if missing:
            raise Failure("missing_input", names=missing)
        if MUTATION is not None and MUTATION not in MUTATIONS:
            raise Failure("unknown_mutation")
        if not RUN_ID_RE.fullmatch(env["RUN_ID"]):
            raise Failure("invalid_run_id")
        report["run_id"] = env["RUN_ID"]
        base = env.get("BASE_SHA") or BASE_SHA_DEFAULT
        report["base"] = base_ancestry(base)
        if not report["base"]["is_ancestor"]:
            raise Failure("base_not_ancestor", base=base)
        run = Run(dict(env))
        report["endpoints"] = {"mc_url": "loopback", "mc_port": run.origin.port, "database": "loopback",
                               "database_port": run.db_url.port}
        report["preflight"] = run.preflight()
        wanted = [s.strip() for s in env.get("BRIDGE_E2E_SCENARIOS", ",".join(ALL_SCENARIOS)).split(",") if s.strip()]
        unknown = [s for s in wanted if s not in ALL_SCENARIOS]
        if unknown:
            raise Failure("unknown_scenario", names=unknown)
        report["scenarios_requested"] = wanted
        for name in wanted:
            report["scenarios"][name] = run.run_scenario(name)
            if run.incident is not None:
                raise Failure(run.incident["code"], scenario=name, note="run stopped; evidence retained")
        report["acceptance"] = acceptance(report["scenarios"])
        all_pass = (all(s["result"] == "pass" for s in report["scenarios"].values())
                    and wanted == list(ALL_SCENARIOS) and MUTATION is None)
        report["result"] = "pass" if all(s["result"] == "pass" for s in report["scenarios"].values()) else "fail"
        report["all_scenarios_ran"] = wanted == list(ALL_SCENARIOS)
        code = 0 if all_pass else 1
    except Failure as f:
        report["result"] = "fail"
        report["failure"] = {"code": f.code, "detail": f.detail}
    except Interrupted as i:
        report["result"] = "fail"
        report["failure"] = {"code": "signal", "detail": {"signal": int(i.args[0]) if i.args else None}}
    except Exception:
        report["result"] = "fail"
        report["failure"] = {"code": "runner_error", "detail": {"trace": traceback.format_exc()[-2000:]}}
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        if run is not None:
            report["final_cleanup"] = run.cleanup_scenario({})
            report["run_root"] = str(run.run_root)
            if run.incident is None:
                shutil.rmtree(run.run_root, ignore_errors=True)
            report["final_cleanup"]["run_root_removed"] = not run.run_root.exists()
            if not (report["final_cleanup"]["ok"] and report["final_cleanup"]["run_root_removed"]):
                report["result"] = "fail"
                code = 1
            report["api_calls"] = run.api.calls
        report["finished_at"] = utc_now()
        report["acceptance"] = acceptance(report["scenarios"])
        report["close_ready"], report["close_ready_reason"] = close_ready_decision(report)
        if not close_ready_consistent(report):
            report["close_ready"] = False
            report["close_ready_reason"] = "inconsistent: close_ready claimed beside a failed check"
            report["result"] = "fail"
            report["failure"] = {"code": "close_ready_inconsistent", "detail": {}}
            code = 1
        if code == 0 and report["close_ready"] is not True:
            code = 1
        write_json(report_dir / "report.json", report)
        summary = ", ".join("%s=%s" % (k, v["result"]) for k, v in report["scenarios"].items())
        print(f"bridge-e2e: {report.get('result')} ({summary}) report={report_dir / 'report.json'}")
    return code


def main() -> int:
    if len(sys.argv) > 1:
        return host_main(sys.argv[1:])
    return run_main()


# ---------------------------------------------------------------------------
# Optional host tooling (AC4 was dropped by the owner; nothing requires these modes).


def _host_env() -> tuple[Path, str]:
    report_dir = Path(os.environ.get("REPORT_DIR") or "").resolve()
    run_id = os.environ.get("RUN_ID", "")
    if not os.environ.get("REPORT_DIR") or not RUN_ID_RE.fullmatch(run_id):
        raise SystemExit("REPORT_DIR and a valid RUN_ID are required")
    for name, label in (("MC_TOKEN", "token"), ("MC_DASHBOARD_PASSWORD", "dashboard-password"),
                        ("DATABASE_URL", "database-url")):
        REDACT.add(os.environ.get(name), label)
    return report_dir, run_id


def _hash_ps_args(text: str, keep: tuple[str, ...]) -> str:
    """ps args of processes the run does not own become a digest: equal lines stay equal, nothing leaks."""
    out = []
    for i, line in enumerate(text.splitlines()):
        parts = line.split(None, 5)
        if i == 0 or len(parts) < 6 or any(k and k in line for k in keep):
            out.append(line)
            continue
        digest = hashlib.sha256(parts[5].encode("utf-8", "replace")).hexdigest()[:16]
        out.append(line[: len(line) - len(line.lstrip())] + " ".join(parts[:5]) + f" <args sha256:{digest}>")
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


def host_snapshot(label: str) -> int:
    """L10, L17, M8: five commands, each recorded with timestamps, redacted text, stdout, stderr and exit code.

    A non-zero exit (no crontab, no user systemd, a missing tool) is a recorded result, never an abort.
    """
    report_dir, run_id = _host_env()
    if label not in ("before", "after"):
        raise SystemExit("label must be before or after")
    out_dir = report_dir / "snapshots" / label
    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {"label": label, "snapshot_pid": os.getpid(), "snapshot_ppid": os.getppid(), "commands": {},
            "user": pwd.getpwuid(os.getuid()).pw_name, "hostname": socket.gethostname()}
    keep = (run_id, str(REPO))
    for name, cmd in SNAPSHOT_COMMANDS:
        entry = {"command": " ".join(cmd), "started_at": utc_now()}
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            entry["pid"] = proc.pid
            try:
                stdout, stderr = proc.communicate(timeout=60)
                entry["exit_code"] = proc.returncode
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout, stderr = proc.communicate()
                entry["exit_code"] = "timeout"
        except OSError as e:
            stdout, stderr = b"", f"{type(e).__name__}: {e.strerror}\n".encode()
            entry["exit_code"] = 127
        entry["finished_at"] = utc_now()
        text = stdout.decode("utf-8", "replace")
        if name == "ps":
            text = _hash_ps_args(text, keep)
        write_text(out_dir / f"{name}.out", text)
        write_text(out_dir / f"{name}.err", stderr.decode("utf-8", "replace"))
        meta["commands"][name] = entry
    write_json(out_dir / "meta.json", meta)
    return 0


def host_stop_tree(pidfile: Path) -> int:
    """L12, M9: stop the whole tree rooted at next.pid (it was started with setsid), prove it gone, drop the pid file."""
    report_dir, _run_id = _host_env()
    result: dict = {"pidfile": str(pidfile), "started_at": utc_now()}
    try:
        record = json.loads(pidfile.read_text())
        pid, pgid, start = int(record["pid"]), int(record["pgid"]), str(record["start"])
    except (OSError, ValueError, KeyError, TypeError):
        result.update(ok=False, reason="pid file unreadable; write it with --record-pid at launch")
        write_json(report_dir / "cleanup-next.json", result)
        return 1
    table = process_table()
    leader = table.get(pid)
    # Ownership is proven only against the launch-time record: same start identity and same group.
    if leader is None or leader["start"] != start or leader["pgid"] != pgid:
        result.update(ok=False, reason="cannot verify the launch-time identity; nothing signalled", pid=pid,
                      pgid=pgid, observed=leader)
        write_json(report_dir / "cleanup-next.json", result)
        return 1
    if pgid <= 1 or pgid == os.getpgrp():
        result.update(ok=False, reason="refusing to signal this group", pid=pid, pgid=pgid)
        write_json(report_dir / "cleanup-next.json", result)
        return 1
    tree = {p: table[p]["start"] for p in [pid, *descendants(table, pid)] if p in table}
    tree.update({p: row["start"] for p, row in table.items() if row["pgid"] == pgid})
    result.update(pid=pid, pgid=pgid, members_before=sorted(tree), signals=[])

    def live() -> dict:
        now = process_table()
        return {p: s for p, s in tree.items() if p in now and now[p]["start"] == s}

    for sig, wait in ((signal.SIGTERM, 30.0), (signal.SIGKILL, 10.0)):
        remaining = live()
        if not remaining:
            break
        now = process_table()
        if any(row["pgid"] == pgid for row in now.values()):
            os.killpg(pgid, sig)  # members still exist, so the group id cannot have been reused
        for p in remaining:
            if p in now and now[p]["pgid"] != pgid and now[p]["start"] == tree[p]:
                os.kill(p, sig)  # a descendant that left the group: start identity re-checked just now
        result["signals"].append({"signal": int(sig), "t": utc_now(), "targets": sorted(remaining)})
        deadline = time.monotonic() + wait
        while live() and time.monotonic() < deadline:
            time.sleep(0.2)
    check_gone = gone_check(tree, [pgid])
    result.update(ok=check_gone["ok"], gone=check_gone, finished_at=utc_now())
    if check_gone["ok"]:
        pidfile.unlink()
        result["pidfile_removed"] = not pidfile.exists()
    write_json(report_dir / "cleanup-next.json", result)
    return 0 if result["ok"] else 1


def _normalise(text: str, name: str, tokens: list[str], pids: set[int]) -> tuple[list[str], list[str]]:
    kept, removed = [], []
    for line in text.splitlines():
        owned = any(t and t in line for t in tokens)
        if name == "ps" and not owned:
            parts = line.split(None, 3)
            owned = len(parts) >= 3 and all(x.isdigit() for x in parts[:3]) and bool({int(x) for x in parts[:3]} & pids)
        (removed if owned else kept).append(line)
    return kept, removed


def host_finalize() -> int:
    """Optional: normalised before/after diff and run-owned resources gone. Never changes close_ready."""
    import difflib

    report_dir, run_id = _host_env()
    report = json.loads((report_dir / "report.json").read_text())
    before_meta = json.loads((report_dir / "snapshots" / "before" / "meta.json").read_text())
    after_meta = json.loads((report_dir / "snapshots" / "after" / "meta.json").read_text())
    next_cleanup = json.loads((report_dir / "cleanup-next.json").read_text())
    ports = [int(p) for p in os.environ.get("BRIDGE_E2E_PORTS", "3999,55462").split(",") if p.strip()]
    pids: set[int] = set()
    for meta in (before_meta, after_meta):
        pids.add(meta["snapshot_pid"])
        pids.update(c["pid"] for c in meta["commands"].values() if isinstance(c.get("pid"), int))
    run_pids: dict[int, str | None] = {}
    for scen in report.get("scenarios", {}).values():
        disp = scen.get("dispatcher") or {}
        if isinstance(disp.get("pid"), int):
            run_pids[disp["pid"]] = disp.get("start_identity")
        for snap in scen.get("tree_snapshots", []):
            for p, start in snap.get("descendant_starts", {}).items():
                run_pids[int(p)] = start
        sentinel = scen.get("sentinel") or {}
        if isinstance(sentinel.get("pid"), int):
            run_pids[sentinel["pid"]] = sentinel.get("start")
    for p in next_cleanup.get("members_before", []):
        run_pids.setdefault(int(p), None)
    pids.update(run_pids)
    tokens = [run_id, str(report_dir), str(REPO)] + [f":{p} " for p in ports] + [f":{p}\t" for p in ports]
    manifest = {"rules": ["drop lines containing RUN_ID, the report path or the clone path",
                          "drop lines containing a recorded port (%s)" % ",".join(map(str, ports)),
                          "ps only: drop lines whose pid, ppid or pgid is a recorded run-owned or snapshot pid"],
                "run_owned_pids": sorted(run_pids), "snapshot_pids": sorted(pids - set(run_pids)), "files": {}}
    diffs_empty = True
    diff_dir = report_dir / "snapshots" / "diff"
    diff_dir.mkdir(parents=True, exist_ok=True)
    classification = {}
    for name, _cmd in SNAPSHOT_COMMANDS:
        b = (report_dir / "snapshots" / "before" / f"{name}.out").read_text()
        a = (report_dir / "snapshots" / "after" / f"{name}.out").read_text()
        bk, br = _normalise(b, name, tokens, pids)
        ak, ar = _normalise(a, name, tokens, pids)
        diff = list(difflib.unified_diff(bk, ak, f"before/{name}", f"after/{name}", lineterm="", n=0))
        rc_same = before_meta["commands"][name]["exit_code"] == after_meta["commands"][name]["exit_code"]
        (diff_dir / f"{name}.diff").write_text("\n".join(diff) + ("\n" if diff else ""))
        manifest["files"][name] = {"removed_before": br, "removed_after": ar, "diff_lines": len(diff),
                                   "exit_codes": [before_meta["commands"][name]["exit_code"],
                                                  after_meta["commands"][name]["exit_code"]]}
        changed = [l for l in diff if l[:1] in "+-" and not l.startswith(("+++", "---"))]
        classification[name] = {"changed_lines": len(changed),
                                "changed_lines_naming_run_owned": [l for l in changed if any(t in l for t in tokens)]}
        diffs_empty = diffs_empty and not diff and rc_same
    write_json(diff_dir / "normalization-manifest.json", manifest)
    container = subprocess.run(["docker", "ps", "-a", "--filter", f"name=^/pg-{run_id}$", "--format", "{{.ID}}"],
                               capture_output=True, text=True, timeout=60) if shutil.which("docker") else None
    container_gone = container is not None and container.returncode == 0 and container.stdout.strip() == ""
    procs = gone_check(run_pids, [])
    head = git_head()
    checks = {
        "scenarios_all_pass": report.get("result") == "pass" and report.get("all_scenarios_ran") is True,
        "no_mutation": report.get("mutation") is None,
        "tested_sha_is_checkout_head": report.get("tested_sha") == head,
        "base_is_ancestor": (report.get("base") or {}).get("is_ancestor") is True,
        "runner_cleanup": (report.get("final_cleanup") or {}).get("ok") is True
                          and (report.get("final_cleanup") or {}).get("run_root_removed") is True,
        "scenario_cleanup": all((s.get("cleanup") or {}).get("ok") for s in report.get("scenarios", {}).values()),
        "next_tree_gone": next_cleanup.get("ok") is True and next_cleanup.get("pidfile_removed") is True,
        "postgres_container_gone": container_gone,
        "run_processes_gone": procs["ok"],
        "snapshot_diff_empty": diffs_empty,
    }
    ok = all(checks.values())
    host = {"ok": ok, "checks": checks, "diff_classification": classification, "process_check": procs,
            "finalized_at": utc_now(), "hostname": socket.gethostname(),
            "user": pwd.getpwuid(os.getuid()).pw_name}
    write_json(report_dir / "host-check.json", host)
    print(f"bridge-e2e host check: ok={ok} " + ",".join(k for k, v in checks.items() if not v))
    return 0 if ok else 1


def record_pid(pid: int, pidfile: Path) -> int:
    """At launch: record the session leader's pid, group and start identity for --stop-tree."""
    row = process_table().get(pid)
    if row is None:
        print("process not found", file=sys.stderr)
        return 1
    pidfile.write_text(json.dumps({"pid": pid, "pgid": row["pgid"], "start": row["start"]}) + "\n")
    return 0


def sanitize_file(src: Path, dst: Path) -> int:
    for name, label in (("MC_TOKEN", "token"), ("MC_DASHBOARD_PASSWORD", "dashboard-password"),
                        ("DATABASE_URL", "database-url")):
        REDACT.add(os.environ.get(name), label)
    return 0 if publish_log(src, dst)["published"] else 1


def host_main(argv: list[str]) -> int:
    if argv[0] == "--sanitize-file" and len(argv) == 3:
        return sanitize_file(Path(argv[1]), Path(argv[2]))
    if argv[0] == "--record-pid" and len(argv) == 3:
        return record_pid(int(argv[1]), Path(argv[2]).resolve())
    if argv[0] == "--snapshot" and len(argv) == 2:
        return host_snapshot(argv[1])
    if argv[0] == "--stop-tree" and len(argv) == 2:
        return host_stop_tree(Path(argv[1]).resolve())
    if argv[0] == "--finalize-host" and len(argv) == 1:
        return host_finalize()
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
