"""Synthetic Grok CLI usage files: never read real sessions or secrets."""
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
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / "agents" / "grok-usage-collector" / "collector.py"
SPEC = importlib.util.spec_from_file_location("grok_usage_collector", SCRIPT)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
SINCE = collector.instant("2026-11-01T00:00:00Z")
UNTIL = collector.instant("2026-11-04T00:00:00Z")
CANARY = "PRIVATE-CONTENT-CANARY-DO-NOT-EMIT"


def usage(input_tokens=1000, output=200, cached=600, reasoning=150, calls=3, ticks=12_340_000, **changes):
    value = {
        "inputTokens": input_tokens, "outputTokens": output, "cachedReadTokens": cached,
        "cacheCreationTokens": 0, "reasoningTokens": reasoning, "totalTokens": input_tokens + output,
        "modelCalls": calls, "costUsdTicks": ticks,
    }
    value.update(changes)
    return value


def turn(number=1, ended="2026-11-02T12:00:00.123456+00:00", models=None, **changes):
    models = models if models is not None else {"grok-4.7-build": usage()}
    value = {
        "turnNumber": number, "endedAt": ended, "primaryModelId": next(iter(models), None),
        "prompt": CANARY, "modelUsage": models,
        # Turn-level totals are ignored; only modelUsage is read.
        "inputTokens": 999_999_999, "outputTokens": 999_999_999,
    }
    value.update(changes)
    return value


