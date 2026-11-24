"""Claude Reviewer runner tests (#176 Part 2, AC 5-16 and the runner-facing contract ACs).

Everything here is local: a loopback stub for the AK API and the GitHub REST API, a file://
bare repository standing in for GitHub's git endpoint, a stub `claude` binary, a stub
`sandbox-exec` that drops the profile and execs the rest (the real sandbox is exercised by a
separate macOS-only test), and a throwaway RSA key signed with the real `openssl`.

Guards active in every runner test: any non-loopback socket connect fails the test, every
subprocess argv is recorded (no `gh`, no secret in argv), and a stub `gh` on PATH records any
invocation. No test claims the real App, registry, trust list or live identity is verified.
"""
from __future__ import annotations

import base64
import contextlib
import datetime as dt
import decimal
import io
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from agents.reviewer import config as rconfig  # noqa: E402
from agents.reviewer import evidence, ledger  # noqa: E402
from agents.reviewer import github as rgithub  # noqa: E402
from agents.reviewer import provenance  # noqa: E402

OPENSSL = "/usr/bin/openssl" if os.path.exists("/usr/bin/openssl") else shutil.which("openssl")
AK_TOKEN = "akc_test_ak_token_6f1d2c9e0b7a"
INSTALL_TOKEN = "ghs_testinstallationtoken9c41aa"
OAUTH_TOKEN = "sk-ant-oat-test-oauth-token-77e2"
BOT = "aie-claude-reviewer[bot]"
SLUG = "aie-claude-reviewer"
REPO = "mrhinkle/conference-os"
REPO2 = "the-aie/the-gibson"
QUEUE = "conference-os/pr-review"
QUEUE2 = "the-gibson/pr-review"
LENSES6 = ("correctness", "tests", "security", "scope", "contract", "maintainability")
SANDBOX_DARWIN = sys.platform == "darwin" and os.path.exists("/usr/bin/sandbox-exec")

_KEY_DIR = tempfile.mkdtemp(prefix="ak-reviewer-testkey-")
KEY_FILE = os.path.join(_KEY_DIR, "app.pem")
PUB_FILE = os.path.join(_KEY_DIR, "app.pub")


