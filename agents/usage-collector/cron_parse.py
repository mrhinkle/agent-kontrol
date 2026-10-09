"""Parse Hermes cron job ids from session_id / task fields.

Hermes cron sessions look like:
  cron_<jobid>_<YYYYMMDD>_<HHMMSS>
e.g. cron_276f85f1aa52_20261002_132350

Returns the stable job id (hex prefix), not the run timestamp.
"""
from __future__ import annotations

import re
from typing import Optional

# Primary: cron_<12-hex>_<date>_<time>  OR cron_<id> without timestamp
CRON_RE = re.compile(
    r"(?:^|[^a-z0-9])cron[_:-](?P<job>[a-f0-9]{6,32})(?:[_:-]\d{8}[_:-]\d{6})?",
    re.IGNORECASE,
)
# Fallback: job_<id>
JOB_RE = re.compile(r"(?:^|[^a-z0-9])job[_:-](?P<job>[a-z0-9_-]{4,64})", re.IGNORECASE)

# Fields that must never be treated as content carriers for cron parsing beyond ids
FORBIDDEN_CONTENT_KEYS = frozenset({
    "content", "prompt", "completion", "message", "messages",
    "system_prompt", "tool_args", "arguments", "body", "text",
})


def parse_cron_job_id(*candidates: Optional[str]) -> Optional[str]:
    for raw in candidates:
        if not raw or not isinstance(raw, str):
            continue
        m = CRON_RE.search(raw)
        if m:
            return m.group("job").lower()
        m = JOB_RE.search(raw)
        if m:
            return m.group("job").lower()
    return None
