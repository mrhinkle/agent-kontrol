"""Commit vendor resolution, ROLES.md "Provenance has one reading" (AC 6, 21, 39, 63, 82, 87).

Per commit:
- every `Agent-Vendor:` line is matched with the exact scripts/collect-progress.sh regex and
  lower-cased; two or more distinct values → provenance_unknown;
- one distinct value → accepted only when the exact lower-case `author.login` is registered
  with that same vendor (AC 87); otherwise provenance_unknown;
- no trailer → the registered vendor of the exact lower-case `author.login` (AC 63), human or
  not; a null, deleted or unregistered author → provenance_unknown.

Per PR: any `claude` → same_vendor; else any unknown → provenance_unknown; else eligible.
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Tuple

from .common import TRAILER_RE
from .config import Identity

UNKNOWN = "provenance_unknown"


def trailer_vendors(message: str) -> List[str]:
    return sorted({match.group("v").lower() for match in TRAILER_RE.finditer(message)})


def commit_vendor(commit: dict, registry: Dict[str, Identity]) -> str:
    inner = commit.get("commit")
    message = inner.get("message") if isinstance(inner, dict) else None
    if not isinstance(message, str):
        return UNKNOWN
    author = commit.get("author")
    login: Optional[str] = None
    if isinstance(author, dict) and isinstance(author.get("login"), str) and author.get("login"):
        login = author["login"].lower()
    registered = registry.get(login) if login is not None else None
    vendors = trailer_vendors(message)
    if len(vendors) > 1:
        return UNKNOWN
    if len(vendors) == 1:
        if registered is None or registered.vendor != vendors[0]:
            return UNKNOWN
        return vendors[0]
    if registered is None:
        return UNKNOWN
    return registered.vendor


def resolve(commits: Iterable[dict], registry: Dict[str, Identity]) -> Tuple[str, List[str]]:
    """Return (decision, sorted vendor set). decision ∈ eligible | same_vendor | provenance_unknown."""
    vendors = [commit_vendor(commit, registry) for commit in commits]
    if not vendors:
        return UNKNOWN, []
    found = sorted(set(vendors))
    if "claude" in found:
        return "same_vendor", found
    if UNKNOWN in found:
        return UNKNOWN, found
    return "eligible", found
