"""Outbound notification transport; no agent CLI or production service is run."""
import contextlib
from email.message import Message
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

    def test_established_disconnect_wakes_polling_on_eof_and_parse_error(self):
        for data in (b"", b"\xff\n"):
            with self.subTest(data=data):
                client, wake = self.client()
                response = io.BytesIO(data)
                response.status = 200
                response.headers = Message()
                response.headers["Content-Type"] = "text/event-stream"
                with patch.object(client._opener, "open", return_value=response), \
                        patch.object(client._stop, "wait", return_value=True), \
                        contextlib.redirect_stderr(io.StringIO()):
                    client._run()
                self.assertFalse(client.connected)
                self.assertEqual(wake.wait(0), {"reconcile"})

    def test_failed_connection_preserves_polling_without_reconcile_loop(self):
        client, wake = self.client()
        with patch.object(client._opener, "open", side_effect=OSError("offline")), \
                patch.object(client._stop, "wait", return_value=True) as backoff, \
                contextlib.redirect_stderr(io.StringIO()):
            client._run()
        self.assertFalse(client.connected)
        self.assertEqual(wake.wait(0), {"fallback"})
        backoff.assert_called_once_with(0.25)

    def test_http_errors_reset_only_a_rejected_cursor_and_preserve_retry_after(self):
        cases = (
            (403, "reviewer:1", None, 0.25, None, {"reconcile"}),
            (403, None, None, 0.25, None, {"fallback"}),
            (401, "reviewer:1", None, 0.25, "reviewer:1", {"fallback"}),
            (429, "reviewer:1", "120", 120, "reviewer:1", {"fallback"}),
        )
        for code, cursor, retry, delay, expected_cursor, reasons in cases:
            with self.subTest(code=code, cursor=cursor):
                client, wake = self.client()
                client.cursor = cursor
                headers = Message()
                if retry is not None:
                    headers["Retry-After"] = retry
                error = dispatcher.urllib.error.HTTPError(client.url, code, "refused", headers, None)
                with patch.object(client._opener, "open", side_effect=error), \
                        patch.object(client._stop, "wait", return_value=True) as backoff, \
                        contextlib.redirect_stderr(io.StringIO()):
                    client._run()
                self.assertFalse(client.connected)
                self.assertEqual(client.cursor, expected_cursor)
                self.assertEqual(wake.wait(0), reasons)
                backoff.assert_called_once_with(delay)

    def test_real_foreign_cursor_reconnects_without_stale_header(self):
        requests = []
        before_replay = []
        finished = threading.Event()
        wake = dispatcher.DispatchWake()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                requests.append(self.headers.get("Last-Event-ID"))
                if len(requests) == 1:
                    self.send_response(403)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":"foreign_cursor"}')
                    return
                before_replay.append(wake.wait(0))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b"event: superseded\ndata: {}\n\n")
                finished.set()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = dispatcher.EventStreamWake(f"http://127.0.0.1:{server.server_port}", "reviewer", "akc_test", wake)
        client.cursor = "reviewer:1"
        try:
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                client.start()
                self.assertTrue(finished.wait(3), "client did not retry the rejected cursor")
                client._thread.join(timeout=2)
            self.assertFalse(client._thread.is_alive())
            self.assertEqual(requests, ["reviewer:1", None])
            self.assertEqual(before_replay, [{"reconcile"}])
            self.assertIsNone(client.cursor)
            self.assertTrue(client._stop.is_set())
            self.assertNotIn("akc_test", errors.getvalue())
            self.assertNotIn("foreign_cursor", errors.getvalue())
        finally:
            client.stop()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

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


def task_ready(notice="20", task="9", episode="4", extra=None):
    cursor = "reviewer:" + notice
    payload = {"v": 1, "task_id": task, "queue_receipt_id": episode, "platform": "codex", "machine": "box"}
    if extra:
        payload.update(extra)
    value = {"id": cursor, "event": "task-ready", "payload": payload}
    return ("id: " + cursor + "\nevent: github\ndata: " + json.dumps(value) + "\n\n").encode()


def notified(**over):
    coverage = {
        "evidence": "notified",
        "reason": "exact_notice",
        "queue_episode": "4",
        "notice_id": "20",
        "notice_at": "2026-11-15T00:00:00+00:00",
        "measured_at": "2026-11-15T00:02:00+00:00",
    }
    coverage.update(over)
    return coverage


