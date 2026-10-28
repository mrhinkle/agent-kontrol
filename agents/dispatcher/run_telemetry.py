"""Metadata-only parsing for finalized dispatcher invocations; no I/O or config."""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime


MAX_COUNT = 1_000_000_000
MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}\Z")
RESUME_FLAGS = {
    "claude-code": {"--resume", "--continue", "-r", "-c"},
    "grok": {"--resume", "--continue", "-r", "-c"},
    # Codex -c is a configuration override, not a continuation switch.
    "codex": {"resume", "fork"},
}


@dataclass
class ParsedRun:
    # Task output stays on the existing result path; build_detail never copies it.
    output_text: str | None = None
    model_usage: list[dict] = field(default_factory=list)
    usage_complete: bool = False
    protocol_ok: bool = False
    reported_error: bool = False


def count(value: object) -> int | None:
    return value if type(value) is int and 0 <= value <= MAX_COUNT else None


def safe_model(value: object) -> str | None:
    if not isinstance(value, str) or not MODEL_NAME.fullmatch(value):
        return None
    if value.startswith(("sk-", "pk-")) or ".." in value:
        return None
    return value


def usage_row(model: str, raw: dict, *, camel: bool, full_input: bool) -> dict:
    keys = (
        {"input_tokens": "inputTokens", "output_tokens": "outputTokens",
         "cache_read_tokens": "cacheReadInputTokens", "cache_write_tokens": "cacheCreationInputTokens",
         "reasoning_tokens": "reasoningTokens"}
        if camel else
        {"input_tokens": "input_tokens", "output_tokens": "output_tokens",
         "cache_read_tokens": "cache_read_input_tokens", "cache_write_tokens": "cache_creation_input_tokens",
         "reasoning_tokens": "reasoning_tokens"}
    )
    row = {"model": model}
    for target, source in keys.items():
        n = count(raw.get(source))
        if n is not None:
            row[target] = n
    if full_input and "input_tokens" in row:
        total = row["input_tokens"] + row.get("cache_read_tokens", 0) + row.get("cache_write_tokens", 0)
        if total <= MAX_COUNT:
            row["input_tokens"] = total
        else:
            del row["input_tokens"]
    return row


def envelope_usage(payload: dict) -> list[dict]:
    """Claude/Grok camel-case per-model usage supersedes top-level usage."""
    per_model = payload.get("modelUsage")
    if isinstance(per_model, dict) and per_model:
        rows = []
        for model, raw in per_model.items():
            name = safe_model(model)
            if name and isinstance(raw, dict):
                row = usage_row(name, raw, camel=True, full_input=True)
                if len(row) > 1:
                    rows.append(row)
        return rows
    raw = payload.get("usage")
    if isinstance(raw, dict):
        row = usage_row("unknown", raw, camel=False, full_input=True)
        return [row] if len(row) > 1 else []
    return []


def parse_cli_output(platform: str, stdout: str) -> ParsedRun:
    """Parse synthetic-compatible public envelopes, never conversation files."""
    result = ParsedRun()
    try:
        if platform == "codex":
            terminal = None
            texts = []
            valid = True
            for line in stdout.splitlines():
                if not line.strip():
                    continue
                event = json.loads(line)
                if not isinstance(event, dict):
                    valid = False
                    continue
                kind = event.get("type")
                item = event.get("item")
                if kind == "item.completed" and isinstance(item, dict) and item.get("type") == "agent_message":
                    if isinstance(item.get("text"), str):
                        texts.append(item["text"])
                if kind == "turn.completed":
                    terminal = event
                if kind in {"turn.failed", "error"}:
                    result.reported_error = True
            if texts:
                result.output_text = "\n\n".join(texts)
            result.protocol_ok = valid and (terminal is not None or result.reported_error)
            raw = terminal.get("usage") if terminal else None
            if isinstance(raw, dict):
                row = {"model": "unknown"}
                for target, source in {
                    "input_tokens": "input_tokens", "output_tokens": "output_tokens",
                    "cache_read_tokens": "cached_input_tokens", "reasoning_tokens": "reasoning_output_tokens",
                }.items():
                    n = count(raw.get(source))
                    if n is not None:
                        row[target] = n
                if len(row) > 1:
                    result.model_usage = [row]
        else:
            payload = json.loads(stdout)
            if not isinstance(payload, dict):
                return result
            if platform == "claude-code":
                result.protocol_ok = payload.get("type") == "result"
                result.reported_error = payload.get("is_error") is True
                text = payload.get("result")
            elif platform == "grok":
                result.reported_error = payload.get("type") == "error"
                result.protocol_ok = isinstance(payload.get("text"), str) or result.reported_error
                text = payload.get("message") if result.reported_error else payload.get("text")
            else:
                return result
            if isinstance(text, str):
                result.output_text = text
            result.model_usage = envelope_usage(payload) if result.protocol_ok else []
        result.usage_complete = bool(result.model_usage) and result.protocol_ok and all(
            "input_tokens" in row and "output_tokens" in row for row in result.model_usage
        )
        if platform != "codex":
            # These protocols report uncached input. Missing cache categories are
            # unknown; the summed input remains a lower bound, not complete usage.
            result.usage_complete = result.usage_complete and all(
                "cache_read_tokens" in row and "cache_write_tokens" in row for row in result.model_usage
            )
        if platform != "codex" and isinstance(payload.get("modelUsage"), dict):
            result.usage_complete = result.usage_complete and len(result.model_usage) == len(payload["modelUsage"])
        if platform != "codex" and payload.get("usage_is_incomplete") is True:
            result.usage_complete = False
        if len(result.model_usage) > 32:
            result.model_usage = result.model_usage[:32]
            result.usage_complete = False
    except (ValueError, TypeError):
        # No raw payload or exception may reach telemetry.
        result.protocol_ok = False
        result.model_usage = []
        result.usage_complete = False
    return result


def resumes_session(args: list[str], platform: str) -> bool:
    flags = RESUME_FLAGS.get(platform, set())
    return any(arg.split("=", 1)[0] in flags for arg in args)


def build_detail(*, review: bool, started_at: datetime, ended_at: datetime,
                 duration_ms: int, outcome: str, error_class: str | None,
                 parsed: ParsedRun, cumulative: bool, task_id: int | None) -> dict:
    rows = [] if cumulative else parsed.model_usage
    detail = {
        "schema": "mc.run.v2",
        "run_id": str(uuid.uuid4()),
        "role": "review" if review else "worker",
        "started_at": started_at.isoformat().replace("+00:00", "Z"),
        "ended_at": ended_at.isoformat().replace("+00:00", "Z"),
        "duration_ms": max(0, duration_ms),
        "outcome": outcome,
        "error_class": error_class,
        "usage_scope": "session_cumulative" if cumulative else ("run" if rows else "unavailable"),
        "usage_complete": bool(rows) and parsed.usage_complete and not cumulative,
        "model_usage": rows,
    }
    if type(task_id) is int and task_id > 0:
        detail["task_id"] = task_id
    return detail
