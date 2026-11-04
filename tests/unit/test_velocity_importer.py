"""Delivery security tests: fake transports and synthetic temporary files only."""
import contextlib
import io
import json
import pathlib
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest import mock

import importlib.util
import sys

_spec = importlib.util.spec_from_file_location("import_velocity", pathlib.Path(__file__).resolve().parents[2] / "scripts" / "import-velocity.py")
_importer = importlib.util.module_from_spec(_spec)
sys.modules["import_velocity"] = _importer
_spec.loader.exec_module(_importer)

from import_velocity import (
    MAX_CAPTURE_BYTES, MAX_RESPONSE_BYTES, NoRedirect, SafeImportError,
    default_opener, main, origin,
)

SYNTHETIC_TOKEN = "synthetic-test-credential-never-real"
SYNTHETIC_URL = "https://collector.example"


def capture():
    return {
        "schemaVersion": 1, "metricVersion": "observed-development-velocity-v1.0",
        "capturedAt": "2026-01-02T00:00:00Z", "captureKind": "observed",
        "window": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-02T00:00:00Z",
                   "days": 1, "timezone": "UTC"},
        "scope": {"owners": ["example"], "includeForks": True, "includeArchived": True,
                  "cohort": "pr-created-in-window"},
        "inventoryComplete": True,
        "source": {"artifactSha256": "c" * 64, "evidenceSha256": "d" * 64, "collectorVersion": "synthetic"},
        "repositories": [],
    }


def receipt(**updates):
    result = {"ok": True, "id": "a" * 64, "scopeKey": "b" * 64,
              "duplicate": False, "recordedAt": "2026-01-02T00:00:01Z"}
    result.update(updates)
    return result


class FakeResponse:
    def __init__(self, body=None, status=200, url=None):
        self.body = json.dumps(receipt()).encode() if body is None else body
        self.status = status
        self.url = url
        self.read_sizes = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def getcode(self):
        return self.status

    def geturl(self):
        return self.url

    def read(self, size):
        self.read_sizes.append(size)
        return self.body[:size]


