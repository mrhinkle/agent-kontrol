"""State-dir ledgers for the Claude Reviewer (AC 11, 13, 41, 42, 53, 66, 84, 93, 102).

Every mutation happens under the runner flock held by claude_reviewer.Runner.

Files in state_dir:
- spend-YYYY-MM-DD.json   per-UTC-day spend ledger, atomically replaced (AC 102)
- invalid-output.json     invalid-output counts per (repo, PR, head SHA) (AC 53)
- reviews.jsonl           one line per successful live POST, or reconciled review (AC 41, 84, 93)
- would-be.jsonl          one line per dry-run would-be review (AC 93, 103)
- would-be/<...>.md       the dry-run would-be bodies (AC 15)
- outcomes.jsonl          per-candidate outcomes, rotated at 10,000 lines (AC 66)
- receipts.jsonl          one line per receipt attempt (the retirement report's receipts export)
- errors.log              bounded local error lines with fixed categories only
"""
from __future__ import annotations

import datetime as dt
import decimal
import json
import os
from typing import Any, Dict, List, Optional

from .common import (ReviewerError, append_line, atomic_write, canonical_decimal, iso_z, read_jsonl,
                     strict_json, to_decimal)

OUTCOME_ROTATE_LINES = 10_000
ERROR_LOG_MAX_BYTES = 256 * 1024
INVALID_OUTPUT_MAX_KEYS = 10_000
DEFAULT_ESTIMATE = decimal.Decimal("1.00")
MICRO = decimal.Decimal(1_000_000)


def item_key(repo: str, number: int, head_sha: str) -> str:
    return "%s#%d@%s" % (repo, number, head_sha)


