#!/usr/bin/env python3
"""Read all owner inventories/current activity through existing gh authentication.

Inputs are saved GET /api/settings/{owners,repos} JSON. Output contains discovery
and kind=activity payloads; this helper never calls Fleet or mutates GitHub.
Valid partial results exit 0 so callers can persist explicit unavailable rows.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys

PAGE_SIZE = 50
MAX_BYTES = 4 * 1024 * 1024
OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$")
UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
FIELDS = """id nameWithOwner isArchived isFork pushedAt
  openPullRequests: pullRequests(states: OPEN) { totalCount }
  openIssues: issues(states: OPEN) { totalCount }
  latestPullRequest: pullRequests(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount nodes { updatedAt }
  }
  latestIssue: issues(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount nodes { updatedAt }
  }"""
OWNER_QUERY = """query ProgressOwnerActivity($owner: String!, $cursor: String) {
  repositoryOwner(login: $owner) { login repositories(first: 50, after: $cursor,
    ownerAffiliations: [OWNER], orderBy: {field: NAME, direction: ASC}) {
      totalCount pageInfo { hasNextPage endCursor } nodes { """ + FIELDS + " } } } }"
REPO_QUERY = "query ProgressRepoActivity($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { " + FIELDS + " } }"


class ReadFailed(Exception):
    def __init__(self, code="github_read_failed"):
        self.code = code


def require(condition, code="invalid_github_response"):
    if not condition:
        raise ReadFailed(code)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("nonfinite number")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def utcnow():
    return datetime.now(timezone.utc)


def stamp(clock):
    value = clock()
    require(isinstance(value, datetime) and value.utcoffset() == timezone.utc.utcoffset(value), "invalid_clock")
    return value.isoformat().replace("+00:00", "Z")


def instant(value):
    require(isinstance(value, str) and UTC_RE.fullmatch(value) is not None, "invalid_timestamp")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ReadFailed("invalid_timestamp") from None


def count(value):
    require(type(value) is int and 0 <= value <= 2_147_483_647)
    return value


def repo_name(value):
    require(isinstance(value, str) and REPO_RE.fullmatch(value) is not None
            and value.split("/")[1] not in (".", ".."))
    return value


def github_query(query, variables):
    # Static read-only operations; gh owns its existing credentials. Never read
    # environment/config credentials or emit subprocess stderr/exception text.
    command = ["gh", "api", "--hostname", "github.com", "graphql", "-f", "query=" + query]
    for key, value in variables.items():
        if value is not None:
            command.extend(["-f", key + "=" + value])
    try:
        process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=45, check=False)
        require(process.returncode == 0 and len(process.stdout) <= MAX_BYTES, "github_read_failed")
        return strict_json(process.stdout)
    except Exception:
        raise ReadFailed("github_read_failed") from None


def read(query, variables, query_fn, clock):
    try:
        data = query_fn(query, variables)
    except Exception:
        raise ReadFailed("github_read_failed") from None
    checked = stamp(clock)  # Taken after the API response, never before it.
    require(isinstance(data, dict) and not data.get("errors") and isinstance(data.get("data"), dict))
    return data["data"], checked


def latest(connection, checked):
    total, nodes = count(connection["totalCount"]), connection["nodes"]
    require(isinstance(nodes, list) and len(nodes) == (1 if total else 0))
    if not total:
        return None, total  # A known empty connection, not a missing field.
    value = nodes[0]["updatedAt"]
    require(instant(value) <= instant(checked), "invalid_timestamp")
    return value, total


def parse_repo(node, checked, owner=None, expected=None):
    name = repo_name(node["nameWithOwner"])
    require(owner is None or name.split("/")[0].lower() == owner.lower(), "repository_identity_changed")
    require(expected is None or name.lower() == expected.lower(), "repository_identity_changed")
    require(isinstance(node["id"], str) and 0 < len(node["id"]) <= 200)
    require(type(node["isArchived"]) is bool and type(node["isFork"]) is bool)
    pushed = node["pushedAt"]
    require(pushed is None or instant(pushed) <= instant(checked), "invalid_timestamp")
    prs, issues = count(node["openPullRequests"]["totalCount"]), count(node["openIssues"]["totalCount"])
    pr_at, pr_total = latest(node["latestPullRequest"], checked)
    issue_at, issue_total = latest(node["latestIssue"], checked)
    require(prs <= pr_total and issues <= issue_total)
    discovery = {"name": name.split("/")[1], "pushedAt": pushed,
                 "isArchived": node["isArchived"], "isFork": node["isFork"]}
    snapshot = {"repo": name, "open_prs": prs, "detail": {"activity": {
        "status": "complete", "checked_at": checked, "pushed_at": pushed,
        "pr_updated_at": pr_at, "issue_updated_at": issue_at, "open_issues": issues}}}
    return node["id"], discovery, snapshot


def owner_sweep(owner, query_fn, clock, prior_ids):
    cursor, total, names, ids, cursors, listed, rows = None, None, set(), set(), set(), [], []
    while True:  # No search or repository-count cap; every cursor is followed.
        data, checked = read(OWNER_QUERY, {"owner": owner, "cursor": cursor}, query_fn, clock)
        account = data["repositoryOwner"]
        require(isinstance(account["login"], str) and account["login"].lower() == owner)
        page = account["repositories"]
        observed_total = count(page["totalCount"])
        require(observed_total > 0, "empty_owner_inventory")
        total = observed_total if total is None else total
        require(total == observed_total, "pagination_incomplete")
        nodes, info = page["nodes"], page["pageInfo"]
        require(isinstance(nodes, list) and len(nodes) == min(PAGE_SIZE, total - len(rows)), "pagination_incomplete")
        require(type(info["hasNextPage"]) is bool and isinstance(info["endCursor"], str)
                and 0 < len(info["endCursor"]) <= 2048 and info["endCursor"] not in cursors, "pagination_incomplete")
        cursors.add(info["endCursor"])
        for node in nodes:
            identity, item, row = parse_repo(node, checked, owner=owner)
            key = row["repo"].lower()
            require(key not in names and identity not in ids and identity not in prior_ids, "duplicate_repository")
            names.add(key)
            ids.add(identity)
            listed.append(item)
            rows.append(row)
        require(info["hasNextPage"] == (len(rows) < total), "pagination_incomplete")
        if not info["hasNextPage"]:
            require(len(rows) == total, "pagination_incomplete")
            return listed, rows, ids, checked
        cursor = info["endCursor"]


def settings(owners_body, repos_body):
    owners, retained = [], {}
    require(isinstance(owners_body, dict) and isinstance(owners_body.get("owners"), list), "invalid_settings")
    require(isinstance(repos_body, dict) and isinstance(repos_body.get("repos"), list), "invalid_settings")
    for row in owners_body["owners"]:
        name = row["owner"]
        require(isinstance(name, str) and OWNER_RE.fullmatch(name) is not None, "invalid_settings")
        require(name.lower() not in owners and all(type(row[k]) is bool for k in ("include_forks", "include_archived")), "invalid_settings")
        owners.append(name.lower())
    seen = set()
    for row in repos_body["repos"]:
        name = repo_name(row["repo"])
        require(name.lower() not in seen and row.get("origin", "manual") in ("auto", "manual"), "invalid_settings")
        require(all(type(row[k]) is bool for k in ("gone", "hidden", "pinned", "isFork", "isArchived") if k in row), "invalid_settings")
        seen.add(name.lower())
        if not row.get("gone", False):
            retained[name.lower()] = name
    return owners, retained


def unavailable(repo, checked, error):
    return {"repo": repo, "open_prs": None, "detail": {"activity": {
        "status": "unavailable", "checked_at": checked, "pushed_at": None,
        "pr_updated_at": None, "issue_updated_at": None, "open_issues": None, "error": error}}}


def collect(owners_body, repos_body, query_fn=None, clock=utcnow):
    query_fn = github_query if query_fn is None else query_fn
    owners, retained = settings(owners_body, repos_body)
    discoveries, rows, seen_ids, owner_status = [], {}, set(), {}
    direct_queries = 0
    for owner in owners:
        swept = stamp(clock)
        try:
            listed, observed, identities, checked = owner_sweep(owner, query_fn, clock, seen_ids)
            seen_ids.update(identities)
            discoveries.append({"owner": owner, "ok": True, "truncated": False, "swept_at": swept, "repos": listed})
            owner_status[owner] = (checked, "missing_from_inventory")
            for row in observed:
                key = row["repo"].lower()
                row["repo"] = retained.get(key, row["repo"])
                rows[key] = row
        except Exception as exc:
            checked = stamp(clock)
            error = exc.code if isinstance(exc, ReadFailed) else "invalid_github_response"
            discoveries.append({"owner": owner, "ok": False, "swept_at": swept, "error": error})
            owner_status[owner] = (checked, error)
    for key, name in retained.items():
        if key in rows:
            continue
        owner, repo = name.split("/")
        if owner.lower() in owner_status:
            checked, error = owner_status[owner.lower()]
            rows[key] = unavailable(name, checked, error)
            continue
        # Includes manual/legacy rows and retained rows after owner removal.
        direct_queries += 1
        try:
            data, checked = read(REPO_QUERY, {"owner": owner, "name": repo}, query_fn, clock)
            identity, _, row = parse_repo(data["repository"], checked, expected=name)
            require(identity not in seen_ids, "duplicate_repository")
            seen_ids.add(identity)
            row["repo"] = name
            rows[key] = row
        except Exception as exc:
            checked = stamp(clock)
            error = exc.code if isinstance(exc, ReadFailed) else "invalid_github_response"
            rows[key] = unavailable(name, checked, error)
    collected = stamp(clock)
    require(all(instant(r["detail"]["activity"]["checked_at"]) <= instant(collected) for r in rows.values()), "invalid_clock")
    complete = sum(r["detail"]["activity"]["status"] == "complete" for r in rows.values())
    return {"discovery": {"results": discoveries},
            "snapshot": {"kind": "activity", "collected_at": collected, "repos": [rows[k] for k in sorted(rows)]},
            "summary": {"owners_total": len(owners), "owners_complete": sum(d["ok"] for d in discoveries),
                        "owners_unavailable": sum(not d["ok"] for d in discoveries), "repositories_total": len(rows),
                        "repositories_complete": complete, "repositories_unavailable": len(rows) - complete,
                        "direct_queries": direct_queries}}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(2, "progress activity: invalid arguments\n")


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("--owners", type=Path, required=True)
    parser.add_argument("--repos", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        bodies = []
        for path in (args.owners, args.repos):
            with path.open("rb") as handle:
                raw = handle.read(MAX_BYTES + 1)
            require(len(raw) <= MAX_BYTES, "invalid_settings")
            bodies.append(strict_json(raw))
        result = collect(*bodies)
        print(json.dumps(result, separators=(",", ":"), allow_nan=False))
        return 0
    except Exception:
        print("progress activity: invalid settings or collector failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
