#!/usr/bin/env python3
"""Trace span construction in the Claude Code hook (pure functions, no network)."""
import importlib.util
import os
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[2] / "agents" / "claude-code" / "mission_control_hook.py"
spec = importlib.util.spec_from_file_location("mc_hook", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

SID = "sess-1"


def kind_of(span):
    for a in span["attributes"]:
        if a["key"] == "agentkontrol.span.kind":
            return a["value"]["stringValue"]


class HookTraceTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("MC_TRACE_CAPTURE_CONTENT", None)

    def run_events(self, events):
        state, out = {}, []
        for i, (name, extra) in enumerate(events):
            payload = {"session_id": SID, "hook_event_name": name, **extra}
            out.append(hook.trace_spans_for(name, payload, state, 1_000_000_000 * (i + 1)))
        return out, state

    def test_ids_are_deterministic_and_valid(self):
        t1, r1 = hook.trace_ids(SID)
        t2, r2 = hook.trace_ids(SID)
        self.assertEqual((t1, r1), (t2, r2))
        self.assertEqual((len(t1), len(r1)), (32, 16))
        self.assertNotEqual(hook.trace_ids("other")[0], t1)

    def test_session_turn_tool_tree(self):
        out, _ = self.run_events([
            ("SessionStart", {"cwd": "/work/api"}),
            ("UserPromptSubmit", {"prompt": "secret prompt"}),
            ("PreToolUse", {"tool_name": "Bash", "tool_use_id": "t1"}),
            ("PostToolUse", {"tool_name": "Bash", "tool_use_id": "t1", "tool_response": {}}),
            ("Stop", {}),
            ("SessionEnd", {}),
        ])
        trace_id, root = hook.trace_ids(SID)
        session = out[0][0]
        self.assertEqual((session["spanId"], kind_of(session), "parentSpanId" in session), (root, "session", False))
        turn = out[1][0]
        self.assertEqual((kind_of(turn), turn["parentSpanId"]), ("turn", root))
        self.assertEqual(out[2], [], "PreToolUse emits nothing, it only records the start")
        tool = out[3][0]
        self.assertEqual((tool["name"], kind_of(tool), tool["parentSpanId"]), ("Bash", "tool", turn["spanId"]))
        self.assertEqual(tool["startTimeUnixNano"], str(3_000_000_000))
        self.assertEqual(tool["endTimeUnixNano"], str(4_000_000_000))
        self.assertEqual(tool["status"]["code"], 1)
        closed_turn = out[4][0]
        self.assertEqual((closed_turn["spanId"], closed_turn["endTimeUnixNano"]), (turn["spanId"], str(5_000_000_000)))
        closed_root = out[5][0]
        self.assertEqual((closed_root["spanId"], closed_root["startTimeUnixNano"]), (root, str(1_000_000_000)))
        self.assertTrue(all(s["traceId"] == trace_id for spans in out for s in spans))

    def test_failed_tool_is_error(self):
        out, _ = self.run_events([
            ("SessionStart", {}),
            ("PostToolUse", {"tool_name": "Bash", "tool_use_id": "x", "tool_response": {"is_error": True}}),
            ("PostToolUseFailure", {"tool_name": "Edit", "tool_use_id": "y"}),
        ])
        self.assertEqual(out[1][0]["status"]["code"], 2)
        self.assertEqual(out[2][0]["status"]["code"], 2)

    def test_prompt_and_tool_input_are_not_sent_by_default(self):
        out, _ = self.run_events([
            ("SessionStart", {}),
            ("UserPromptSubmit", {"prompt": "hunter2 please"}),
            ("PostToolUse", {"tool_name": "Bash", "tool_use_id": "z", "tool_input": {"command": "cat ~/.ssh/id_rsa"}, "tool_response": {}}),
        ])
        blob = repr(out)
        self.assertNotIn("hunter2", blob)
        self.assertNotIn("id_rsa", blob)

    def test_content_capture_is_opt_in(self):
        os.environ["MC_TRACE_CAPTURE_CONTENT"] = "1"
        out, _ = self.run_events([("SessionStart", {}), ("UserPromptSubmit", {"prompt": "hello"})])
        self.assertIn("hello", repr(out[1]))

    def test_otlp_request_names_the_agent(self):
        req = hook.otlp_request("cc-mac", SID, [])
        attrs = {a["key"]: a["value"]["stringValue"] for a in req["resourceSpans"][0]["resource"]["attributes"]}
        self.assertEqual(attrs["agent.id"], "cc-mac")


if __name__ == "__main__":
    unittest.main()