class SpendLedger:
    """state_dir/spend-YYYY-MM-DD.json: invocation timestamps, canonical decimal costs, total."""

    def __init__(self, state_dir: str, day: dt.date):
        self.path = os.path.join(state_dir, "spend-%s.json" % day.isoformat())
        self.day = day.isoformat()
        self.invocations: List[Dict[str, str]] = []
        self.halted = False
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "rb") as handle:
                data = strict_json(handle.read())
        except FileNotFoundError:
            return
        except (OSError, ValueError, UnicodeError):
            # An unreadable ledger is unknown spend: fail closed for the day.
            self.halted = True
            return
        if (not isinstance(data, dict) or set(data) != {"date", "invocations", "total_usd", "halted"}
                or data["date"] != self.day or type(data["halted"]) is not bool
                or not isinstance(data["invocations"], list)):
            self.halted = True
            return
        for item in data["invocations"]:
            if (not isinstance(item, dict) or set(item) != {"at", "cost_usd"} or not isinstance(item["at"], str)
                    or not isinstance(item["cost_usd"], str)):
                self.halted = True
                return
            try:
                cost = decimal.Decimal(item["cost_usd"])
            except decimal.InvalidOperation:
                self.halted = True
                return
            if not cost.is_finite() or cost < 0:
                self.halted = True
                return
            self.invocations.append({"at": item["at"], "cost_usd": canonical_decimal(cost)})
        self.halted = self.halted or data["halted"]

    @property
    def total(self) -> decimal.Decimal:
        return sum((decimal.Decimal(item["cost_usd"]) for item in self.invocations), decimal.Decimal(0))

    @property
    def count(self) -> int:
        return len(self.invocations)

    def estimate(self) -> decimal.Decimal:
        """Median of the ten most recent charged invocations by time; $1.00 with fewer than ten."""
        if len(self.invocations) < 10:
            return DEFAULT_ESTIMATE
        recent = sorted(self.invocations, key=lambda item: item["at"])[-10:]
        costs = sorted(decimal.Decimal(item["cost_usd"]) for item in recent)
        return (costs[4] + costs[5]) / 2

    def blocks(self, cap: decimal.Decimal, max_reviews: int) -> bool:
        if self.halted or self.count >= max_reviews:
            return True
        return self.total + self.estimate() > cap

    def charge(self, at: dt.datetime, cost: decimal.Decimal) -> None:
        self.invocations.append({"at": at.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                                 "cost_usd": canonical_decimal(cost)})
        self._save()

    def halt(self) -> None:
        self.halted = True
        self._save()

    def micro_usd(self) -> int:
        return int((self.total * MICRO).quantize(decimal.Decimal(1), rounding=decimal.ROUND_HALF_UP))

    def _save(self) -> None:
        data = {"date": self.day, "invocations": self.invocations, "total_usd": canonical_decimal(self.total),
                "halted": self.halted}
        atomic_write(self.path, (json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8"))


class InvalidOutputLedger:
    """AC 53: persisted invalid-output count per (repo, PR, head SHA); a new head starts at zero."""

    def __init__(self, state_dir: str):
        self.path = os.path.join(state_dir, "invalid-output.json")
        self.counts: Dict[str, int] = {}
        try:
            with open(self.path, "rb") as handle:
                data = strict_json(handle.read())
            if isinstance(data, dict) and all(isinstance(k, str) and type(v) is int and v >= 0 for k, v in data.items()):
                self.counts = data
            else:
                raise ValueError("bad ledger")
        except FileNotFoundError:
            pass
        except (OSError, ValueError, UnicodeError):
            raise ReviewerError("invalid-output ledger unreadable") from None

    def count(self, key: str) -> int:
        return self.counts.get(key, 0)

    def increment(self, key: str) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        if len(self.counts) > INVALID_OUTPUT_MAX_KEYS:
            for old in sorted(self.counts)[: len(self.counts) - INVALID_OUTPUT_MAX_KEYS]:
                if old != key:
                    del self.counts[old]
        atomic_write(self.path, (json.dumps(self.counts, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8"))
        return self.counts[key]


def review_lines(state_dir: str) -> List[dict]:
    return read_jsonl(os.path.join(state_dir, "reviews.jsonl"))


def would_be_lines(state_dir: str) -> List[dict]:
    return read_jsonl(os.path.join(state_dir, "would-be.jsonl"))


def has_line(rows: List[dict], repo: str, number: int, head_sha: str) -> bool:
    return any(isinstance(row, dict) and row.get("repo") == repo and row.get("number") == number
               and row.get("head_sha") == head_sha for row in rows)


def append_review(state_dir: str, record: dict) -> None:
    append_line(os.path.join(state_dir, "reviews.jsonl"), record)


def append_would_be(state_dir: str, record: dict, body: str) -> None:
    folder = os.path.join(state_dir, "would-be")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    name = "%s-%d-%s.md" % (record["repo"].replace("/", "__"), record["number"], record["head_sha"])
    atomic_write(os.path.join(folder, name), (body + "\n").encode("utf-8"))
    append_line(os.path.join(state_dir, "would-be.jsonl"), record)


def append_outcome(state_dir: str, record: dict) -> None:
    """AC 66: bounded per-candidate outcome log, rotated at 10,000 lines (one previous file kept)."""
    path = os.path.join(state_dir, "outcomes.jsonl")
    try:
        with open(path, "rb") as handle:
            lines = sum(1 for _ in handle)
    except FileNotFoundError:
        lines = 0
    if lines >= OUTCOME_ROTATE_LINES:
        os.replace(path, path + ".1")
    append_line(path, record)


def append_receipt(state_dir: str, record: dict) -> None:
    append_line(os.path.join(state_dir, "receipts.jsonl"), record)


def error_line(state_dir: Optional[str], category: str, at: dt.datetime) -> None:
    """One bounded local error line; `category` is always a fixed string from this package."""
    if not state_dir:
        return
    path = os.path.join(state_dir, "errors.log")
    try:
        if os.path.exists(path) and os.path.getsize(path) > ERROR_LOG_MAX_BYTES:
            os.replace(path, path + ".1")
        append_line(path, {"at": iso_z(at), "error": category[:120]})
    except OSError:
        pass
