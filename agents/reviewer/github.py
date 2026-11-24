"""GitHub App client for the Claude Reviewer (AC 7, 19, 30, 46, 57, 70, 90, 100).

Conventions match src/lib/github-read.ts: X-GitHub-Api-Version 2022-11-28, 15-second timeout,
redirects refused, Retry-After honoured once (then `rate_limit`), installation-lookup 404 is
`not_installed`, and 401 / 403-or-404 / other map to token_revoked / missing_permission /
github_error. No ambient proxy, no credential helper, no `gh`, no environment token.

The App JWT is used only for GET /app, GET /repos/{o}/{r}/installation and
POST /app/installations/{id}/access_tokens. Every other call uses an installation token.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

from .common import strict_json

GITHUB_API = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"
GITHUB_TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_RETRY_AFTER_SECONDS = 60
REVIEW_PAGE_CAP = 100
COMMIT_LIMIT = 250

FAILURES = ("not_installed", "token_revoked", "missing_permission", "rate_limit", "github_error")


class GitHubFailure(Exception):
    """One of FAILURES; carries no response body, URL or header."""

    def __init__(self, outcome: str, status: int = 0):
        super().__init__(outcome)
        assert outcome in FAILURES
        self.outcome = outcome
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def default_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_app_jwt(app_id: int, key_file: str, openssl_path: str, now: float) -> str:
    """RS256 App JWT signed by one `openssl dgst -sha256 -sign <key_file>` subprocess (AC 57, 100).

    The signing input goes to stdin and the raw signature comes from stdout. Only the key
    file path appears in argv. Any failure raises GitHubFailure("not_installed").
    """
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    issued = int(now)
    payload = b64url(json.dumps({"iat": issued - 60, "exp": issued + 540, "iss": app_id}, separators=(",", ":")).encode())
    signing_input = (header + "." + payload).encode("ascii")
    try:
        done = subprocess.run(
            [openssl_path, "dgst", "-sha256", "-sign", key_file],
            input=signing_input,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "LANG": "C"},
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise GitHubFailure("not_installed") from None
    if done.returncode != 0 or not done.stdout:
        raise GitHubFailure("not_installed")
    return header + "." + payload + "." + b64url(done.stdout)


def retry_after_seconds(headers, now: float) -> Optional[int]:
    retry = headers.get("retry-after") if headers is not None else None
    if retry:
        text = retry.strip()
        if text.isdigit():
            return int(text)
        try:
            from email.utils import parsedate_to_datetime
            when = parsedate_to_datetime(text).timestamp()
            return max(0, int(when - now + 0.999))
        except (TypeError, ValueError, IndexError, OverflowError):
            pass
    if headers is None or (headers.get("x-ratelimit-remaining") or "").strip() != "0":
        return None
    reset = (headers.get("x-ratelimit-reset") or "").strip()
    if reset.isdigit():
        return max(0, int(reset) - int(now))
    return None


def classify(status: int, body: bytes, headers, now: float) -> Optional[str]:
    """github-read.ts classifyGitHubResponse, with `http` renamed `github_error`."""
    if 200 <= status < 300:
        return None
    retry = retry_after_seconds(headers, now)
    text = body[:4096].decode("utf-8", "replace") if body else ""
    secondary = re.search(r"secondary rate limit", text, re.I) is not None or (
        status == 403 and retry is not None and re.search(r"rate limit", text, re.I) is not None)
    if status == 429 or secondary:
        return "rate_limit"
    if status == 401:
        return "token_revoked"
    if status in (403, 404):
        return "missing_permission"
    return "github_error"


class Response:
    def __init__(self, status: int, headers, body: bytes):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self) -> Any:
        try:
            return strict_json(self.body) if self.body else None
        except (ValueError, UnicodeError, RecursionError):
            raise GitHubFailure("github_error") from None


class GitHubClient:
    """Minimal REST client. `api` may be a loopback URL in tests."""

    def __init__(self, app_id: int, key_file: str, openssl_path: str, *, api: str = GITHUB_API,
                 opener=None, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep):
        self.app_id = app_id
        self.key_file = key_file
        self.openssl_path = openssl_path
        self.api = api.rstrip("/")
        self.opener = opener or default_opener()
        self.clock = clock
        self.sleep = sleep
        self._installation_tokens: Dict[int, str] = {}
        self._repo_installation: Dict[str, int] = {}
        self.writes: List[Tuple[str, str]] = []  # (method, path) of every non-GET sent

    # -- transport -------------------------------------------------------
    def _send(self, method: str, path: str, bearer: str, body: Optional[dict] = None) -> Response:
        data = None
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + bearer,
            "User-Agent": "agent-kontrol",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        }
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.api + path, data=data, method=method, headers=headers)
        if method != "GET":
            self.writes.append((method, path))
        try:
            with self.opener.open(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
                payload = response.read(MAX_RESPONSE_BYTES + 1)
                status = response.status
                response_headers = response.headers
        except urllib.error.HTTPError as exc:
            status = exc.code
            response_headers = exc.headers
            try:
                payload = exc.read(MAX_RESPONSE_BYTES + 1)
            except Exception:
                payload = b""
            finally:
                exc.close()
        except Exception:
            # Transport errors may embed URLs or headers; never surface them.
            raise GitHubFailure("github_error") from None
        if 300 <= status < 400:
            raise GitHubFailure("github_error", status)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise GitHubFailure("github_error", status)
        return Response(status, response_headers, payload)

    def _call(self, method: str, path: str, bearer: str, body: Optional[dict] = None) -> Response:
        """Send once; on a rate limit with a bounded Retry-After, wait and send exactly once more."""
        first = self._send(method, path, bearer, body)
        if classify(first.status, first.body, first.headers, self.clock()) != "rate_limit":
            return first
        retry = retry_after_seconds(first.headers, self.clock())
        if retry is None or retry > MAX_RETRY_AFTER_SECONDS:
            return first
        self.sleep(retry)
        return self._send(method, path, bearer, body)

    def _jwt(self) -> str:
        return sign_app_jwt(self.app_id, self.key_file, self.openssl_path, self.clock())

    # -- App-JWT endpoints ---------------------------------------------------
    def app_login(self) -> str:
        """GET /app → `<slug>[bot]`, ASCII lower-cased (AC 7, 101). Any failure is fatal (AC 90)."""
        response = self._call("GET", "/app", self._jwt())
        outcome = classify(response.status, response.body, response.headers, self.clock())
        if outcome is not None:
            raise GitHubFailure("token_revoked" if response.status == 401 else "github_error", response.status)
        data = response.json()
        slug = data.get("slug") if isinstance(data, dict) else None
        if not isinstance(slug, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,33}", slug) is None:
            raise GitHubFailure("github_error", response.status)
        return slug.encode("ascii").lower().decode("ascii") + "[bot]"

    def installation_token(self, repo: str) -> str:
        if repo in self._repo_installation:
            return self._installation_tokens[self._repo_installation[repo]]
        jwt = self._jwt()
        response = self._call("GET", "/repos/" + repo_path(repo) + "/installation", jwt)
        if response.status == 404:
            raise GitHubFailure("not_installed", 404)
        outcome = classify(response.status, response.body, response.headers, self.clock())
        if outcome is not None:
            raise GitHubFailure(outcome, response.status)
        data = response.json()
        installation_id = data.get("id") if isinstance(data, dict) else None
        if type(installation_id) is not int or installation_id <= 0:
            raise GitHubFailure("not_installed", response.status)
        if installation_id not in self._installation_tokens:
            minted = self._call("POST", "/app/installations/%d/access_tokens" % installation_id, jwt)
            outcome = classify(minted.status, minted.body, minted.headers, self.clock())
            if outcome is not None:
                raise GitHubFailure("token_revoked" if outcome == "missing_permission" else outcome, minted.status)
            token = minted.json()
            token = token.get("token") if isinstance(token, dict) else None
            if not isinstance(token, str) or not token or any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
                raise GitHubFailure("token_revoked", minted.status)
            self._installation_tokens[installation_id] = token
        self._repo_installation[repo] = installation_id
        return self._installation_tokens[installation_id]

    def known_secrets(self) -> List[str]:
        return list(self._installation_tokens.values())

    # -- installation-token endpoints ---------------------------------------
    def _read(self, repo: str, path: str, absent_is_none: bool = False) -> Tuple[Any, Response]:
        response = self._call("GET", path, self.installation_token(repo))
        if absent_is_none and response.status == 404:
            return None, response
        outcome = classify(response.status, response.body, response.headers, self.clock())
        if outcome is not None:
            raise GitHubFailure(outcome, response.status)
        return response.json(), response

    def get_pull(self, repo: str, number: int) -> Optional[dict]:
        data, _ = self._read(repo, "/repos/%s/pulls/%d" % (repo_path(repo), number), absent_is_none=True)
        if data is None:
            return None
        if not isinstance(data, dict):
            raise GitHubFailure("github_error")
        return data

    def list_commits(self, repo: str, number: int) -> List[dict]:
        """AC 82: per_page=100 pages until a short page or no Link next; 250-commit endpoint cap."""
        commits: List[dict] = []
        page = 1
        while True:
            data, response = self._read(repo, "/repos/%s/pulls/%d/commits?per_page=100&page=%d" % (repo_path(repo), number, page))
            if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
                raise GitHubFailure("github_error")
            commits.extend(data)
            if len(data) < 100 or not _has_next(response.headers):
                return commits
            if len(commits) >= COMMIT_LIMIT:
                raise GitHubFailure("github_error")
            page += 1

    def list_reviews(self, repo: str, number: int) -> List[dict]:
        """AC 38: every review, all pages."""
        reviews: List[dict] = []
        for page in range(1, REVIEW_PAGE_CAP + 1):
            data, response = self._read(repo, "/repos/%s/pulls/%d/reviews?per_page=100&page=%d" % (repo_path(repo), number, page))
            if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
                raise GitHubFailure("github_error")
            reviews.extend(data)
            if len(data) < 100 or not _has_next(response.headers):
                return reviews
        raise GitHubFailure("github_error")

    def post_review(self, repo: str, number: int, head_sha: str, body: str) -> None:
        """AC 10: one COMMENT review pinned to the reviewed head."""
        response = self._call(
            "POST", "/repos/%s/pulls/%d/reviews" % (repo_path(repo), number), self.installation_token(repo),
            {"commit_id": head_sha, "body": body, "event": "COMMENT"},
        )
        if response.status == 404:
            # Edge cases: the App is not installed (or cannot see the pull) for this post.
            raise GitHubFailure("not_installed", 404)
        outcome = classify(response.status, response.body, response.headers, self.clock())
        if outcome is not None:
            raise GitHubFailure(outcome, response.status)


def _has_next(headers) -> bool:
    link = headers.get("link") if headers is not None else None
    if not link:
        # No Link header: a full page may still be followed by more; GitHub always sends Link
        # when more pages exist, so a missing header means this was the last page.
        return False
    return re.search(r'rel="next"', link) is not None


def repo_path(repo: str) -> str:
    owner, name = repo.split("/")
    return urllib.parse.quote(owner, safe="") + "/" + urllib.parse.quote(name, safe="")


def basic_auth_header(token: str) -> str:
    """Git-over-HTTPS header for an installation token (x-access-token basic auth)."""
    return "Authorization: Basic " + base64.b64encode(("x-access-token:" + token).encode("ascii")).decode("ascii")
