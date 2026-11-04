"""Synthetic Claude usage observations: never read real transcripts or secrets."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, HTTPServer


SCRIPT = Path(__file__).resolve().parents[2] / "agents" / "claude-usage-collector" / "collector.py"
SPEC = importlib.util.spec_from_file_location("claude_usage_collector", SCRIPT)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
SINCE = collector.instant("2026-11-01T00:00:00Z")
UNTIL = collector.instant("2026-11-04T00:00:00Z")
CANARY = "PRIVATE-CONTENT-CANARY-DO-NOT-EMIT"


def record(request="request-private-1", session="session-private-1", timestamp="2026-11-02T12:00:00Z", **changes):
    value = {
        "type": "assistant", "sessionId": session, "requestId": request,
        "timestamp": timestamp, "cwd": "/private/" + CANARY,
        "message": {
            "id": "message-private-1", "role": "assistant", "model": "claude-sonnet-4-5",
            "content": [{"type": "text", "text": CANARY}],
            "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 10},
        },
    }
    value.update(changes)
    return value


class Response:
    def __init__(self, value, url="https://fleet.example.test/api/usage/ingest", code=200):
        self.value = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.url, self.code = url, code

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, count):
        return self.value[:count]

    def geturl(self):
        return self.url

    def getcode(self):
        return self.code


class Opener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, **kwargs):
        self.requests.append((request, kwargs))
        return self.response


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.logs = self.root / "logs"
        self.logs.mkdir()

    def write(self, values, name="one.jsonl"):
        path = self.logs / name
        path.write_text("".join(json.dumps(value) + "\n" for value in values))
        return path

    def collect(self, **kwargs):
        return collector.collect([self.logs], "test-machine", kwargs.get("billing_mode", "unknown"), SINCE, UNTIL, UNTIL)

    def test_chunks_and_copies_collapse_with_maxima_and_latest_timestamp(self):
        first = record(costUSD=0.25)
        last = record(timestamp="2026-11-02T12:00:01Z", costUSD=0.4)
        last["message"]["id"] = "different-message-same-request"
        last["message"]["usage"]["input_tokens"] = 90
        last["message"]["usage"]["output_tokens"] = 30
        self.write([first, last])
        self.write([first, last], "copy.jsonl")
        payload = self.collect(billing_mode="subscription")
        self.assertEqual(len(payload["facts"]), 1)
        fact = payload["facts"][0]
        self.assertEqual((fact["input_tokens"], fact["output_tokens"], fact["api_call_count"]), (100, 30, 1))
        self.assertEqual(fact["last_seen_at"], "2026-11-02T12:00:01.000000Z")
        self.assertEqual(fact["paid_cost_usd"], 0)
        self.assertEqual(fact["shadow_cost_usd"], 0.4)
        self.assertEqual(fact["cost_status"], "local_reported_estimate")
        self.assertEqual(fact["billing_mode"], "observation")
        self.assertEqual(fact["detail"]["billing_mode"], "subscription")
        self.assertEqual(payload["snapshot"]["detail"]["coverage"]["duplicates"], 3)

    def test_different_requests_and_sessions_are_distinct(self):
        self.write([record(), record(request="request-2", timestamp="2026-11-03T12:00:00Z"), record(session="session-2")])
        self.assertEqual(len(self.collect()["facts"]), 3)

    def test_message_id_fallback_and_absent_usage_chunk(self):
        one = record(); del one["requestId"]
        two = record(); del two["requestId"]; two["message"]["id"] = "second-message"
        chunk = record(); del chunk["message"]["usage"]
        self.write([one, one, two, chunk, {"type": "user", "message": {"content": CANARY}}])
        self.assertEqual(len(self.collect()["facts"]), 2)
        self.assertEqual(self.collect()["snapshot"]["detail"]["coverage"]["status"], "complete")

    def test_invalid_present_request_id_is_not_fallback(self):
        self.write([record(request=False)])
        result = self.collect()
        self.assertEqual(result["facts"], [])
        self.assertEqual(result["snapshot"]["detail"]["coverage"]["status"], "partial")

    def test_window_is_half_open_and_offsets_normalized(self):
        self.write([
            record(request="at-start", timestamp="2026-10-31T20:00:00-04:00"),
            record(request="before", timestamp="2026-10-31T23:59:59Z"),
            record(request="at-end", timestamp="2026-11-04T00:00:00Z"),
        ])
        self.assertEqual(len(self.collect()["facts"]), 1)

    def test_unpriced_and_reported_zero_are_different(self):
        self.write([record(), record(request="free-estimate", costUSD=0)])
        facts = self.collect()["facts"]
        self.assertEqual({x["cost_status"] for x in facts}, {"local_unpriced", "local_reported_estimate"})
        result = collector.summary(self.collect())
        self.assertEqual(result["known_reported_estimate_usd"], 0)
        self.assertEqual(result["unpriced_observations"], 1)
        self.assertIsNone(result["actual_charges_usd"])

    def test_malformed_counters_estimates_and_records_are_partial(self):
        values = [record()]
        for index, value in enumerate([-1, True, "5", 1.2, None, 2**54]):
            item = record(request="bad-" + str(index)); item["message"]["usage"]["output_tokens"] = value
            values.append(item)
        for index, value in enumerate([-1, True, "0.2", None, float("nan")]):
            values.append(record(request="bad-cost-" + str(index), costUSD=value))
        missing = record(request="missing"); del missing["message"]["usage"]["input_tokens"]; values.append(missing)
        path = self.write(values)
        with path.open("a") as handle:
            handle.write('{"type":"assistant",badjson\n')
        payload = self.collect()
        self.assertEqual(len(payload["facts"]), 1)
        self.assertEqual(payload["snapshot"]["detail"]["coverage"]["status"], "partial")
        self.assertEqual(payload["snapshot"]["detail"]["coverage"]["malformed_records"], 13)

    def test_conflicting_models_discard_ambiguous_request(self):
        first, second = record(), record()
        second["message"]["model"] = "claude-opus-4-5"
        self.write([first, second, first])
        self.assertEqual(self.collect()["facts"], [])
        self.assertEqual(self.collect()["snapshot"]["detail"]["coverage"]["status"], "partial")

    def test_no_files_unreadable_and_limits_are_partial(self):
        self.assertEqual(self.collect()["snapshot"]["detail"]["coverage"]["status"], "partial")
        self.write([record()])
        with mock.patch.object(Path, "open", side_effect=PermissionError(CANARY)):
            result = self.collect()
        self.assertEqual(result["snapshot"]["detail"]["coverage"]["unreadable_files"], 1)
        with mock.patch.object(collector, "MAX_LINE_BYTES", 10):
            self.assertEqual(self.collect()["snapshot"]["detail"]["coverage"]["status"], "partial")
        self.write([record()], "two.jsonl")
        with mock.patch.object(collector, "MAX_FILES", 1):
            self.assertEqual(self.collect()["snapshot"]["detail"]["coverage"]["status"], "partial")
        with mock.patch.object(collector, "MAX_SCAN_ENTRIES", 1):
            self.assertEqual(self.collect()["snapshot"]["detail"]["coverage"]["status"], "partial")

    def test_output_is_allowlisted_and_ids_are_hashed(self):
        value = record()
        value["apiKey"] = CANARY
        value["message"]["usage"]["content"] = CANARY
        self.write([value])
        payload = self.collect()
        raw = json.dumps(payload)
        for forbidden in [CANARY, "session-private-1", "request-private-1", "message-private-1", str(self.root), "apiKey", '"content"']:
            self.assertNotIn(forbidden, raw)
        fact = payload["facts"][0]
        self.assertRegex(fact["session_id"], r"^cc:[0-9a-f]{64}$")
        self.assertEqual(set(fact["detail"]), {"version", "machine", "billing_mode", "cost_basis", "session_hash", "request_hash"})

    def test_bounded_scan_prioritizes_newest_files_and_stays_partial(self):
        older = self.write([record(request="old-request")], "a-old.jsonl")
        middle = self.write([record(request="middle-request")], "b-middle.jsonl")
        newest_record = record(request="new-request")
        newest = self.write([newest_record], "z-new.jsonl")
        for path, timestamp in [(older, 10), (middle, 20), (newest, 30)]:
            os.utime(path, (timestamp, timestamp))
        expected = "cc:" + collector.observation(newest_record)["key"]
        for bounds in [{"MAX_FILES": 1}, {"MAX_TOTAL_BYTES": newest.stat().st_size + 1}]:
            with self.subTest(bounds=bounds), mock.patch.multiple(collector, **bounds):
                payload = self.collect()
            self.assertEqual([f["session_id"] for f in payload["facts"]], [expected])
            coverage = payload["snapshot"]["detail"]["coverage"]
            self.assertEqual(coverage["files"], 3)
            self.assertEqual(coverage["status"], "partial")
            self.assertGreater(coverage["limits_reached"], 0)

    def test_mtime_does_not_establish_window_coverage(self):
        older = self.write([record()], "a-old.jsonl")
        newest = self.write([record(request="outside", timestamp="2020-01-01T00:00:00Z")], "z-new.jsonl")
        os.utime(older, (10, 10)); os.utime(newest, (20, 20))
        with mock.patch.object(collector, "MAX_FILES", 1):
            payload = self.collect()
        self.assertEqual(payload["facts"], [])
        self.assertEqual(payload["snapshot"]["detail"]["coverage"]["status"], "partial")

    def test_unreadable_priority_stat_keeps_partial_coverage(self):
        unreadable = self.write([record(request="unreadable")], "a-unreadable.jsonl")
        self.write([record(request="readable")], "z-readable.jsonl")
        original_stat = Path.stat

        def stat_file(path, *args, **kwargs):
            if path == unreadable:
                raise PermissionError(CANARY)
            return original_stat(path, *args, **kwargs)

        with mock.patch.object(Path, "stat", stat_file):
            payload = self.collect()
        self.assertEqual(len(payload["facts"]), 1)
        self.assertEqual(payload["snapshot"]["detail"]["coverage"]["unreadable_files"], 1)
        self.assertEqual(payload["snapshot"]["detail"]["coverage"]["status"], "partial")
        self.assertNotIn(CANARY, json.dumps(payload))

    def test_default_dry_run_has_no_facts_files_or_credential_reads(self):
        self.write([record()])
        output = io.StringIO()
        before = set(self.root.rglob("*"))
        with mock.patch.object(collector, "credentials", side_effect=AssertionError("no auth read")), contextlib.redirect_stdout(output):
            code = collector.main(["--machine", "test-machine", "--roots", str(self.logs), "--since", collector.iso(SINCE), "--until", collector.iso(UNTIL)])
        result = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertFalse(result["published"])
        self.assertNotIn("facts", result)
        self.assertEqual(before, set(self.root.rglob("*")))

    def test_cli_ids_stable_across_processes_and_billing_correction(self):
        self.write([record()])
        outputs = []
        for mode in ["unknown", "subscription"]:
            target = self.root / (mode + ".json")
            run = subprocess.run([
                sys.executable, str(SCRIPT), "--machine", "test-machine", "--roots", str(self.logs),
                "--since", collector.iso(SINCE), "--until", collector.iso(UNTIL),
                "--billing-mode", mode, "--output", str(target),
            ], capture_output=True, text=True, check=True)
            self.assertNotIn(CANARY, run.stdout + run.stderr)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            outputs.append(json.loads(target.read_text())["facts"][0])
        key_fields = ("source", "account_id", "profile", "session_id", "model", "billing_provider", "billing_mode")
        self.assertEqual([outputs[0][k] for k in key_fields], [outputs[1][k] for k in key_fields])
        self.assertNotEqual(outputs[0]["detail"]["billing_mode"], outputs[1]["detail"]["billing_mode"])

    def test_private_output_never_overwrites(self):
        target = self.root / "existing.json"; target.write_text("preserve")
        with self.assertRaises(collector.CollectorError):
            collector.write_private(target, b"replacement")
        self.assertEqual(target.read_text(), "preserve")

    def test_literal_configuration_never_executes_substitution(self):
        marker = self.root / "never-create"
        path = self.root / "config.env"
        path.write_text('MC_URL="https://fleet.example.test"\nMC_TOKEN="$(touch ' + str(marker) + ')"\n')
        with self.assertRaises(collector.CollectorError):
            collector.credentials(path)
        self.assertFalse(marker.exists())
        path.write_text('MC_URL=https://fleet.example.test\nMC_TOKEN="synthetic-token" # comment\nIGNORED=secret\n')
        self.assertEqual(collector.credentials(path), ("https://fleet.example.test", "synthetic-token"))

    def test_origins_are_pinned_and_loopback_is_explicit(self):
        for value in ["http://fleet.example.test", "https://user@fleet.example.test", "https://fleet.example.test/path", "https://fleet.example.test?x", "https://fleet.example.test#", "https://fleet.example.test:0", "https://fleet.example.test\\evil"]:
            with self.subTest(value=value), self.assertRaises(collector.CollectorError):
                collector.origin(value, True)
        with self.assertRaises(collector.CollectorError):
            collector.origin("http://127.0.0.1:8765")
        self.assertEqual(collector.origin("http://127.0.0.1:8765", True), "http://127.0.0.1:8765")
        self.assertEqual(collector.origin("https://fleet.example.test/"), "https://fleet.example.test")

    def test_publish_exact_receipt_and_all_metadata_before_transport(self):
        self.write([record()]); payload = self.collect()
        opener = Opener(Response({"ok": True, "written": 1}))
        with mock.patch.object(collector, "credentials", return_value=("https://fleet.example.test", "synthetic-token")):
            result = collector.publish(payload, expected_origin="https://fleet.example.test", opener=opener)
        self.assertEqual(result, {"ok": True, "written": 1})
        request, options = opener.requests[0]
        self.assertEqual(options["timeout"], 30)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), payload)
        self.assertNotIn(CANARY.encode(), request.data)
        self.assertNotIn(b"synthetic-token", request.data)

    def test_publish_rejects_demo_bad_counts_redirects_and_oversized_receipts(self):
        self.write([record()]); payload = self.collect()
        bad = [{"ok": True, "demo": True, "written": 1}, {"ok": True, "written": 0}, {"ok": True, "written": True}, {"ok": False, "written": 1}, b"x" * (collector.MAX_RECEIPT_BYTES + 1)]
        with mock.patch.object(collector, "credentials", return_value=("https://fleet.example.test", "synthetic-token")):
            for value in bad:
                with self.subTest(value=str(value)[:40]), self.assertRaises(collector.CollectorError):
                    collector.publish(payload, opener=Opener(Response(value)))
            with self.assertRaises(collector.CollectorError):
                collector.publish(payload, opener=Opener(Response({"ok": True, "written": 1}, url="https://elsewhere.example.test/")))
            unopened = Opener(Response({"ok": True, "written": 1}))
            with self.assertRaises(collector.CollectorError):
                collector.publish(payload, expected_origin="https://elsewhere.example.test", opener=unopened)
            self.assertEqual(unopened.requests, [])
        with self.assertRaises(collector.CollectorError):
            collector.NoRedirect().redirect_request(None, None, 307, None, {}, "https://elsewhere.example.test")

    def test_partial_batch_may_publish_but_returns_nonzero(self):
        path = self.write([record()])
        with path.open("a") as handle: handle.write(CANARY + "\n")
        output = io.StringIO()
        with mock.patch.object(collector, "publish", return_value={"ok": True, "written": 1}) as post, contextlib.redirect_stdout(output):
            code = collector.main(["--machine", "test-machine", "--roots", str(self.logs), "--since", collector.iso(SINCE), "--until", collector.iso(UNTIL), "--publish"])
        self.assertEqual(code, 2)
        self.assertTrue(json.loads(output.getvalue())["published"])
        self.assertEqual(post.call_args[0][0]["snapshot"]["detail"]["coverage"]["status"], "partial")
        self.assertNotIn(CANARY, output.getvalue())

    def test_real_loopback_post_and_redirect_refusal(self):
        self.write([record()]); payload = self.collect()
        received = []
        redirect = [False]

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                received.append((self.path, json.loads(body)))
                if redirect[0]:
                    self.send_response(307)
                    self.send_header("Location", "/must-not-follow")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"ok":true,"written":1}')

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            endpoint = "http://127.0.0.1:" + str(server.server_port)
            with mock.patch.object(collector, "credentials", return_value=(endpoint, "synthetic-token")):
                self.assertEqual(collector.publish(payload, allow_loopback_http=True), {"ok": True, "written": 1})
                redirect[0] = True
                with self.assertRaisesRegex(collector.CollectorError, "^redirect_refused$"):
                    collector.publish(payload, allow_loopback_http=True)
            self.assertEqual(len(received), 2)
            self.assertEqual([row[0] for row in received], ["/api/usage/ingest", "/api/usage/ingest"])
            self.assertEqual(received[0][1], payload)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_invalid_options_and_transport_errors_never_echo_values(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = collector.main(["--machine", CANARY, "--roots", str(self.logs)])
        self.assertEqual(code, 1)
        self.assertNotIn(CANARY, output.getvalue())
        self.write([record()])
        with mock.patch.object(collector, "credentials", return_value=("https://fleet.example.test", "synthetic-token")), mock.patch.object(Opener, "open", side_effect=OSError(CANARY)):
            with self.assertRaisesRegex(collector.CollectorError, "^publish_failed$"):
                collector.publish(self.collect(), opener=Opener(None))


if __name__ == "__main__":
    unittest.main()
