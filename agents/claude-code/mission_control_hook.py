#!/usr/bin/env python3
"""
Agent Kontrol hook for Claude Code / Cowork (local).

Reads the hook event JSON from stdin and POSTs a normalized event to the
Agent Kontrol ingest API. Deterministic ground truth: this fires whether
or not the model remembers to report in.

Config via environment (put these in ~/.zshenv or the hook command):
  MC_URL    e.g. https://your-deploy.vercel.app
  MC_TOKEN  shared secret (matches the Vercel env var)
  MC_AGENT  optional agent id override (default: claude-code-<hostname>)

Fail-open by design: any error exits 0 so hooks never block your session.
Stdlib only — no dependencies.
"""
import hashlib
import json
import os
import socket
import sys
import time
import urllib.request
from pathlib import Path


def load_env_file() -> None:
    """GUI-launched apps don't read ~/.zshenv, so fall back to
    ~/.claude/mission-control.env (written by install.sh)."""
    p = Path("~/.claude/mission-control.env").expanduser()
    if not p.exists():
        return
    try:
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))
    except Exception:
        pass


KIND_MAP = {
    "SessionStart": "session_start",
    "UserPromptSubmit": "turn_start",
    "Stop": "waiting",           # Claude finished its turn -> waiting on you
    "Notification": "notification",
    "SessionEnd": "session_end",
    "SubagentStop": "milestone",
    "PreCompact": "milestone",
}


# ---------------------------------------------------------------- traces
# Each Claude Code session becomes one trace: a session span, a turn span per
# prompt, and a span per tool call. Hooks run as separate short processes, so
# the little state needed to pair a tool's start with its end lives in a file.
# Set MC_TRACES=0 to turn this off. Prompt text and tool input/output are NOT
# sent unless MC_TRACE_CAPTURE_CONTENT=1 (and the server also has it set).


def _hid(seed: str, n: int) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()[:n]


def trace_ids(session_id: str) -> tuple:
    """Deterministic ids so every hook process agrees without talking to each other."""
    return _hid("trace:" + session_id, 32), _hid("root:" + session_id, 16)


def _state_path(session_id: str) -> Path:
    d = Path("~/.claude/mission-control-trace").expanduser()
    d.mkdir(parents=True, exist_ok=True)
    return d / (_hid(session_id, 24) + ".json")


def load_state(session_id: str) -> dict:
    try:
        return json.loads(_state_path(session_id).read_text())
    except Exception:
        return {}


def save_state(session_id: str, state: dict) -> None:
    try:
        _state_path(session_id).write_text(json.dumps(state))
    except Exception:
        pass


def prune_old_state(days: int = 7) -> None:
    """Sessions that crashed never send SessionEnd; drop their leftover state files."""
    try:
        cutoff = time.time() - days * 86400
        for f in Path("~/.claude/mission-control-trace").expanduser().glob("*.json"):
            if f.stat().st_mtime < cutoff:
                f.unlink()
    except Exception:
        pass


def clear_state(session_id: str) -> None:
    try:
        _state_path(session_id).unlink()
    except Exception:
        pass


def make_span(trace_id, span_id, parent, name, kind, start_ns, end_ns=None, error=False, message=None, attrs=None):
    """One OTLP JSON span. Times are integer nanoseconds, sent as strings as OTLP requires."""
    attributes = [{"key": "agentkontrol.span.kind", "value": {"stringValue": kind}}]
    for k, v in (attrs or {}).items():
        if isinstance(v, bool):
            attributes.append({"key": k, "value": {"boolValue": v}})
        elif isinstance(v, int):
            attributes.append({"key": k, "value": {"intValue": str(v)}})
        elif v is not None:
            attributes.append({"key": k, "value": {"stringValue": str(v)[:500]}})
    span = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "startTimeUnixNano": str(start_ns),
        "attributes": attributes,
    }
    if parent:
        span["parentSpanId"] = parent
    if end_ns is not None:
        span["endTimeUnixNano"] = str(end_ns)
    if error:
        span["status"] = {"code": 2, "message": (message or "error")[:200]}
    elif end_ns is not None:
        span["status"] = {"code": 1}
    return span


def otlp_request(agent_id: str, session_id: str, spans: list) -> dict:
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "agent.id", "value": {"stringValue": agent_id}},
                        {"key": "session.id", "value": {"stringValue": session_id}},
                    ]
                },
                "scopeSpans": [{"scope": {"name": "agent-kontrol-claude-code-hook"}, "spans": spans}],
            }
        ]
    }


def tool_failed(payload: dict) -> bool:
    resp = payload.get("tool_response")
    if isinstance(resp, dict):
        return bool(resp.get("is_error") or resp.get("error") or resp.get("interrupted"))
    return False