class FallbackObservationTests(unittest.TestCase):
    def setUp(self):
        self.previous_poll = dispatcher.POLL
        dispatcher.POLL = 20

    def tearDown(self):
        dispatcher.POLL = self.previous_poll

    def opened(self):
        client, wake = DispatcherStreamTests().client()
        client._consume(io.BytesIO(b'event: observation\ndata: {"baseline":"15","generation":"4"}\n\n'))
        return client, wake

    def test_observation_does_not_advance_or_wake(self):
        client, wake = self.opened()
        self.assertIsNone(client.cursor)
        self.assertEqual(client.notices.proof(), "4")
        self.assertEqual(client.notices.baseline, "15")
        self.assertEqual(wake.wait(0), {"fallback"})

    def test_malformed_observation_invalidates_without_clearing_eviction(self):
        client, _wake = self.opened()
        client.notices.evicted_through = 8
        client._consume(io.BytesIO(b'event: observation\ndata: {"baseline":"01","generation":"4","title":"secret"}\n\n'))
        self.assertIsNone(client.notices.proof())
        self.assertEqual(client.notices.evicted_through, 8)
        self.assertIsNone(client.cursor)

    def claim(self, client, coverage, task=9, trigger="fallback", reasons=None, observed="live"):
        if reasons is None:
            reasons = {trigger}
        if observed == "live":
            observed = client.notices.snapshot()
        return client.notices.classify_claim(trigger, reasons, coverage, task, observed)

    def test_exact_accept_is_received_and_replay_is_idempotent(self):
        client, wake = self.opened()
        client._consume(io.BytesIO(task_ready()))
        client._consume(io.BytesIO(task_ready()))
        self.assertEqual(client.cursor, "reviewer:20")
        self.assertEqual(wake.wait(0), {"event"})
        self.assertEqual(len(client.notices._items), 1)
        self.assertEqual(self.claim(client, notified()), ("received", "exact_notice"))

    def test_withheld_notice_after_the_interval_is_one_fallback_before_notice(self):
        client, _wake = self.opened()
        observed = client.notices.snapshot()
        self.assertEqual(self.claim(client, notified(), observed=observed), ("fallback_before_notice", "notice_absent_at_claim"))
        client.notices.accept("4", "20", "9", "4")
        self.assertEqual(self.claim(client, notified(), observed=observed), ("received", "exact_notice"))

    def test_short_interval_baseline_and_unnotified_stay_unknown(self):
        client, _wake = self.opened()
        short = notified(measured_at="2026-11-15T00:00:30+00:00")
        self.assertEqual(self.claim(client, short)[0], "unknown")
        self.assertEqual(self.claim(client, notified(notice_id="15"))[1], "before_baseline")
        absent = {"evidence": "unnotified_or_expired", "reason": "notice_absent", "queue_episode": "4", "notice_id": None, "notice_at": None, "measured_at": "2026-11-15T00:02:00+00:00"}
        self.assertEqual(self.claim(client, absent), ("unknown", "notice_absent"))
        truncated = {"evidence": "unknown_history", "reason": "audit_window_truncated", "queue_episode": None, "notice_id": None, "notice_at": None, "measured_at": "2026-11-15T00:02:00+00:00"}
        self.assertEqual(self.claim(client, truncated)[1], "audit_window_truncated")

    def test_capacity_mixed_and_disconnect_are_unknown(self):
        client, _wake = self.opened()
        self.assertEqual(self.claim(client, notified(), trigger="capacity", reasons={"capacity"}), ("unknown", "capacity"))
        self.assertEqual(self.claim(client, notified(), trigger="event", reasons={"event", "fallback"}), ("unknown", "mixed"))
        self.assertEqual(dispatcher.coverage_for_disconnected("reconcile", {"startup"}), ("unknown", "reconcile"))
        client._consume(io.BytesIO(b"event: cursor_expired\ndata: {}\n\n"))
        self.assertIsNone(client.cursor)
        self.assertIsNone(client.notices.proof())
        self.assertEqual(self.claim(client, notified()), ("unknown", "missing_baseline"))

    def test_eviction_and_new_generation_cannot_become_a_miss(self):
        client, _wake = self.opened()
        for number in range(100, 100 + dispatcher.NOTICE_CACHE_LIMIT + 1):
            client.notices.accept("4", str(number), "9", "4")
        self.assertGreater(client.notices.evicted_through, 0)
        evicted = str(client.notices.evicted_through)
        self.assertEqual(self.claim(client, notified(notice_id=evicted, queue_episode="4")), ("unknown", "evicted"))
        boundary = client.notices.evicted_through
        client._consume(io.BytesIO(b'event: observation\ndata: {"baseline":"900","generation":"5"}\n\n'))
        self.assertEqual(client.notices.proof(), "5")
        self.assertEqual(client.notices.evicted_through, boundary)
        self.assertEqual(len(client.notices._items), 0)
        self.assertEqual(self.claim(client, notified(notice_id=evicted))[1], "evicted")
        restarted, _wake = DispatcherStreamTests().client()
        self.assertIsNone(restarted.notices.proof())
        self.assertEqual(restarted.notices.evicted_through, 0)

    def test_unpinned_machine_is_accepted_and_bad_routes_end_the_epoch(self):
        client, _wake = self.opened()
        payload = {"v": 1, "task_id": "9", "queue_receipt_id": "4", "platform": "codex", "machine": None}
        wire = {"id": "reviewer:20", "event": "task-ready", "payload": payload}
        client._consume(io.BytesIO(("id: reviewer:20\nevent: github\ndata: " + json.dumps(wire) + "\n\n").encode()))
        self.assertEqual(client.cursor, "reviewer:20")
        self.assertEqual(client.notices.proof(), "4")
        self.assertEqual(list(client.notices._items.values()), [("9", "4")])
        self.assertEqual(self.claim(client, notified()), ("received", "exact_notice"))
        pinned, _wake = self.opened()
        pinned._consume(io.BytesIO(task_ready(notice="21")))
        self.assertEqual(pinned.notices.proof(), "4")
        self.assertEqual(list(pinned.notices._items.values()), [("9", "4")])

        def rejected(machine="box", platform="codex", drop=None, extra=None, notice="22"):
            fresh, _wake = self.opened()
            body = {"v": 1, "task_id": "9", "queue_receipt_id": "4", "platform": platform, "machine": machine}
            if drop:
                body.pop(drop)
            if extra:
                body.update(extra)
            cursor = "reviewer:" + notice
            value = {"id": cursor, "event": "task-ready", "payload": body}
            fresh._consume(io.BytesIO(("id: " + cursor + "\nevent: github\ndata: " + json.dumps(value) + "\n\n").encode()))
            self.assertEqual(fresh.cursor, cursor)
            self.assertIsNone(fresh.notices.proof())
            self.assertEqual(fresh.notices._items, {})
            self.assertEqual(self.claim(fresh, notified()), ("unknown", "missing_baseline"))

        rejected(machine="")
        rejected(machine=12, notice="23")
        rejected(machine=False, notice="24")
        rejected(platform=None, notice="25")
        rejected(platform="", notice="26")
        rejected(drop="machine", notice="27")
        rejected(machine="bad\nmachine", notice="28")
        rejected(machine="m" * 201, notice="29")
        rejected(extra={"title": "secret"}, notice="30")

    def test_delayed_claim_stays_on_the_epoch_that_sent_it(self):
        client, _wake = self.opened()
        body, headers, observed = dispatcher.task_claim_request("codex", client)
        self.assertEqual(body["coverage"], True)
        self.assertEqual(headers["X-AK-Event-Generation"], "4")
        self.assertEqual(observed[1:], ("4", "15"))
        # Unchanged epoch: withheld, then the exact receipt, both use the captured snapshot.
        self.assertEqual(self.claim(client, notified(), observed=observed), ("fallback_before_notice", "notice_absent_at_claim"))
        client._consume(io.BytesIO(task_ready()))
        self.assertEqual(self.claim(client, notified(), observed=observed), ("received", "exact_notice"))
        # The HTTP claim is still in flight. Disconnect, then a replacement observation
        # whose retained max baseline shrank to 0. The delayed generation-4 response
        # must not be scored on generation 5.
        client.notices.invalidate()
        client._consume(io.BytesIO(b'event: observation\ndata: {"baseline":"0","generation":"5"}\n\n'))
        self.assertEqual(client.notices.proof(), "5")
        self.assertEqual(client.notices.baseline, "0")
        delayed = notified(notice_at="2026-10-17T03:00:00Z", measured_at="2026-11-16T02:59:59Z")
        self.assertEqual(self.claim(client, delayed, observed=observed), ("unknown", "epoch_changed"))
        # A reconnect that repeats server generation 4 is still a new local epoch.
        client.notices.invalidate()
        client._consume(io.BytesIO(b'event: observation\ndata: {"baseline":"0","generation":"4"}\n\n'))
        self.assertEqual(client.notices.proof(), "4")
        self.assertNotEqual(client.notices.snapshot(), observed)
        self.assertEqual(self.claim(client, delayed, observed=observed), ("unknown", "epoch_changed"))
        self.assertNotEqual(self.claim(client, delayed, observed=observed)[0], "received")
        self.assertNotEqual(self.claim(client, delayed, observed=observed)[0], "fallback_before_notice")
        # A claim that starts after the replacement may use that epoch. The old response may not.
        fresh_body, fresh_headers, fresh = dispatcher.task_claim_request("codex", client)
        self.assertEqual(fresh_body["coverage"], True)
        self.assertEqual(fresh_headers["X-AK-Event-Generation"], "4")
        self.assertNotEqual(fresh, observed)
        self.assertEqual(self.claim(client, delayed, observed=fresh), ("fallback_before_notice", "notice_absent_at_claim"))

    def test_claim_issued_without_an_epoch_ignores_a_later_one(self):
        client, _wake = DispatcherStreamTests().client()
        body, headers, observed = dispatcher.task_claim_request("codex", client)
        self.assertNotIn("coverage", body)
        self.assertIsNone(headers)
        self.assertIsNone(observed)
        client._consume(io.BytesIO(b'event: observation\ndata: {"baseline":"0","generation":"5"}\n\n'))
        self.assertEqual(client.notices.proof(), "5")
        self.assertEqual(self.claim(client, notified(), observed=observed), ("unknown", "missing_baseline"))

    def test_bad_task_ready_ends_the_epoch_and_claim_headers_follow_the_observation(self):
        client, _wake = self.opened()
        bare, bare_headers, bare_observed = dispatcher.task_claim_request("codex", None)
        self.assertEqual(set(bare), {"platform", "machine", "agent_id"})
        self.assertIsNone(bare_headers)
        self.assertIsNone(bare_observed)
        body, headers, observed = dispatcher.task_claim_request("codex", client)
        self.assertEqual(body["coverage"], True)
        self.assertNotIn("akc_test", json.dumps(body))
        self.assertEqual(headers["X-AK-Event-Authorization"], "Bearer akc_test")
        self.assertEqual(headers["X-AK-Event-Consumer"], "reviewer")
        self.assertEqual(headers["X-AK-Event-Generation"], "4")
        self.assertEqual(client.notices.snapshot(), observed)
        client._consume(io.BytesIO(task_ready(extra={"title": "secret"})))
        self.assertIsNone(client.notices.proof())
        self.assertNotIn("secret", json.dumps(client.notices._items))
        quiet, quiet_headers, quiet_observed = dispatcher.task_claim_request("codex", client)
        self.assertNotIn("coverage", quiet)
        self.assertIsNone(quiet_headers)
        self.assertIsNone(quiet_observed)

    def test_event_header_does_not_replace_the_task_bearer(self):
        captured = {}

        class Response:
            def read(self):
                return b"{}"
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False

        def opener(req, timeout=30):
            captured["authorization"] = req.get_header("Authorization")
            captured["event"] = req.get_header("X-ak-event-authorization")
            captured["timeout"] = timeout
            return Response()

        with patch.object(dispatcher, "MC_URL", "https://example.test"), patch.object(dispatcher, "MC_TOKEN", "task-token"), patch.object(dispatcher.urllib.request, "urlopen", opener):
            dispatcher.api("/api/tasks/claim", {"platform": "codex", "coverage": True}, headers={"X-AK-Event-Authorization": "Bearer akc_test"})
        self.assertEqual(captured["authorization"], "Bearer task-token")
        self.assertEqual(captured["event"], "Bearer akc_test")
        self.assertNotIn("akc_test", json.dumps({"platform": "codex", "coverage": True}))


def client_limit():
    return dispatcher.EventStreamWake.MAX_FRAME + 1


if __name__ == "__main__":
    unittest.main()
