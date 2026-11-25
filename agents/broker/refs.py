"""Parse secretref:// references. Stdlib only.

A reference is not a secret. ``parse_reference`` either returns the three
components or raises ``ValueError("invalid secret reference")`` with no
input echoed and no chained exception.
"""
from __future__ import annotations

import re

_PREFIX = "secretref://"
_PROVIDERS = frozenset(("file", "exec"))
_SOURCE_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_SEGMENT_RE = re.compile(r"[A-Za-z0-9_.-]+\Z")
_INVALID = "invalid secret reference"


def _raise_invalid() -> None:
    # Raised outside an except handler so __context__ stays empty.
    raise ValueError(_INVALID) from None


def _valid_name(name: str) -> bool:
    """Name is 1–200 characters, slash-separated segments, no '.' or '..'."""
    if not name or len(name) > 200:
        return False
    for segment in name.split("/"):
        if segment in (".", ".."):
            return False
        if _SEGMENT_RE.fullmatch(segment) is None:
            return False
    return True


def parse_reference(text: str) -> tuple[str, str, str]:
    """Return ``(provider, source, name)`` for a ``secretref://`` reference."""
    if not isinstance(text, str) or not text.isascii():
        _raise_invalid()
    if any(ch.isspace() for ch in text) or "%" in text or "?" in text or "#" in text:
        _raise_invalid()
    if not text.startswith(_PREFIX):
        _raise_invalid()
    provider, sep, rest = text[len(_PREFIX):].partition("/")
    source, sep2, name = rest.partition("/")
    if sep != "/" or sep2 != "/" or provider not in _PROVIDERS:
        _raise_invalid()
    if _SOURCE_RE.fullmatch(source) is None or not _valid_name(name):
        _raise_invalid()
    return provider, source, name
