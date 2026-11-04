#!/usr/bin/env python3
"""Collect Claude Code usage metadata; dry-run by default, never infer a bill."""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shlex
import sys
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.parse
import urllib.request

MAX_FILES = 2000
MAX_SCAN_ENTRIES = 100_000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_LINE_BYTES = 1024 * 1024
MAX_RECORDS = 250_000
MAX_OBSERVATIONS = 100_000
MAX_PAYLOAD_BYTES = 20 * 1024 * 1024
MAX_RECEIPT_BYTES = 64 * 1024
MAX_CONFIG_BYTES = 256 * 1024
MAX_COUNTER = 2**53 - 1
MACHINE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MODEL = re.compile(r"^(?:anthropic/)?claude-[A-Za-z0-9][A-Za-z0-9._-]{0,149}$")
INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$")
COUNTERS = {
    "input_tokens": "input_tokens",
    "output_tokens": "output_tokens",
    "cache_read_input_tokens": "cache_read_tokens",
    "cache_creation_input_tokens": "cache_write_tokens",
    "reasoning_tokens": "reasoning_tokens",
}


class CollectorError(Exception):
    """Only fixed, non-sensitive error codes may be supplied."""


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("non-finite number")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def instant(value):
    if not isinstance(value, str) or not INSTANT.fullmatch(value):
        raise ValueError("invalid timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def identifier(value):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ValueError("invalid identifier")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("invalid identifier")
    return value


def digest(*values):
    raw = json.dumps(values, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def observation(record):
    """Extract an allowlist; no message text or arbitrary metadata survives."""
    if not isinstance(record, dict):
        raise ValueError("invalid record")
    if record.get("type") != "assistant":
        return None
    message = record.get("message")
    if not isinstance(message, dict):
        raise ValueError("invalid assistant")
    if "usage" not in message:
        return None  # Non-final assistant chunks need not contain usage.
    usage = message["usage"]
    if not isinstance(usage, dict):
        raise ValueError("invalid usage")
    model = message.get("model")
    if not isinstance(model, str) or not MODEL.fullmatch(model):
        raise ValueError("invalid model")
    session = identifier(record.get("sessionId"))
    request = identifier(record["requestId"] if "requestId" in record else message.get("id"))
    timestamp = instant(record.get("timestamp"))
    tokens = {}
    for raw_key, fact_key in COUNTERS.items():
        if raw_key in ("input_tokens", "output_tokens") and raw_key not in usage:
            raise ValueError("missing counter")
        value = usage.get(raw_key, 0)
        if type(value) is not int or not 0 <= value <= MAX_COUNTER:
            raise ValueError("invalid counter")
        tokens[fact_key] = value
    estimate = record.get("costUSD")
    if "costUSD" in record:
        if type(estimate) not in (int, float) or not math.isfinite(estimate) or not 0 <= estimate <= 1_000_000:
            raise ValueError("invalid estimate")
        estimate = round(float(estimate), 10)
    return {
        "key": digest("claude-request-v1", session, request),
        "session_hash": digest("claude-session-v1", session),
        "model": model,
        "first": timestamp,
        "last": timestamp,
        "tokens": tokens,
        "estimate": estimate,
    }


def collect(roots, machine, billing_mode, since, until, collected_at=None):
    if not MACHINE.fullmatch(machine) or billing_mode not in ("unknown", "subscription", "api"):
        raise CollectorError("invalid_collection_options")
    if since >= until:
        raise CollectorError("invalid_window")
    collected_at = collected_at or datetime.now(timezone.utc)
    counts = {key: 0 for key in (
        "files", "files_read", "records", "duplicates", "malformed_records",
        "unreadable_files", "scan_errors", "limits_reached", "bytes_read", "scan_entries",
    )}
    paths = set()

    def scan_error(_=None):
        counts["scan_errors"] += 1

    for root in roots:
        root = Path(root)
        if root.is_symlink():
            scan_error()
        elif root.is_file():
            if root.suffix == ".jsonl":
                paths.add(root)
            else:
                scan_error()
        elif root.is_dir():
            directories = [root]
            while directories:
                directory = directories.pop()
                try:
                    # Iterate entries instead of materializing an unbounded os.walk list.
                    with os.scandir(directory) as entries:
                        for entry in entries:
                            counts["scan_entries"] += 1
                            if counts["scan_entries"] > MAX_SCAN_ENTRIES:
                                counts["limits_reached"] += 1
                                break
                            try:
                                if entry.is_symlink():
                                    scan_error()
                                elif entry.is_dir(follow_symlinks=False):
                                    directories.append(Path(entry.path))
                                elif entry.name.endswith(".jsonl"):
                                    if entry.is_file(follow_symlinks=False):
                                        paths.add(Path(entry.path))
                                    else:
                                        scan_error()
                            except OSError:
                                scan_error()
                            if len(paths) > MAX_FILES:
                                break
                except OSError:
                    scan_error()
                if len(paths) > MAX_FILES or counts["scan_entries"] > MAX_SCAN_ENTRIES:
                    break
        else:
            scan_error()
        if len(paths) > MAX_FILES or counts["scan_entries"] > MAX_SCAN_ENTRIES:
            if len(paths) > MAX_FILES:
                counts["limits_reached"] += 1
            break
    counts["files"] = len(paths)
    observations = {}
    invalid_requests = set()
    stopped = False
    for path in sorted(paths)[:MAX_FILES]:
        if stopped:
            break
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                counts["limits_reached"] += 1
                continue
            with path.open("rb") as handle:
                counts["files_read"] += 1
                file_bytes = 0
                while True:
                    line = handle.readline(MAX_LINE_BYTES + 1)
                    if not line:
                        break
                    file_bytes += len(line)
                    counts["bytes_read"] += len(line)
                    if file_bytes > MAX_FILE_BYTES or counts["bytes_read"] > MAX_TOTAL_BYTES or counts["records"] >= MAX_RECORDS:
                        counts["limits_reached"] += 1
                        stopped = True
                        break
                    counts["records"] += 1
                    if len(line) > MAX_LINE_BYTES:
                        counts["limits_reached"] += 1
                        # Stop this file, rather than interpreting a continuation as JSON.
                        break
                    if not line.strip():
                        continue
                    try:
                        item = observation(strict_json(line.decode("utf-8")))
                    except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError):
                        counts["malformed_records"] += 1
                        continue
                    if item is None:
                        continue
                    key = item["key"]
                    if key in invalid_requests:
                        continue
                    previous = observations.get(key)
                    if previous is not None:
                        counts["duplicates"] += 1
                        if previous["model"] != item["model"]:
                            counts["malformed_records"] += 1
                            invalid_requests.add(key)
                            del observations[key]
                            continue
                        previous["first"] = min(previous["first"], item["first"])
                        previous["last"] = max(previous["last"], item["last"])
                        previous["tokens"] = {k: max(v, item["tokens"][k]) for k, v in previous["tokens"].items()}
                        if item["estimate"] is not None:
                            previous["estimate"] = max(previous["estimate"] or 0, item["estimate"])
                    elif len(observations) >= MAX_OBSERVATIONS:
                        counts["limits_reached"] += 1
                        stopped = True
                        break
                    else:
                        observations[key] = item
        except (OSError, ValueError):
            counts["unreadable_files"] += 1

    error_count = sum(counts[k] for k in ("malformed_records", "unreadable_files", "scan_errors", "limits_reached"))
    if not counts["files"]:
        error_count += 1
    coverage = {
        "version": 1, "provider": "claude_code", "scope": "scanned_local_files",
        "since": iso(since), "until": iso(until),
        "status": "partial" if error_count else "complete",
        "error_count": error_count, **counts,
    }
    account = "claude-code:" + machine
    facts = []
    for key, item in sorted(observations.items()):
        if not since <= item["last"] < until:
            continue
        priced = item["estimate"] is not None
        facts.append({
            "source": "claude_code", "account_id": account, "profile": machine,
            "session_id": "cc:" + key, "model": item["model"],
            "billing_provider": "anthropic", "billing_mode": "observation",
            "api_call_count": 1, **item["tokens"],
            "paid_cost_usd": 0, "shadow_cost_usd": item["estimate"] if priced else 0,
            "cost_status": "local_reported_estimate" if priced else "local_unpriced",
            "first_seen_at": iso(item["first"]), "last_seen_at": iso(item["last"]),
            "detail": {
                "version": 1, "machine": machine, "billing_mode": billing_mode,
                "cost_basis": "local_observation", "session_hash": item["session_hash"],
                "request_hash": key,
            },
        })
    coverage["observations"] = len(facts)
    return {
        "collected_at": iso(collected_at), "kind": "claude_code_observation", "facts": facts,
        "snapshot": {
            "account_id": account, "collected_at": iso(collected_at),
            "detail": {"machine": machine, "billing_mode": billing_mode, "coverage": coverage},
        },
    }


def summary(payload, published=False):
    facts = payload["facts"]
    priced = [f for f in facts if f["cost_status"] == "local_reported_estimate"]
    return {
        "ok": payload["snapshot"]["detail"]["coverage"]["status"] == "complete",
        "published": published,
        "account_id": payload["snapshot"]["account_id"],
        "billing_mode": payload["snapshot"]["detail"]["billing_mode"],
        "coverage": payload["snapshot"]["detail"]["coverage"],
        "tokens": {k: sum(f[k] for f in facts) for k in COUNTERS.values()},
        "priced_observations": len(priced), "unpriced_observations": len(facts) - len(priced),
        "known_reported_estimate_usd": round(sum(f["shadow_cost_usd"] for f in priced), 10) if priced else None,
        "actual_charges_usd": None,
    }


def payload_bytes(payload):
    raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise CollectorError("payload_too_large")
    return raw


def write_private(path, raw):
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw + b"\n")
    except OSError:
        raise CollectorError("output_unavailable") from None