class FakeOpener:
    def __init__(self, response=None, failure=None):
        self.response = response if response is not None else FakeResponse()
        self.failure = failure
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.failure is not None:
            raise self.failure
        if self.response.url is None:
            self.response.url = request.full_url
        return self.response


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.capture_path = self.root / "capture.json"
        self.capture_path.write_text(json.dumps(capture()))

    def run_cli(self, *, extra=(), environ=None, opener=None):
        env = {"MC_URL": SYNTHETIC_URL, "MC_TOKEN": SYNTHETIC_TOKEN} if environ is None else environ
        transport = FakeOpener() if opener is None else opener
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main([str(self.capture_path), *extra], environ=env, opener=transport)
        output = stdout.getvalue() + stderr.getvalue()
        self.assertNotIn(SYNTHETIC_TOKEN, output)
        return code, stdout.getvalue(), stderr.getvalue(), transport

    def test_success_sends_exact_file_once_and_prints_only_safe_receipt(self):
        body = json.dumps(receipt(debug=SYNTHETIC_TOKEN, requestHeaders={"secret": SYNTHETIC_TOKEN})).encode()
        code, stdout, stderr, transport = self.run_cli(opener=FakeOpener(FakeResponse(body)))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout), receipt())
        self.assertEqual(stderr, "")
        self.assertEqual(len(transport.calls), 1)
        request, timeout = transport.calls[0]
        self.assertEqual(request.full_url, SYNTHETIC_URL + "/api/velocity/ingest")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, self.capture_path.read_bytes())
        self.assertEqual(request.get_header("Authorization"), "Bearer " + SYNTHETIC_TOKEN)
        self.assertEqual(timeout, 30)
        self.assertEqual(transport.response.read_sizes, [MAX_RESPONSE_BYTES + 1])
        self.assertTrue(transport.response.closed)

    def test_origin_assertion_mismatch_never_opens_transport(self):
        code, stdout, stderr, transport = self.run_cli(extra=["--url", "https://different.example"])
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertIn("target origin", stderr)
        self.assertNotIn(SYNTHETIC_URL, stderr)
        self.assertEqual(transport.calls, [])

    def test_default_port_and_case_share_the_same_origin(self):
        code, _, _, transport = self.run_cli(
            extra=["--url", "https://COLLECTOR.example:443"])
        self.assertEqual(code, 0)
        self.assertEqual(transport.calls[0][0].full_url, SYNTHETIC_URL + "/api/velocity/ingest")

    def test_different_port_is_a_different_origin(self):
        code, _, _, transport = self.run_cli(extra=["--url", "https://collector.example:444"])
        self.assertEqual(code, 1)
        self.assertEqual(transport.calls, [])

    def test_non_origin_and_non_https_targets_are_rejected(self):
        bad_urls = [
            "http://collector.example", "http://localhost.evil",
            "https://user:password@collector.example", "https://collector.example/path",
            "https://collector.example/", "https://collector.example?secret=hidden",
            "https://collector.example#fragment", "https://collector.example\\other",
            "https://collector.example:0", "https://collector.example:65536",
            "https://collector.example\n",
        ]
        for value in bad_urls:
            with self.subTest(url=value):
                code, stdout, stderr, transport = self.run_cli(
                    environ={"MC_URL": value, "MC_TOKEN": SYNTHETIC_TOKEN})
                self.assertEqual(code, 1)
                self.assertEqual(stdout, "")
                self.assertEqual(stderr, "Import failed: invalid configuration.\n")
                self.assertEqual(transport.calls, [])

    def test_http_is_allowed_only_for_literal_loopback_or_localhost(self):
        for value in ("http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"):
            with self.subTest(url=value):
                code, _, _, transport = self.run_cli(
                    environ={"MC_URL": value, "MC_TOKEN": SYNTHETIC_TOKEN})
                self.assertEqual(code, 0)
                self.assertEqual(len(transport.calls), 1)
        with self.assertRaises(SafeImportError):
            origin("http://0.0.0.0:3000")

    def test_redirect_response_is_denied_without_another_request(self):
        response = FakeResponse(status=302)
        code, stdout, stderr, transport = self.run_cli(opener=FakeOpener(response))
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Import failed: HTTP 302.\n")
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(response.read_sizes, [])
        handler = NoRedirect()
        request = urllib.request.Request(SYNTHETIC_URL, headers={"Authorization": "Bearer " + SYNTHETIC_TOKEN})
        self.assertIsNone(handler.redirect_request(request, None, 302, "", {}, "https://different.example"))

    def test_default_transport_disables_proxies_and_redirects_without_opening_network(self):
        with mock.patch("import_velocity.urllib.request.build_opener") as build:
            default_opener()
        handlers = build.call_args.args
        self.assertTrue(any(isinstance(item, NoRedirect) for item in handlers))
        self.assertTrue(any(isinstance(item, urllib.request.ProxyHandler) and item.proxies == {} for item in handlers))

    def test_returned_url_cannot_silently_change(self):
        code, stdout, stderr, transport = self.run_cli(
            opener=FakeOpener(FakeResponse(url="https://different.example/api/velocity/ingest")))
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Import failed: invalid response.\n")
        self.assertEqual(len(transport.calls), 1)

    def test_existing_config_is_literal_and_unrelated_assignments_never_execute(self):
        config = self.root / "collector.env"
        sentinel = self.root / "must-not-exist"
        text = (
            "# synthetic fixture\n"
            "export MC_URL='https://collector.example'\n"
            f'MC_TOKEN="{SYNTHETIC_TOKEN}" # literal comment\n'
            f"OTHER=$(touch {sentinel})\n"
        )
        config.write_text(text)
        code, _, _, transport = self.run_cli(extra=["--config", str(config)],
                                             environ={"MC_URL": "https://wrong.example", "MC_TOKEN": "unused"})
        self.assertEqual(code, 0)
        self.assertEqual(config.read_text(), text)
        self.assertFalse(sentinel.exists())
        self.assertEqual(transport.calls[0][0].get_header("Authorization"), "Bearer " + SYNTHETIC_TOKEN)

    def test_config_substitution_syntax_is_never_executed(self):
        config = self.root / "collector.env"
        sentinel = self.root / "must-not-exist"
        config.write_text(f"MC_URL={SYNTHETIC_URL}\nMC_TOKEN=$(touch {sentinel})\n")
        code, _, _, transport = self.run_cli(extra=["--config", str(config)])
        self.assertEqual(code, 1)
        self.assertFalse(sentinel.exists())
        self.assertEqual(transport.calls, [])

    def test_duplicate_or_missing_config_values_fail_without_environment_fallback(self):
        config = self.root / "collector.env"
        for content in (
            f"MC_URL={SYNTHETIC_URL}\n",
            f"MC_URL={SYNTHETIC_URL}\nMC_TOKEN={SYNTHETIC_TOKEN}\nMC_TOKEN=another\n",
        ):
            config.write_text(content)
            code, _, _, transport = self.run_cli(extra=["--config", str(config)])
            self.assertEqual(code, 1)
            self.assertEqual(transport.calls, [])

    def test_header_injection_and_missing_environment_are_rejected(self):
        for env in ({}, {"MC_URL": SYNTHETIC_URL, "MC_TOKEN": "not-real\r\nX-Injected: yes"}):
            code, _, stderr, transport = self.run_cli(environ=env)
            self.assertEqual(code, 1)
            self.assertEqual(stderr, "Import failed: invalid configuration.\n")
            self.assertEqual(transport.calls, [])

    def test_oversized_capture_is_rejected_locally(self):
        self.capture_path.write_bytes(b" " * (MAX_CAPTURE_BYTES + 1))
        code, stdout, stderr, transport = self.run_cli()
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Import failed: invalid capture.\n")
        self.assertEqual(transport.calls, [])

    def test_invalid_json_duplicate_keys_or_nonfinite_values_never_leave_machine(self):
        for raw in (b"{", b'{"x":1,"x":2}', b'{"x":NaN}', b'{"not":"a capture"}'):
            self.capture_path.write_bytes(raw)
            code, _, _, transport = self.run_cli()
            self.assertEqual(code, 1)
            self.assertEqual(transport.calls, [])

    def test_oversized_response_is_bounded_and_not_printed(self):
        response = FakeResponse(body=(SYNTHETIC_TOKEN.encode() + b" " * (MAX_RESPONSE_BYTES + 1)))
        code, stdout, stderr, _ = self.run_cli(opener=FakeOpener(response))
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Import failed: invalid response.\n")
        self.assertEqual(response.read_sizes, [MAX_RESPONSE_BYTES + 1])

    def test_invalid_receipt_fields_never_get_printed(self):
        invalid = [
            receipt(ok=False), receipt(id=SYNTHETIC_TOKEN), receipt(scopeKey="x" * 64),
            receipt(duplicate=1), receipt(recordedAt="not-a-date"),
            receipt(recordedAt="2026-99-02T00:00:00Z"),
        ]
        for value in invalid:
            with self.subTest(value=value):
                code, stdout, stderr, _ = self.run_cli(opener=FakeOpener(FakeResponse(json.dumps(value).encode())))
                self.assertEqual(code, 1)
                self.assertEqual(stdout, "")
                self.assertEqual(stderr, "Import failed: invalid response.\n")

    def test_even_valid_receipt_field_must_not_echo_the_bearer(self):
        token = "e" * 64
        stdout, stderr = io.StringIO(), io.StringIO()
        transport = FakeOpener(FakeResponse(json.dumps(receipt(id=token)).encode()))
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = main([str(self.capture_path)], environ={"MC_URL": SYNTHETIC_URL, "MC_TOKEN": token}, opener=transport)
        self.assertEqual(result, 1)
        self.assertNotIn(token, stdout.getvalue() + stderr.getvalue())

    def test_http_error_prints_status_only_and_never_retries(self):
        failure = urllib.error.HTTPError("https://example/" + SYNTHETIC_TOKEN, 401, SYNTHETIC_TOKEN,
                                         {"Authorization": SYNTHETIC_TOKEN}, io.BytesIO(SYNTHETIC_TOKEN.encode()))
        code, stdout, stderr, transport = self.run_cli(opener=FakeOpener(failure=failure))
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Import failed: HTTP 401.\n")
        self.assertEqual(len(transport.calls), 1)

    def test_transport_exception_is_generic_and_never_retries(self):
        code, stdout, stderr, transport = self.run_cli(
            opener=FakeOpener(failure=urllib.error.URLError(SYNTHETIC_TOKEN)))
        self.assertEqual(code, 1)
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "Import failed: request could not be completed.\n")
        self.assertEqual(len(transport.calls), 1)

    def test_explicit_same_file_retry_preserves_payload_and_accepts_duplicate_receipt(self):
        first = FakeOpener(FakeResponse(json.dumps(receipt()).encode()))
        second = FakeOpener(FakeResponse(json.dumps(receipt(duplicate=True)).encode()))
        self.assertEqual(self.run_cli(opener=first)[0], 0)
        code, stdout, _, _ = self.run_cli(opener=second)
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(stdout)["duplicate"])
        self.assertEqual(first.calls[0][0].data, second.calls[0][0].data)
        self.assertEqual(len(first.calls), 1)
        self.assertEqual(len(second.calls), 1)

    def test_unknown_arguments_are_not_echoed(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit):
                main([str(self.capture_path), "--token", SYNTHETIC_TOKEN], environ={}, opener=FakeOpener())
        self.assertNotIn(SYNTHETIC_TOKEN, stdout.getvalue() + stderr.getvalue())
        self.assertEqual(stderr.getvalue(), "Import failed: invalid arguments.\n")


if __name__ == "__main__":
    unittest.main()
