"""Allowlisted environment for a headless agent CLI. Stdlib only.

``build_child_env`` returns a new mapping for ``subprocess.Popen(env=...)``.
``strip_secret_env`` is the deny-only form used by ``main_worker_exec``.
Neither function logs a variable's value.
"""
from __future__ import annotations

import os
import sys
from collections.abc import Mapping, MutableMapping

# Matched case-sensitively. The lower-case proxy names are the only exceptions.
_BASE_NAMES = frozenset({
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
})

_NONSECRET_MC = frozenset({
    "MC_URL", "MC_AGENT", "MC_AGENT_NAME", "MC_TRACES", "MC_TRACE_CAPTURE_CONTENT",
})

# Dropped even when MC_CHILD_ENV_ALLOW names them. Other MC_* names are refused too.
_NEVER_EXACT = frozenset({
    "MC_TOKEN",
    "MC_EVENT_TOKEN",
    "MC_DASHBOARD_PASSWORD",
    "MC_COOKIE_SECRET",
    "MC_OAUTH_SECRET",
    "CRON_SECRET",
    "MC_CHILD_ENV_ALLOW",
})

_PLATFORM_PREFIXES = {
    "claude-code": ("ANTHROPIC_", "CLAUDE_"),
    "claude": ("ANTHROPIC_", "CLAUDE_"),
    "codex": ("OPENAI_", "CODEX_"),
    "grok": ("XAI_", "GROK_"),
}


def _is_base(name: str) -> bool:
    return name in _BASE_NAMES or name.startswith("LC_") or name.startswith("XDG_")


def _is_never(name: str) -> bool:
    if name in _NEVER_EXACT:
        return True
    return name.startswith("MC_") and name not in _NONSECRET_MC


def _allow_rules(raw: str) -> tuple[set[str], tuple[str, ...]]:
    """Split MC_CHILD_ENV_ALLOW. A single trailing * is a prefix; any other * is invalid."""
    exact: set[str] = set()
    prefixes: list[str] = []
    seen_invalid: set[str] = set()
    for part in raw.split(","):
        entry = part.strip()
        if entry == "":
            continue
        if "*" in entry:
            if entry != "*" and entry.endswith("*") and entry.count("*") == 1:
                prefixes.append(entry[:-1])
            elif entry not in seen_invalid:
                seen_invalid.add(entry)
                print(f"child_env: ignoring invalid MC_CHILD_ENV_ALLOW entry: {entry}", file=sys.stderr)
            continue
        exact.add(entry)
    return exact, tuple(prefixes)


def _allow_matches(name: str, exact: set[str], prefixes: tuple[str, ...]) -> bool:
    return name in exact or any(name.startswith(prefix) for prefix in prefixes)


def build_child_env(platform: str, parent: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return a new environment for one agent CLI. ``parent`` defaults to ``os.environ`` now."""
    if parent is None:
        parent = os.environ
    exact, prefixes = _allow_rules(parent.get("MC_CHILD_ENV_ALLOW", ""))
    platform_prefixes = _PLATFORM_PREFIXES.get(platform, ())
    warned: set[str] = set()
    child: dict[str, str] = {}
    for name, value in parent.items():
        matched = _allow_matches(name, exact, prefixes)
        if _is_never(name):
            if matched and name not in warned:
                warned.add(name)
                print(f"child_env: not passing {name}", file=sys.stderr)
            continue
        if (
            _is_base(name)
            or name in _NONSECRET_MC
            or any(name.startswith(prefix) for prefix in platform_prefixes)
            or matched
        ):
            child[name] = value
    return child


def strip_secret_env(environ: MutableMapping[str, str]) -> list[str]:
    """Remove never-passed names from ``environ`` in place. Return the removed names."""
    removed: list[str] = []
    for name in list(environ):
        if _is_never(name):
            del environ[name]
            removed.append(name)
    return removed
