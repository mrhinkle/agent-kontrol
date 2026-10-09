#!/usr/bin/env python3
"""collect_usage.py — Hermes → Agent Kontrol Usage and Costs collector.

Read-only walk of Hermes state.db files (host profiles + Neuro container),
price/classify each session_model_usage row, POST to /api/usage/ingest.

  ./collect_usage.py                  # tick
  ./collect_usage.py --dry-run        # print payload, post nothing
  ./collect_usage.py --backfill 7     # last N days (by last_seen)
  ./collect_usage.py --since 2026-09-28 --until 2026-10-06
  ./collect_usage.py --roots /path/to/fixtures/hermes

Never reads message/prompt content. Never writes to Hermes files.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from cron_parse import FORBIDDEN_CONTENT_KEYS, parse_cron_job_id  # noqa: E402
from prices import PRICE_VERSION  # noqa: E402
from pricing import classify_costs  # noqa: E402

ACCOUNT_ID = "hermes-mac-mini"
SOURCE = "hermes_state"
DEFAULT_PRICE_VERSION = PRICE_VERSION

# cron id → name maps loaded from profile cron/jobs.json (names only; never prompts)
_CRON_NAME_CACHE: dict[str, dict[str, str]] = {}


def load_cron_names_for_profile(profile: str, db_path: Path) -> dict[str, str]:
    """Resolve human cron job names from cron/jobs.json next to the profile.

    Reads only id + name. Never loads or emits prompt / skill content.
    """
    if profile in _CRON_NAME_CACHE:
        return _CRON_NAME_CACHE[profile]
    names: dict[str, str] = {}
    candidates: list[Path] = []
    # Fixture layout: fixtures/hermes/host/alpha.db → look for fixtures/hermes/cron-names or sibling
    # Live Mini: ~/.hermes/profiles/<name>/state.db → cron/jobs.json
    #           neuro hermes-data/state.db → cron/jobs.json
    #           neuro hermes-data/profiles/<name>/state.db → cron/jobs.json
    parent = db_path.parent
    if db_path.name == "state.db":
        candidates.append(parent / "cron" / "jobs.json")
        if parent.name == "hermes-data" or "hermes-data" in str(parent):
            candidates.append(parent / "cron" / "jobs.json")
    else:
        # Slim fixture .db files: use bundled tests/fixtures/cron-job-names.json via env
        pass
    # Always try env / repo fixture maps
    fixture = os.environ.get("MC_CRON_NAMES_JSON")
    if fixture:
        candidates.append(Path(fixture))
    # Default: repo tests fixture when running from clone
    here = Path(__file__).resolve()
    repo_fixture = here.parents[2] / "tests" / "fixtures" / "cron-job-names.json"
    candidates.append(repo_fixture)

    for c in candidates:
        if not c.is_file():
            continue
        try:
            data = json.loads(c.read_text())
        except Exception:
            continue
        # Live jobs.json shape: { "jobs": [ { "id", "name", ...prompt } ] }
        if isinstance(data, dict) and "jobs" in data and isinstance(data["jobs"], list):
            for j in data["jobs"]:
                if isinstance(j, dict) and j.get("id"):
                    names[str(j["id"]).lower()] = str(j.get("name") or j["id"])
            break
        # Bundled fixture: { "by_profile": { "host/alpha": {id: name} }, "by_id": {...} }
        if isinstance(data, dict) and "by_id" in data:
            by_prof = data.get("by_profile") or {}
            if profile in by_prof:
                names.update({str(k).lower(): str(v) for k, v in by_prof[profile].items()})
            else:
                names.update({str(k).lower(): str(v) for k, v in (data.get("by_id") or {}).items()})
            break
    _CRON_NAME_CACHE[profile] = names
    return names


# Columns we are allowed to SELECT from session_model_usage. Anything else is
# rejected so a schema drift that adds content-like columns cannot leak.
ALLOWED_USAGE_COLS = frozenset({
    "session_id", "model", "billing_provider", "billing_base_url", "billing_mode",
    "task", "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd",
    "cost_status", "cost_source", "first_seen", "last_seen",
})


def log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", file=sys.stderr)


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


def discover_dbs(roots: List[Path]) -> List[Tuple[str, Path]]:
    """Return (profile_label, db_path) pairs. profile_label = host/<name> or neuro/<name>."""
    found: List[Tuple[str, Path]] = []
    for root in roots:
        root = root.expanduser()
        if not root.exists():
            log(f"skip missing root: {root}")
            continue
        # Fixture layout: <root>/host/*.db and <root>/neuro/*.db
        host_dir = root / "host"
        neuro_dir = root / "neuro"
        if host_dir.is_dir() or neuro_dir.is_dir():
            if host_dir.is_dir():
                for p in sorted(host_dir.glob("*.db")):
                    found.append((f"host/{p.stem}", p))
            if neuro_dir.is_dir():
                for p in sorted(neuro_dir.glob("*.db")):
                    found.append((f"neuro/{p.stem}", p))
            continue
        # Live Mac Mini layout
        profiles = root / "profiles"
        if profiles.is_dir():
            kind = "neuro" if "Neuro" in str(root) or "hermes-data" in str(root) else "host"
            for p in sorted(profiles.glob("*/state.db")):
                found.append((f"{kind}/{p.parent.name}", p))
            root_db = root / "state.db"
            if root_db.is_file():
                found.append((f"{kind}/neuro-root" if kind == "neuro" else f"{kind}/default", root_db))
            continue
        # Single db file
        if root.is_file() and root.suffix == ".db":
            found.append((root.stem, root))
    return found


def ts_to_iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OSError, TypeError):
        return None


def read_usage_rows(db_path: Path, since: Optional[float], until: Optional[float]) -> List[Dict[str, Any]]:
    """Read session_model_usage read-only. Raises if forbidden columns appear."""
    uri = f"file:{db_path}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    try:
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "session_model_usage" not in tables:
            return []
        cols = [c[1] for c in con.execute("PRAGMA table_info(session_model_usage)")]
        for c in cols:
            if c.lower() in FORBIDDEN_CONTENT_KEYS or c not in ALLOWED_USAGE_COLS:
                # Unknown non-content columns are ignored; forbidden names abort.
                if c.lower() in FORBIDDEN_CONTENT_KEYS:
                    raise RuntimeError(f"refusing to read content-like column {c!r} from {db_path}")
        select_cols = [c for c in cols if c in ALLOWED_USAGE_COLS]
        q = f"SELECT {', '.join(select_cols)} FROM session_model_usage"
        params: List[Any] = []
        clauses = []
        if since is not None:
            clauses.append("last_seen >= ?")
            params.append(since)
        if until is not None:
            clauses.append("last_seen < ?")
            params.append(until)
        if clauses:
            q += " WHERE " + " AND ".join(clauses)
        rows = []
        for r in con.execute(q, params):
            d = {k: r[k] for k in select_cols}
            # Ensure task key exists for DBs that lack the column
            d.setdefault("task", "")
            rows.append(d)
        return rows
    finally:
        con.close()


def row_to_fact(profile: str, row: Dict[str, Any], cron_names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    paid, shadow, price_version = classify_costs(row)
    session_id = row.get("session_id") or ""
    task = row.get("task") or ""
    cron_job_id = parse_cron_job_id(session_id, task)
    cron_job_name = None
    if cron_job_id and cron_names:
        cron_job_name = cron_names.get(cron_job_id.lower()) or cron_names.get(cron_job_id)
    return {
        "source": SOURCE,
        "account_id": ACCOUNT_ID,
        "profile": profile,
        "session_id": session_id,
        "model": row.get("model") or "unknown",
        "billing_provider": row.get("billing_provider") or "",
        "billing_mode": row.get("billing_mode") or "",
        "cron_job_id": cron_job_id,
        "cron_job_name": cron_job_name,
        "task": task,
        "api_call_count": int(row.get("api_call_count") or 0),
        "input_tokens": int(row.get("input_tokens") or 0),
        "output_tokens": int(row.get("output_tokens") or 0),
        "cache_read_tokens": int(row.get("cache_read_tokens") or 0),
        "cache_write_tokens": int(row.get("cache_write_tokens") or 0),
        "reasoning_tokens": int(row.get("reasoning_tokens") or 0),
        "paid_cost_usd": round(paid, 6),
        "shadow_cost_usd": round(shadow, 6),
        "price_version": price_version,
        "cost_status": row.get("cost_status"),
        "first_seen_at": ts_to_iso(row.get("first_seen")),
        "last_seen_at": ts_to_iso(row.get("last_seen")) or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        # Privacy: detail may hold non-content metadata only
        "detail": {
            "billing_base_url": row.get("billing_base_url") or "",
            "cost_source": row.get("cost_source"),
            "hermes_estimated_cost_usd": row.get("estimated_cost_usd"),
        },
    }


def collect(
    roots: List[Path],
    since: Optional[float],
    until: Optional[float],
) -> List[Dict[str, Any]]:
    facts: List[Dict[str, Any]] = []
    for profile, path in discover_dbs(roots):
        try:
            rows = read_usage_rows(path, since, until)
        except Exception as e:
            log(f"ERROR reading {profile} ({path}): {e}")
            continue
        cron_names = load_cron_names_for_profile(profile, path)
        for row in rows:
            facts.append(row_to_fact(profile, row, cron_names))
        log(f"{profile}: {len(rows)} rows from {path.name} (cron names={len(cron_names)})")
    return facts


def post_facts(url: str, token: str, facts: List[Dict[str, Any]], kind: str) -> Dict[str, Any]:
    body = json.dumps({
        "collected_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "kind": kind,
        "facts": facts,
    }).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + "/api/usage/ingest",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="Print payload JSON, do not POST")
    p.add_argument("--backfill", type=int, metavar="DAYS", help="Collect last N days of last_seen")
    p.add_argument("--since", type=str, help="ISO date (UTC) inclusive, e.g. 2026-09-28")
    p.add_argument("--until", type=str, help="ISO date (UTC) exclusive, e.g. 2026-10-06")
    p.add_argument("--roots", nargs="+", help="Override Hermes roots / fixture dirs")
    p.add_argument("--out", type=str, help="Write facts JSON to this path (in addition to POST)")
    p.add_argument("--mc-url", type=str, default=os.environ.get("MC_URL"))
    p.add_argument("--mc-token", type=str, default=os.environ.get("MC_TOKEN"))
    return p.parse_args(argv)


def parse_day(s: str) -> float:
    # date only → midnight UTC
    if len(s) == 10:
        dt = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def default_roots() -> List[Path]:
    home = Path.home()
    return [
        home / ".hermes",
        home / "Library" / "Application Support" / "Neuro" / "hermes-data",
    ]


def main(argv: Optional[List[str]] = None) -> int:
    env_file = Path(os.environ.get("MC_ENV_FILE", Path.home() / ".claude" / "mission-control.env"))
    load_env_file(env_file)
    args = parse_args(argv)

    since = until = None
    kind = "tick"
    if args.backfill is not None:
        kind = "backfill"
        until_dt = datetime.now(timezone.utc)
        since_dt = until_dt - timedelta(days=args.backfill)
        since, until = since_dt.timestamp(), until_dt.timestamp()
    if args.since:
        since = parse_day(args.since)
        kind = "backfill"
    if args.until:
        until = parse_day(args.until)
        kind = "backfill"

    roots = [Path(r) for r in args.roots] if args.roots else default_roots()
    facts = collect(roots, since, until)
    paid = sum(f["paid_cost_usd"] for f in facts)
    shadow = sum(f["shadow_cost_usd"] for f in facts)
    log(f"collected {len(facts)} facts; paid=${paid:.4f} shadow=${shadow:.4f} version={DEFAULT_PRICE_VERSION}")

    payload = {
        "collected_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "kind": kind,
        "facts": facts,
        "summary": {"count": len(facts), "paid_cost_usd": round(paid, 4), "shadow_cost_usd": round(shadow, 4)},
    }

    if args.out:
        Path(args.out).write_text(json.dumps(payload, indent=2))
        log(f"wrote {args.out}")

    if args.dry_run:
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    mc_url = args.mc_url or os.environ.get("MC_URL")
    mc_token = args.mc_token or os.environ.get("MC_TOKEN")
    if not mc_url or not mc_token:
        log("MC_URL / MC_TOKEN required unless --dry-run; writing nothing")
        return 2
    try:
        result = post_facts(mc_url, mc_token, facts, kind)
    except urllib.error.URLError as e:
        log(f"POST failed: {e}")
        return 1
    log(f"ingest ok: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