def trace_spans_for(event_name: str, payload: dict, state: dict, now_ns: int) -> list:
    """Pure: decide which spans this hook event produces, updating `state` in place."""
    session_id = payload.get("session_id") or "unknown"
    trace_id, root_id = trace_ids(session_id)
    capture = os.environ.get("MC_TRACE_CAPTURE_CONTENT", "").lower() in ("1", "true", "yes")
    spans = []

    if event_name == "SessionStart":
        state.clear()
        state.update({"root_start": now_ns, "turn": 0, "tools": {}})
        cwd = payload.get("cwd") or ""
        spans.append(make_span(trace_id, root_id, None, "session", "session", now_ns,
                               attrs={"project": os.path.basename(cwd) if cwd else None, "session.id": session_id}))
    elif event_name == "UserPromptSubmit":
        state.setdefault("root_start", now_ns)
        n = int(state.get("turn", 0)) + 1
        state["turn"] = n
        turn_id = _hid(f"turn:{session_id}:{n}", 16)
        state["turn_id"], state["turn_start"] = turn_id, now_ns
        attrs = {"turn.number": n}
        if capture:
            attrs["prompt"] = (payload.get("prompt") or "")[:300]
        spans.append(make_span(trace_id, turn_id, root_id, f"turn {n}", "turn", now_ns, attrs=attrs))
    elif event_name == "PreToolUse":
        tools = state.setdefault("tools", {})
        tools[payload.get("tool_use_id") or payload.get("tool_name", "tool")] = now_ns
    elif event_name in ("PostToolUse", "PostToolUseFailure"):
        tool_use_id = payload.get("tool_use_id")
        start = state.get("tools", {}).pop(tool_use_id or payload.get("tool_name", "tool"), None) or max(0, now_ns - 1_000_000)
        name = payload.get("tool_name") or "tool"
        span_id = _hid(f"tool:{session_id}:{tool_use_id or now_ns}", 16)
        attrs = {"tool.name": name}
        if capture:
            attrs["tool.input"] = json.dumps(payload.get("tool_input"))[:300]
        failed = event_name == "PostToolUseFailure" or tool_failed(payload)
        spans.append(make_span(trace_id, span_id, state.get("turn_id") or root_id, name, "tool", start, now_ns,
                               error=failed, message="tool failed", attrs=attrs))
    elif event_name == "Stop":
        if state.get("turn_id"):
            n = state.get("turn", 0)
            spans.append(make_span(trace_id, state["turn_id"], root_id, f"turn {n}", "turn",
                                   state.get("turn_start", now_ns), now_ns, attrs={"turn.number": n}))
            state.pop("turn_id", None)
    elif event_name == "SessionEnd":
        spans.append(make_span(trace_id, root_id, None, "session", "session", state.get("root_start", now_ns), now_ns,
                               attrs={"session.id": session_id}))
    return spans


def send_traces(url: str, agent_id: str, event_name: str, payload: dict) -> None:
    if os.environ.get("MC_TRACES", "1") == "0":
        return
    session_id = payload.get("session_id")
    if not session_id:
        return
    if event_name == "SessionStart":
        prune_old_state()
    state = load_state(session_id)
    spans = trace_spans_for(event_name, payload, state, time.time_ns())
    if event_name == "SessionEnd":
        clear_state(session_id)
    else:
        save_state(session_id, state)
    if not spans:
        return
    req = urllib.request.Request(
        f"{url}/api/v1/traces",
        data=json.dumps(otlp_request(agent_id, session_id, spans)).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('MC_TOKEN', '')}"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    load_env_file()
    url = os.environ.get("MC_URL", "").rstrip("/")
    if not url:
        return

    hostname = socket.gethostname().split(".")[0].lower()
    event_name = payload.get("hook_event_name", "unknown")
    agent_id = os.environ.get("MC_AGENT", f"claude-code-{hostname}")
    if event_name in ("PreToolUse", "PostToolUse", "PostToolUseFailure"):
        # Tool events only feed traces; they would flood the fleet event log.
        send_traces(url, agent_id, event_name, payload)
        return
    kind = KIND_MAP.get(event_name, "status")
    cwd = payload.get("cwd") or os.getcwd()
    project = os.path.basename(cwd) if cwd else None

    title = event_name
    if event_name == "SessionStart":
        title = f"Session started in {cwd}"
    elif event_name == "UserPromptSubmit":
        prompt = (payload.get("prompt") or "")[:140]
        title = f"New instruction: {prompt}" if prompt else "New instruction"
    elif event_name == "Stop":
        title = "Turn finished — waiting for input"
    elif event_name == "Notification":
        title = (payload.get("message") or "Needs attention")[:140]
    elif event_name == "SessionEnd":
        title = "Session ended"

    body = {
        "agent_id": agent_id,
        "platform": "claude-code",
        "machine": hostname,
        "display_name": os.environ.get("MC_AGENT_NAME", f"Claude Code ({hostname})"),
        "session_id": payload.get("session_id"),
        "kind": kind,
        "title": title,
        "summary": title,
        "project": project,
        "detail": {"hook_event": event_name},
    }

    req = urllib.request.Request(
        f"{url}/api/ingest",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ.get('MC_TOKEN', '')}",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=3)
    except Exception:
        pass

    send_traces(url, agent_id, event_name, payload)

    # Two-way: at natural checkpoints, pull any messages the operator queued for this
    # agent and inject them into the session as additional context.
    if event_name in ("UserPromptSubmit", "SessionStart"):
        try:
            ireq = urllib.request.Request(
                f"{url}/api/messages?agent_id={body['agent_id']}&ack=true",
                headers={"Authorization": f"Bearer {os.environ.get('MC_TOKEN', '')}"},
                method="GET",
            )
            with urllib.request.urlopen(ireq, timeout=3) as resp:
                msgs = json.loads(resp.read().decode()).get("messages", [])
            if msgs:
                lines = "\n".join(f"- {m.get('body', '')}" for m in msgs)
                out = {
                    "hookSpecificOutput": {
                        "hookEventName": event_name,
                        "additionalContext": "\U0001F4EC Messages from the operator via Agent Kontrol:\n" + lines,
                    }
                }
                print(json.dumps(out))
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.exit(0)
