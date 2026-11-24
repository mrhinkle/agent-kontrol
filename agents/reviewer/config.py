"""Config, AK credential and registry loading for the Claude Reviewer (AC 15, 17, 45, 88, 104, 106, 108).

Loading the config opens only the config file. Secret files (App key, AK credential, Claude
OAuth token) are opened later, and only by an enabled run.
"""
from __future__ import annotations

import decimal
import ipaddress
import re
import shlex
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .common import QUEUE_ID_RE, REPO_PART_RE, ReviewerError, bounded_file, strict_json, to_decimal

MAX_CONFIG_BYTES = 256 * 1024
MAX_CREDENTIAL_BYTES = 256 * 1024  # AC 106: same cap as scripts/import-velocity.py
MAX_REGISTRY_BYTES = 1024 * 1024
MAX_OAUTH_TOKEN_BYTES = 16 * 1024

# Same pattern as scripts/import-velocity.py ASSIGNMENT_RE.
ASSIGNMENT_RE = re.compile(r"^\s*(?:export\s+)?(MC_URL|MC_TOKEN)\s*=(.*)$")
DNS_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$")
LOGIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}(?:\[bot\])?$")
VENDOR_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,31}$")

LENS_ALLOWLIST = ("correctness", "tests", "security", "scope", "contract", "maintainability", "adversarial")
DEFAULT_LENSES = ("correctness", "tests", "security", "scope", "contract", "maintainability")

REQUIRED_FIELDS = (
    "enabled", "mode", "ak_url", "ak_credential_file", "github_app_id", "github_app_key_file",
    "registry_path", "state_dir", "queues", "model_mid", "model_top", "daily_cap_usd",
    "claude_oauth_token_file",
)
OPTIONAL_FIELDS = (
    "lenses", "claude_path", "claude_timeout_seconds", "openssl_path", "daily_max_reviews",
    "max_clone_bytes", "max_diff_lines", "schedule_minutes",
)
ALL_FIELDS = frozenset(REQUIRED_FIELDS + OPTIONAL_FIELDS)

DEFAULTS = {
    "claude_path": "claude",
    "claude_timeout_seconds": 900,
    "openssl_path": "/usr/bin/openssl",
    "daily_max_reviews": 40,
    "max_clone_bytes": 200_000_000,
    "max_diff_lines": 5000,
    "schedule_minutes": 15,
}


class ConfigError(ReviewerError):
    pass


@dataclass(frozen=True)
class QueueRef:
    queue: str
    repo: str  # normalized lower-case owner/name


@dataclass(frozen=True)
class Config:
    enabled: bool
    mode: str
    ak_url: str
    ak_credential_file: str
    github_app_id: int
    github_app_key_file: str
    registry_path: str
    state_dir: str
    queues: Tuple[QueueRef, ...]
    lenses: Tuple[str, ...]
    model_mid: str
    model_top: str
    claude_path: str
    claude_timeout_seconds: int
    openssl_path: str
    daily_cap_usd: decimal.Decimal
    daily_max_reviews: int
    max_clone_bytes: int
    max_diff_lines: int
    schedule_minutes: int
    claude_oauth_token_file: str


def _fail(message: str) -> None:
    raise ConfigError("invalid configuration: " + message)


def _path(raw: Dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value or len(value) > 1024:
        _fail(key + " must be an absolute path")
    if '"' in value or "\\" in value or "\n" in value:
        _fail(key + " has a forbidden character")
    return value


def _positive_int(raw: Dict[str, Any], key: str) -> int:
    value = raw.get(key, DEFAULTS.get(key))
    if type(value) is not int or value <= 0:
        _fail(key + " must be a positive integer")
    return value


def origin(value: Any) -> Tuple[str, Tuple[str, str, int]]:
    """Canonical origin, as scripts/import-velocity.py origin(): https, or http on loopback only."""
    if not isinstance(value, str) or not value or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in value):
        _fail("ak_url")
    if "?" in value or "#" in value or "\\" in value:
        _fail("ak_url")
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.path or parsed.query
            or parsed.fragment or parsed.username is not None or parsed.password is not None):
        _fail("ak_url must be an origin")
    host = parsed.hostname
    if not host or "%" in host:
        _fail("ak_url host")
    loopback = host.lower() == "localhost"
    try:
        address = ipaddress.ip_address(host)
        host = address.compressed
        loopback = address.is_loopback
        serialized = "[" + host + "]" if address.version == 6 else host
    except ValueError:
        host = host.lower()
        if len(host) > 253 or any(DNS_LABEL_RE.fullmatch(label) is None for label in host.split(".")):
            _fail("ak_url host")
        serialized = host
    if parsed.scheme == "http" and not loopback:
        _fail("ak_url must use https")
    default_port = 443 if parsed.scheme == "https" else 80
    try:
        port = parsed.port if parsed.port is not None else default_port
    except ValueError:
        _fail("ak_url port")
    canonical = parsed.scheme + "://" + serialized + ("" if port == default_port else ":" + str(port))
    return canonical, (parsed.scheme, host, port)


