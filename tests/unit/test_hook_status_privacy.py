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


class StatusPrivacyTests(unittest.TestCase):
    def test_status_never_contains_prompt_notification_or_absolute_path(self):
        for capture in ("0", "1"):
            for event in ("UserPromptSubmit", "Notification", "SessionStart"):
                with self.subTest(event=event, capture=capture):
                    payload = {"hook_event_name": event, "session_id": "test",
                               "prompt": "PRIVATE_PROMPT", "message": "PRIVATE_NOTIFICATION",
                               "cwd": "/private/home/project"}
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


if __name__ == "__main__":
    unittest.main()