def _make_key() -> None:
    if not os.path.exists(KEY_FILE):
        subprocess.run([OPENSSL, "genrsa", "-out", KEY_FILE, "2048"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run([OPENSSL, "rsa", "-in", KEY_FILE, "-pubout", "-out", PUB_FILE], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def tearDownModule():
    shutil.rmtree(_KEY_DIR, ignore_errors=True)


def key_secret_fragments():
    with open(KEY_FILE) as handle:
        lines = [line.strip() for line in handle if line.strip() and not line.startswith("-----")]
    return lines[1:4]


def iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def good_result(lenses=LENSES6, findings=None, finding_lens=None):
    out = {"lenses": {lens: {"status": "cleared", "summary": "checked"} for lens in lenses}, "findings": findings or []}
    if finding_lens:
        out["lenses"][finding_lens] = {"status": "finding", "summary": "missing test for the new branch"}
    return out


def envelope(result, cost="0.25", **extra) -> str:
    text = result if isinstance(result, str) else json.dumps(result)
    parts = {"type": "result", "subtype": "success", "is_error": False, "result": text}
    parts.update(extra)
    body = json.dumps(parts)[:-1]
    if cost is not None:
        body += ', "total_cost_usd": ' + cost
    return body + "}"


def commit(login, message, sha="a" * 40):
    return {"sha": sha, "author": ({"login": login} if login else None), "commit": {"message": message}}




# ---------------------------------------------------------------------------------------------
# Config (AC 15, 17, 45, 88, 104, 106, 108)
# ---------------------------------------------------------------------------------------------
class ConfigTests(unittest.TestCase):
    def base(self, **over):
        data = {
            "enabled": True, "mode": "dry-run", "ak_url": "https://ak.example", "ak_credential_file": "/x/ak.env",
            "github_app_id": 1, "github_app_key_file": "/x/key.pem", "registry_path": "/x/reg.json",
            "state_dir": "/x/state", "queues": [{"queue": "q", "repo": "o/r"}], "model_mid": "sonnet",
            "model_top": "opus", "daily_cap_usd": 5, "claude_oauth_token_file": "/x/oauth",
        }
        data.update(over)
        return data

    def load(self, data):
        return rconfig.load_config_text(json.dumps(data).encode())

    def test_example_config_is_valid_disabled_dry_run(self):
        cfg = rconfig.load_config(os.path.join(ROOT, "agents", "reviewer", "reviewer.config.example.json"))
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.mode, "dry-run")
        with open(os.path.join(ROOT, "agents", "reviewer", "reviewer.config.example.json")) as h:
            keys = set(json.load(h))
        self.assertEqual(keys, rconfig.ALL_FIELDS, "the example names every schema field")

    def test_defaults(self):
        cfg = self.load(self.base())
        self.assertEqual((cfg.claude_path, cfg.claude_timeout_seconds, cfg.openssl_path, cfg.daily_max_reviews,
                          cfg.max_clone_bytes, cfg.max_diff_lines, cfg.schedule_minutes),
                         ("claude", 900, "/usr/bin/openssl", 40, 200000000, 5000, 15))
        self.assertEqual(cfg.lenses, LENSES6)

    def test_rejections(self):
        bad = [
            {"surprise": 1},
            {"mode": "live-ish"},
            {"enabled": "true"},
            {"github_app_id": 0},
            {"github_app_id": True},
            {"github_app_id": 1.0},
            {"queues": []},
            {"queues": ["q"]},
            {"queues": [{"queue": "q", "repo": "o/r", "lenses": ["tests"]}]},
            {"queues": [{"queue": "Q", "repo": "o/r"}]},
            {"queues": [{"queue": "q", "repo": "o/r"}, {"queue": "q", "repo": "o/other"}]},
            {"queues": [{"queue": "q", "repo": "not-a-repo"}]},
            {"lenses": ["tests", "adversarial"]},
            {"lenses": ["tests", "tests"]},
            {"lenses": ["style"]},
            {"lenses": ["tests", "correctness"]},
            {"lenses": []},
            {"daily_cap_usd": -1},
            {"daily_cap_usd": "5"},
            {"daily_cap_usd": True},
            {"daily_max_reviews": 0},
            {"claude_timeout_seconds": 1.5},
            {"max_clone_bytes": -5},
            {"state_dir": "relative/state"},
            {"ak_url": "http://ak.example"},
            {"ak_url": "https://ak.example/path"},
            {"model_mid": "sonnet; rm -rf /"},
        ]
        for over in bad:
            with self.subTest(over=over):
                with self.assertRaises(rconfig.ConfigError):
                    self.load(self.base(**over))
        for missing in rconfig.REQUIRED_FIELDS:
            data = self.base()
            del data[missing]
            with self.subTest(missing=missing), self.assertRaises(rconfig.ConfigError):
                self.load(data)
        with self.assertRaises(rconfig.ConfigError):
            rconfig.load_config_text(b'{"enabled": true, "enabled": false}')

    def test_cap_parsed_as_decimal_from_json_text(self):
        raw = json.dumps(self.base()).replace('"daily_cap_usd": 5', '"daily_cap_usd": 0.30000000000000000001')
        cfg = rconfig.load_config_text(raw.encode())
        self.assertEqual(cfg.daily_cap_usd, decimal.Decimal("0.30000000000000000001"))

    def test_lens_subset_in_allowlist_order(self):
        self.assertEqual(self.load(self.base(lenses=["correctness", "security"])).lenses, ("correctness", "security"))

    def test_credential_loader_matches_import_velocity(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "ak.env")
            cases = [
                ("MC_URL=https://ak.example\nMC_TOKEN=abc\n", "abc"),
                ("export MC_URL='https://ak.example'\nexport MC_TOKEN=\"a$HOME\"  # c\n", "a$HOME"),
            ]
            for text, token in cases:
                with open(path, "w") as h:
                    h.write(text)
                self.assertEqual(rconfig.load_ak_credential(path, "https://ak.example"), token)
            for text in ("MC_URL=https://ak.example\nMC_TOKEN=a\nMC_TOKEN=b\n",
                         "MC_URL=https://ak.example\nMC_TOKEN=a b\n",
                         "MC_URL=https://other.example\nMC_TOKEN=a\n",
                         "MC_URL=https://ak.example\n"):
                with open(path, "w") as h:
                    h.write(text)
                with self.subTest(text=text), self.assertRaises(rconfig.ReviewerError):
                    rconfig.load_ak_credential(path, "https://ak.example")
            with open(path, "wb") as h:
                h.write(b"#" * (256 * 1024 + 1))
            with self.assertRaises(rconfig.ReviewerError):
                rconfig.load_ak_credential(path, "https://ak.example")

    def test_registry_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "r.json")
            with open(path, "w") as h:
                json.dump({"identities": [{"login": BOT, "vendor": "claude", "tier": "top"}]}, h)
            self.assertEqual(rconfig.load_registry(path)[BOT].vendor, "claude")
            for bad in ({"identities": [{"login": "Upper", "vendor": "claude", "tier": "top"}]},
                        {"identities": [{"login": "a", "vendor": "claude", "tier": "max"}]},
                        {"identities": [{"login": "a", "vendor": "claude", "tier": "top", "x": 1}]},
                        {"identities": [{"login": "a", "vendor": "c", "tier": "top"}, {"login": "a", "vendor": "d", "tier": "top"}]},
                        {"people": []}):
                with open(path, "w") as h:
                    json.dump(bad, h)
                with self.subTest(bad=bad), self.assertRaises(rconfig.ReviewerError):
                    rconfig.load_registry(path)


# ---------------------------------------------------------------------------------------------
# JWT and GitHub client conventions (AC 57, 70, 100)
# ---------------------------------------------------------------------------------------------
class JwtTests(unittest.TestCase):
    def test_rs256_signature_verifies_with_openssl(self):
        _make_key()
        calls = []
        real_run = subprocess.run

        def recording_run(args, *a, **kw):
            calls.append((list(args), kw.get("input")))
            return real_run(args, *a, **kw)

        with mock.patch.object(subprocess, "run", recording_run):
            jwt = rgithub.sign_app_jwt(4242, KEY_FILE, OPENSSL, 1_800_000_000)
        self.assertEqual(calls[0][0], [OPENSSL, "dgst", "-sha256", "-sign", KEY_FILE])
        header_b64, payload_b64, sig_b64 = jwt.split(".")
        self.assertEqual(calls[0][1], (header_b64 + "." + payload_b64).encode())
        for segment in (header_b64, payload_b64, sig_b64):
            self.assertNotIn("=", segment)
            self.assertRegex(segment, r"^[A-Za-z0-9_-]+$")
        pad = lambda s: s + "=" * (-len(s) % 4)
        header = base64.urlsafe_b64decode(pad(header_b64))
        payload = base64.urlsafe_b64decode(pad(payload_b64))
        self.assertEqual(header, b'{"alg":"RS256","typ":"JWT"}')
        self.assertEqual(json.loads(payload), {"iat": 1_800_000_000 - 60, "exp": 1_800_000_000 + 540, "iss": 4242})
        self.assertNotIn(b" ", payload)
        with tempfile.TemporaryDirectory() as tmp:
            sig = os.path.join(tmp, "sig")
            data = os.path.join(tmp, "data")
            with open(sig, "wb") as h:
                h.write(base64.urlsafe_b64decode(pad(sig_b64)))
            with open(data, "wb") as h:
                h.write((header_b64 + "." + payload_b64).encode())
            verified = subprocess.run([OPENSSL, "dgst", "-sha256", "-verify", PUB_FILE, "-signature", sig, data],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)
        with open(KEY_FILE) as h:
            key_text = h.read()
        self.assertNotIn(key_text.splitlines()[1], " ".join(calls[0][0]))

    def test_missing_or_failing_openssl_is_not_installed(self):
        for openssl in ("/nonexistent/openssl", "/usr/bin/false"):
            with self.subTest(openssl=openssl), self.assertRaises(rgithub.GitHubFailure) as caught:
                rgithub.sign_app_jwt(1, KEY_FILE, openssl, 1_800_000_000)
            self.assertEqual(caught.exception.outcome, "not_installed")

    def test_classification_matches_github_read(self):
        H = lambda **kw: {k.replace("_", "-"): v for k, v in kw.items()}
        self.assertIsNone(rgithub.classify(200, b"", H(), 0))
        self.assertEqual(rgithub.classify(429, b"", H(), 0), "rate_limit")
        self.assertEqual(rgithub.classify(403, b"You have exceeded a secondary rate limit", H(), 0), "rate_limit")
        self.assertEqual(rgithub.classify(403, b"API rate limit exceeded", H(retry_after="5"), 0), "rate_limit")
        self.assertEqual(rgithub.classify(401, b"", H(), 0), "token_revoked")
        self.assertEqual(rgithub.classify(403, b"", H(), 0), "missing_permission")
        self.assertEqual(rgithub.classify(404, b"", H(), 0), "missing_permission")
        self.assertEqual(rgithub.classify(500, b"", H(), 0), "github_error")
        self.assertEqual(rgithub.GITHUB_API_VERSION, "2022-11-28")
        self.assertEqual(rgithub.GITHUB_TIMEOUT_SECONDS, 15)


# ---------------------------------------------------------------------------------------------
# Provenance (AC 6, 21, 39, 63, 87)
# ---------------------------------------------------------------------------------------------
class ProvenanceTests(unittest.TestCase):
    REG = {
        "codex-lane[bot]": rconfig.Identity("codex-lane[bot]", "codex", "mid"),
        "claude-lane[bot]": rconfig.Identity("claude-lane[bot]", "claude", "top"),
        "mrhinkle": rconfig.Identity("mrhinkle", "human", "top"),
        "grok-lane[bot]": rconfig.Identity("grok-lane[bot]", "grok", "mid"),
    }

    def vendor(self, login, message):
        return provenance.commit_vendor(commit(login, message), self.REG)

    def test_commit_cases(self):
        cases = [
            ("codex-lane[bot]", "x\n\nAgent-Vendor: codex", "codex"),
            ("codex-lane[bot]", "x\n\nagent-vendor:\tCODEX  ", "codex"),
            ("Codex-Lane[bot]", "x", "codex"),                      # untrailed, registered (case-folded login)
            ("mrhinkle", "owner commit", "human"),                   # untrailed registered human
            ("stranger", "x", "provenance_unknown"),                 # untrailed unregistered
            (None, "x\n\nAgent-Vendor: codex", "provenance_unknown"),  # null author with trailer (AC 87)
            ("stranger", "x\n\nAgent-Vendor: codex", "provenance_unknown"),
            ("codex-lane[bot]", "x\n\nAgent-Vendor: grok", "provenance_unknown"),  # mismatch with registry
            ("codex-lane[bot]", "x\nAgent-Vendor: codex\nAgent-Vendor: grok", "provenance_unknown"),
            ("codex-lane[bot]", "x\nAgent-Vendor: codex\nAgent-Vendor: Codex", "codex"),  # one distinct value
            ("codex-lane[bot]", "x\nNot-Agent-Vendor: grok\nAgent-Vendor: codex x", "codex"),  # non-matching lines ignored
            ("claude-lane[bot]", "x\n\nAgent-Vendor: claude", "claude"),
        ]
        for login, message, expected in cases:
            with self.subTest(login=login, message=message):
                self.assertEqual(self.vendor(login, message), expected)

    def test_pr_resolution(self):
        codex = commit("codex-lane[bot]", "a\n\nAgent-Vendor: codex")
        claude = commit("claude-lane[bot]", "b\n\nAgent-Vendor: claude")
        grok = commit("grok-lane[bot]", "c")
        unknown = commit("stranger", "d")
        self.assertEqual(provenance.resolve([codex, grok], self.REG), ("eligible", ["codex", "grok"]))
        self.assertEqual(provenance.resolve([grok, claude], self.REG)[0], "same_vendor")
        self.assertEqual(provenance.resolve([claude, unknown], self.REG)[0], "same_vendor")
        self.assertEqual(provenance.resolve([codex, unknown], self.REG)[0], "provenance_unknown")
        self.assertEqual(provenance.resolve([], self.REG)[0], "provenance_unknown")

    def test_trailer_regex_is_collect_progress_regex(self):
        with open(os.path.join(ROOT, "scripts", "collect-progress.sh")) as h:
            text = h.read()
        self.assertIn('capture("(?im)^Agent-Vendor:[ \\\\t]+(?<v>[A-Za-z0-9][A-Za-z0-9._-]{0,31})[ \\\\t]*$")', text)
        self.assertEqual(provenance.TRAILER_RE.pattern,
                         r"^Agent-Vendor:[ \t]+(?P<v>[A-Za-z0-9][A-Za-z0-9._-]{0,31})[ \t]*$")


# ---------------------------------------------------------------------------------------------
# Model output, tier and body (AC 8, 9, 24, 28, 64, 68, 98)
# ---------------------------------------------------------------------------------------------
class EvidenceTests(unittest.TestCase):
    def test_tier_labels(self):
        cases = [([], "B"), (["bug"], "B"), (["tier:A"], "A"), (["TIER:c"], "C"), (["Tier:b"], "B"),
                 ([" tier:a"], "B"), (["tier:ab"], "B"), (["x-tier:c"], "B"), (["tier:a", "tier:C"], None),
                 (["tier:c", "TIER:C"], None)]
        for labels, expected in cases:
            with self.subTest(labels=labels):
                self.assertEqual(evidence.tier_from_labels([{"name": n} for n in labels]), expected)

    def test_lenses_for_tier(self):
        self.assertEqual(evidence.lenses_for(LENSES6, "B"), LENSES6)
        self.assertEqual(evidence.lenses_for(LENSES6, "C"), LENSES6 + ("adversarial",))
        self.assertEqual(evidence.lenses_for(("correctness", "tests"), "C"), ("correctness", "tests", "adversarial"))

    def test_envelope(self):
        cost, result = evidence.parse_envelope(envelope(good_result(), cost="0.1234").encode())
        self.assertEqual(cost, decimal.Decimal("0.1234"))
        self.assertIsInstance(result, str)
        invalid_output = [
            b"not json", b"[]", envelope(good_result(), type="assistant").encode(),
            envelope(good_result(), is_error=True).encode(), envelope(good_result(), subtype="error_max_turns").encode(),
            json.dumps({"type": "result", "is_error": False, "result": 5, "total_cost_usd": 1}).encode(),
            (envelope(good_result())[:-1] + ', "type": "result"}').encode(),  # duplicate key
        ]
        for raw in invalid_output:
            with self.subTest(raw=raw[:60]), self.assertRaises(evidence.InvalidOutput):
                evidence.parse_envelope(raw)
        for cost in (None, "-0.01", '"0.10"', "true", "null"):
            raw = envelope(good_result(), cost=cost).encode()
            with self.subTest(cost=cost), self.assertRaises(evidence.InvalidCost):
                evidence.parse_envelope(raw)
        with self.assertRaises(evidence.InvalidOutput):
            evidence.parse_envelope(b'{"type":"result","is_error":false,"result":"{}","total_cost_usd":NaN}')

    def test_valid_and_fenced_result(self):
        parsed = evidence.parse_model_result(json.dumps(good_result()), LENSES6)
        self.assertEqual(set(parsed["lenses"]), set(LENSES6))
        fenced = "```json\n" + json.dumps(good_result()) + "\n```"
        self.assertEqual(evidence.parse_model_result(fenced, LENSES6), parsed)

    def test_rejections(self):
        def with_(mutate):
            data = good_result(findings=[{"severity": "low", "path": "src/a.py", "line": 3, "summary": "nit"}])
            mutate(data)
            return json.dumps(data)

        long = "x" * 501
        bad = {
            "surrounding text": "Here you go:\n" + json.dumps(good_result()),
            "two fences": "```json\n{}\n```\n```json\n{}\n```",
            "fence plus text": "```json\n" + json.dumps(good_result()) + "\n```\nthanks",
            "duplicate key": json.dumps(good_result())[:-1] + ', "findings": []}',
            "unknown top": with_(lambda d: d.update(extra=1)),
            "missing lens": with_(lambda d: d["lenses"].pop("tests")),
            "unknown lens": with_(lambda d: d["lenses"].update(style={"status": "cleared", "summary": "x"})),
            "adversarial on B": with_(lambda d: d["lenses"].update(adversarial={"status": "cleared", "summary": "x"})),
            "lens extra field": with_(lambda d: d["lenses"]["tests"].update(score=1)),
            "bad status": with_(lambda d: d["lenses"]["tests"].update(status="ok")),
            "empty summary": with_(lambda d: d["lenses"]["tests"].update(summary="  ")),
            "long summary": with_(lambda d: d["lenses"]["tests"].update(summary=long)),
            "control char": with_(lambda d: d["lenses"]["tests"].update(summary="a\nb")),
            "C1 control": with_(lambda d: d["lenses"]["tests"].update(summary="a\u0085b")),
            "marker": with_(lambda d: d["lenses"]["tests"].update(summary="<!-- review-evidence:v1")),
            "verdict": with_(lambda d: d["lenses"]["tests"].update(summary="VERDICT: APPROVE")),
            "header": with_(lambda d: d["findings"][0].update(summary="Reviewed head: abc")),
            "review evidence": with_(lambda d: d["findings"][0].update(summary="## Review evidence")),
            "severity": with_(lambda d: d["findings"][0].update(severity="blocker")),
            "line zero": with_(lambda d: d["findings"][0].update(line=0)),
            "line bool": with_(lambda d: d["findings"][0].update(line=True)),
            "line float": with_(lambda d: d["findings"][0].update(line=1.0)),
            "finding extra": with_(lambda d: d["findings"][0].update(url="x")),
            "too many findings": with_(lambda d: d.update(findings=[{"severity": "low", "path": "a", "line": 1, "summary": "s"}] * 101)),
            "NaN": json.dumps(good_result())[:-1] + ', "x": NaN}',
        }
        for path in ("", "/etc/passwd", "../x", "a/../b", "./a", "a//b", "a/", "a\\b", "C:/x", " a", "a/./b"):
            bad["path " + repr(path)] = with_(lambda d, p=path: d["findings"][0].update(path=p))
        for name, text in bad.items():
            with self.subTest(name=name), self.assertRaises(evidence.InvalidOutput):
                evidence.parse_model_result(text, LENSES6)

    def test_body_exact_and_verdict_derivation(self):
        sha = "b" * 40
        approve = evidence.parse_model_result(json.dumps(good_result()), LENSES6)
        body = evidence.build_body(approve, head_sha=sha, bot_login=BOT, tier="B", lenses=LENSES6)
        self.assertEqual(body.splitlines(), [
            "<!-- review-evidence:v1", "head-sha: " + sha, "result: pass", "-->", "## Review evidence",
            "Reviewed head: " + sha, "Reviewer: %s (vendor claude)" % BOT, "Tier: B",
            "- correctness: cleared", "- tests: cleared", "- security: cleared", "- scope: cleared",
            "- contract: cleared", "- maintainability: cleared", "### Findings", "- none", "VERDICT: APPROVE"])
        medium = good_result(findings=[{"severity": "medium", "path": "a.py", "line": 2, "summary": "rename"}])
        self.assertEqual(evidence.verdict(evidence.parse_model_result(json.dumps(medium), LENSES6)), "APPROVE")
        for severity in ("critical", "high"):
            data = good_result(findings=[{"severity": severity, "path": "a.py", "line": 2, "summary": "bug"}])
            self.assertEqual(evidence.verdict(evidence.parse_model_result(json.dumps(data), LENSES6)), "REQUEST_CHANGES")
        lens_finding = evidence.parse_model_result(json.dumps(good_result(finding_lens="tests")), LENSES6)
        body = evidence.build_body(lens_finding, head_sha=sha, bot_login=BOT, tier="C", lenses=LENSES6)
        self.assertIn("result: fail", body)
        self.assertIn("- tests: missing test for the new branch", body)
        self.assertEqual(body.splitlines()[-1], "VERDICT: REQUEST_CHANGES")


# ---------------------------------------------------------------------------------------------
# Ledgers (AC 13, 42, 53, 65, 102)
# ---------------------------------------------------------------------------------------------
class LedgerTests(unittest.TestCase):
    def test_spend_ledger_decimal_median_and_rounding(self):
        with tempfile.TemporaryDirectory() as tmp:
            day = dt.date(2026, 11, 23)
            spend = ledger.SpendLedger(tmp, day)
            self.assertEqual(spend.estimate(), decimal.Decimal("1.00"))
            base = dt.datetime(2026, 11, 23, 1, tzinfo=dt.timezone.utc)
            for i in range(3):
                spend.charge(base + dt.timedelta(minutes=i), decimal.Decimal("0.1"))
            self.assertEqual(spend.total, decimal.Decimal("0.3"))  # exact, unlike 0.1+0.1+0.1 in float
            self.assertFalse(spend.blocks(decimal.Decimal("1.3"), 40))
            self.assertTrue(spend.blocks(decimal.Decimal("1.29999999999999999"), 40))
            self.assertTrue(spend.blocks(decimal.Decimal("100"), 3))
            with open(os.path.join(tmp, "spend-2026-11-23.json")) as h:
                data = json.load(h)
            self.assertEqual(set(data), {"date", "invocations", "total_usd", "halted"})
            self.assertEqual(data["total_usd"], "0.3")
            self.assertEqual([i["cost_usd"] for i in data["invocations"]], ["0.1", "0.1", "0.1"])
            costs = ["5", "1", "2", "3", "4", "9", "8", "7", "6", "10", "0.5"]
            other = ledger.SpendLedger(tmp, dt.date(2026, 11, 24))
            for i, cost in enumerate(costs):
                other.charge(base + dt.timedelta(days=1, minutes=i), decimal.Decimal(cost))
            # The ten most recent by time: 1..10 except the first ("5"); 0.5 included → sorted median of
            # [0.5,1,2,3,4,6,7,8,9,10] is (4+6)/2.
            self.assertEqual(other.estimate(), decimal.Decimal(5))
            half = ledger.SpendLedger(tmp, dt.date(2026, 11, 25))
            half.charge(base, decimal.Decimal("0.0000005"))
            self.assertEqual(half.micro_usd(), 1)  # half-up
            half.charge(base, decimal.Decimal("0.0000004"))
            self.assertEqual(half.micro_usd(), 1)
            reloaded = ledger.SpendLedger(tmp, dt.date(2026, 11, 25))
            self.assertEqual(reloaded.total, decimal.Decimal("0.0000009"))

    def test_corrupt_ledger_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "spend-2026-11-23.json"), "w") as h:
                h.write("{not json")
            self.assertTrue(ledger.SpendLedger(tmp, dt.date(2026, 11, 23)).blocks(decimal.Decimal(100), 40))

    def test_outcomes_rotate(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "outcomes.jsonl")
            with open(path, "w") as h:
                h.write('{"a":1}\n' * ledger.OUTCOME_ROTATE_LINES)
            ledger.append_outcome(tmp, {"b": 2})
            self.assertEqual(len(ledger.read_jsonl(path)), 1)
            self.assertTrue(os.path.exists(path + ".1"))


if __name__ == "__main__":
    unittest.main()
