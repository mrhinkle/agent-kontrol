"""Outbound notification transport; no agent CLI or production service is run."""
import contextlib
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents" / "dispatcher"))
import mc_dispatcher as dispatcher


def frame(cursor="reviewer:1", payload=None):
    value = {"id": cursor, "event": "status", "payload": payload or {"state": "success"}}
    return ("id: " + cursor + "\nevent: github\ndata: " + json.dumps(value) + "\n\n").encode()


class DispatcherStreamTests(unittest.TestCase):
    def client(self):
        wake = dispatcher.DispatchWake()
        return dispatcher.EventStreamWake("https://example.test", "reviewer", "akc_test", wake), wake

    def test_wake_is_retained_and_coalesced(self):
        wake = dispatcher.DispatchWake()
        wake.signal("event")
        wake.signal("event")
        wake.signal("capacity")
        self.assertEqual(wake.wait(0), {"event", "capacity"})
        self.assertEqual(wake.wait(0), {"fallback"})

    def test_complete_frame_updates_cursor_and_only_wakes(self):
        client, wake = self.client()
        client._consume(io.BytesIO(frame()))
        self.assertEqual(client.cursor, "reviewer:1")
        self.assertEqual(wake.wait(0), {"event"})

    def test_partial_response_does_not_advance_cursor(self):
        client, wake = self.client()
        client._consume(io.BytesIO(frame()[:-1]))
        self.assertIsNone(client.cursor)
        self.assertEqual(wake.wait(0), {"fallback"})

    def test_foreign_malformed_and_oversized_frames_do_not_advance(self):
        for data in (frame("other:1"), b"event: github\ndata: invalid-json\n\n", b"\xff\n", b":" + b"x" * client_limit()):
            client, wake = self.client()
            with self.assertRaises((ValueError, UnicodeDecodeError)):
                client._consume(io.BytesIO(data))
            self.assertIsNone(client.cursor)
            self.assertEqual(wake.wait(0), {"fallback"})

    def test_expired_cursor_requests_reconciliation_and_replay(self):
        client, wake = self.client()
        client.cursor = "reviewer:1"
        client._consume(io.BytesIO(b"event: cursor_expired\ndata: {}\n\n"))
        self.assertIsNone(client.cursor)
        self.assertEqual(wake.wait(0), {"reconcile"})

    def test_superseded_connection_stops_competing(self):
        client, wake = self.client()
        client._consume(io.BytesIO(b"event: superseded\ndata: {}\n\n"))
        self.assertTrue(client._stop.is_set())
        self.assertFalse(client.connected)
        self.assertEqual(wake.wait(0), {"reconcile"})

    def test_unsafe_origins_and_partial_configuration_are_rejected(self):
        for base in ("http://remote.test", "https://user:password@example.test", "https://example.test/?key=x", "https://example.test/path"):
            with self.assertRaises(ValueError):
                dispatcher.EventStreamWake(base, "reviewer", "akc_test", dispatcher.DispatchWake())
        for consumer, token in (("reviewer", ""), ("reviewer\n", "akc_test"), ("reviewer", "legacy")):
            with self.assertRaises(ValueError):
                dispatcher.EventStreamWake("https://example.test", consumer, token, dispatcher.DispatchWake())

    def test_capacity_wakes_even_when_task_runner_fails(self):
        wake = dispatcher.DispatchWake()
        with patch.object(dispatcher, "run_task", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError):
                dispatcher.run_task_and_wake({}, "codex", threading.Semaphore(1), wake)
        self.assertEqual(wake.wait(0), {"capacity"})

    def test_real_connection_resumes_and_superseded_stops_it(self):
        requests = []
        finished = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                requests.append((self.path, self.headers.get("Last-Event-ID"), self.headers.get("Authorization")))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(frame("reviewer:1" if len(requests) == 1 else "reviewer:2"))
                if len(requests) > 1:
                    self.wfile.write(b"event: superseded\ndata: {}\n\n")
                    finished.set()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = dispatcher.EventStreamWake(f"http://127.0.0.1:{server.server_port}", "reviewer", "akc_test", dispatcher.DispatchWake())
        try:
            client.start()
            self.assertTrue(finished.wait(3), "client did not reconnect")
            client._thread.join(timeout=2)
            self.assertEqual(requests[0][1], None)
            self.assertEqual(requests[1][1], "reviewer:1")
            self.assertEqual(requests[1][2], "Bearer akc_test")
            self.assertEqual(client.cursor, "reviewer:2")
            self.assertTrue(client._stop.is_set())
        finally:
            client.stop()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_real_redirect_never_receives_the_credential(self):
        attempts = threading.Event()
        leaked = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path.startswith("/api/events/stream"):
                    self.send_response(302)
                    self.send_header("Location", "/steal")
                    self.end_headers()
                    attempts.set()
                else:
                    leaked.append(self.headers.get("Authorization"))
                    self.send_response(200)
                    self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = dispatcher.EventStreamWake(f"http://127.0.0.1:{server.server_port}", "reviewer", "akc_test", dispatcher.DispatchWake())
        try:
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                client.start()
                self.assertTrue(attempts.wait(2))
                client.stop()
            self.assertEqual(leaked, [])
            self.assertNotIn("akc_test", errors.getvalue())
        finally:
            client.stop()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


def client_limit():
    return dispatcher.EventStreamWake.MAX_FRAME + 1


if __name__ == "__main__":
    unittest.main()
