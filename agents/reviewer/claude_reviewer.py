"""Claude Reviewer runner (#176, Part 2).

    python3 -m agents.reviewer.claude_reviewer --config <path>

Consumes the `pr_review` ready queue from `GET /api/sweep/queues?classification=pr_review`,
skips same-vendor and unknown-provenance PRs, reviews each eligible head read-only with a
sandboxed `claude -p`, and (in `live` mode only) posts one COMMENT review carrying structured
review evidence as the registered Claude GitHub App. Off by default. See README.md.

Exit codes: 0 done (or disabled, or another run holds the lock); 1 AK preflight failed;
2 config error; 78 refused (App identity, /app failure, platform, sandbox, openssl, registry).
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import evidence, ledger
from .common import (QUEUE_ID_RE, SANDBOX_DENIED_ROOTS, SHA_RE, ReviewerError, iso_instant, iso_z, parse_iso,
                     strict_json, utc_now, within_roots)
from .config import Config, ConfigError, Identity, load_ak_credential, load_config, load_oauth_token, load_registry
from .github import FAILURES, GITHUB_API, GitHubClient, GitHubFailure, basic_auth_header, default_opener
from .provenance import resolve

AGENT_ID = "claude-reviewer"
QUEUE_PATH = "/api/sweep/queues?classification=pr_review"
INGEST_PATH = "/api/ingest"
AK_TIMEOUT_SECONDS = 15
MAX_AK_RESPONSE = 4 * 1024 * 1024
COUNTER_CAP = 100_000
SPEND_CAP_MICROUSD = 10 ** 12
GIT_TIMEOUT_SECONDS = 900
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
SANDBOX_PROFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sandbox.sb")
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

EXIT_OK, EXIT_AK, EXIT_CONFIG, EXIT_REFUSED = 0, 1, 2, 78

# AC 14 / 31 / 66: the receipt counters, in this order.
COUNTERS = (
    "ready", "queue_unknown", "same_vendor", "provenance_unknown", "invalid_input", "already_reviewed",
    "reviewed", "posted", "tier_c_partial", "head_moved", "invalid_output", "escalate", "not_installed",
    "budget_stop", "not_ready", "invalid_cost", "token_revoked", "missing_permission", "rate_limit",
    "github_error",
)

ALLOWED_TOOLS = (
    "Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git blame:*)",
    "Bash(git ls-files:*)", "Bash(ls:*)",
)
DISALLOWED_TOOLS = (
    "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Bash(gh:*)", "Bash(curl:*)",
    "Bash(wget:*)", "Bash(git push:*)", "Bash(git commit:*)", "Bash(git reset:*)", "Bash(git checkout:*)",
    "Bash(rm:*)",
)
SLA_MINUTES = {"A": 240, "B": 240, "C": 720}
# Per-candidate outcomes that are receipt counters (mutually exclusive per candidate). `posted`,
# `reviewed` and `tier_c_partial` are counted where they happen; `budget_stop` is a 0/1 flag.
OUTCOME_COUNTERS = frozenset(COUNTERS) - {"ready", "reviewed", "posted", "tier_c_partial", "budget_stop"}


def claude_argv(claude_path: str, model: str) -> List[str]:
    """AC 86, element for element."""
    return ([claude_path, "-p", "--output-format", "json", "--model", model, "--permission-mode", "plan",
             "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--allowedTools"]
            + list(ALLOWED_TOOLS) + ["--disallowedTools"] + list(DISALLOWED_TOOLS))


def _sb_path(path: str) -> str:
    if '"' in path or "\\" in path or "\n" in path or not path.startswith("/"):
        raise ReviewerError("unsafe sandbox path")
    return path


def _ancestors(path: str) -> List[str]:
    out = []
    current = path
    while True:
        parent = os.path.dirname(current)
        if parent == current:
            break
        out.append(parent)
        current = parent
    return out


def render_profile(template: str, *, clone_dir: str, home_dir: str, claude_dir: str, claude_real_dir: str) -> str:
    roots = [os.path.realpath(p) for p in (clone_dir, home_dir, claude_dir, claude_real_dir)]
    ancestors = sorted({a for root in roots for a in _ancestors(root)})
    literals = " ".join('(literal "%s")' % _sb_path(a) for a in ancestors) or '(literal "/")'
    return (template
            .replace("@CLONE_DIR@", _sb_path(roots[0]))
            .replace("@HOME_DIR@", _sb_path(roots[1]))
            .replace("@CLAUDE_DIR@", _sb_path(roots[2]))
            .replace("@CLAUDE_REAL_DIR@", _sb_path(roots[3]))
            .replace("@ANCESTOR_LITERALS@", literals))


def floor_schedule(moment: dt.datetime, minutes: int) -> dt.datetime:
    moment = moment.astimezone(dt.timezone.utc).replace(second=0, microsecond=0)
    total = moment.hour * 60 + moment.minute
    floored = total - (total % minutes)
    return moment.replace(hour=floored // 60, minute=floored % 60)


class AkError(Exception):
    pass


class AkClient:
    """AK requests: bearer auth, no ambient proxy, no redirects, no automatic retries (AC 106)."""

    def __init__(self, base: str, token: str, opener=None):
        self.base = base
        self.token = token
        self.opener = opener or default_opener()

    def _request(self, method: str, path: str, body: Optional[dict]) -> Tuple[int, bytes]:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8") if body is not None else None
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json", "User-Agent": "agent-kontrol-claude-reviewer"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=AK_TIMEOUT_SECONDS) as response:
                return response.status, response.read(MAX_AK_RESPONSE + 1)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            return status, b""
        except Exception:
            raise AkError("unreachable") from None

    def queues(self) -> List[dict]:
        status, payload = self._request("GET", QUEUE_PATH, None)
        if status != 200 or len(payload) > MAX_AK_RESPONSE:
            raise AkError("queue read failed")
        try:
            data = strict_json(payload)
        except (ValueError, UnicodeError, RecursionError):
            raise AkError("queue read malformed") from None
        if not isinstance(data, dict) or not isinstance(data.get("queues"), list):
            raise AkError("queue read malformed")
        return data["queues"]

    def post_event(self, body: dict) -> int:
        status, _ = self._request("POST", INGEST_PATH, body)
        return status


@dataclass
class Candidate:
    queue: str
    repo: str
    number: int
    head_sha: str
    green_since: Optional[dt.datetime]
    tier: Optional[str] = None
    pull: Optional[dict] = None

    @property
    def key(self) -> str:
        return ledger.item_key(self.repo, self.number, self.head_sha)


class CloneFailure(Exception):
    def __init__(self, outcome: str):
        super().__init__(outcome)
        self.outcome = outcome


class Runner:
    """One scheduled run. Constructor keyword arguments are test seams, never config."""

    def __init__(self, config: Config, *, github_api: str = GITHUB_API, git_base: str = "https://github.com",
                 ak_opener=None, github_opener=None, clock: Callable[[], dt.datetime] = utc_now,
                 sleep: Callable[[float], None] = time.sleep, platform: str = sys.platform,
                 sandbox_exec: str = SANDBOX_EXEC, tmp_root: Optional[str] = None,
                 environ: Optional[Dict[str, str]] = None, stdout=None,
                 denied_roots: Optional[Sequence[str]] = None):
        self.config = config
        self.denied_roots = tuple(denied_roots) if denied_roots is not None else SANDBOX_DENIED_ROOTS
        self.github_api = github_api
        self.git_base = git_base.rstrip("/")
        self.ak_opener = ak_opener
        self.github_opener = github_opener
        self.clock = clock
        self.sleep = sleep
        self.platform = platform
        self.sandbox_exec = sandbox_exec
        self.tmp_root = tmp_root
        self.environ = dict(os.environ if environ is None else environ)
        self.stdout = stdout or sys.stdout
        self.counters: Dict[str, int] = {name: 0 for name in COUNTERS}
        self.app_login: Optional[str] = None
        self.identity: Optional[Identity] = None
        self.claude_unavailable = False
        self.oauth_token: Optional[str] = None
        self.ak: Optional[AkClient] = None
        self.gh: Optional[GitHubClient] = None
        self.started = self.clock()
        self.scheduled_at = floor_schedule(self.started, config.schedule_minutes)
        self.oldest_ready_minutes = 0
        self.sla_breaches = 0

    # -- entry -----------------------------------------------------------------
    def run(self) -> int:
        state_dir = self.config.state_dir
        os.makedirs(state_dir, mode=0o700, exist_ok=True)
        lock = open(os.path.join(state_dir, ".lock"), "a+")
        try:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return EXIT_OK  # AC 11: an overlapping run exits 0 without work
            return self._run_locked()
        finally:
            lock.close()

    def _error(self, category: str) -> None:
        ledger.error_line(self.config.state_dir, category, self.clock())

    def _run_locked(self) -> int:
        try:
            token = load_ak_credential(self.config.ak_credential_file, self.config.ak_url)
        except ReviewerError:
            self._error("ak credential file invalid")
            return EXIT_AK
        self.ak = AkClient(self.config.ak_url, token, self.ak_opener)
        try:
            rows = self.ak.queues()  # AC 40: the one bounded preflight
        except AkError:
            self._error("ak preflight failed")
            self._receipt(log_failure=False)
            return EXIT_AK

        if self.platform != "darwin" or not os.path.isfile(self.sandbox_exec):
            self.counters["not_installed"] += 1  # AC 107: no read boundary on this OS
            return self._refuse("sandbox unavailable")
        # The profile denies reads only under these roots, so a secret or state path anywhere
        # else would be readable by the model. Refuse rather than run with it exposed (review of #178).
        cfg = self.config
        for path in (cfg.ak_credential_file, cfg.github_app_key_file, cfg.claude_oauth_token_file,
                     cfg.registry_path, cfg.state_dir):
            if not within_roots(path, self.denied_roots):
                return self._refuse("secret path outside sandbox boundary")
        try:
            registry = load_registry(self.config.registry_path)
        except ReviewerError:
            return self._refuse("registry invalid")

        self.gh = GitHubClient(self.config.github_app_id, self.config.github_app_key_file, self.config.openssl_path,
                               api=self.github_api, opener=self.github_opener,
                               clock=lambda: self.clock().timestamp(), sleep=self.sleep)
        try:
            login = self.gh.app_login()
        except GitHubFailure as failure:
            self.counters[failure.outcome] += 1
            return self._refuse("github app lookup failed")
        identity = registry.get(login)
        if identity is None or identity.vendor != "claude":
            return self._refuse("app login not registered as claude")
        self.app_login, self.identity = login, identity

        candidates = self._candidates(rows)
        self._process(candidates, registry)
        self._receipt()
        return EXIT_OK

    def _refuse(self, category: str) -> int:
        self._error(category)
        self._event("error", category)
        self._receipt()
        return EXIT_REFUSED

    # -- queue -----------------------------------------------------------------
    def _usable_row(self, row: Any, repo: str) -> Optional[List[dict]]:
        if not isinstance(row, dict):
            return None
        row_repo = row.get("repo")
        if not isinstance(row_repo, str) or row_repo.lower() != repo:
            return None  # AC 34
        if row.get("complete") is not True or row.get("stale") is not False:
            return None
        items = row.get("ready_items")
        if not isinstance(items, list):
            return None  # AC 79: missing ready_items
        for item in items:
            if not isinstance(item, dict):
                return None
            if type(item.get("number")) is not int or item["number"] <= 0:
                return None
            if not isinstance(item.get("head_sha"), str) or SHA_RE.fullmatch(item["head_sha"]) is None:
                return None
            if item.get("green_since") is not None and not iso_instant(item.get("green_since")):
                return None
        return items

    def _candidates(self, rows: List[Any]) -> List[Candidate]:
        by_queue: Dict[str, List[Any]] = {}
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("queue"), str):
                by_queue.setdefault(row["queue"], []).append(row)
        seen = set()
        out: List[Candidate] = []
        for ref in self.config.queues:
            matches = by_queue.get(ref.queue, [])
            items = self._usable_row(matches[0], ref.repo) if len(matches) == 1 else None
            if items is None:
                self.counters["queue_unknown"] += 1  # AC 5, 34, 79
                continue
            for item in items:
                key = (ref.repo, item["number"], item["head_sha"])
                if key in seen:
                    continue  # AC 38: de-duplicated across queues
                seen.add(key)
                green = parse_iso(item["green_since"]) if item.get("green_since") else None
                out.append(Candidate(ref.queue, ref.repo, item["number"], item["head_sha"], green))
        self.counters["ready"] = len(out)
        return out

    @staticmethod
    def _sort_key(c: Candidate):
        rank = 0 if c.tier == "C" else 1
        if c.green_since is not None:
            return (rank, 0, c.green_since.timestamp(), c.queue, c.repo, c.number)
        return (rank, 1, float(c.number), c.queue, c.repo, c.number)

    def _sla(self, candidates: Sequence[Candidate]) -> None:
        """AC 12/62: from green_since at run start; null green_since never breaches."""
        oldest = 0
        breaches = 0
        for c in candidates:
            if c.green_since is None:
                continue
            waited = max(0.0, (self.started - c.green_since).total_seconds())
            oldest = max(oldest, int(waited // 60))
            if waited > SLA_MINUTES.get(c.tier or "B", 240) * 60:
                breaches += 1
        self.oldest_ready_minutes = oldest
        self.sla_breaches = breaches

    # -- per-candidate -----------------------------------------------------------
    def _outcome(self, c: Candidate, outcome: str) -> None:
        if outcome in OUTCOME_COUNTERS:
            self.counters[outcome] += 1
        ledger.append_outcome(self.config.state_dir, {
            "at": iso_z(self.clock()), "scheduled_at": iso_z(self.scheduled_at), "repo": c.repo,
            "number": c.number, "head_sha": c.head_sha, "outcome": outcome,
        })

    def _pull_state(self, c: Candidate) -> Optional[str]:
        """Re-read the pull (AC 20/37). Returns an outcome to stop with, or None to continue."""
        try:
            pull = self.gh.get_pull(c.repo, c.number)
        except GitHubFailure as failure:
            return failure.outcome
        if pull is None or pull.get("state") != "open" or pull.get("draft") is not False:
            return "not_ready"
        head = pull.get("head")
        if not isinstance(head, dict) or head.get("sha") != c.head_sha:
            return "head_moved"
        c.pull = pull
        return None

    def _process(self, candidates: List[Candidate], registry: Dict[str, Identity]) -> None:
        eligible: List[Candidate] = []
        for c in candidates:
            stop = self._pull_state(c)
            if stop is not None:
                self._outcome(c, stop)
                continue
            c.tier = evidence.tier_from_labels(c.pull.get("labels"))
            if c.tier is None:
                self._outcome(c, "invalid_input")
                continue
            eligible.append(c)
        self._sla(candidates)
        eligible.sort(key=self._sort_key)

        budget_stopped = False
        for c in eligible:
            if budget_stopped:
                self._outcome(c, "budget_wait")
                continue
            try:
                result = self._review_one(c, registry)
            except ReviewerError:
                self._error("local state unreadable")
                result = "escalate"
            if result == "budget_stop":
                budget_stopped = True
                self.counters["budget_stop"] = 1
                self._outcome(c, "budget_wait")
            elif result is not None:
                self._outcome(c, result)

    def _review_one(self, c: Candidate, registry: Dict[str, Identity]) -> Optional[str]:
        cfg = self.config
        if c.tier == "C" and (self.identity is None or self.identity.tier != "top"):
            return "invalid_input"  # AC 101
        commits_total = c.pull.get("commits")
        if type(commits_total) is not int or commits_total >= 250:
            return "provenance_unknown"  # AC 82
        try:
            commits = self.gh.list_commits(c.repo, c.number)
        except GitHubFailure:
            return "provenance_unknown"  # AC 82: any page failure
        decision, vendors = resolve(commits, registry)
        if decision != "eligible":
            return decision

        try:
            reviews = self.gh.list_reviews(c.repo, c.number)
        except GitHubFailure as failure:
            return failure.outcome
        existing = [r for r in reviews if isinstance(r.get("user"), dict)
                    and isinstance(r["user"].get("login"), str) and r["user"]["login"].lower() == self.app_login
                    and r.get("state") != "PENDING" and r.get("commit_id") == c.head_sha]
        if existing:
            if not ledger.has_line(ledger.review_lines(cfg.state_dir), c.repo, c.number, c.head_sha):
                submitted = existing[0].get("submitted_at")
                posted_at = parse_iso(submitted) if iso_instant(submitted) else self.clock()
                ledger.append_review(cfg.state_dir, self._record(c, vendors, posted_at, "live", reconciled=True))
            return "already_reviewed"  # AC 29, 84
        if cfg.mode == "dry-run" and ledger.has_line(ledger.would_be_lines(cfg.state_dir), c.repo, c.number, c.head_sha):
            return "already_reviewed"

        additions, deletions = c.pull.get("additions"), c.pull.get("deletions")
        if type(additions) is not int or type(deletions) is not int or additions < 0 or deletions < 0:
            return "escalate"
        if additions + deletions > cfg.max_diff_lines:
            return "escalate"  # AC 44/67, before clone
        invalid = ledger.InvalidOutputLedger(cfg.state_dir)
        if invalid.count(c.key) >= 2:
            return "escalate"  # AC 53

        # AC 13/42: one invocation timestamp picks the UTC day for both the cap check and the
        # charge, so a review that crosses midnight is checked and charged on the same day.
        invoked_at = self.clock()
        spend = ledger.SpendLedger(cfg.state_dir, invoked_at.date())
        if spend.blocks(cfg.daily_cap_usd, cfg.daily_max_reviews):
            return "budget_stop"  # AC 13
        if self.claude_unavailable:
            return "not_installed"

        stop = self._pull_state(c)  # AC 20: pre-clone re-read
        if stop is not None:
            return stop
        base = c.pull.get("base")
        base_sha = base.get("sha") if isinstance(base, dict) else None
        if not isinstance(base_sha, str) or SHA_RE.fullmatch(base_sha) is None:
            return "github_error"

        claude = self._resolve_claude()
        if claude is None:
            self.claude_unavailable = True
            return "not_installed"  # AC 54
        if self.oauth_token is None:
            try:
                self.oauth_token = load_oauth_token(cfg.claude_oauth_token_file)
            except ReviewerError:
                self.claude_unavailable = True
                return "not_installed"

        lenses = evidence.lenses_for(cfg.lenses, c.tier)
        workspace = tempfile.mkdtemp(prefix="ak-reviewer-", dir=self.tmp_root)
        try:
            clone = os.path.join(workspace, "clone")
            home = os.path.join(workspace, "home")
            for path in (clone, home, os.path.join(home, "tmp"), os.path.join(home, ".claude"), os.path.join(home, ".config")):
                os.makedirs(path, mode=0o700, exist_ok=True)
            open(os.path.join(home, ".gitconfig"), "w").close()
            try:
                self._clone(c, base_sha, clone, home)
            except CloneFailure as failure:
                return failure.outcome
            prompt = evidence.build_prompt(
                repo=c.repo, number=c.number, title=str(c.pull.get("title") or ""),
                body=str(c.pull.get("body") or ""), base_sha=base_sha, head_sha=c.head_sha,
                tier=c.tier, lenses=lenses)
            model = cfg.model_top if c.tier == "C" else cfg.model_mid
            outcome, stdout = self._invoke_claude(claude, model, prompt, clone, home)
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
        if outcome == "not_installed":
            self.claude_unavailable = True
            return "not_installed"

        spend = ledger.SpendLedger(cfg.state_dir, invoked_at.date())  # reload: same day as the check
        if outcome is not None:
            # Timeout or non-zero exit: no valid cost was reported, so the day's spend is unknown.
            spend.halt()
            invalid.increment(c.key)
            return "invalid_output"
        try:
            cost, result = evidence.parse_envelope(stdout)
        except evidence.InvalidCost:
            spend.halt()  # AC 25: no further reviews this UTC day
            return "invalid_cost"
        except evidence.InvalidOutput:
            spend.halt()
            invalid.increment(c.key)
            return "invalid_output"
        spend.charge(invoked_at, cost)  # AC 42: charged even if validation fails below
        try:
            parsed = evidence.parse_model_result(result, lenses)
        except evidence.InvalidOutput:
            invalid.increment(c.key)
            return "invalid_output"

        body = evidence.build_body(parsed, head_sha=c.head_sha, bot_login=self.app_login, tier=c.tier, lenses=lenses)
        stop = self._pull_state(c)  # AC 10/37: pre-post re-read
        if stop is not None:
            return stop
        self.counters["reviewed"] += 1
        now = self.clock()
        if cfg.mode == "dry-run":
            ledger.append_would_be(cfg.state_dir, self._record(c, vendors, now, "dry-run"), body)
            return "would_be"
        try:
            self.gh.post_review(c.repo, c.number, c.head_sha, body)
        except GitHubFailure as failure:
            return failure.outcome
        ledger.append_review(cfg.state_dir, self._record(c, vendors, self.clock(), "live"))  # AC 84: before counting
        self.counters["posted"] += 1
        if c.tier == "C":
            self.counters["tier_c_partial"] += 1
        return "posted"

    def _record(self, c: Candidate, vendors: List[str], at: dt.datetime, phase: str, reconciled: bool = False) -> dict:
        waited = 0
        if c.green_since is not None:
            waited = max(0, int((at - c.green_since).total_seconds() // 60))
        record = {
            "repo": c.repo, "number": c.number, "head_sha": c.head_sha, "tier": c.tier,
            "green_since": iso_z(c.green_since) if c.green_since else None, "posted_at": iso_z(at),
            "waited_minutes": waited, "app_login": self.app_login, "provenance": sorted(vendors),
            "phase": phase, "scheduled_at": iso_z(self.scheduled_at),
        }
        if reconciled:
            record["reconciled"] = True
        return record

    # -- clone -----------------------------------------------------------------
    def _git_env(self, home: str, token: Optional[str]) -> Dict[str, str]:
        """AC 36: no system/global config, no prompts, no askpass/ssh/proxy; token only via GIT_CONFIG_*."""
        settings = [
            ("credential.helper", ""),
            ("core.hooksPath", "/dev/null"),
            ("fetch.unpackLimit", "1"),
            ("transfer.unpackLimit", "1"),
            ("protocol.allow", "never"),
            ("protocol.%s.allow" % ("file" if self.git_base.startswith("file://") else "https"), "always"),
        ]
        if token is not None:
            settings.append(("http.extraHeader", basic_auth_header(token)))
        env = {
            "PATH": SYSTEM_PATH, "HOME": home, "XDG_CONFIG_HOME": os.path.join(home, ".config"),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.path.join(home, ".gitconfig"),
            "GIT_TERMINAL_PROMPT": "0", "LANG": "C", "TMPDIR": os.path.join(home, "tmp"),
            "GIT_CONFIG_COUNT": str(len(settings)),
        }
        for index, (key, value) in enumerate(settings):
            env["GIT_CONFIG_KEY_%d" % index] = key
            env["GIT_CONFIG_VALUE_%d" % index] = value
        return env

    def _git(self, args: List[str], cwd: str, env: Dict[str, str], capture_err: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run(["git"] + args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE if capture_err else subprocess.DEVNULL,
                              timeout=GIT_TIMEOUT_SECONDS, check=False)

    @staticmethod
    def _fetch_outcome(stderr: bytes) -> str:
        """Map git's HTTP failure text to the failure table; the text itself is never stored."""
        match = re.search(rb"returned error: (\d{3})", stderr or b"")
        status = int(match.group(1)) if match else 0
        if status == 401:
            return "token_revoked"
        if status in (403, 404):
            return "missing_permission"
        if status == 429:
            return "rate_limit"
        return "github_error"

    def _clone(self, c: Candidate, base_sha: str, clone: str, home: str) -> None:
        """AC 8/52/67/83: fresh repo, fetch refs/pull/N/head and the base SHA, verify, detach, size."""
        try:
            token = self.gh.installation_token(c.repo)
        except GitHubFailure as failure:
            raise CloneFailure(failure.outcome) from None
        plain = self._git_env(home, None)
        try:
            if self._git(["init", "-q", clone], clone, plain).returncode != 0:
                raise CloneFailure("github_error")
            url = "%s/%s.git" % (self.git_base, c.repo)
            fetched = self._git(["fetch", "--no-tags", "--no-recurse-submodules", "--quiet", url,
                                 "+refs/pull/%d/head:refs/ak/head" % c.number, base_sha],
                                clone, self._git_env(home, token), capture_err=True)
            if fetched.returncode != 0:
                raise CloneFailure(self._fetch_outcome(fetched.stderr))
            got = self._git(["rev-parse", "--verify", "refs/ak/head^{commit}"], clone, plain)
            if got.returncode != 0 or got.stdout.decode("ascii", "replace").strip() != c.head_sha:
                raise CloneFailure("head_moved")  # AC 52
            if self._git(["checkout", "--detach", "-q", c.head_sha], clone, plain).returncode != 0:
                raise CloneFailure("github_error")
            counted = self._git(["count-objects", "-v"], clone, plain)
        except subprocess.TimeoutExpired:
            raise CloneFailure("github_error") from None
        except OSError:
            raise CloneFailure("github_error") from None
        match = re.search(rb"^size-pack: (\d+)$", counted.stdout or b"", re.M)
        if counted.returncode != 0 or match is None:
            raise CloneFailure("escalate")
        if int(match.group(1)) * 1024 > self.config.max_clone_bytes:
            raise CloneFailure("escalate")

    # -- claude ------------------------------------------------------------------
    def _resolve_claude(self) -> Optional[str]:
        path = self.config.claude_path
        if "/" not in path:
            path = shutil.which(path, path=self.environ.get("PATH", SYSTEM_PATH)) or ""
        if not path or not os.path.isabs(path) or not os.path.isfile(path) or not os.access(path, os.X_OK):
            return None
        return path

    def claude_env(self, claude: str, home: str) -> Dict[str, str]:
        """AC 8/108: isolated HOME/config; OAuth token only here; no GitHub or AK credential."""
        return {
            "PATH": os.path.dirname(claude) + ":" + SYSTEM_PATH,
            "HOME": home,
            "CLAUDE_CONFIG_DIR": os.path.join(home, ".claude"),
            "XDG_CONFIG_HOME": os.path.join(home, ".config"),
            "TMPDIR": os.path.join(home, "tmp"),
            "LANG": "en_US.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.path.join(home, ".gitconfig"),
            "GIT_TERMINAL_PROMPT": "0",
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_OAUTH_TOKEN": self.oauth_token or "",
        }

    def sandbox_argv(self, claude: str, model: str, clone: str, home: str) -> List[str]:
        with open(SANDBOX_PROFILE, "r", encoding="utf-8") as handle:
            template = handle.read()
        profile = render_profile(template, clone_dir=clone, home_dir=home, claude_dir=os.path.dirname(claude),
                                 claude_real_dir=os.path.dirname(os.path.realpath(claude)))
        return [self.sandbox_exec, "-p", profile] + claude_argv(claude, model)

    def _invoke_claude(self, claude: str, model: str, prompt: str, clone: str, home: str) -> Tuple[Optional[str], bytes]:
        """Returns (None, stdout) on exit 0; ("not_installed"|"invalid_output", b"") otherwise (AC 54)."""
        argv = self.sandbox_argv(claude, model, clone, home)
        try:
            process = subprocess.Popen(argv, cwd=clone, env=self.claude_env(claude, home), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            return "not_installed", b""
        try:
            stdout, _ = process.communicate(prompt.encode("utf-8"), timeout=self.config.claude_timeout_seconds)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
            process.communicate()
            return "invalid_output", b""
        if process.returncode != 0:
            return "invalid_output", b""
        return None, stdout

    # -- receipts ------------------------------------------------------------------
    def detail(self) -> Dict[str, Any]:
        """AC 14/31/66/104: bounded non-negative integers and ISO timestamps only."""
        out: Dict[str, Any] = {name: min(COUNTER_CAP, max(0, self.counters[name])) for name in COUNTERS}
        out["budget_stop"] = 1 if self.counters["budget_stop"] else 0
        try:
            spend = ledger.SpendLedger(self.config.state_dir, self.clock().date()).micro_usd()
        except Exception:
            spend = 0
        out["spend_microusd_today"] = min(SPEND_CAP_MICROUSD, max(0, spend))
        out["oldest_ready_minutes"] = min(COUNTER_CAP, self.oldest_ready_minutes)
        out["sla_breaches"] = min(COUNTER_CAP, self.sla_breaches)
        out["scheduled_at"] = iso_z(self.scheduled_at)
        out["started_at"] = iso_z(self.started)
        return out

    def _event(self, kind: str, title: str) -> Optional[int]:
        if self.ak is None:
            return None
        try:
            return self.ak.post_event({"agent_id": AGENT_ID, "kind": kind, "title": title,
                                       "detail": {"scheduled_at": iso_z(self.scheduled_at)}})
        except AkError:
            return None

    def _receipt(self, log_failure: bool = True) -> None:
        """Exactly one attempt, never retried (AC 14/31)."""
        detail = self.detail()
        status: Optional[int] = None
        observed: Optional[str] = None
        try:
            status = self.ak.post_event({"agent_id": AGENT_ID, "kind": "status", "title": "claude-reviewer run",
                                         "detail": detail})
            observed = iso_z(self.clock())
        except AkError:
            if log_failure:
                self._error("receipt not delivered")
        if status is not None and not 200 <= status < 300 and log_failure:
            self._error("receipt rejected")
        ledger.append_receipt(self.config.state_dir, {
            "scheduled_at": detail["scheduled_at"], "observed_at": observed, "receipt_http_status": status,
            "app_login": self.app_login, "mode": self.config.mode, "detail": detail,
        })
        self.stdout.write(json.dumps({"receipt_http_status": status, "detail": detail}, separators=(",", ":"), sort_keys=True) + "\n")


class _SafeParser(argparse.ArgumentParser):
    def error(self, message):
        self.exit(EXIT_CONFIG, "claude-reviewer: invalid arguments.\n")


def main(argv: Optional[Sequence[str]] = None, **seams) -> int:
    parser = _SafeParser(description="Claude Reviewer runner (#176)")
    parser.add_argument("--config", required=True)
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except ReviewerError as exc:
        sys.stderr.write("claude-reviewer: " + str(exc) + ".\n")
        return EXIT_CONFIG
    if not config.enabled:
        return EXIT_OK  # AC 15/31: no secret file, no socket, no receipt
    return Runner(config, **seams).run()


if __name__ == "__main__":
    raise SystemExit(main())
