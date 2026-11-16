#!/usr/bin/env python3
"""Convert a saved velocity baseline to the dashboard's schemaVersion 1.

Usage: python3 convert_velocity.py INPUT.json OUTPUT.json [--receipt RECEIPT.json]

No network, credentials, database, or project-specific paths are used. Input is an
observed retrospective-window capture, not a reconstructed earlier capture. The
conversion keeps its original capture time and does not assert historical backlog.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import pathlib
import re
import statistics
import sys
import tempfile
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

METRIC_VERSION = "observed-development-velocity-v1.0"
CONVERTER_VERSION = "baseline-converter-v1.0.0"
MAX_BYTES = 2 * 1024 * 1024
REPO_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9_.-]{1,100}$")
HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
CD_CLASSES = ("production", "preview", "other")


class ConversionError(ValueError):
    """The input cannot be converted without inventing or losing measurements."""


def require(ok: bool, message: str) -> None:
    if not ok:
        raise ConversionError(message)


def count(value: Any, label: str, minimum: int = 0) -> int:
    require(type(value) is int and minimum <= value <= 10_000_000,
            f"{label}: expected an integer from {minimum} through 10000000")
    return value


def numeric(value: Any, label: str) -> float:
    require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1_000_000,
            f"{label}: expected a finite nonnegative sample <= 1000000")
    return value


def instant(value: Any, label: str) -> dt.datetime:
    require(isinstance(value, str), f"{label}: expected an ISO timestamp")
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ConversionError(f"{label}: invalid ISO timestamp") from exc
    require(result.tzinfo is not None, f"{label}: timestamp must include its UTC offset")
    return result.astimezone(dt.timezone.utc)


def canonical_bytes(value: Any) -> bytes:
    """Sorted object keys, original array order, UTF-8, no whitespace or newline."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def source_stats(values: list[float]) -> dict[str, Any]:
    """Exactly the saved analyzer's statistics and rounding convention."""
    values = sorted(values)
    if not values:
        return {"n": 0, "mean": None, "median": None, "p90": None, "max": None}
    return {
        "n": len(values), "mean": round(statistics.mean(values), 4),
        "median": round(statistics.median(values), 4),
        "p90": values[math.ceil(0.9 * len(values)) - 1], "max": values[-1],
    }


def observed_counts(prs: list[dict], targets: list[dict], days: int) -> dict[str, Any]:
    cohort = [p for p in prs if p["in_created_cohort"]]
    covered = [p for p in cohort if p["ci_state"] != "no_observed_pr_actions"]
    green = [p for p in covered if p["ci_state"] == "observed_green"]
    merged = [p for p in prs if p["merged_in_window"]]
    result = {
        "prs_created": len(cohort), "prs_merged": len(merged),
        "merged_per_week": round(len(merged) * 7 / days, 4),
        "open_prs_current": sum(p["current_state"] == "open" for p in prs),
        "created_cohort_with_pr_ci": len(covered),
        "created_cohort_observed_green": len(green),
        "created_cohort_no_observed_green": len(covered) - len(green),
        "created_cohort_no_pr_ci": len(cohort) - len(covered),
        "ci_revisions_to_green": source_stats([p["revisions_to_first_green"] for p in green]),
        "first_pass_prs": sum(p["first_pass"] is True for p in covered),
        "first_pass_rate_percent": round(100 * sum(p["first_pass"] is True for p in covered) / len(covered), 2) if covered else None,
        "hours_open_to_green": source_stats([p["hours_open_to_first_green"] for p in green]),
        "hours_open_to_merge": source_stats([p["hours_open_to_merge"] for p in merged]),
        "github_reruns_in_created_cohort": sum(p["github_reruns_observed"] for p in cohort),
        "same_sha_fresh_executions_in_created_cohort": sum(p["same_sha_fresh_executions_observed"] for p in cohort),
        "deployment_targets": len(targets),
        "deployment_targets_observed_success": sum(p["first_success_at"] is not None for p in targets),
        "deployment_records": sum(p["deployment_records"] for p in targets),
    }
    for kind in CD_CLASSES:
        rows = [p for p in targets if p["classification"] == kind]
        successes = [p["attempts_to_first_success"] for p in rows if p["first_success_at"] is not None]
        result[kind + "_cd"] = {
            "targets": len(rows), "observed_success": len(successes),
            "no_observed_success": len(rows) - len(successes),
            "deployment_records": sum(p["deployment_records"] for p in rows),
            "attempts_to_first_success_within_window": source_stats(successes),
        }
    return result


