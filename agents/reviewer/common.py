"""Shared helpers for the Claude Reviewer: strict JSON, grammars, atomic files.

Standard library only (Python 3.9+). Nothing here logs a value it was given.
"""
from __future__ import annotations

import datetime as dt
import decimal
import json
import os
import re
import tempfile
from typing import Any, Optional

# Head SHA grammar shared with src/lib/sweep-evidence.ts and scripts/sweep-producer.sh (AC 33).
SHA_RE = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
# Queue id grammar from src/lib/sweep-evidence.ts QUEUE_ID.
QUEUE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._:/-]{0,127}$")
REPO_PART_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
# Exact trailer regex from scripts/collect-progress.sh (jq: "(?im)^Agent-Vendor:[ \t]+(?<v>...)[ \t]*$").
TRAILER_RE = re.compile(r"^Agent-Vendor:[ \t]+(?P<v>[A-Za-z0-9][A-Za-z0-9._-]{0,31})[ \t]*$", re.IGNORECASE | re.MULTILINE)

MAX_JSON_BYTES = 8 * 1024 * 1024


class ReviewerError(Exception):
    """Carries only a fixed, non-sensitive category string."""


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _constant(_value):
    raise ValueError("non-finite constant")


def strict_json(raw: Any) -> Any:
    """Parse JSON rejecting duplicate keys and NaN/Infinity; floats become Decimal.

    Integers stay int. A float literal that overflows to a non-finite Decimal is rejected by
    callers via is_finite_decimal; Decimal itself never overflows on parse.
    """
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8")
    if not isinstance(raw, str):
        raise ValueError("not text")
    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=_constant, parse_float=decimal.Decimal)


def is_int(value: Any) -> bool:
    return type(value) is int


def is_finite_decimal(value: Any) -> bool:
    return isinstance(value, decimal.Decimal) and value.is_finite()


def to_decimal(value: Any) -> Optional[decimal.Decimal]:
    """A JSON number (int or Decimal) as a finite Decimal; bools, strings and others are None."""
    if type(value) is int:
        return decimal.Decimal(value)
    if isinstance(value, decimal.Decimal) and value.is_finite():
        return value
    return None


def canonical_decimal(value: decimal.Decimal) -> str:
    """Plain (non-exponent) canonical string: trailing zeros removed, '0' for zero."""
    if value == 0:
        return "0"
    text = format(value.normalize(), "f")
    return text


def iso_instant(value: Any) -> bool:
    if not isinstance(value, str) or ISO_RE.fullmatch(value) is None:
        return False
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def parse_iso(value: str) -> dt.datetime:
    text = value.replace("Z", "+00:00")
    # Python 3.9 fromisoformat accepts at most 6 fractional digits.
    match = re.match(r"^(.*T\d{2}:\d{2}:\d{2})(\.\d+)?(.*)$", text)
    if match and match.group(2) and len(match.group(2)) > 7:
        text = match.group(1) + match.group(2)[:7] + match.group(3)
    return dt.datetime.fromisoformat(text).astimezone(dt.timezone.utc)


def iso_z(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def atomic_write(path: str, data: bytes, mode: int = 0o600) -> None:
    """Write a temp file next to `path` and os.replace it in (AC 102)."""
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_line(path: str, record: dict) -> None:
    line = json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def read_jsonl(path: str) -> list:
    rows = []
    try:
        with open(path, "rb") as handle:
            for raw in handle:
                raw = raw.strip()
                if raw:
                    rows.append(strict_json(raw))
    except FileNotFoundError:
        return []
    return rows


def bounded_file(path: str, maximum: int, category: str) -> bytes:
    try:
        with open(path, "rb") as handle:
            data = handle.read(maximum + 1)
    except (OSError, ValueError):
        raise ReviewerError(category) from None
    if not data or len(data) > maximum:
        raise ReviewerError(category)
    return data


def json_dumps(value: Any) -> str:
    def default(obj):
        if isinstance(obj, decimal.Decimal):
            return canonical_decimal(obj)
        raise TypeError("unserializable")
    return json.dumps(value, separators=(",", ":"), sort_keys=True, default=default)


# The roots sandbox.sb denies to the Claude subprocess (AC 107). Kept in step with the
# profile by a test. Every secret and state path must resolve under one of them.
SANDBOX_DENIED_ROOTS = ("/Users", "/private/var/folders", "/private/tmp", "/Volumes", "/opt/homebrew/etc")


def within_roots(path: str, roots) -> bool:
    """True when the symlink-resolved path is one of `roots` or lies beneath one."""
    real = os.path.realpath(path)
    return any(real == root or real.startswith(root.rstrip("/") + "/") for root in roots)