def credentials(config=None, environ=None):
    if config is None:
        environ = os.environ if environ is None else environ
        values = {k: environ.get(k) for k in ("MC_URL", "MC_TOKEN")}
    else:
        try:
            with Path(config).open("rb") as handle:
                raw = handle.read(MAX_CONFIG_BYTES + 1)
            if len(raw) > MAX_CONFIG_BYTES:
                raise ValueError()
            values = {}
            for line in raw.decode("utf-8-sig").splitlines():
                matched = re.fullmatch(r"\s*(?:export\s+)?(MC_URL|MC_TOKEN)\s*=(.*)", line)
                if matched:
                    name, value = matched.groups()
                    parts = shlex.split(value, comments=True, posix=True)
                    if name in values or len(parts) != 1:
                        raise ValueError()
                    values[name] = parts[0]
        except (OSError, ValueError, UnicodeError):
            raise CollectorError("invalid_configuration") from None
    url, token = values.get("MC_URL"), values.get("MC_TOKEN")
    if not isinstance(url, str) or not isinstance(token, str) or not token or len(token) > 16384:
        raise CollectorError("invalid_configuration")
    if any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise CollectorError("invalid_configuration")
    return url, token


def origin(value, allow_loopback_http=False):
    try:
        if not isinstance(value, str) or not value or any(ord(c) <= 32 or ord(c) >= 127 for c in value):
            raise ValueError()
        if any(c in value for c in ("?", "#", "\\")):
            raise ValueError()
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.path not in ("", "/") or parsed.username is not None or parsed.password is not None:
            raise ValueError()
        host = parsed.hostname
        if not host or "%" in host:
            raise ValueError()
        loopback = host.lower() == "localhost"
        try:
            ip = ipaddress.ip_address(host)
            loopback = ip.is_loopback
            host = "[" + ip.compressed + "]" if ip.version == 6 else ip.compressed
        except ValueError:
            host = host.lower()
            if len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
                raise ValueError()
        if parsed.scheme == "http" and not (allow_loopback_http and loopback):
            raise ValueError()
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        if not 1 <= port <= 65535:
            raise ValueError()
        default = 443 if parsed.scheme == "https" else 80
        return parsed.scheme + "://" + host + (":" + str(port) if port != default else "")
    except (ValueError, TypeError, AttributeError):
        raise CollectorError("invalid_origin") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CollectorError("redirect_refused")