def stream_coverage(repo: dict, errors: list[dict], prs: list[dict], targets: list[dict]) -> dict[str, str]:
    """Do not turn a failed source into a measured zero."""
    result = {stream: "complete" for stream in ("prs", "ci", "cd")}

    def partial(stream: str) -> None:
        if result[stream] != "unavailable":
            result[stream] = "partial"

    if not repo["collected_complete"] and not errors:
        result = {stream: "partial" for stream in result}
    for error in errors:
        collection = error.get("collection") or {}
        if not isinstance(collection, dict):
            collection = {"unknown": collection}
        for key in collection:
            if key == "prs":
                result["prs"] = result["ci"] = "unavailable"
            elif key == "runs":
                result["ci"] = "unavailable"
            elif key == "deployments":
                result["cd"] = "unavailable"
            else:
                for stream in result:
                    partial(stream)
        history = error.get("history") or []
        if not isinstance(history, list):
            history = [history]
        for item in history:
            if isinstance(item, dict) and "run" in item:
                partial("ci")
            elif isinstance(item, dict) and ("missing_deployments" in item or "deployment_history_error" in item):
                partial("cd")
            else:
                partial("ci")
                partial("cd")
        if not collection and not history and not error.get("complete", True):
            for stream in result:
                partial(stream)
    if any(p.get("attempt_history_complete") is False for p in prs):
        partial("ci")
    if any(p.get("history_complete") is False for p in targets):
        partial("cd")
    return result


