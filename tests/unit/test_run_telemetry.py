"""Synthetic process/envelope tests; never invoke agent CLIs, credentials, or HTTP."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch
from datetime import datetime, timezone


DISPATCHER = Path(__file__).resolve().parents[2] / "agents" / "dispatcher"
sys.path.insert(0, str(DISPATCHER))
from run_telemetry import parse_cli_output, resumes_session

# The production module eagerly probes protected env files. Disable that probe
# before import; synthetic tests must never read the user's credential files.
spec = importlib.util.spec_from_file_location("dispatcher_telemetry_test", DISPATCHER / "mc_dispatcher.py")
dispatcher = importlib.util.module_from_spec(spec)
with patch.dict(os.environ, {}, clear=True), patch.object(Path, "exists", return_value=False):
    spec.loader.exec_module(dispatcher)


def claude(**overrides):
    return {"type": "result", "subtype": "success", "is_error": False,
            "result": "RESULT: synthetic completed task", "total_cost_usd": 0.25,
            "duration_ms": 999, "duration_api_ms": 500,
            "modelUsage": {"claude-test": {"inputTokens": 10, "outputTokens": 4,
                "cacheReadInputTokens": 20, "cacheCreationInputTokens": 3}}, **overrides}


class EnvelopeTests(unittest.TestCase):
    def test_claude_prefers_per_model_and_adds_cache_to_full_input(self):
        parsed = parse_cli_output("claude-code", json.dumps(claude(
            usage={"input_tokens": 9999, "output_tokens": 9999})))
        self.assertEqual(parsed.model_usage, [{"model": "claude-test", "input_tokens": 33,
            "output_tokens": 4, "cache_read_tokens": 20, "cache_write_tokens": 3}])
        self.assertTrue(parsed.usage_complete)

    def test_grok_output_and_incomplete_metadata(self):
        parsed = parse_cli_output("grok", json.dumps({"text": "synthetic result", "usage_is_incomplete": True,
            "modelUsage": {"grok-test": {"inputTokens": 10, "outputTokens": 2, "cacheReadInputTokens": 7}},
            "usage": {"input_tokens": 999, "output_tokens": 999}}))
        self.assertEqual(parsed.output_text, "synthetic result")
        self.assertEqual(parsed.model_usage[0]["input_tokens"], 17)
        self.assertFalse(parsed.usage_complete)

    def test_grok_top_level_full_input_and_missing_counts(self):
        parsed = parse_cli_output("grok", json.dumps({"text": "done", "usage": {
            "input_tokens": 4, "cache_read_input_tokens": 8, "cache_creation_input_tokens": 2,
            "output_tokens": 3, "reasoning_tokens": 1}}))
        self.assertEqual(parsed.model_usage[0], {"model": "unknown", "input_tokens": 14,
            "output_tokens": 3, "cache_read_tokens": 8, "cache_write_tokens": 2, "reasoning_tokens": 1})
        missing = parse_cli_output("grok", '{"text":"done"}')
        self.assertEqual(missing.model_usage, [])
        self.assertFalse(missing.usage_complete)

    def test_codex_preserves_task_text_and_counts_cache_once(self):
        events = [{"type": "thread.started", "thread_id": "synthetic-thread"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "RESULT: done"}},
            {"type": "turn.completed", "usage": {"input_tokens": 20, "cached_input_tokens": 15,
                "output_tokens": 5, "reasoning_output_tokens": 2}}]
        parsed = parse_cli_output("codex", "\n".join(map(json.dumps, events)))
        self.assertEqual(parsed.output_text, "RESULT: done")
        self.assertEqual(parsed.model_usage, [{"model": "unknown", "input_tokens": 20,
            "output_tokens": 5, "cache_read_tokens": 15, "reasoning_tokens": 2}])
        self.assertTrue(parsed.usage_complete)

    def test_codex_repeated_final_snapshot_is_not_summed(self):
        line = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}'
        parsed = parse_cli_output("codex", line + "\n" + line)
        self.assertEqual(parsed.model_usage[0]["input_tokens"], 10)

    def test_invalid_counts_models_and_extra_fields_are_not_exported(self):
        parsed = parse_cli_output("grok", json.dumps({"text": "private synthetic result",
            "modelUsage": {"/private/path": {"inputTokens": 1}, "grok-test": {
                "inputTokens": True, "outputTokens": -3, "cacheReadInputTokens": "22",
                "reasoningTokens": 2**64, "prompt": "synthetic secret", "costUSD": 1}}}))
        self.assertEqual(parsed.model_usage, [])
        self.assertFalse(parsed.usage_complete)

    def test_explicit_zero_is_valid_but_absence_is_not_zero(self):
        parsed = parse_cli_output("grok", '{"text":"done","usage":{"input_tokens":0,"output_tokens":0}}')
        self.assertEqual(parsed.model_usage, [{"model": "unknown", "input_tokens": 0, "output_tokens": 0}])
        partial = parse_cli_output("grok", '{"text":"done","usage":{"output_tokens":3}}')
        self.assertNotIn("input_tokens", partial.model_usage[0])
        self.assertFalse(partial.usage_complete)
        self.assertFalse(parsed.usage_complete)  # cache categories absent, not known zero

    def test_dropped_model_cannot_leave_complete_usage_claim(self):
        parsed = parse_cli_output("grok", json.dumps({"text": "done", "modelUsage": {
            "grok-test": {"inputTokens": 1, "outputTokens": 1, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0},
            "/private/model/path": {"inputTokens": 5, "outputTokens": 2}}}))
        self.assertEqual(len(parsed.model_usage), 1)
        self.assertFalse(parsed.usage_complete)

    def test_malformed_or_unrecognized_protocols(self):
        for platform, text in [("grok", "not JSON"), ("claude-code", "[]"),
                ("claude-code", "{}"), ("codex", '{"type":"thread.started"}')]:
            with self.subTest(platform=platform, text=text):
                self.assertFalse(parse_cli_output(platform, text).protocol_ok)

    def test_error_envelopes_keep_task_error_separate(self):
        parsed = parse_cli_output("grok", '{"type":"error","message":"synthetic private error","usage":{"input_tokens":3,"output_tokens":1}}')
        self.assertTrue(parsed.reported_error)
        self.assertTrue(parsed.protocol_ok)
        self.assertEqual(parsed.output_text, "synthetic private error")
        self.assertTrue(parse_cli_output("claude-code", json.dumps(claude(is_error=True))).reported_error)
        self.assertTrue(parse_cli_output("codex", '{"type":"turn.failed","error":{"message":"private"}}').reported_error)

    def test_resume_flags(self):
        for args in [["--resume=abc"], ["--continue"], ["-c"], ["-r", "abc"]]:
            self.assertTrue(resumes_session(args, "claude-code"))
        self.assertFalse(resumes_session(["--model", "test-model"], "claude-code"))
        self.assertFalse(resumes_session(["-c", "model=gpt-test"], "codex"))
        self.assertTrue(resumes_session(["resume", "--last"], "codex"))
        self.assertTrue(resumes_session(["--continue"], "grok"))


class DispatcherTests(unittest.TestCase):
    def invoke(self, platform="claude-code", *, stdout=None, returncode=0, error=None,
               review=False, extra=None, fail_ingest=False):
        if stdout is None:
            stdout = json.dumps(claude())
        proc = subprocess.CompletedProcess(["synthetic-cli"], returncode, stdout, "synthetic stderr" if returncode else "")
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        with patch.dict(os.environ, extra or {}, clear=True), \
             patch.object(dispatcher.subprocess, "run", side_effect=error, return_value=proc) as run, \
             patch.object(dispatcher.time, "monotonic", side_effect=[10.0, 11.25]), \
             patch.object(dispatcher, "datetime") as clock, \
             patch.object(dispatcher, "ingest", side_effect=RuntimeError("private report failure") if fail_ingest else None) as ingest, \
             patch("run_telemetry.uuid.uuid4", return_value=uuid.UUID("11111111-1111-4111-8111-111111111111")):
            clock.now.return_value = now
            result = dispatcher.run_cli(platform, "synthetic private prompt", Path("/synthetic/private/repo"), review, task_id=7)
        self.assertEqual(ingest.call_count, 1)
        self.assertEqual(ingest.call_args.args[0], "run_complete")
        detail = ingest.call_args.args[4]
        self.assertEqual(detail["schema"], "mc.run.v2")
        self.assertEqual(detail["duration_ms"], 1250)
        start = datetime.fromisoformat(detail["started_at"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(detail["ended_at"].replace("Z", "+00:00"))
        self.assertEqual((end - start).total_seconds(), 1.25)
        self.assertEqual(detail["task_id"], 7)
        self.assertEqual(detail["role"], "review" if review else "worker")
        self.assertEqual(set(detail), {"schema", "run_id", "role", "started_at", "ended_at",
            "duration_ms", "outcome", "error_class", "usage_scope", "usage_complete", "model_usage", "task_id"})
        encoded = json.dumps(detail)
        for private in ["private", "synthetic completed task", "synthetic stderr", "total_cost", "duration_api", "999"]:
            self.assertNotIn(private, encoded)
        return result, detail, run

    def test_success_measures_subprocess_and_preserves_cost_tuple(self):
        result, detail, _ = self.invoke()
        self.assertEqual(result, (True, "RESULT: synthetic completed task", 0.25))
        self.assertEqual((detail["outcome"], detail["error_class"], detail["usage_scope"]), ("completed", None, "run"))

    def test_codex_json_and_grok_json_flags_and_outputs(self):
        result, _, run = self.invoke("codex", stdout='{"type":"item.completed","item":{"type":"agent_message","text":"RESULT: codex done"}}\n{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}')
        self.assertIn("--json", run.call_args.args[0])
        self.assertIn("workspace-write", run.call_args.args[0])
        self.assertNotIn("--full-auto", run.call_args.args[0])
        self.assertEqual(result, (True, "RESULT: codex done", None))
        result, _, run = self.invoke("grok", stdout='{"text":"RESULT: grok done"}')
        self.assertEqual(run.call_args.args[0][-2:], ["--output-format", "json"])
        self.assertEqual(result, (True, "RESULT: grok done", None))

    def test_codex_review_keeps_read_only_sandbox(self):
        _, _, run = self.invoke("codex", stdout='{"type":"turn.completed"}', review=True)
        self.assertIn("read-only", run.call_args.args[0])
        self.assertNotIn("workspace-write", run.call_args.args[0])

    def test_process_and_protocol_failures_emit_sanitized_metadata(self):
        result, detail, _ = self.invoke(returncode=1)
        self.assertFalse(result[0])
        self.assertEqual(detail["error_class"], "process_error")
        result, detail, _ = self.invoke(stdout="synthetic private malformed result")
        self.assertFalse(result[0])
        self.assertEqual(detail["error_class"], "protocol_error")
        self.assertEqual(detail["model_usage"], [])

    def test_timeout_unavailable_and_other_os_errors(self):
        for error, outcome, error_class in [
            (subprocess.TimeoutExpired("synthetic private command", 1), "timeout", "timeout"),
            (FileNotFoundError("synthetic private path"), "unavailable", "unavailable"),
            (PermissionError("synthetic private path"), "failed", "process_error"),
        ]:
            with self.subTest(outcome=outcome):
                result, detail, _ = self.invoke(error=error)
                self.assertFalse(result[0])
                self.assertEqual((detail["outcome"], detail["error_class"]), (outcome, error_class))
                self.assertEqual(detail["usage_scope"], "unavailable")

    def test_resume_suppresses_cumulative_usage(self):
        _, detail, _ = self.invoke(extra={"MC_CLAUDE_ARGS": "--resume synthetic-session"})
        self.assertEqual(detail["usage_scope"], "session_cumulative")
        self.assertEqual(detail["model_usage"], [])
        self.assertFalse(detail["usage_complete"])

    def test_codex_config_override_keeps_fresh_usage(self):
        _, detail, _ = self.invoke("codex", stdout='{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}', extra={"MC_CODEX_ARGS": "-c model=gpt-test"})
        self.assertEqual(detail["usage_scope"], "run")
        self.assertEqual(detail["model_usage"][0]["input_tokens"], 9)

    def test_review_ignores_unused_worker_resume_flags(self):
        _, detail, _ = self.invoke(review=True, extra={"MC_CLAUDE_ARGS": "--continue"})
        self.assertEqual(detail["usage_scope"], "run")

    def test_telemetry_failure_does_not_change_return(self):
        result, _, _ = self.invoke(fail_ingest=True)
        self.assertEqual(result, (True, "RESULT: synthetic completed task", 0.25))

    def test_reported_claude_failure_on_zero_exit(self):
        result, detail, _ = self.invoke(stdout=json.dumps(claude(is_error=True)))
        self.assertFalse(result[0])
        self.assertEqual(detail["error_class"], "process_error")

    def test_worker_and_review_receive_task_id(self):
        task = {"id": 8, "title": "synthetic", "reviewer_platform": "grok"}
        with patch.object(Path, "is_dir", return_value=True), patch.object(dispatcher, "api"), \
             patch.object(dispatcher, "ingest"), patch.object(dispatcher.shutil, "which", return_value="synthetic"), \
             patch.object(dispatcher, "run_cli", side_effect=[(True, "done", None), (True, "VERDICT: APPROVE", None)]) as run:
            dispatcher.run_task(task, "claude-code", unittest.mock.Mock())
        self.assertEqual(run.call_args_list[0].kwargs, {"task_id": 8})
        self.assertEqual(run.call_args_list[1].kwargs, {"review": True, "task_id": 8})


if __name__ == "__main__":
    unittest.main()
