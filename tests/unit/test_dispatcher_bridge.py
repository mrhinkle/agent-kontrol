#!/usr/bin/env python3
"""Dispatcher bridge wiring (#212). Fake HTTP, real worktrees, real child processes.

The golden fixture pins one polling iteration of the disabled dispatcher
(``MC_BRIDGE_ENABLED`` unset). It was captured from ``main`` at ``5c57bff``
before any dispatcher edit:

    python3 tests/unit/test_dispatcher_bridge.py --capture-golden
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

DISPATCHER = Path(__file__).resolve().parents[2] / "agents" / "dispatcher"
sys.path.insert(0, str(DISPATCHER))
import mc_dispatcher as md  # noqa: E402

GOLDEN = Path(__file__).resolve().parent / "fixtures" / "dispatcher_bridge_disabled_golden.json"
GOLDEN_HOST = "goldenhost"
GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}
BLOCK = (
    "<!-- ak-skills:begin -->\n- a (1.0.0, aaaaaaa) — first. Fetch: get_skill {\"id\":\"a\"}\n"
    "<!-- ak-skills:end -->"
)

# A fake agent CLI. It records its argv, cwd and environment names, then
# prints a claude-code result envelope. A review run prints an approval.
FAKE_CLI = r'''#!/usr/bin/env python3
import json, os, sys
log = "@CLI_LOG@"
review = "default" in sys.argv
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "env": sorted(k for k in os.environ if k != "LC_CTYPE" and not k.startswith("__CF"))}) + "\n")
text = "looks right\nVERDICT: APPROVE" if review else "did it\nRESULT: golden ok"
print(json.dumps({"type": "result", "result": text, "total_cost_usd": 0.25}))
'''


def run_git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True,
                   env={**os.environ, **GIT_ENV})


def make_worktree(base: Path, name: str = "proj") -> tuple[Path, Path]:
    """(MC_WORKDIR root, linked worktree) under base."""
    main_repo = base / "main"
    root = base / "work"
    root.mkdir()
    run_git(base, "init", "-q", "-b", "main", str(main_repo))
    (main_repo / "README.md").write_text("hi\n")
    run_git(main_repo, "add", "README.md")
    run_git(main_repo, "commit", "-q", "-m", "init")
    wt = root / name
    run_git(main_repo, "worktree", "add", "-q", "-b", f"lane-{name}", str(wt))
    return root, wt


def make_fakebin(base: Path, script: str = FAKE_CLI) -> Path:
    fakebin = base / "bin"
    fakebin.mkdir()
    for cli in ("claude", "codex", "grok"):
        path = fakebin / cli
        path.write_text(script.replace("#!/usr/bin/env python3", f"#!{sys.executable}")
                        .replace("@CLI_LOG@", str(base / "cli.log")))
        path.chmod(0o755)
    return fakebin


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.data = json.dumps(payload).encode()

    def read(self, n: int = -1) -> bytes:
        return self.data if n is None or n < 0 else self.data[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeServer:
    """urlopen replacement that records every request byte for byte."""

    def __init__(self, task: dict | None) -> None:
        self.task = task
        self.requests: list[dict] = []
        self.claim_reply = None  # callable(body) -> payload, overrides the default

    def urlopen(self, req, timeout=None):
        split = md.urllib.parse.urlsplit(req.full_url)
        raw = req.data.decode("utf-8") if req.data is not None else None
        self.requests.append({
            "method": req.get_method(),
            "path": split.path + (("?" + split.query) if split.query else ""),
            "headers": {k.lower(): v for k, v in sorted(req.header_items())},
            "body": raw,
            "timeout": timeout,
        })
        body = json.loads(raw) if raw else None
        if split.path == "/api/tasks/claim":
            if self.claim_reply is not None:
                return FakeResponse(self.claim_reply(body))
            task, self.task = self.task, None
            return FakeResponse({"task": task})
        if split.path == "/api/skills/pointers":
            q = md.urllib.parse.parse_qs(split.query)
            return FakeResponse({"demo": False, "lane": q["lane"][0], "runtime": q["runtime"][0],
                                 "empty": False, "block": BLOCK})
        return FakeResponse({})


class _OneIteration(Exception):
    pass


class InlineThread:
    """threading.Thread stand-in that runs the target when started."""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._target, self._args, self._kwargs = target, args, kwargs or {}

    def start(self):
        self._target(*self._args, **self._kwargs)


def _normalize(value, tmp: str):
    if isinstance(value, str):
        return value.replace(tmp, "<TMP>")
    if isinstance(value, list):
        return [_normalize(v, tmp) for v in value]
    if isinstance(value, dict):
        return {k: _normalize(v, tmp) for k, v in value.items()}
    return value


_VOLATILE = re.compile(r'"(started_at|ended_at|duration_ms|run_id)": ("[^"]*"|[0-9]+)')


def _normalize_body(raw: str | None, tmp: str):
    """The exact request bytes, with only run timing replaced."""
    if raw is None:
        return None
    return _VOLATILE.sub(lambda m: f'"{m.group(1)}": "<{m.group(1)}>"', raw).replace(tmp, "<TMP>")


def golden_task() -> dict:
    return {"id": 41, "title": "Golden task", "description": "do the golden thing",
            "project": "proj", "platform": "claude-code", "machine": GOLDEN_HOST,
            "reviewer_platform": "claude-code", "status": "claimed"}


def disabled_iteration(extra_env: dict | None = None) -> dict:
    """One polling iteration of main() with bridge mode not enabled. Normalized record."""
    with tempfile.TemporaryDirectory() as tmp_name:
        base = Path(tmp_name).resolve()
        root, _wt = make_worktree(base)
        fakebin = make_fakebin(base)
        home = base / "home"
        home.mkdir()
        cli_log = base / "cli.log"
        env = {
            "PATH": f"{fakebin}:/usr/bin:/bin",
            "HOME": str(home),
            "MC_URL": "https://ak.invalid",
            "MC_TOKEN": "golden-token",
            "MC_WORKDIR": str(root),
            "MC_PLATFORMS": "claude-code",
            **GIT_ENV,
            **(extra_env or {}),
        }
        server = FakeServer(golden_task())
        printed: list[str] = []
        errors: list[str] = []

        def fake_print(*args, file=None, **kwargs):
            text = " ".join(str(a) for a in args)
            (errors if file is sys.stderr else printed).append(text)

        def stop_wait(self, timeout):
            raise _OneIteration()

        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(md, "HOSTNAME", GOLDEN_HOST), \
                mock.patch.object(md.urllib.request, "urlopen", side_effect=server.urlopen), \
                mock.patch.object(md.threading, "Thread", InlineThread), \
                mock.patch.object(md.DispatchWake, "wait", stop_wait), \
                mock.patch("builtins.print", side_effect=fake_print):
            try:
                md.main()
            except _OneIteration:
                pass
        cli_runs = [json.loads(line) for line in cli_log.read_text().splitlines()] if cli_log.exists() else []
        record = {
            "requests": [
                {**{k: v for k, v in r.items() if k != "body"}, "body": _normalize_body(r["body"], str(base))}
                for r in server.requests
            ],
            "stdout": printed,
            "stderr": errors,
            "cli_runs": _normalize(cli_runs, str(base)),
            "agents_md_after": (_wt / "AGENTS.md").read_text() if (_wt / "AGENTS.md").exists() else None,
        }
        return _normalize(record, str(base))


class GoldenDisabledTests(unittest.TestCase):
    """C13 / AC1: with MC_BRIDGE_ENABLED unset, one iteration matches main byte for byte."""

    def test_disabled_iteration_matches_main_golden(self):
        expected = json.loads(GOLDEN.read_text(encoding="utf-8"))
        self.assertEqual(disabled_iteration(), expected)


if __name__ == "__main__":
    if "--capture-golden" in sys.argv:
        GOLDEN.write_text(json.dumps(disabled_iteration(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {GOLDEN}")
    else:
        unittest.main()