def convert_baseline(data: dict, input_bytes: bytes) -> tuple[dict, dict]:
    require(isinstance(data, dict), "Baseline must be a JSON object")
    require(data.get("metric_version") == METRIC_VERSION, "Unsupported metric_version")
    window = data["window"]
    start = instant(window["start"], "window.start")
    end = instant(window["end_exclusive"], "window.end_exclusive")
    captured = instant(data["recorded_at"], "recorded_at")
    require(start < end <= captured, "Window must end at or before the original capture time")
    require(isinstance(window["timezone"], str) and 1 <= len(window["timezone"]) <= 80,
            "Invalid reporting timezone")
    try:
        zone = ZoneInfo(window["timezone"])
    except ZoneInfoNotFoundError as exc:
        raise ConversionError("Unknown reporting timezone") from exc
    local_start, local_end = start.astimezone(zone), end.astimezone(zone)
    require(local_start.timetz().replace(tzinfo=None) == dt.time() and
            local_end.timetz().replace(tzinfo=None) == dt.time(),
            "Window must contain complete local calendar days")
    days = (local_end.date() - local_start.date()).days
    require(1 <= days <= 366, "Window must contain 1 through 366 complete local days")
    dates = [(local_start.date() + dt.timedelta(days=i)).isoformat() for i in range(days)]
    require(window.get("elapsed_hours") == round((end - start).total_seconds() / 3600, 4),
            "window.elapsed_hours does not match its timestamps")

    repo_rows, pr_rows, target_rows = data["repositories"], data["pull_requests"], data["deployment_targets"]
    require(isinstance(repo_rows, list) and len(repo_rows) <= 1000, "Invalid repository inventory")
    require(isinstance(pr_rows, list) and isinstance(target_rows, list), "Missing observation arrays")
    require(isinstance(data["collection_errors"], list), "collection_errors must be an array")
    inventory: dict[str, dict] = {}
    for row in repo_rows:
        require(isinstance(row, dict) and isinstance(row.get("repo"), str) and REPO_PATTERN.fullmatch(row["repo"]) is not None,
                "Invalid repository identifier")
        key = row["repo"].lower()
        require(key not in inventory, "Duplicate repository identifier, ignoring case")
        require(row["owner"].lower() == key.split("/")[0], f"{key}: owner does not match repository")
        for flag in ("archived", "fork", "collected_complete"):
            require(type(row[flag]) is bool, f"{key}: {flag} must be boolean")
        inventory[key] = row
    owners = sorted({key.split("/")[0] for key in inventory})
    require(1 <= len(owners) <= 20, "Snapshot must contain repositories from 1 through 20 owners")

    grouped_prs: dict[str, list[dict]] = collections.defaultdict(list)
    seen_prs: set[tuple[str, int]] = set()
    for p in pr_rows:
        key = p["repo"].lower()
        require(key in inventory, "PR observation references a repository outside inventory")
        number = count(p["number"], "PR number", 1)
        require((key, number) not in seen_prs, f"{key}#{number}: duplicate PR observation")
        seen_prs.add((key, number))
        label = f"{key}#{number}"
        created = instant(p["created_at"], label + ".created_at")
        merged = instant(p["merged_at"], label + ".merged_at") if p.get("merged_at") else None
        closed = instant(p["closed_at"], label + ".closed_at") if p.get("closed_at") else None
        require(type(p["in_created_cohort"]) is bool and p["in_created_cohort"] == (start <= created < end),
                label + ": created-cohort flag does not match the window")
        require(type(p["merged_in_window"]) is bool and p["merged_in_window"] == bool(merged and start <= merged < end),
                label + ": merged-cohort flag does not match the window")
        require(p["current_state"] in ("open", "closed"), label + ": invalid current state")
        require(merged is None or merged >= created, label + ": merge precedes creation")
        require(closed is None or closed >= created, label + ": closure precedes creation")
        if merged:
            numeric(p["hours_open_to_merge"], label + ".hours_open_to_merge")
            require(p["hours_open_to_merge"] == round((merged - created).total_seconds() / 3600, 4),
                    label + ": merge duration does not match timestamps")
        require(p["ci_state"] in ("observed_green", "no_observed_green", "no_observed_pr_actions"),
                label + ": unknown CI observation state")
        for field in ("github_reruns_observed", "same_sha_fresh_executions_observed"):
            count(p[field], label + "." + field)
        if p["ci_state"] == "observed_green":
            count(p["revisions_to_first_green"], label + ".revisions_to_first_green", 1)
            green = instant(p["first_green_at"], label + ".first_green_at")
            stop = min([end] + [t for t in (closed, merged) if t is not None])
            require(created <= green < stop, label + ": green timestamp is outside observed lifetime")
            numeric(p["hours_open_to_first_green"], label + ".hours_open_to_first_green")
            require(p["hours_open_to_first_green"] == round((green - created).total_seconds() / 3600, 4),
                    label + ": green duration does not match timestamps")
            require(p.get("attempt_history_complete") is not False, label + ": success has incomplete attempt history")
            reruns = count(p["reruns_before_first_green"], label + ".reruns_before_first_green")
            repeats = count(p["fresh_repeats_before_first_green"], label + ".fresh_repeats_before_first_green")
            require(type(p["first_pass"]) is bool and p["first_pass"] ==
                    (p["revisions_to_first_green"] == 1 and reruns == 0 and repeats == 0),
                    label + ": first-pass flag does not reconcile")
        else:
            require(p.get("first_green_at") is None and p.get("revisions_to_first_green") is None,
                    label + ": a non-green observation contains a green result")
            require(p.get("first_pass") is not True, label + ": a non-green PR cannot be first-pass")
        grouped_prs[key].append(p)

    grouped_targets: dict[str, list[dict]] = collections.defaultdict(list)
    seen_targets: set[tuple[str, str, str]] = set()
    for target in target_rows:
        key = target["repo"].lower()
        require(key in inventory, "Deployment observation references a repository outside inventory")
        ident = (key, target["sha"], target["environment"])
        require(ident not in seen_targets, f"{key}: duplicate deployment target")
        seen_targets.add(ident)
        require(target["classification"] in CD_CLASSES, f"{key}: unsupported deployment classification")
        records = count(target["deployment_records"], key + ".deployment_records", 1)
        submitted = instant(target["first_submitted_at"], key + ".first_submitted_at")
        require(start <= submitted < end, f"{key}: deployment submission is outside the window")
        if target.get("first_success_at") is not None:
            success = instant(target["first_success_at"], key + ".first_success_at")
            require(submitted <= success < end, f"{key}: deployment success is outside its observed lifetime")
            attempts = count(target["attempts_to_first_success"], key + ".attempts_to_first_success", 1)
            require(attempts <= records, f"{key}: deployment success attempts exceed records")
        else:
            require(target.get("attempts_to_first_success") is None, f"{key}: unsuccessful target has success samples")
        grouped_targets[key].append(target)

    errors_by_repo: dict[str, list[dict]] = collections.defaultdict(list)
    for error in data["collection_errors"]:
        require(isinstance(error, dict) and isinstance(error.get("repo"), str), "Malformed collection error")
        key = error["repo"].lower()
        require(key in inventory, "Collection error references an unknown repository")
        errors_by_repo[key].append(error)

    checked = 0

    def equal(label: str, actual: Any, expected: Any) -> None:
        nonlocal checked
        require(actual == expected, f"{label}: source summary does not reconcile ({actual!r} != {expected!r})")
        checked += 1

    def reconcile(label: str, actual: dict, source: dict) -> None:
        for field, value in actual.items():
            require(field in source, f"{label}: missing source summary field {field}")
            equal(label + "." + field, value, source[field])

    output_repos = []
    per_repo_receipts = []
    for key, row in sorted(inventory.items()):
        prs, targets = grouped_prs[key], grouped_targets[key]
        actual = observed_counts(prs, targets, days)
        reconcile(key, actual, row)
        cohort = [p for p in prs if p["in_created_cohort"]]
        green = [p for p in cohort if p["ci_state"] == "observed_green"]
        merged = [p for p in prs if p["merged_in_window"]]
        revision_samples = sorted(p["revisions_to_first_green"] for p in green)
        merge_samples = sorted(p["hours_open_to_merge"] for p in merged)
        require(len(revision_samples) <= 100_000 and len(merge_samples) <= 100_000,
                key + ": sample count exceeds dashboard schema limits")
        daily = {date: {"date": date, "opened": 0, "merged": 0} for date in dates}
        for p in cohort:
            daily[instant(p["created_at"], "PR.created_at").astimezone(zone).date().isoformat()]["opened"] += 1
        for p in merged:
            daily[instant(p["merged_at"], "PR.merged_at").astimezone(zone).date().isoformat()]["merged"] += 1
        equal(key + ".daily.opened", sum(d["opened"] for d in daily.values()), row["prs_created"])
        equal(key + ".daily.merged", sum(d["merged"] for d in daily.values()), row["prs_merged"])
        coverage = stream_coverage(row, errors_by_repo[key], prs, targets)
        cds = {}
        for kind in CD_CLASSES:
            cd = actual[kind + "_cd"]
            attempts = sorted(t["attempts_to_first_success"] for t in targets
                              if t["classification"] == kind and t["first_success_at"] is not None)
            require(len(attempts) <= 100_000, key + ": CD sample count exceeds dashboard schema limits")
            cds[kind] = {"targets": cd["targets"], "records": cd["deployment_records"], "attempts": attempts}
            equal(key + "." + kind + ".success_samples", len(attempts), row[kind + "_cd"]["observed_success"])
        output_repos.append({
            "repo": key, "archived": row["archived"], "fork": row["fork"], "coverage": coverage,
            "prs": None if coverage["prs"] == "unavailable" else {
                "opened": actual["prs_created"], "merged": actual["prs_merged"],
                "openCurrent": actual["open_prs_current"], "mergeHours": merge_samples,
                "daily": list(daily.values()),
            },
            "ci": None if coverage["ci"] == "unavailable" else {
                "covered": actual["created_cohort_with_pr_ci"], "noGreen": actual["created_cohort_no_observed_green"],
                "noCI": actual["created_cohort_no_pr_ci"], "revisionSamples": revision_samples,
                "firstPass": actual["first_pass_prs"], "reruns": actual["github_reruns_in_created_cohort"],
                "sameShaRepeats": actual["same_sha_fresh_executions_in_created_cohort"],
            },
            "cd": None if coverage["cd"] == "unavailable" else cds,
        })
        per_repo_receipts.append({"repo": key, "opened": actual["prs_created"], "merged": actual["prs_merged"],
                                  "ciSuccessSamples": len(revision_samples), "mergeHourSamples": len(merge_samples),
                                  "cdSuccessSamples": {kind: len(cds[kind]["attempts"]) for kind in CD_CLASSES},
                                  "coverage": coverage})

    global_actual = observed_counts(pr_rows, target_rows, days)
    reconcile("summary", global_actual, data["summary"])
    owner_counts = dict(collections.Counter(key.split("/")[0] for key in inventory))
    source_owners = data["summary"]["owners"]
    require(isinstance(source_owners, dict) and len({o.lower() for o in source_owners}) == len(source_owners),
            "Summary owners contain duplicate or invalid identifiers")
    equal("summary.owners", owner_counts, {owner.lower(): n for owner, n in source_owners.items()})
    for field, value in {
        "repository_count": len(inventory),
        "archived_repositories": sum(r["archived"] for r in repo_rows),
        "fork_repositories": sum(r["fork"] for r in repo_rows),
        "repositories_with_pr_activity": sum(bool(r["prs_created"] or r["prs_merged"]) for r in repo_rows),
        "repositories_with_pr_ci_cohort": sum(r["created_cohort_with_pr_ci"] > 0 for r in repo_rows),
        "repositories_with_deployment_records": sum(r["deployment_records"] > 0 for r in repo_rows),
    }.items():
        equal("summary." + field, value, data["summary"][field])

    manifest = data["source_hashes"]
    require(isinstance(manifest, list) and len(manifest) > 0, "Source hash manifest is missing")
    manifest_paths = set()
    for item in manifest:
        require(isinstance(item, dict) and isinstance(item.get("file"), str) and item["file"] and
                isinstance(item.get("sha256"), str) and HASH_PATTERN.fullmatch(item["sha256"]) is not None,
                "Malformed source hash manifest entry")
        require(item["file"] not in manifest_paths, "Duplicate source hash manifest path")
        manifest_paths.add(item["file"])
    artifact_hash = hashlib.sha256(input_bytes).hexdigest()
    evidence_hash = hashlib.sha256(canonical_bytes(manifest)).hexdigest()
    inventory_complete = (not data["collection_errors"] and all(r["collected_complete"] for r in repo_rows)
                          and all(all(v == "complete" for v in r["coverage"].values()) for r in output_repos))
    snapshot = {
        "schemaVersion": 1, "metricVersion": METRIC_VERSION, "capturedAt": data["recorded_at"],
        "captureKind": "observed",
        "window": {"start": window["start"], "end": window["end_exclusive"], "days": days, "timezone": window["timezone"]},
        "scope": {"owners": owners, "includeForks": True, "includeArchived": True, "cohort": "pr-created-in-window"},
        "inventoryComplete": inventory_complete,
        "source": {"artifactSha256": artifact_hash, "evidenceSha256": evidence_hash, "collectorVersion": CONVERTER_VERSION},
        "repositories": output_repos,
    }
    payload = canonical_bytes(snapshot) + b"\n"
    require(len(payload) <= MAX_BYTES, "Converted snapshot exceeds dashboard's 2 MiB limit")
    receipt = {
        "converterVersion": CONVERTER_VERSION, "status": "pass",
        "sourceArtifactSha256": artifact_hash, "sourceEvidenceManifestSha256": evidence_hash,
        "outputSnapshotSha256": hashlib.sha256(payload).hexdigest(), "outputBytes": len(payload),
        "sourceManifestEntries": len(manifest), "reconciliationChecksPassed": checked,
        "schemaVersion": 1, "metricVersion": METRIC_VERSION, "capturedAt": data["recorded_at"],
        "window": snapshot["window"], "inventoryComplete": inventory_complete,
        "inventory": {"repositories": len(inventory), "owners": owner_counts,
                      "archived": sum(r["archived"] for r in repo_rows), "forks": sum(r["fork"] for r in repo_rows)},
        "sourceRecomputedSummary": global_actual,
        "exactAnchors": {
            "ciRevisionSamples": global_actual["ci_revisions_to_green"]["n"],
            "ciRevisionSum": sum(p["revisions_to_first_green"] for p in pr_rows
                                 if p["in_created_cohort"] and p["ci_state"] == "observed_green"),
            "mergeHourSamples": global_actual["hours_open_to_merge"]["n"],
            "mergeHoursSumRounded4": round(sum(p["hours_open_to_merge"] for p in pr_rows if p["merged_in_window"]), 4),
            "dailyOpened": sum(d["opened"] for r in output_repos if r["prs"] for d in r["prs"]["daily"]),
            "dailyMerged": sum(d["merged"] for r in output_repos if r["prs"] for d in r["prs"]["daily"]),
        },
        "repositories": per_repo_receipts,
        "limitations": [
            "Observed means an actual measurement of a retrospective reporting window, not an earlier reconstructed capture.",
            "openCurrent is the retrieval-time backlog, not historical backlog at the reporting cutoff.",
            "CI samples mean observed Actions-tested revisions to green, not required-check certification or review rounds.",
            "CD samples count observed GitHub deployment records within the window; earlier and provider-internal attempts are not represented.",
            "Input evidence hashes are preserved and hashed as a manifest; source evidence files are not opened by this converter.",
            "This compact schema omits PR details, time-to-green samples, and workflow-run diagnostics; the source artifact remains authoritative.",
        ],
    }
    return snapshot, receipt