def publish(payload, config=None, expected_origin=None, allow_loopback_http=False, opener=None):
    raw = payload_bytes(payload)  # Validate/serialize the entire batch before transport.
    configured, token = credentials(config)
    target = origin(configured, allow_loopback_http)
    if expected_origin is not None and origin(expected_origin, allow_loopback_http) != target:
        raise CollectorError("origin_mismatch")
    endpoint = target + "/api/usage/ingest"
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(endpoint, data=raw, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json",
    })
    try:
        with opener.open(req, timeout=30) as response:
            if response.geturl() != endpoint or response.getcode() != 200:
                raise CollectorError("unexpected_response")
            body = response.read(MAX_RECEIPT_BYTES + 1)
        if len(body) > MAX_RECEIPT_BYTES:
            raise CollectorError("invalid_receipt")
        receipt = strict_json(body.decode("utf-8"))
        if not isinstance(receipt, dict) or receipt.get("ok") is not True or ("demo" in receipt and receipt["demo"] is not False):
            raise CollectorError("invalid_receipt")
        if type(receipt.get("written")) is not int or receipt["written"] != len(payload["facts"]):
            raise CollectorError("invalid_receipt")
    except CollectorError:
        raise
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        raise CollectorError("publish_failed") from None
    return {"ok": True, "written": receipt["written"]}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(1, '{"ok":false,"error":"invalid_arguments"}\n')


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("--machine", required=True, help="Stable non-secret machine label, e.g. macbook-pro")
    parser.add_argument("--roots", nargs="+", type=Path, default=[Path.home() / ".claude" / "projects"])
    parser.add_argument("--billing-mode", choices=("unknown", "subscription", "api"), default="unknown")
    parser.add_argument("--since", help="Inclusive timestamp with UTC offset")
    parser.add_argument("--until", help="Exclusive timestamp with UTC offset")
    parser.add_argument("--output", type=Path, help="Explicit new private payload file; existing files are never overwritten")
    parser.add_argument("--publish", action="store_true", help="Publish with existing MC_URL/MC_TOKEN")
    parser.add_argument("--config", type=Path, help="Existing literal env file; only read when publishing")
    parser.add_argument("--url", help="Assert the configured Fleet origin, never override it")
    parser.add_argument("--allow-loopback-http", action="store_true", help="Explicit test-only loopback HTTP allowance")
    args = parser.parse_args(argv)
    try:
        now = datetime.now(timezone.utc)
        try:
            until = instant(args.until) if args.until else now
            since = instant(args.since) if args.since else until - timedelta(days=30)
        except (ValueError, OverflowError):
            raise CollectorError("invalid_window") from None
        payload = collect(args.roots, args.machine, args.billing_mode, since, until, now)
        raw = payload_bytes(payload)
        if args.output:
            write_private(args.output, raw)
        if args.publish:
            publish(payload, args.config, args.url, args.allow_loopback_http)
        result = summary(payload, args.publish)
        print(json.dumps(result, separators=(",", ":"), allow_nan=False))
        return 0 if result["ok"] else 2
    except CollectorError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1
    except Exception:
        print('{"ok":false,"error":"collector_failed"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
