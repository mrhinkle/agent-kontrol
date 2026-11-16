"""Exercise the actual outbound hook requests, not just span construction."""
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / "agents/claude-code/mission_control_hook.py"
spec = importlib.util.spec_from_file_location("status_hook", path)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

QUEUED = "QUEUED_OPERATOR_MESSAGE"


class _Resp:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class StatusPrivacyTests(unittest.TestCase):
    def _run(self, payload, env, read_messages):
        """Return (requests, stdout, send_traces mock). read_messages None leaves the var unset."""
        stdout = io.StringIO()
        seen = []

        def urlopen(req, timeout=3):
            seen.append(req)
            if "/api/messages" in req.full_url:
                return _Resp({"messages": [{"id": "m1", "body": QUEUED}]})
            return _Resp({})

        with patch.dict(os.environ, env, clear=False), \
             patch.object(hook, "load_env_file"), \
             patch.object(hook, "send_traces") as traces, \
             patch.object(hook.sys, "stdin", io.StringIO(json.dumps(payload))), \
             patch.object(hook.sys, "stdout", stdout), \
             patch.object(hook.urllib.request, "urlopen", urlopen):
            if read_messages is None:
                os.environ.pop("MC_READ_MESSAGES", None)
            else:
                os.environ["MC_READ_MESSAGES"] = read_messages
            hook.main()
        return seen, stdout.getvalue(), traces

    def test_status_never_contains_prompt_notification_or_absolute_path(self):
        for capture in ("0", "1"):
            for event in ("UserPromptSubmit", "Notification", "SessionStart"):
                with self.subTest(event=event, capture=capture):
                    payload = {"hook_event_name": event, "session_id": "test",
                               "prompt": "PRIVATE_PROMPT", "message": "PRIVATE_NOTIFICATION",
                               "cwd": "/private/home/project"}
                    # Opt out so this counts the ingest request alone.
                    with patch.dict(os.environ, {"MC_URL": "https://example.invalid", "MC_TOKEN": "test",
                                                  "MC_TRACE_CAPTURE_CONTENT": capture, "MC_READ_MESSAGES": "0"}), \
                         patch.object(hook, "load_env_file"), patch.object(hook, "send_traces"), \
                         patch.object(hook.sys, "stdin", io.StringIO(json.dumps(payload))), \
                         patch.object(hook.urllib.request, "urlopen") as send:
                        hook.main()
                    self.assertEqual(send.call_count, 1)
                    request = send.call_args.args[0]
                    self.assertEqual(request.full_url, "https://example.invalid/api/ingest")
                    body = json.loads(request.data)
                    for secret in ("PRIVATE_PROMPT", "PRIVATE_NOTIFICATION", "/private/home"):
                        self.assertNotIn(secret, json.dumps(body))
                    self.assertEqual(body["title"], body["summary"])

    def test_stop_title_uses_an_em_dash(self):
        payload = {"hook_event_name": "Stop", "session_id": "test"}
        seen, stdout, traces = self._run(
            payload,
            {"MC_URL": "https://example.invalid", "MC_TOKEN": "test", "MC_TRACE_CAPTURE_CONTENT": "1"},
            "0",
        )
        self.assertEqual(len(seen), 1)
        body = json.loads(seen[0].data)
        self.assertEqual(body["title"], "Turn finished \u2014 waiting for input")
        self.assertEqual(body["summary"], body["title"])
        self.assertNotIn("\u00e2\u20ac", body["title"])
        self.assertEqual(stdout, "")
        traces.assert_called_once()

    def test_unset_mc_read_messages_acks_and_injects_queued_message(self):
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": "test",
                   "prompt": "PRIVATE_PROMPT", "cwd": "/private/home/project"}
        seen, stdout, traces = self._run(
            payload,
            {"MC_URL": "https://example.invalid", "MC_TOKEN": "test",
             "MC_TRACE_CAPTURE_CONTENT": "0", "MC_AGENT": "claude-code-test"},
            None,
        )
        self.assertEqual(len(seen), 2)
        ingest, inbox = seen
        self.assertEqual(ingest.full_url, "https://example.invalid/api/ingest")
        self.assertEqual(ingest.get_method(), "POST")
        ingest_body = json.loads(ingest.data)
        self.assertNotIn("PRIVATE_PROMPT", json.dumps(ingest_body))
        self.assertNotIn(QUEUED, json.dumps(ingest_body))
        self.assertEqual(
            inbox.full_url,
            "https://example.invalid/api/messages?agent_id=claude-code-test&ack=true",
        )
        self.assertEqual(inbox.get_method(), "GET")
        self.assertEqual(inbox.get_header("Authorization"), "Bearer test")
        out = json.loads(stdout)
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertIn(QUEUED, out["hookSpecificOutput"]["additionalContext"])
        traces.assert_called_once()
        self.assertEqual(traces.call_args.args[2], "UserPromptSubmit")

    def test_mc_read_messages_zero_does_not_poll(self):
        payload = {"hook_event_name": "UserPromptSubmit", "session_id": "test",
                   "prompt": "PRIVATE_PROMPT", "cwd": "/private/home/project"}
        seen, stdout, traces = self._run(
            payload,
            {"MC_URL": "https://example.invalid", "MC_TOKEN": "test",
             "MC_TRACE_CAPTURE_CONTENT": "1", "MC_AGENT": "claude-code-test"},
            "0",
        )
        self.assertEqual([req.full_url for req in seen], ["https://example.invalid/api/ingest"])
        self.assertNotIn("/api/messages", "".join(req.full_url for req in seen))
        self.assertEqual(stdout, "")
        self.assertNotIn("PRIVATE_PROMPT", json.dumps(json.loads(seen[0].data)))
        traces.assert_called_once()


if __name__ == "__main__":
    unittest.main()