def read_baseline(raw: bytes) -> dict:
    def pairs(items: list[tuple[str, Any]]) -> dict:
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate JSON object key")
            result[key] = value
        return result

    def invalid_constant(value: str) -> None:
        raise ConversionError("Non-finite JSON constant: " + value)

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def atomic_write(path: pathlib.Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(prefix="." + path.name + ".", suffix=".tmp", dir=path.parent, delete=False) as f:
            temp = pathlib.Path(f.name)
            f.write(content)
        temp.replace(path)
    finally:
        if temp is not None and temp.exists():
            temp.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=pathlib.Path, help="Saved observed-development-velocity-v1.0 baseline JSON")
    parser.add_argument("output", type=pathlib.Path, help="Dashboard snapshot JSON path")
    parser.add_argument("--receipt", type=pathlib.Path, help="Optional parity receipt JSON path")
    args = parser.parse_args(argv)
    try:
        paths = [args.input.resolve(), args.output.resolve()] + ([args.receipt.resolve()] if args.receipt else [])
        require(len(set(paths)) == len(paths), "Input, output, and receipt paths must be distinct")
        raw = args.input.read_bytes()
        snapshot, receipt = convert_baseline(read_baseline(raw), raw)
        atomic_write(args.output, canonical_bytes(snapshot) + b"\n")
        if args.receipt:
            atomic_write(args.receipt, json.dumps(receipt, indent=2, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n")
        print(json.dumps({"status": "pass", "output": str(args.output), "outputBytes": receipt["outputBytes"],
                          "repositories": len(snapshot["repositories"]), "checks": receipt["reconciliationChecksPassed"],
                          "receipt": str(args.receipt) if args.receipt else None}))
        return 0
    except (ConversionError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        print("Conversion rejected: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
