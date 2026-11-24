"""Retirement artifact builder for the Claude Reviewer (#176, AC 76, 92, 93, 103, 104).

    python3 -m agents.reviewer.retirement_report --schedule <file> --state-dir <dir> \
        --receipts <file> --phase dry-run|live --out <file>

--schedule   text file, one ISO UTC `scheduled_at` per line (YYYY-MM-DDTHH:MM:SSZ); blank lines ignored
--receipts   JSONL export of the runner's receipts; each object carries `scheduled_at`,
             `observed_at`, `receipt_http_status`, `app_login` and optionally the receipt
             `detail` (the runner writes exactly this to state_dir/receipts.jsonl)
--state-dir  the runner's state dir; reviews.jsonl (live) and would-be.jsonl (dry-run) are read

Writes one JSON object per schedule line (AC 76):
  scheduled_at, observed_at, receipt_http_status, app_login, posted, budget_total_microusd,
  sla_breaches, missing_run   (+ would_be in the dry-run phase, AC 103)

A scheduled run counts as received only when its receipt was accepted by AK (HTTP 2xx); a run
with no receipt, or a receipt AK did not accept, is written with nulls, zeros and
`missing_run: true`.

Exit 0: every scheduled run has a receipt and every record validates.
Exit 1: one or more runs missing (records still written).
Exit 2: malformed input (bad timestamp, duplicate or unmatched scheduled_at, bad JSON or field,
        a live review inside a dry-run window, a mode that contradicts --phase).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Sequence

from .common import SHA_RE, atomic_write, iso_instant, strict_json

SCHEDULE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
MAX_INPUT_BYTES = 64 * 1024 * 1024
POSTED_FIELDS = ("repo", "number", "head_sha", "app_login", "provenance", "phase")


class Malformed(Exception):
    pass


def _read(path: str) -> bytes:
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_INPUT_BYTES + 1)
    except OSError:
        raise Malformed("unreadable input") from None
    if len(data) > MAX_INPUT_BYTES:
        raise Malformed("input too large")
    return data


def _jsonl(path: str, missing_ok: bool) -> List[Any]:
    if missing_ok and not os.path.exists(path):
        return []
    rows = []
    for raw in _read(path).splitlines():
        if not raw.strip():
            continue
        try:
            rows.append(strict_json(raw))
        except (ValueError, UnicodeError, RecursionError):
            raise Malformed("malformed JSON line") from None
    return rows


def read_schedule(path: str) -> List[str]:
    try:
        lines = _read(path).decode("utf-8").splitlines()
    except UnicodeError:
        raise Malformed("schedule is not UTF-8") from None
    out: List[str] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if SCHEDULE_RE.fullmatch(line) is None or not iso_instant(line):
            raise Malformed("malformed scheduled_at")
        if line in out:
            raise Malformed("duplicate scheduled_at in schedule")
        out.append(line)
    return out


def _nonneg_int(value: Any) -> bool:
    return type(value) is int and value >= 0


def read_receipts(path: str, schedule: Sequence[str], phase: str) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for row in _jsonl(path, missing_ok=False):
        if not isinstance(row, dict):
            raise Malformed("receipt is not an object")
        slot = row.get("scheduled_at")
        if not isinstance(slot, str) or SCHEDULE_RE.fullmatch(slot) is None:
            raise Malformed("malformed receipt scheduled_at")
        if slot not in schedule:
            raise Malformed("receipt scheduled_at not in schedule")
        if slot in out:
            raise Malformed("duplicate receipt scheduled_at")
        observed = row.get("observed_at")
        if observed is not None and not iso_instant(observed):
            raise Malformed("malformed observed_at")
        status = row.get("receipt_http_status")
        if status is not None and (type(status) is not int or not 100 <= status <= 599):
            raise Malformed("malformed receipt_http_status")
        login = row.get("app_login")
        if login is not None and (not isinstance(login, str) or not login):
            raise Malformed("malformed app_login")
        mode = row.get("mode")
        if mode is not None and mode != phase:
            raise Malformed("receipt mode contradicts --phase")
        detail = row.get("detail", {})
        if not isinstance(detail, dict):
            raise Malformed("malformed detail")
        for key in ("spend_microusd_today", "sla_breaches"):
            if key in detail and not _nonneg_int(detail[key]):
                raise Malformed("malformed " + key)
        if "scheduled_at" in detail and detail["scheduled_at"] != slot:
            raise Malformed("detail scheduled_at mismatch")
        out[slot] = row
    return out


def _ledger_entries(rows: List[Any], schedule: Sequence[str], expected_phase: str) -> Dict[str, List[dict]]:
    by_slot: Dict[str, List[dict]] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise Malformed("ledger line is not an object")
        slot = row.get("scheduled_at")
        if not isinstance(slot, str) or SCHEDULE_RE.fullmatch(slot) is None:
            raise Malformed("ledger line scheduled_at")
        if slot not in schedule:
            continue  # outside this phase's window
        entry = {key: row.get(key) for key in POSTED_FIELDS}
        if (not isinstance(entry["repo"], str) or type(entry["number"]) is not int or entry["number"] <= 0
                or not isinstance(entry["head_sha"], str) or SHA_RE.fullmatch(entry["head_sha"]) is None
                or not isinstance(entry["app_login"], str)
                or not isinstance(entry["provenance"], list) or not all(isinstance(v, str) for v in entry["provenance"])
                or entry["phase"] not in ("live", "dry-run")):
            raise Malformed("malformed ledger line")
        if entry["phase"] != expected_phase:
            raise Malformed("ledger phase mismatch")
        by_slot.setdefault(slot, []).append(entry)
    return by_slot


def build(schedule: Sequence[str], receipts: Dict[str, dict], phase: str, state_dir: str) -> List[dict]:
    reviews = _jsonl(os.path.join(state_dir, "reviews.jsonl"), missing_ok=True)
    live = _ledger_entries(reviews, schedule, "live")
    if phase == "dry-run" and live:
        raise Malformed("live review inside a dry-run window")
    would_be = _ledger_entries(_jsonl(os.path.join(state_dir, "would-be.jsonl"), missing_ok=True), schedule, "dry-run") \
        if phase == "dry-run" else {}
    records: List[dict] = []
    for slot in schedule:
        receipt = receipts.get(slot)
        status = receipt.get("receipt_http_status") if receipt else None
        received = receipt is not None and status is not None and 200 <= status < 300
        if received:
            detail = receipt.get("detail") or {}
            record = {
                "scheduled_at": slot,
                "observed_at": receipt.get("observed_at"),
                "receipt_http_status": status,
                "app_login": receipt.get("app_login"),
                "posted": live.get(slot, []) if phase == "live" else [],
                "budget_total_microusd": detail.get("spend_microusd_today", 0),
                "sla_breaches": detail.get("sla_breaches", 0),
                "missing_run": False,
            }
        else:
            record = {
                "scheduled_at": slot, "observed_at": None, "receipt_http_status": None, "app_login": None,
                "posted": [], "budget_total_microusd": 0, "sla_breaches": 0, "missing_run": True,
            }
        if phase == "dry-run":
            record["would_be"] = would_be.get(slot, []) if received else []
        records.append(record)
    return records


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "retirement_report: invalid arguments.\n")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _Parser(description="Build the #176 retirement artifact")
    parser.add_argument("--schedule", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--receipts", required=True)
    parser.add_argument("--phase", required=True, choices=("dry-run", "live"))
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        schedule = read_schedule(args.schedule)
        receipts = read_receipts(args.receipts, schedule, args.phase)
        records = build(schedule, receipts, args.phase, args.state_dir)
    except Malformed as exc:
        sys.stderr.write("retirement_report: " + str(exc) + ".\n")
        return 2
    text = "".join(json.dumps(r, separators=(",", ":"), sort_keys=True) + "\n" for r in records)
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    atomic_write(os.path.abspath(args.out), text.encode("utf-8"), mode=0o644)
    missing = sum(1 for r in records if r["missing_run"])
    sys.stdout.write("retirement_report: %d scheduled runs, %d missing.\n" % (len(records), missing))
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