def normalize_repo(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("repo")
    parts = value.split("/")
    if len(parts) != 2 or not all(REPO_PART_RE.fullmatch(p) for p in parts) or parts[1] in (".", ".."):
        raise ValueError("repo")
    return value.lower()


def parse_lenses(value: Any) -> Tuple[str, ...]:
    """AC 17/45/98: unique allowlisted lenses, adversarial excluded, in the allowlist's order."""
    if value is None:
        return DEFAULT_LENSES
    if not isinstance(value, list) or not value:
        _fail("lenses must be a non-empty array")
    if any(not isinstance(item, str) for item in value):
        _fail("lenses must be strings")
    if "adversarial" in value:
        _fail("adversarial is Tier-C-only and added automatically")
    if any(item not in LENS_ALLOWLIST for item in value) or len(set(value)) != len(value):
        _fail("lenses must be unique allowlisted values")
    canonical = tuple(lens for lens in LENS_ALLOWLIST if lens in value)
    if tuple(value) != canonical:
        # AC 17 ("output in that order") and AC 98 ("in configured order") agree only when
        # the configured list is already in allowlist order, so any other order is rejected.
        _fail("lenses must be listed in allowlist order")
    return canonical


def load_config_text(raw: bytes) -> Config:
    try:
        data = strict_json(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise ConfigError("invalid configuration: not strict JSON") from None
    if not isinstance(data, dict):
        _fail("top level must be an object")
    unknown = set(data) - ALL_FIELDS
    if unknown:
        _fail("unknown field")
    missing = [key for key in REQUIRED_FIELDS if key not in data]
    if missing:
        _fail("missing field " + missing[0])
    if type(data["enabled"]) is not bool:
        _fail("enabled must be a boolean")
    if data["mode"] not in ("dry-run", "live"):
        _fail("mode must be dry-run or live")
    ak_url, _ = origin(data["ak_url"])
    app_id = data["github_app_id"]
    if type(app_id) is not int or app_id <= 0:
        _fail("github_app_id must be a positive integer")

    queues_raw = data["queues"]
    if not isinstance(queues_raw, list) or not queues_raw:
        _fail("queues must be a non-empty array")
    queues: List[QueueRef] = []
    seen = set()
    for item in queues_raw:
        if not isinstance(item, dict) or set(item) != {"queue", "repo"}:
            _fail("each queue must be exactly {queue, repo}")
        queue = item["queue"]
        if not isinstance(queue, str) or QUEUE_ID_RE.fullmatch(queue) is None:
            _fail("queue id must be a lower-case queue id")
        try:
            repo = normalize_repo(item["repo"])
        except ValueError:
            _fail("repo must be owner/name")
        if queue in seen:
            _fail("duplicate queue id")
        seen.add(queue)
        queues.append(QueueRef(queue=queue, repo=repo))

    lenses = parse_lenses(data.get("lenses"))
    for key in ("model_mid", "model_top"):
        if not isinstance(data[key], str) or MODEL_RE.fullmatch(data[key]) is None:
            _fail(key + " must be a model id")
    claude_path = data.get("claude_path", DEFAULTS["claude_path"])
    if not isinstance(claude_path, str) or not claude_path or "\x00" in claude_path or '"' in claude_path or "\\" in claude_path:
        _fail("claude_path")
    openssl_path = data.get("openssl_path", DEFAULTS["openssl_path"])
    if not isinstance(openssl_path, str) or not openssl_path.startswith("/"):
        _fail("openssl_path must be absolute")

    cap = to_decimal(data["daily_cap_usd"])
    if cap is None or cap < 0:
        _fail("daily_cap_usd must be a finite non-negative decimal")

    return Config(
        enabled=data["enabled"],
        mode=data["mode"],
        ak_url=ak_url,
        ak_credential_file=_path(data, "ak_credential_file"),
        github_app_id=app_id,
        github_app_key_file=_path(data, "github_app_key_file"),
        registry_path=_path(data, "registry_path"),
        state_dir=_path(data, "state_dir"),
        queues=tuple(queues),
        lenses=lenses,
        model_mid=data["model_mid"],
        model_top=data["model_top"],
        claude_path=claude_path,
        claude_timeout_seconds=_positive_int(data, "claude_timeout_seconds"),
        openssl_path=openssl_path,
        daily_cap_usd=cap,
        daily_max_reviews=_positive_int(data, "daily_max_reviews"),
        max_clone_bytes=_positive_int(data, "max_clone_bytes"),
        max_diff_lines=_positive_int(data, "max_diff_lines"),
        schedule_minutes=_positive_int(data, "schedule_minutes"),
        claude_oauth_token_file=_path(data, "claude_oauth_token_file"),
    )


def load_config(path: str) -> Config:
    return load_config_text(bounded_file(path, MAX_CONFIG_BYTES, "invalid configuration: unreadable"))


def load_ak_credential(path: str, expected_url: str) -> str:
    """MC_URL/MC_TOKEN literal assignments, parsed like scripts/import-velocity.py (AC 106).

    MC_URL must name the same origin as config `ak_url`. Returns the token.
    """
    raw = bounded_file(path, MAX_CREDENTIAL_BYTES, "invalid credential file")
    values: Dict[str, str] = {}
    try:
        text = raw.decode("utf-8-sig")
        for line in text.splitlines():
            matched = ASSIGNMENT_RE.fullmatch(line)
            if matched is None:
                continue
            key, literal = matched.groups()
            if key in values:
                raise ValueError("duplicate recognized assignment")
            # shlex parses quoting only. It performs no substitutions or execution.
            parts = shlex.split(literal, comments=True, posix=True)
            if len(parts) != 1:
                raise ValueError("invalid literal assignment")
            values[key] = parts[0]
    except (UnicodeError, ValueError):
        raise ReviewerError("invalid credential file") from None
    url, token = values.get("MC_URL"), values.get("MC_TOKEN")
    if not isinstance(url, str) or not isinstance(token, str) or not token or len(token) > 16384:
        raise ReviewerError("invalid credential file")
    if any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
        raise ReviewerError("invalid credential file")
    try:
        if origin(url)[1] != origin(expected_url)[1]:
            raise ReviewerError("credential MC_URL does not match ak_url")
    except ConfigError:
        raise ReviewerError("invalid credential file") from None
    return token


def load_oauth_token(path: str) -> str:
    raw = bounded_file(path, MAX_OAUTH_TOKEN_BYTES, "invalid claude oauth token file")
    try:
        token = raw.decode("ascii").strip()
    except UnicodeError:
        raise ReviewerError("invalid claude oauth token file") from None
    if not token or any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
        raise ReviewerError("invalid claude oauth token file")
    return token


@dataclass(frozen=True)
class Identity:
    login: str
    vendor: str
    tier: str


def load_registry(path: str) -> Dict[str, Identity]:
    """AC 22 shape: {"identities": [{"login", "vendor", "tier"}]}; logins exact lower-case."""
    raw = bounded_file(path, MAX_REGISTRY_BYTES, "invalid registry")
    try:
        data = strict_json(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise ReviewerError("invalid registry") from None
    if not isinstance(data, dict) or set(data) != {"identities"} or not isinstance(data["identities"], list):
        raise ReviewerError("invalid registry")
    out: Dict[str, Identity] = {}
    for item in data["identities"]:
        if not isinstance(item, dict) or set(item) != {"login", "vendor", "tier"}:
            raise ReviewerError("invalid registry")
        login, vendor, tier = item["login"], item["vendor"], item["tier"]
        if not isinstance(login, str) or LOGIN_RE.fullmatch(login) is None:
            raise ReviewerError("invalid registry")
        if not isinstance(vendor, str) or VENDOR_RE.fullmatch(vendor) is None:
            raise ReviewerError("invalid registry")
        if tier not in ("top", "mid"):
            raise ReviewerError("invalid registry")
        if login in out:
            raise ReviewerError("invalid registry")
        out[login] = Identity(login=login, vendor=vendor, tier=tier)
    return out