def document(turns, session="session-private-1", session_totals=None):
    return {
        "sessionId": session, "updatedAt": "2026-11-02T12:00:00Z",
        # Session totals can include inherited history and must never be read.
        "session": session_totals or {"inputTokens": 10**12, "outputTokens": 10**12, "costUsdTicks": 10**18},
        "turns": turns,
    }


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sessions = self.root / "sessions"
        self.sessions.mkdir()

    def write(self, value, cwd="%2Fprivate%2F" + CANARY, session="session-private-1", raw=None):
        directory = self.sessions / cwd / session
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "chat_history.jsonl").write_text(json.dumps({"content": CANARY}) + "\n")
        path = directory / "usage.json"
        path.write_text(raw if raw is not None else json.dumps(value))
        return path

    def collect(self, billing_mode="unknown"):
        return collector.collect([self.sessions], "test-machine", billing_mode, SINCE, UNTIL, UNTIL)

    def coverage(self, payload):
        return payload["snapshot"]["detail"]["coverage"]

    def test_turn_model_fact_maps_counters_and_grok_estimate(self):
        self.write(document([turn()]))
        payload = self.collect("subscription")
        self.assertEqual(len(payload["facts"]), 1)
        fact = payload["facts"][0]
        self.assertEqual(fact["source"], "grok_cli")
        self.assertEqual(fact["account_id"], "grok-cli:test-machine")
        self.assertEqual(fact["model"], "grok-4.7-build")
        self.assertEqual(fact["billing_provider"], "xai")
        self.assertEqual(fact["billing_mode"], "observation")
        self.assertEqual(fact["detail"]["billing_mode"], "subscription")
        self.assertEqual(fact["api_call_count"], 3)
        # inputTokens includes the cached read; the fact keeps only the uncached part.
        self.assertEqual((fact["input_tokens"], fact["cache_read_tokens"], fact["cache_write_tokens"]), (400, 600, 0))
        # reasoningTokens is already inside outputTokens.
        self.assertEqual((fact["output_tokens"], fact["reasoning_tokens"]), (200, 150))
        self.assertEqual(fact["paid_cost_usd"], 0)
        self.assertEqual(fact["shadow_cost_usd"], 0.001234)
        self.assertEqual(fact["cost_status"], "local_reported_estimate")
        self.assertEqual(fact["last_seen_at"], "2026-11-02T12:00:00.123456Z")
        self.assertEqual(self.coverage(payload)["status"], "complete")

    def test_session_and_turn_totals_are_never_summed(self):
        self.write(document([turn()]))
        result = collector.summary(self.collect())
        self.assertEqual(result["tokens"]["input_tokens"], 400)
        self.assertEqual(result["grok_reported_estimate_usd"], 0.001234)
        self.assertIsNone(result["actual_charges_usd"])

    def test_one_fact_per_model_in_a_turn(self):
        self.write(document([turn(models={"grok-4.7-build": usage(), "grok-4.6-build": usage(calls=1)})]))
        facts = self.collect()["facts"]
        self.assertEqual(sorted(f["model"] for f in facts), ["grok-4.6-build", "grok-4.7-build"])
        self.assertEqual(len({f["session_id"] for f in facts}), 2)

    def test_resumed_or_forked_session_copying_a_turn_counts_it_once(self):
        parent = [turn(1, "2026-11-02T10:00:00+00:00"), turn(2, "2026-11-02T11:00:00+00:00")]
        child = parent + [turn(3, "2026-11-02T12:00:00+00:00")]
        self.write(document(parent, "parent-session"), session="parent-session")
        self.write(document(child, "child-session"), cwd="%2Fother", session="child-session")
        payload = self.collect()
        self.assertEqual(len(payload["facts"]), 3)
        self.assertEqual(self.coverage(payload)["duplicates"], 2)
        self.assertEqual(self.coverage(payload)["status"], "complete")
        self.assertEqual(collector.summary(payload)["model_calls"], 9)

    def test_repeated_scans_and_ids_are_stable(self):
        self.write(document([turn()]))
        first, second = self.collect()["facts"], self.collect()["facts"]
        self.assertEqual(first, second)

    def test_window_is_half_open_by_turn_end(self):
        self.write(document([
            turn(1, "2026-10-31T20:00:00-04:00"),
            turn(2, "2026-10-31T23:59:59Z"),
            turn(3, "2026-11-04T00:00:00Z"),
        ]))
        facts = self.collect()["facts"]
        self.assertEqual([f["last_seen_at"] for f in facts], ["2026-11-01T00:00:00.000000Z"])

    def test_missing_grok_estimate_is_unpriced_not_zero(self):
        missing = usage(); del missing["costUsdTicks"]
        self.write(document([turn(1, models={"grok-4.7-build": missing}), turn(2, "2026-11-02T13:00:00Z", models={"grok-4.7-build": usage(ticks=0)})]))
        facts = self.collect()["facts"]
        self.assertEqual(sorted(f["cost_status"] for f in facts), ["local_reported_estimate", "local_unpriced"])
        result = collector.summary(self.collect())
        self.assertEqual(result["grok_reported_estimate_usd"], 0)
        self.assertEqual(result["reported_observations"], 1)

    def test_api_billed_rows_are_left_out_of_the_cross_check(self):
        self.write(document([turn()]))
        result = collector.summary(self.collect("api"))
        self.assertIsNone(result["grok_reported_estimate_usd"])
        self.assertEqual(result["reported_observations"], 0)
        self.assertEqual(result["tokens"]["input_tokens"], 400)

    def test_malformed_turns_are_skipped_and_coverage_partial(self):
        bad_turns = [
            turn(0), turn("1"), turn(1, "yesterday"), turn(1, models={}), turn(1, models=[]),
            turn(1, models={"gpt-5": usage()}), turn(1, models={"grok-4.7/../x": usage()}),
            turn(1, models={"grok-4.7": usage(output=-1)}), turn(1, models={"grok-4.7": usage(input_tokens=True)}),
            turn(1, models={"grok-4.7": usage(input_tokens=1.5)}), turn(1, models={"grok-4.7": usage(ticks="5")}),
            turn(1, models={"grok-4.7": usage(input_tokens=2**54)}),
            turn(1, models={"grok-4.7": usage(cached=2000)}), turn(1, models={"grok-4.7": usage(reasoning=500)}),
            turn(1, models={"grok-4.7": usage(calls=0)}), turn(1, models={"grok-4.7": usage(calls=-1)}),
            "not-a-turn",
        ]
        missing = usage(); del missing["outputTokens"]
        bad_turns.append(turn(1, models={"grok-4.7": missing}))
        self.write(document([turn()] + bad_turns))
        payload = self.collect()
        self.assertEqual(len(payload["facts"]), 1)
        self.assertEqual(self.coverage(payload)["malformed_records"], len(bad_turns))
        self.assertEqual(self.coverage(payload)["status"], "partial")

    def test_malformed_files_are_partial(self):
        for index, raw in enumerate(['{"sessionId":"s","turns":[]', '{"sessionId":"s","turns":{}}', '{"turns":[]}', '{"sessionId":"s","sessionId":"t","turns":[]}', '[]', '{"sessionId":"s","turns":[],"x":NaN}']):
            self.write(None, session="bad-" + str(index), raw=raw)
        payload = self.collect()
        self.assertEqual(payload["facts"], [])
        self.assertEqual(self.coverage(payload)["malformed_records"], 6)
        self.assertEqual(self.coverage(payload)["status"], "partial")

    def test_empty_session_file_is_complete_and_no_files_is_partial(self):
        self.assertEqual(self.coverage(self.collect())["status"], "partial")
        self.write(document([]))
        self.assertEqual(self.coverage(self.collect())["status"], "complete")

    def test_only_usage_json_is_read_and_depth_is_bounded(self):
        self.write(document([turn()]))
        deep = self.sessions / "cwd" / "session" / "terminal" / "nested"
        deep.mkdir(parents=True)
        (deep / "usage.json").write_text(json.dumps(document([turn(9, "2026-11-02T09:00:00Z")], "deep")))
        opened = []
        original = collector.open_regular_file

        def spy(path):
            opened.append(Path(path).name)
            return original(path)

        with mock.patch.object(collector, "open_regular_file", spy):
            payload = self.collect()
        self.assertEqual(opened, ["usage.json"])
        self.assertEqual(len(payload["facts"]), 1)

    def test_output_is_allowlisted_and_ids_are_hashed(self):
        value = document([turn()])
        value["apiKey"] = CANARY
        value["turns"][0]["modelUsage"]["grok-4.7-build"]["content"] = CANARY
        self.write(value)
        payload = self.collect()
        raw = json.dumps(payload)
        for forbidden in [CANARY, "session-private-1", str(self.root), "%2F", "apiKey", '"content"', "prompt"]:
            self.assertNotIn(forbidden, raw)
        fact = payload["facts"][0]
        self.assertRegex(fact["session_id"], r"^grok:[0-9a-f]{64}$")
        self.assertEqual(set(fact["detail"]), {"version", "machine", "billing_mode", "cost_basis", "granularity", "session_hash", "turn_hash"})

    def test_symlinks_unreadable_files_and_limits_are_partial(self):
        target = self.write(document([turn()]))
        link_dir = self.sessions / "linked" / "session"
        link_dir.mkdir(parents=True)
        (link_dir / "usage.json").symlink_to(target)
        payload = self.collect()
        self.assertEqual(len(payload["facts"]), 1)
        self.assertEqual(self.coverage(payload)["scan_errors"], 1)
        self.assertEqual(self.coverage(payload)["status"], "partial")
        (link_dir / "usage.json").unlink()
        with mock.patch.object(collector.os, "open", side_effect=PermissionError(CANARY)):
            result = self.collect()
        self.assertEqual(self.coverage(result)["unreadable_files"], 1)
        self.assertNotIn(CANARY, json.dumps(result))
        for bounds in ({"MAX_FILE_BYTES": 10}, {"MAX_SCAN_ENTRIES": 1}, {"MAX_OBSERVATIONS": 0}, {"MAX_TURNS_PER_FILE": 0}):
            with self.subTest(bounds=bounds), mock.patch.multiple(collector, **bounds):
                self.assertEqual(self.coverage(self.collect())["status"], "partial")

    def test_file_bound_prefers_newest_files(self):
        old = self.write(document([turn(1, "2026-11-02T01:00:00Z")], "old"), session="old")
        new = self.write(document([turn(1, "2026-11-02T02:00:00Z")], "new"), session="new")
        os.utime(old, (10, 10)); os.utime(new, (20, 20))
        with mock.patch.object(collector, "MAX_FILES", 1):
            payload = self.collect()
        self.assertEqual([f["last_seen_at"] for f in payload["facts"]], ["2026-11-02T02:00:00.000000Z"])
        self.assertEqual(self.coverage(payload)["status"], "partial")

    def test_fifo_leaf_does_not_block(self):
        directory = self.sessions / "cwd" / "fifo-session"
        directory.mkdir(parents=True)
        os.mkfifo(directory / "usage.json")
        payload = self.collect()
        self.assertEqual(payload["facts"], [])
        self.assertEqual(self.coverage(payload)["status"], "partial")

    def test_invalid_options_fail_closed(self):
        for machine, mode in (("Bad Machine", "unknown"), ("ok", "metered")):
            with self.assertRaisesRegex(collector.CollectorError, "^invalid_collection_options$"):
                collector.collect([self.sessions], machine, mode, SINCE, UNTIL)
        with self.assertRaisesRegex(collector.CollectorError, "^invalid_window$"):
            collector.collect([self.sessions], "ok", "unknown", UNTIL, SINCE)

    def test_default_dry_run_writes_nothing_and_reads_no_credentials(self):
        self.write(document([turn()]))
        output = io.StringIO()
        before = set(self.root.rglob("*"))
        with mock.patch.object(collector, "credentials", side_effect=AssertionError("no auth read")), contextlib.redirect_stdout(output):
            code = collector.main(["--machine", "test-machine", "--roots", str(self.sessions), "--since", collector.iso(SINCE), "--until", collector.iso(UNTIL)])
        result = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertFalse(result["published"])
        self.assertNotIn("facts", result)
        self.assertEqual(result["models"], ["grok-4.7-build"])
        self.assertEqual(before, set(self.root.rglob("*")))

    def test_cli_private_output_and_partial_exit_code(self):
        self.write(document([turn(), "bad"]))
        target = self.root / "out.json"
        run = subprocess.run([
            sys.executable, str(SCRIPT), "--machine", "test-machine", "--roots", str(self.sessions),
            "--since", collector.iso(SINCE), "--until", collector.iso(UNTIL), "--output", str(target),
        ], capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertNotIn(CANARY, run.stdout + run.stderr)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual(len(json.loads(target.read_text())["facts"]), 1)
        again = subprocess.run([sys.executable, str(SCRIPT), "--machine", "test-machine", "--roots", str(self.sessions), "--output", str(target)], capture_output=True, text=True)
        self.assertEqual(again.returncode, 1)
        self.assertIn("output_unavailable", again.stdout)

    def test_publish_posts_once_and_requires_exact_receipt(self):
        self.write(document([turn()]))
        payload = self.collect()

        class Response:
            def __init__(self, body): self.body = json.dumps(body).encode()
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, count): return self.body[:count]
            def geturl(self): return "https://fleet.example.test/api/usage/ingest"
            def getcode(self): return 200

        class Opener:
            def __init__(self, body): self.body, self.requests = body, []
            def open(self, request, **kwargs):
                self.requests.append(request)
                return Response(self.body)

        with mock.patch.object(collector, "credentials", return_value=("https://fleet.example.test", "synthetic-token")):
            opener = Opener({"ok": True, "written": 1})
            self.assertEqual(collector.publish(payload, opener=opener), {"ok": True, "written": 1})
            self.assertEqual(json.loads(opener.requests[0].data), payload)
            self.assertEqual(opener.requests[0].full_url, "https://fleet.example.test/api/usage/ingest")
            for body in ({"ok": True, "written": 0}, {"ok": True, "written": 1, "demo": True}, {"ok": False}):
                with self.subTest(body=body), self.assertRaisesRegex(collector.CollectorError, "^invalid_receipt$"):
                    collector.publish(payload, opener=Opener(body))
            with self.assertRaisesRegex(collector.CollectorError, "^origin_mismatch$"):
                collector.publish(payload, expected_origin="https://other.example.test", opener=Opener({"ok": True, "written": 1}))


if __name__ == "__main__":
    unittest.main()
