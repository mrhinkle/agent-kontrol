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


from agents.reviewer import claude_reviewer as cr  # noqa: E402


# ---------------------------------------------------------------------------------------------
# Loopback stub for AK + GitHub
# ---------------------------------------------------------------------------------------------
class Fake:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = []
        self.events = []
        self.queue_rows = []
        self.queue_status = 200
        self.app = (200, {"slug": SLUG, "id": 1})
        self.installations = {}
        self.install_status = {}
        self.mint_status = 201
        self.pulls = {}
        self.commits = {}
        self.reviews = {}
        self.posted = []
        self.post_status = 200
        self.overrides = {}
        self.jwts = set()

    def add_pull(self, repo, number, head, base, *, labels=(), commits=None, additions=10, deletions=2,
                 state="open", draft=False, title="Add thing", body="Body text"):
        pull = {"number": number, "state": state, "draft": draft, "head": {"sha": head}, "base": {"sha": base},
                "labels": [{"name": name} for name in labels], "commits": None, "additions": additions,
                "deletions": deletions, "title": title, "body": body}
        commit_list = commits if commits is not None else [commit("codex-lane[bot]", "Fix\n\nAgent-Vendor: codex")]
        pull["commits"] = len(commit_list)
        self.pulls[(repo, number)] = [pull]
        self.commits[(repo, number)] = commit_list
        self.reviews.setdefault((repo, number), [])
        self.installations.setdefault(repo, 7 if repo == REPO else 8)
        return pull


def row(queue, repo, items, complete=True, stale=False, **extra):
    out = {"queue": queue, "repo": repo, "complete": complete, "error": None, "observed_at": "2026-11-23T00:00:00Z",
           "received_at": "2026-11-23T00:00:00Z", "stale": stale, "age_minutes": 1, "stale_after_minutes": 30,
           "ready": {"count": len(items), "refs": ["#%d" % i["number"] for i in items]}, "raw": {"count": len(items)},
           "ready_items": items}
    out.update(extra)
    return out


def item(number, head, green_since=None):
    return {"number": number, "head_sha": head, "green_since": green_since}


def make_handler(fake: Fake):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _reply(self, status, payload=None, headers=None):
            data = b"" if payload is None else (payload if isinstance(payload, bytes) else json.dumps(payload).encode())
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _handle(self, method):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            parsed = urllib.parse.urlsplit(self.path)
            auth = self.headers.get("Authorization") or ""
            body = json.loads(raw) if raw else None
            with fake.lock:
                fake.requests.append({"method": method, "path": parsed.path, "query": parsed.query, "auth": auth,
                                      "body": body, "headers": {k.lower(): v for k, v in self.headers.items()}})
            key = (method, parsed.path)
            spec = fake.overrides.get(key)
            if isinstance(spec, list):
                spec = spec.pop(0) if len(spec) > 1 else spec[0]
            if spec is not None:  # None in a sequence falls through to the normal fake
                status, payload, headers = spec
                return self._reply(status, payload, headers)
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query)
            if path == "/api/sweep/queues":
                if auth != "Bearer " + AK_TOKEN:
                    return self._reply(401, {"error": "unauthorized"})
                return self._reply(fake.queue_status, {"queues": fake.queue_rows})
            if path == "/api/ingest" and method == "POST":
                fake.events.append(body)
                return self._reply(200 if auth == "Bearer " + AK_TOKEN else 401, {"ok": True})
            if not path.startswith("/gh/"):
                return self._reply(404, {})
            path = path[3:]
            bearer = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
            if bearer.count(".") == 2:
                fake.jwts.add(bearer)
            if path == "/app":
                return self._reply(fake.app[0], fake.app[1])
            parts = path.strip("/").split("/")
            if parts[0] == "app" and parts[1] == "installations" and parts[3] == "access_tokens":
                return self._reply(fake.mint_status, {"token": INSTALL_TOKEN, "expires_at": "2099-01-01T00:00:00Z"})
            repo = "/".join(parts[1:3])
            if parts[3:] == ["installation"]:
                status = fake.install_status.get(repo, 200)
                if repo not in fake.installations:
                    status = 404
                return self._reply(status, {"id": fake.installations.get(repo)})
            if bearer != INSTALL_TOKEN:
                return self._reply(401, {"message": "Bad credentials"})
            number = int(parts[4])
            if parts[5:] == []:
                versions = fake.pulls.get((repo, number))
                if not versions:
                    return self._reply(404, {"message": "Not Found"})
                current = versions.pop(0) if len(versions) > 1 else versions[0]
                return self._reply(200, current)
            if parts[5:] == ["commits"]:
                page = int(query["page"][0])
                rows = fake.commits[(repo, number)][(page - 1) * 100: page * 100]
                more = len(fake.commits[(repo, number)]) > page * 100
                return self._reply(200, rows, {"Link": '<x?page=%d>; rel="next"' % (page + 1)} if more else {})
            if parts[5:] == ["reviews"] and method == "GET":
                page = int(query["page"][0])
                allr = fake.reviews[(repo, number)]
                more = len(allr) > page * 100
                return self._reply(200, allr[(page - 1) * 100: page * 100], {"Link": '<x>; rel="next"'} if more else {})
            if parts[5:] == ["reviews"] and method == "POST":
                if fake.post_status >= 300:
                    return self._reply(fake.post_status, {"message": "no"})
                fake.posted.append({"repo": repo, "number": number, "body": body})
                return self._reply(fake.post_status, {"id": 1})
            return self._reply(404, {})

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

    return Handler


STUB_CLAUDE = r'''#!{python}
import json, os, subprocess, sys, time
REC = {rec!r}
stdin = sys.stdin.read()
with open(os.path.join(REC, "scenario.json")) as h:
    scenario = json.load(h)
n_path = os.path.join(REC, "claude-count")
n = int(open(n_path).read()) if os.path.exists(n_path) else 0
open(n_path, "w").write(str(n + 1))
step = scenario[min(n, len(scenario) - 1)]
head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, env={{"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/")}}).stdout.strip()
with open(os.path.join(REC, "claude.jsonl"), "a") as h:
    h.write(json.dumps({{"argv": sys.argv, "env": dict(os.environ), "cwd": os.getcwd(), "stdin": stdin, "head": head}}) + "\n")
if step.get("sleep"):
    time.sleep(step["sleep"])
sys.stdout.write(step.get("stdout", ""))
sys.exit(step.get("exit", 0))
'''

STUB_SANDBOX = r'''#!{python}
import os, sys
REC = {rec!r}
assert sys.argv[1] == "-p", sys.argv
with open(os.path.join(REC, "profile.sb"), "w") as h:
    h.write(sys.argv[2])
os.execv(sys.argv[3], sys.argv[3:])
'''

STUB_GH = r'''#!/bin/sh
echo called >> {rec}/gh-called
exit 1
'''


class Harness:
    """A temp world: secrets, registry, state dir, stub binaries, bare git repos, stub server."""

    def __init__(self, test: unittest.TestCase):
        _make_key()
        self.test = test
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="ak-reviewer-test-"))
        test.addCleanup(shutil.rmtree, self.tmp, True)
        for sub in ("secrets", "state", "bin", "git", "work", "rec", "src"):
            os.makedirs(os.path.join(self.tmp, sub))
        self.fake = Fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.fake))
        self.server.daemon_threads = True
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        test.addCleanup(self.server.server_close)
        test.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]
        self.ak_url = "http://127.0.0.1:%d" % self.port
        self.key_file = os.path.join(self.tmp, "secrets", "app.pem")
        shutil.copy(KEY_FILE, self.key_file)
        self.cred_file = os.path.join(self.tmp, "secrets", "ak.env")
        with open(self.cred_file, "w") as h:
            h.write("export MC_URL=%s\nexport MC_TOKEN='%s'\n" % (self.ak_url, AK_TOKEN))
        self.oauth_file = os.path.join(self.tmp, "secrets", "oauth")
        with open(self.oauth_file, "w") as h:
            h.write(OAUTH_TOKEN + "\n")
        self.registry = os.path.join(self.tmp, "secrets", "registry.json")
        self.set_registry()
        self.rec = os.path.join(self.tmp, "rec")
        self.claude = self._script("claude", STUB_CLAUDE.format(python=sys.executable, rec=self.rec))
        self.sandbox = self._script("sandbox-exec", STUB_SANDBOX.format(python=sys.executable, rec=self.rec))
        self._script("gh", STUB_GH.format(rec=self.rec))
        self.scenario([{"stdout": envelope(good_result())}])
        self.config = {
            "enabled": True, "mode": "dry-run", "ak_url": self.ak_url, "ak_credential_file": self.cred_file,
            "github_app_id": 4242, "github_app_key_file": self.key_file, "registry_path": self.registry,
            "state_dir": os.path.join(self.tmp, "state"), "queues": [{"queue": QUEUE, "repo": REPO}],
            "model_mid": "sonnet", "model_top": "opus", "claude_path": self.claude,
            "claude_oauth_token_file": self.oauth_file, "openssl_path": OPENSSL, "daily_cap_usd": 10,
            "claude_timeout_seconds": 30,
        }
        self.config_path = os.path.join(self.tmp, "config.json")
        self.popen_calls = []
        self.sockets = []
        self.sleeps = []
        self.stdout = ""
        self.stderr = ""
        self.repos = {}

    def _script(self, name, text):
        path = os.path.join(self.tmp, "bin", name)
        with open(path, "w") as h:
            h.write(text)
        os.chmod(path, 0o755)
        return path

    def set_registry(self, identities=None):
        identities = identities if identities is not None else [
            {"login": BOT, "vendor": "claude", "tier": "top"},
            {"login": "codex-lane[bot]", "vendor": "codex", "tier": "mid"},
            {"login": "grok-lane[bot]", "vendor": "grok", "tier": "mid"},
            {"login": "claude-lane[bot]", "vendor": "claude", "tier": "top"},
            {"login": "mrhinkle", "vendor": "human", "tier": "top"},
        ]
        with open(self.registry, "w") as h:
            json.dump({"identities": identities}, h)

    def scenario(self, steps):
        with open(os.path.join(self.tmp, "rec", "scenario.json"), "w") as h:
            json.dump(steps, h)

    # -- git ------------------------------------------------------------------
    def git_env(self):
        return {"PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": self.tmp, "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_GLOBAL": "/dev/null"}

    def make_repo(self, repo, number, *, extra_head_commit=False):
        """Bare repo at git/<repo>.git with main=base and refs/pull/<n>/head=head. Returns (base, head)."""
        env = self.git_env()
        src = os.path.join(self.tmp, "src", repo.replace("/", "_") + str(number))
        os.makedirs(src)
        run = lambda *a, cwd=src: subprocess.run(["git"] + list(a), cwd=cwd, env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip()
        run("init", "-q", "-b", "main")
        with open(os.path.join(src, "app.py"), "w") as h:
            h.write("print('base')\n")
        run("add", ".")
        run("commit", "-q", "-m", "base")
        base = run("rev-parse", "HEAD")
        with open(os.path.join(src, "app.py"), "a") as h:
            h.write("print('head')\n")
        run("commit", "-q", "-am", "head")
        head = run("rev-parse", "HEAD")
        bare = os.path.join(self.tmp, "git", repo + ".git")
        if not os.path.exists(bare):
            os.makedirs(os.path.dirname(bare), exist_ok=True)
            run("init", "-q", "--bare", bare, cwd=self.tmp)
            run("config", "uploadpack.allowAnySHA1InWant", "true", cwd=bare)
        run("push", "-q", bare, "main:refs/heads/main-%d" % number, "HEAD:refs/pull/%d/head" % number)
        if extra_head_commit:
            with open(os.path.join(src, "app.py"), "a") as h:
                h.write("print('moved')\n")
            run("commit", "-q", "-am", "moved")
            run("push", "-q", "-f", bare, "HEAD:refs/pull/%d/head" % number)
        return base, head

    def ready_pull(self, repo=REPO, number=5, *, queue=QUEUE, green_since=None, **pull_kwargs):
        base, head = self.make_repo(repo, number)
        self.fake.add_pull(repo, number, head, base, **pull_kwargs)
        rows = [r for r in self.fake.queue_rows if r["queue"] == queue]
        if rows:
            rows[0]["ready_items"].append(item(number, head, green_since))
        else:
            self.fake.queue_rows.append(row(queue, repo, [item(number, head, green_since)]))
        return base, head

    # -- run ------------------------------------------------------------------
    def run(self, *, platform="darwin", sandbox_exec=None, clock=None, raw_config=None, **overrides):
        config = dict(self.config)
        config.update(overrides)
        with open(self.config_path, "w") as h:
            h.write(raw_config if raw_config is not None else json.dumps(config))
        harness = self
        real_popen = subprocess.Popen
        real_connect = socket.socket.connect

        class RecordingPopen(real_popen):
            def __init__(self, args, *a, **kw):
                harness.popen_calls.append({"argv": list(args) if not isinstance(args, str) else [args],
                                            "env": kw.get("env"), "cwd": kw.get("cwd")})
                super().__init__(args, *a, **kw)

        def guarded_connect(sock, address):
            harness.sockets.append(address)
            host = address[0] if isinstance(address, tuple) else address
            if host not in ("127.0.0.1", "::1", "localhost"):
                raise AssertionError("non-loopback socket")
            return real_connect(sock, address)

        seams = dict(github_api=self.ak_url + "/gh", git_base="file://" + os.path.join(self.tmp, "git"),
                     platform=platform, sandbox_exec=sandbox_exec or self.sandbox,
                     tmp_root=os.path.join(self.tmp, "work"), sleep=self.sleeps.append,
                     environ={"PATH": os.path.join(self.tmp, "bin") + ":/usr/bin:/bin"})
        if clock is not None:
            seams["clock"] = clock
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(subprocess, "Popen", RecordingPopen), \
                mock.patch.object(socket.socket, "connect", guarded_connect), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cr.main(["--config", self.config_path], stdout=out, **seams)
        self.stdout += out.getvalue()
        self.stderr += err.getvalue()
        return code

    # -- observations -----------------------------------------------------------
    def receipts(self):
        return [e for e in self.fake.events if e and e.get("kind") == "status"]

    def receipt(self):
        receipts = self.receipts()
        self.test.assertEqual(len(receipts), 1, "exactly one receipt")
        return receipts[0]["detail"]

    def gh_requests(self):
        return [r for r in self.fake.requests if r["path"].startswith("/gh/")]

    def gh_writes(self):
        return [r for r in self.gh_requests() if r["method"] != "GET"]

    def review_posts(self):
        return [r for r in self.gh_requests() if r["method"] == "POST" and r["path"].endswith("/reviews")]

    def repo_writes(self):
        return [r for r in self.gh_writes() if r["path"].startswith("/gh/repos/")]

    def claude_calls(self):
        path = os.path.join(self.rec, "claude.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as h:
            return [json.loads(line) for line in h if line.strip()]

    def state(self, name):
        return ledger.read_jsonl(os.path.join(self.tmp, "state", name))

    def assert_guards(self):
        self.test.assertFalse(os.path.exists(os.path.join(self.rec, "gh-called")), "gh was invoked")
        for call in self.popen_calls:
            self.test.assertNotEqual(os.path.basename(call["argv"][0]), "gh")
            joined = "\x00".join(call["argv"])
            for secret in (INSTALL_TOKEN, AK_TOKEN, OAUTH_TOKEN) + tuple(self.fake.jwts):
                self.test.assertNotIn(secret, joined, "secret in argv")
        for address in self.sockets:
            self.test.assertIn(address[0], ("127.0.0.1", "::1", "localhost"))


# ---------------------------------------------------------------------------------------------
# Runner end to end against the stubs
# ---------------------------------------------------------------------------------------------
class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness(self)

    def test_disabled_opens_no_secret_and_no_socket(self):
        opened = []
        real_open = open

        def tracking_open(file, *a, **kw):
            opened.append(os.path.realpath(file) if isinstance(file, str) else file)
            return real_open(file, *a, **kw)

        with mock.patch("builtins.open", tracking_open):
            code = self.h.run(enabled=False)
        self.assertEqual(code, 0)
        self.assertTrue(opened)
        self.assertEqual(set(opened), {os.path.realpath(self.h.config_path)}, "only the config file is opened")
        self.assertEqual(self.h.fake.requests, [])
        self.assertEqual(self.h.sockets, [])
        self.assertEqual(self.h.popen_calls, [])
        self.assertEqual(os.listdir(os.path.join(self.h.tmp, "state")), [])

    def test_invalid_config_exit_2(self):
        self.assertEqual(self.h.run(raw_config='{"enabled": true}'), 2)
        self.assertEqual(self.h.fake.requests, [])

    def test_dry_run_happy_path(self):
        green = iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5))
        base, head = self.h.ready_pull(green_since=green)
        code = self.h.run()
        self.assertEqual(code, 0, self.h.stderr)
        self.h.assert_guards()
        # AC 78: zero repository writes and zero review POSTs; the token mint is the only GitHub POST.
        self.assertEqual(self.h.review_posts(), [])
        self.assertEqual(self.h.repo_writes(), [])
        self.assertEqual([r["path"] for r in self.h.gh_writes()], ["/gh/app/installations/7/access_tokens"])
        calls = self.h.claude_calls()
        self.assertEqual(len(calls), 1)
        call = calls[0]
        # AC 86: exact argv (after the sandbox stub dropped `sandbox-exec -p <profile>`).
        self.assertEqual(call["argv"][0], self.h.claude)
        self.assertEqual(call["argv"], cr.claude_argv(self.h.claude, "sonnet"))
        self.assertEqual(call["argv"][1:], [
            "-p", "--output-format", "json", "--model", "sonnet", "--permission-mode", "plan", "--strict-mcp-config",
            "--mcp-config", '{"mcpServers":{}}', "--allowedTools", "Read", "Grep", "Glob", "Bash(git log:*)",
            "Bash(git diff:*)", "Bash(git show:*)", "Bash(git blame:*)", "Bash(git ls-files:*)", "Bash(ls:*)",
            "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Bash(gh:*)",
            "Bash(curl:*)", "Bash(wget:*)", "Bash(git push:*)", "Bash(git commit:*)", "Bash(git reset:*)",
            "Bash(git checkout:*)", "Bash(rm:*)"])
        allowed = call["argv"][call["argv"].index("--allowedTools") + 1: call["argv"].index("--disallowedTools")]
        for denied in ("Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent"):
            self.assertNotIn(denied, allowed)
        self.assertFalse(any("gh" in a or "push" in a or "curl" in a for a in allowed))
        # AC 107: argv prefix through sandbox-exec, with the rendered profile.
        sandboxed = [c for c in self.h.popen_calls if c["argv"][0] == self.h.sandbox]
        self.assertEqual(len(sandboxed), 1)
        self.assertEqual(sandboxed[0]["argv"][1], "-p")
        self.assertEqual(sandboxed[0]["argv"][3:], call["argv"])
        profile = sandboxed[0]["argv"][2]
        self.assertNotRegex(profile, r"@[A-Z_]+@")
        self.assertIn('(subpath "%s")' % os.path.realpath(call["cwd"]), profile)
        self.assertIn('(subpath "/Users")', profile)
        # AC 8/108: env and cwd.
        env = call["env"]
        for absent in ("GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "MC_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK"):
            self.assertNotIn(absent, env)
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], OAUTH_TOKEN)
        self.assertNotIn(INSTALL_TOKEN, json.dumps(env))
        self.assertNotIn(AK_TOKEN, json.dumps(env))
        self.assertTrue(env["HOME"].startswith(os.path.join(self.h.tmp, "work")))
        self.assertTrue(env["CLAUDE_CONFIG_DIR"].startswith(env["HOME"]))
        self.assertTrue(call["cwd"].startswith(os.path.join(self.h.tmp, "work")))
        self.assertEqual(call["head"], head)  # detached at the exact head
        self.assertIn("git diff %s...%s" % (base, head), call["stdin"])
        self.assertIn("Lenses (review each one): " + ", ".join(LENSES6), call["stdin"])
        # Clone deleted afterwards (AC 8).
        self.assertEqual(os.listdir(os.path.join(self.h.tmp, "work")), [])
        # Would-be record and body (AC 15, 93).
        would = self.h.state("would-be.jsonl")
        self.assertEqual(len(would), 1)
        self.assertEqual({k: would[0][k] for k in ("repo", "number", "head_sha", "app_login", "provenance", "phase", "tier")},
                         {"repo": REPO, "number": 5, "head_sha": head, "app_login": BOT, "provenance": ["codex"],
                          "phase": "dry-run", "tier": "B"})
        self.assertGreaterEqual(would[0]["waited_minutes"], 299)
        body_path = os.path.join(self.h.tmp, "state", "would-be", "mrhinkle__conference-os-5-%s.md" % head)
        with open(body_path) as h:
            body = h.read()
        self.assertTrue(body.startswith("<!-- review-evidence:v1\nhead-sha: %s\nresult: pass\n-->" % head))
        self.assertTrue(body.rstrip("\n").endswith("VERDICT: APPROVE"))
        self.assertEqual(self.h.state("reviews.jsonl"), [])
        # Receipt (AC 14, 31, 104).
        detail = self.h.receipt()
        self.assertEqual(detail["ready"], 1)
        self.assertEqual(detail["reviewed"], 1)
        self.assertEqual(detail["posted"], 0)
        self.assertEqual(detail["spend_microusd_today"], 250000)
        self.assertGreaterEqual(detail["oldest_ready_minutes"], 299)
        self.assertEqual(detail["sla_breaches"], 1)
        for key, value in detail.items():
            if key in ("scheduled_at", "started_at"):
                self.assertRegex(value, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$" if key == "scheduled_at" else r"Z$")
            else:
                self.assertIs(type(value), int, key)
                self.assertGreaterEqual(value, 0)
        self.assertEqual(int(detail["scheduled_at"][14:16]) % 15, 0)
        receipt = self.h.receipts()[0]
        self.assertEqual((receipt["agent_id"], receipt["kind"]), ("claude-reviewer", "status"))
        ingest = [r for r in self.h.fake.requests if r["path"] == "/api/ingest"]
        self.assertTrue(all(r["auth"] == "Bearer " + AK_TOKEN for r in ingest))
        self.assertEqual(self.h.state("receipts.jsonl")[0]["receipt_http_status"], 200)
        # Second dry-run at the same head does not re-invoke Claude.
        self.h.fake.events.clear()
        self.assertEqual(self.h.run(), 0)
        self.assertEqual(len(self.h.claude_calls()), 1)
        self.assertEqual(self.h.receipt()["already_reviewed"], 1)

    def test_credentials_per_endpoint(self):
        self.h.ready_pull(number=5)
        self.h.config["mode"] = "live"
        self.assertEqual(self.h.run(), 0, self.h.stderr)
        jwt_paths = set()
        for request in self.h.gh_requests():
            bearer = request["auth"][len("Bearer "):]
            self.assertTrue(request["auth"].startswith("Bearer "))
            self.assertEqual(request["headers"].get("x-github-api-version"), "2022-11-28")
            if bearer == INSTALL_TOKEN:
                continue
            self.assertEqual(bearer.count("."), 2)
            jwt_paths.add((request["method"], request["path"]))
        self.assertEqual(jwt_paths, {("GET", "/gh/app"), ("GET", "/gh/repos/mrhinkle/conference-os/installation"),
                                     ("POST", "/gh/app/installations/7/access_tokens")})
        install_paths = {(r["method"], r["path"].split("?")[0]) for r in self.h.gh_requests()
                         if r["auth"] == "Bearer " + INSTALL_TOKEN}
        self.assertIn(("POST", "/gh/repos/mrhinkle/conference-os/pulls/5/reviews"), install_paths)
        self.assertIn(("GET", "/gh/repos/mrhinkle/conference-os/pulls/5/commits"), install_paths)
        # AC 36: git got the token only through environment-scoped config.
        fetches = [c for c in self.h.popen_calls if c["argv"][:2] == ["git", "fetch"]]
        self.assertEqual(len(fetches), 1)
        env = fetches[0]["env"]
        self.assertEqual(env["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(env["GIT_TERMINAL_PROMPT"], "0")
        keys = {env["GIT_CONFIG_KEY_%d" % i]: env["GIT_CONFIG_VALUE_%d" % i] for i in range(int(env["GIT_CONFIG_COUNT"]))}
        self.assertEqual(keys["credential.helper"], "")
        self.assertEqual(keys["http.extraHeader"], rgithub.basic_auth_header(INSTALL_TOKEN))
        for name in ("GIT_ASKPASS", "GIT_SSH_COMMAND", "HTTPS_PROXY", "https_proxy", "GH_TOKEN", "GITHUB_TOKEN"):
            self.assertNotIn(name, env)
        config_files = []
        for dirpath, _, files in os.walk(self.h.tmp):
            config_files += [os.path.join(dirpath, f) for f in files if f == "config" and ".git" in dirpath]
        for path in config_files:
            with open(path, errors="replace") as h:
                self.assertNotIn(INSTALL_TOKEN, h.read())
        self.h.assert_guards()

    def test_live_posts_comment_review_and_ledger(self):
        green = iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=30))
        _, head = self.h.ready_pull(green_since=green, labels=["tier:A"])
        self.h.config["mode"] = "live"
        self.assertEqual(self.h.run(), 0, self.h.stderr)
        posts = self.h.review_posts()
        self.assertEqual(len(posts), 1)
        body = posts[0]["body"]
        self.assertEqual(set(body), {"commit_id", "body", "event"})
        self.assertEqual(body["event"], "COMMENT")
        self.assertEqual(body["commit_id"], head)
        self.assertIn("Reviewer: %s (vendor claude)" % BOT, body["body"])
        self.assertIn("Tier: A", body["body"])
        lines = self.h.state("reviews.jsonl")
        self.assertEqual(len(lines), 1)
        self.assertEqual(set(lines[0]), {"repo", "number", "head_sha", "tier", "green_since", "posted_at",
                                         "waited_minutes", "app_login", "provenance", "phase", "scheduled_at"})
        self.assertEqual(lines[0]["phase"], "live")
        self.assertIs(type(lines[0]["waited_minutes"]), int)
        self.assertIn(lines[0]["waited_minutes"], (29, 30, 31))
        detail = self.h.receipt()
        self.assertEqual((detail["posted"], detail["reviewed"], detail["tier_c_partial"], detail["sla_breaches"]), (1, 1, 0, 0))
        self.h.assert_guards()

    def test_tier_c_uses_top_model_adversarial_and_partial(self):
        _, head = self.h.ready_pull(labels=["Tier:C"])
        self.h.scenario([{"stdout": envelope(good_result(LENSES6 + ("adversarial",)))}])
        self.h.config["mode"] = "live"
        self.assertEqual(self.h.run(), 0)
        call = self.h.claude_calls()[0]
        self.assertEqual(call["argv"][call["argv"].index("--model") + 1], "opus")
        body = self.h.review_posts()[0]["body"]["body"]
        self.assertIn("- adversarial: cleared", body)
        detail = self.h.receipt()
        self.assertEqual((detail["posted"], detail["tier_c_partial"]), (1, 1))

    def test_tier_c_needs_top_tier_identity(self):
        self.h.set_registry([{"login": BOT, "vendor": "claude", "tier": "mid"},
                             {"login": "codex-lane[bot]", "vendor": "codex", "tier": "mid"}])
        self.h.ready_pull(labels=["tier:c"])
        self.h.config["mode"] = "live"
        self.assertEqual(self.h.run(), 0)
        self.assertEqual(self.h.review_posts(), [])
        self.assertEqual(self.h.claude_calls(), [])
        self.assertEqual(self.h.receipt()["invalid_input"], 1)

    def test_two_tier_labels_invalid_input(self):
        self.h.ready_pull(labels=["tier:a", "tier:b"])
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.receipt()["invalid_input"], 1)
        self.assertEqual(self.h.claude_calls(), [])

    def test_identity_not_registered_as_claude_exits_78(self):
        self.h.set_registry([{"login": BOT, "vendor": "codex", "tier": "top"}])
        self.h.ready_pull()
        self.assertEqual(self.h.run(mode="live"), 78)
        self.assertEqual(self.h.gh_writes(), [], "zero GitHub HTTP writes, not even a token mint")
        self.assertEqual([r["path"] for r in self.h.gh_requests()], ["/gh/app"])
        self.assertEqual([e["kind"] for e in self.h.fake.events], ["error", "status"])
        self.assertEqual(self.h.claude_calls(), [])
        self.h.assert_guards()
        self.h.set_registry([])
        self.h.fake.events.clear()
        self.assertEqual(self.h.run(mode="live"), 78)

    def test_app_endpoint_failures_exit_78(self):
        for status, payload, counter in ((401, {}, "token_revoked"), (500, {}, "github_error"), (200, {"name": "x"}, "github_error"),
                                         (200, {"slug": "bad slug!"}, "github_error"), (302, {}, "github_error")):
            with self.subTest(status=status, payload=payload):
                h = Harness(self)
                h.ready_pull()
                h.fake.app = (status, payload)
                self.assertEqual(h.run(mode="live"), 78)
                self.assertEqual(h.gh_writes(), [])
                self.assertEqual(h.receipt()[counter], 1)

    def test_same_vendor_produces_zero_github_writes(self):
        commits = [commit("grok-lane[bot]", "x\n\nAgent-Vendor: grok"), commit("claude-lane[bot]", "y\n\nAgent-Vendor: claude")]
        self.h.ready_pull(commits=commits)
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.repo_writes(), [])
        self.assertEqual(self.h.review_posts(), [])
        self.assertEqual(self.h.claude_calls(), [])
        self.assertEqual(self.h.receipt()["same_vendor"], 1)
        self.h.assert_guards()

    def test_provenance_unknown_cases(self):
        cases = {
            "unregistered": [commit("stranger", "x")],
            "null author": [commit(None, "x\n\nAgent-Vendor: codex")],
            "contradictory": [commit("codex-lane[bot]", "x\nAgent-Vendor: codex\nAgent-Vendor: grok")],
        }
        for name, commits in cases.items():
            with self.subTest(name=name):
                h = Harness(self)
                h.ready_pull(commits=commits)
                self.assertEqual(h.run(mode="live"), 0)
                self.assertEqual(h.receipt()["provenance_unknown"], 1)
                self.assertEqual(h.review_posts(), [])
                self.assertEqual(h.claude_calls(), [])

    def test_owner_untrailed_registered_human_is_eligible(self):
        self.h.ready_pull(commits=[commit("mrhinkle", "owner fix")])
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.receipt()["posted"], 1)
        self.assertEqual(self.h.state("reviews.jsonl")[0]["provenance"], ["human"])

    def test_commit_pagination_and_cap(self):
        many = [commit("codex-lane[bot]", "c%d" % i) for i in range(149)] + [commit("claude-lane[bot]", "last")]
        self.h.ready_pull(commits=many)
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.receipt()["same_vendor"], 1)
        pages = [r["query"] for r in self.h.gh_requests() if r["path"].endswith("/commits")]
        self.assertEqual(pages, ["per_page=100&page=1", "per_page=100&page=2"])
        h = Harness(self)
        h.ready_pull(commits=[commit("codex-lane[bot]", "c")])
        h.fake.pulls[(REPO, 5)][0]["commits"] = 250
        self.assertEqual(h.run(mode="live"), 0)
        self.assertEqual(h.receipt()["provenance_unknown"], 1)
        self.assertFalse([r for r in h.gh_requests() if r["path"].endswith("/commits")])
        h2 = Harness(self)
        h2.ready_pull()
        h2.fake.overrides[("GET", "/gh/repos/mrhinkle/conference-os/pulls/5/commits")] = (500, {}, {})
        self.assertEqual(h2.run(mode="live"), 0)
        self.assertEqual(h2.receipt()["provenance_unknown"], 1)

    def test_queue_rows_unusable_are_queue_unknown_without_github_reads(self):
        sha = "c" * 40
        cases = {
            "missing": [],
            "incomplete": [row(QUEUE, REPO, [item(5, sha)], complete=False)],
            "stale": [row(QUEUE, REPO, [item(5, sha)], stale=True)],
            "null ready_items": [row(QUEUE, REPO, [], ready_items=None)],
            "null repo": [row(QUEUE, None, [item(5, sha)])],
            "other repo": [row(QUEUE, "mrhinkle/other", [item(5, sha)])],
            "bad sha": [row(QUEUE, REPO, [item(5, "C" * 40)])],
            "duplicate rows": [row(QUEUE, REPO, [item(5, sha)]), row(QUEUE, REPO, [item(5, sha)])],
        }
        for name, rows in cases.items():
            with self.subTest(name=name):
                h = Harness(self)
                h.fake.queue_rows = rows
                self.assertEqual(h.run(mode="live"), 0)
                detail = h.receipt()
                self.assertEqual((detail["queue_unknown"], detail["ready"]), (1, 0))
                self.assertEqual([r["path"] for r in h.gh_requests()], ["/gh/app"], "no GitHub read from the row")
        h = Harness(self)
        h.fake.queue_rows = [row(QUEUE, "MRHINKLE/Conference-OS", [])]
        self.assertEqual(h.run(), 0)
        self.assertEqual(h.receipt()["queue_unknown"], 0)

    def test_order_and_dedup(self):
        now = dt.datetime.now(dt.timezone.utc)
        self.h.config["queues"] = [{"queue": QUEUE, "repo": REPO}, {"queue": "conference-os/second", "repo": REPO}]
        self.h.ready_pull(number=10, green_since=None)
        self.h.ready_pull(number=3, green_since=None)
        self.h.ready_pull(number=7, green_since=iso(now - dt.timedelta(hours=1)))
        self.h.ready_pull(number=8, green_since=iso(now - dt.timedelta(hours=3)))
        self.h.ready_pull(number=9, green_since=iso(now - dt.timedelta(minutes=5)), labels=["tier:c"])
        first = self.h.fake.queue_rows[0]
        self.h.fake.queue_rows.append(row("conference-os/second", REPO, [dict(first["ready_items"][0])]))
        self.h.scenario([{"stdout": envelope(good_result(LENSES6 + ("adversarial",)))},
                         {"stdout": envelope(good_result())}])
        self.assertEqual(self.h.run(), 0)
        order = [int(c["stdin"].split("Pull request: #")[1].split("\n")[0]) for c in self.h.claude_calls()]
        self.assertEqual(order, [9, 8, 7, 3, 10])
        self.assertEqual(self.h.receipt()["ready"], 5)

    def test_head_moved_and_not_ready_rereads(self):
        # Pre-clone: closed, draft, moved.
        for name, mutate, counter in (("closed", {"state": "closed"}, "not_ready"), ("draft", {"draft": True}, "not_ready"),
                                      ("moved", {"head": {"sha": "d" * 40}}, "head_moved")):
            with self.subTest(stage="first read", name=name):
                h = Harness(self)
                h.ready_pull()
                h.fake.pulls[(REPO, 5)][0].update(mutate)
                self.assertEqual(h.run(mode="live"), 0)
                self.assertEqual(h.receipt()[counter], 1)
                self.assertEqual(h.claude_calls(), [])
        # Pre-post: the head moves while Claude runs (reads: tier, pre-clone, pre-post).
        for name, mutate, counter in (("moved", {"head": {"sha": "d" * 40}}, "head_moved"), ("closed", {"state": "closed"}, "not_ready")):
            with self.subTest(stage="pre-post", name=name):
                h = Harness(self)
                h.ready_pull()
                original = h.fake.pulls[(REPO, 5)][0]
                later = json.loads(json.dumps(original))
                later.update(mutate)
                h.fake.pulls[(REPO, 5)] = [original, json.loads(json.dumps(original)), later]
                self.assertEqual(h.run(mode="live"), 0)
                self.assertEqual(len(h.claude_calls()), 1)
                self.assertEqual(h.review_posts(), [])
                self.assertEqual(h.receipt()[counter], 1)

    def test_fetched_head_mismatch_is_head_moved(self):
        base, head = self.h.make_repo(REPO, 5, extra_head_commit=True)
        self.h.fake.add_pull(REPO, 5, head, base)
        self.h.fake.queue_rows = [row(QUEUE, REPO, [item(5, head)])]
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.receipt()["head_moved"], 1)
        self.assertEqual(self.h.claude_calls(), [])

    def test_already_reviewed_paginated_and_reconciled(self):
        _, head = self.h.ready_pull()
        other = [{"user": {"login": "someone"}, "state": "COMMENTED", "commit_id": head, "submitted_at": "2026-11-20T00:00:00Z"}] * 100
        pending = {"user": {"login": BOT}, "state": "PENDING", "commit_id": head}
        old_head = {"user": {"login": BOT}, "state": "COMMENTED", "commit_id": "e" * 40, "submitted_at": "2026-11-20T00:00:00Z"}
        self.h.fake.reviews[(REPO, 5)] = other + [pending, old_head]
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.receipt()["posted"], 1, "PENDING and older-head reviews do not suppress")
        h = Harness(self)
        _, head = h.ready_pull()
        mine = {"user": {"login": "AIE-Claude-Reviewer[bot]"}, "state": "CHANGES_REQUESTED", "commit_id": head,
                "submitted_at": "2026-11-21T10:00:00Z"}
        h.fake.reviews[(REPO, 5)] = other + [mine]
        self.assertEqual(h.run(mode="live"), 0)
        self.assertEqual(h.receipt()["already_reviewed"], 1)
        self.assertEqual(h.claude_calls(), [])
        pages = [r["query"] for r in h.gh_requests() if r["path"].endswith("/reviews") and r["method"] == "GET"]
        self.assertEqual(pages, ["per_page=100&page=1", "per_page=100&page=2"])
        lines = h.state("reviews.jsonl")
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0]["reconciled"])
        self.assertEqual(lines[0]["posted_at"], "2026-11-21T10:00:00Z")
        h.fake.events.clear()
        self.assertEqual(h.run(mode="live"), 0)
        self.assertEqual(len(h.state("reviews.jsonl")), 1, "no second reconciled line")

    def test_invalid_output_twice_escalates(self):
        self.h.ready_pull()
        self.h.scenario([{"stdout": envelope("I think it looks fine!", cost="0.2")}])
        for expected in ("invalid_output", "invalid_output", "escalate"):
            self.h.fake.events.clear()
            self.assertEqual(self.h.run(mode="live"), 0)
            self.assertEqual(self.h.receipt()[expected], 1, expected)
        self.assertEqual(len(self.h.claude_calls()), 2, "Claude not invoked after the second invalid result")
        self.assertEqual(self.h.review_posts(), [])
        self.assertEqual(self.h.receipt()["spend_microusd_today"], 400000, "invalid outputs are still charged")

    def test_invalid_cost_halts_the_day(self):
        self.h.ready_pull(number=5)
        self.h.ready_pull(number=6)
        self.h.scenario([{"stdout": envelope(good_result(), cost="-1")}])
        self.assertEqual(self.h.run(mode="live"), 0)
        detail = self.h.receipt()
        self.assertEqual((detail["invalid_cost"], detail["budget_stop"], detail["posted"]), (1, 1, 0))
        self.assertEqual(len(self.h.claude_calls()), 1)
        self.assertEqual(self.h.review_posts(), [])

    def test_budget_cap_and_max_reviews(self):
        for n in (5, 6, 7):
            self.h.ready_pull(number=n)
        self.h.scenario([{"stdout": envelope(good_result(), cost="0.6")}])
        # Cap 2.0: first review estimate $1.00 → spend 0.6; second: 0.6+1.0 ≤ 2.0 → 1.2; third: 1.2+1.0 > 2.0 → stop.
        self.assertEqual(self.h.run(mode="live", daily_cap_usd=2), 0)
        detail = self.h.receipt()
        self.assertEqual((detail["posted"], detail["budget_stop"], detail["spend_microusd_today"]), (2, 1, 1200000))
        h = Harness(self)
        for n in (5, 6):
            h.ready_pull(number=n)
        self.assertEqual(h.run(mode="live", daily_max_reviews=1), 0)
        self.assertEqual((h.receipt()["posted"], h.receipt()["budget_stop"]), (1, 1))
        h0 = Harness(self)
        h0.ready_pull()
        self.assertEqual(h0.run(mode="live", daily_cap_usd=0), 0)
        self.assertEqual((h0.receipt()["budget_stop"], len(h0.claude_calls())), (1, 0))

    def test_process_failures(self):
        cases = {
            "nonzero exit": ([{"stdout": envelope(good_result()), "exit": 1}], "invalid_output"),
            "timeout": ([{"sleep": 5}], "invalid_output"),
            "is_error": ([{"stdout": envelope(good_result(), is_error=True)}], "invalid_output"),
            "malformed envelope": ([{"stdout": "garbage"}], "invalid_output"),
        }
        for name, (steps, counter) in cases.items():
            with self.subTest(name=name):
                h = Harness(self)
                h.ready_pull()
                h.scenario(steps)
                self.assertEqual(h.run(mode="live", claude_timeout_seconds=1), 0)
                self.assertEqual(h.receipt()[counter], 1)
                self.assertEqual(h.review_posts(), [])
                self.assertEqual(h.state("reviews.jsonl"), [])
        h = Harness(self)
        h.ready_pull(number=5)
        h.ready_pull(number=6)
        self.assertEqual(h.run(mode="live", claude_path=os.path.join(h.tmp, "bin", "missing-claude")), 0)
        self.assertEqual(h.receipt()["not_installed"], 2)
        self.assertEqual(h.claude_calls(), [])
        self.assertEqual(h.review_posts(), [])

    def test_size_limits_escalate(self):
        self.h.ready_pull(additions=4000, deletions=1001)
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.receipt()["escalate"], 1)
        self.assertFalse([c for c in self.h.popen_calls if c["argv"][:2] == ["git", "fetch"]], "diff limit checked before clone")
        h = Harness(self)
        h.ready_pull(additions=None)
        self.assertEqual(h.run(mode="live"), 0)
        self.assertEqual(h.receipt()["escalate"], 1)
        h2 = Harness(self)
        h2.ready_pull()
        self.assertEqual(h2.run(mode="live", max_clone_bytes=1), 0)
        self.assertEqual(h2.receipt()["escalate"], 1)
        self.assertEqual(h2.claude_calls(), [])

    def test_failure_table(self):
        inst = ("GET", "/gh/repos/mrhinkle/conference-os/installation")
        mint = ("POST", "/gh/app/installations/7/access_tokens")
        pull = ("GET", "/gh/repos/mrhinkle/conference-os/pulls/5")
        reviews = ("GET", "/gh/repos/mrhinkle/conference-os/pulls/5/reviews")
        post = ("POST", "/gh/repos/mrhinkle/conference-os/pulls/5/reviews")
        rate = {"Retry-After": "1"}
        table = [
            (inst, 404, {}, "not_installed"), (inst, 401, {}, "token_revoked"), (inst, 403, {}, "missing_permission"),
            (inst, 429, {}, "rate_limit"), (inst, 500, {}, "github_error"),
            (mint, 401, {}, "token_revoked"), (mint, 403, {}, "token_revoked"), (mint, 404, {}, "token_revoked"),
            (mint, 429, {}, "rate_limit"), (mint, 500, {}, "github_error"),
            (pull, 401, {}, "token_revoked"), (pull, 403, {}, "missing_permission"), (pull, 404, {}, "not_ready"),
            (pull, 429, rate, "rate_limit"), (pull, 500, {}, "github_error"), (pull, 301, {"Location": "http://example.invalid/"}, "github_error"),
            (reviews, 401, {}, "token_revoked"), (reviews, 403, {}, "missing_permission"), (reviews, 404, {}, "missing_permission"),
            (reviews, 429, {}, "rate_limit"), (reviews, 502, {}, "github_error"),
            (post, 401, {}, "token_revoked"), (post, 403, {}, "missing_permission"), (post, 404, {}, "not_installed"),
            (post, 422, {}, "github_error"), (post, 429, {}, "rate_limit"),
        ]
        for key, status, headers, counter in table:
            with self.subTest(endpoint=key, status=status):
                h = Harness(self)
                h.ready_pull()
                h.ready_pull(repo=REPO2, number=2, queue=QUEUE2)
                h.config["queues"] = [{"queue": QUEUE, "repo": REPO}, {"queue": QUEUE2, "repo": REPO2}]
                h.fake.overrides[key] = (status, {"message": "x"}, headers)
                self.assertEqual(h.run(mode="live"), 0, h.stderr)
                detail = h.receipt()
                self.assertEqual(detail[counter], 1, (key, status, detail))
                outcomes = [o for o in h.state("outcomes.jsonl") if o["repo"] == REPO]
                self.assertEqual([o["outcome"] for o in outcomes], [counter])
                self.assertEqual([p["repo"] for p in h.fake.posted], [REPO2], "independent queue continues")
                if key != post:
                    self.assertFalse([p for p in h.fake.posted if p["repo"] == REPO])
        # Retry-After honoured exactly once, then success.
        h = Harness(self)
        h.ready_pull()
        h.fake.overrides[pull] = [(429, {"message": "slow"}, rate), None]
        self.assertEqual(h.run(mode="live"), 0)
        self.assertEqual(h.sleeps, [1])
        self.assertEqual(h.receipt()["posted"], 1)
        self.assertEqual(len([r for r in h.gh_requests() if r["path"] == pull[1]]), 4, "429, retry, pre-clone, pre-post")

    def test_clone_failure_classified(self):
        self.h.ready_pull()
        shutil.rmtree(os.path.join(self.h.tmp, "git", REPO + ".git"))
        self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.receipt()["github_error"], 1)
        self.assertEqual(self.h.claude_calls(), [])
        self.assertEqual(cr.Runner._fetch_outcome(b"fatal: unable to access 'x': The requested URL returned error: 403"), "missing_permission")
        self.assertEqual(cr.Runner._fetch_outcome(b"The requested URL returned error: 401"), "token_revoked")
        self.assertEqual(cr.Runner._fetch_outcome(b"The requested URL returned error: 429"), "rate_limit")

    def test_ak_preflight_failure(self):
        self.h.ready_pull()
        self.h.fake.queue_status = 500
        self.assertEqual(self.h.run(mode="live"), 1)
        self.assertEqual(self.h.gh_requests(), [], "no GitHub operation")
        self.assertEqual(len([r for r in self.h.fake.requests if r["path"] == "/api/ingest"]), 1, "one receipt attempt")
        with open(os.path.join(self.h.tmp, "state", "errors.log")) as h:
            self.assertEqual(len(h.read().splitlines()), 1)

    def test_ak_unreachable(self):
        self.h.ready_pull()
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        url = "http://127.0.0.1:%d" % port
        with open(self.h.cred_file, "w") as handle:
            handle.write("MC_URL=%s\nMC_TOKEN=%s\n" % (url, AK_TOKEN))
        self.assertEqual(self.h.run(mode="live", ak_url=url), 1)
        self.assertEqual(self.h.fake.requests, [])
        receipts = self.h.state("receipts.jsonl")
        self.assertEqual(len(receipts), 1)
        self.assertIsNone(receipts[0]["receipt_http_status"])
        with open(os.path.join(self.h.tmp, "state", "errors.log")) as h:
            self.assertEqual(len(h.read().splitlines()), 1)

    def test_overlapping_run_exits_zero_without_work(self):
        import fcntl
        self.h.ready_pull()
        os.makedirs(os.path.join(self.h.tmp, "state"), exist_ok=True)
        with open(os.path.join(self.h.tmp, "state", ".lock"), "a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            self.assertEqual(self.h.run(mode="live"), 0)
        self.assertEqual(self.h.fake.requests, [])

    def test_non_macos_refuses(self):
        self.h.ready_pull()
        self.assertEqual(self.h.run(mode="live", platform="linux"), 78)
        self.assertEqual(self.h.receipt()["not_installed"], 1)
        self.assertEqual(self.h.gh_requests(), [])
        self.assertEqual(self.h.run(mode="live", sandbox_exec="/nonexistent/sandbox-exec"), 78)

    def test_secret_scan(self):
        """AC 85/108: no secret in stdout, stderr, logs, receipts, state files or temp files."""
        self.h.ready_pull(number=5)
        self.h.ready_pull(number=6, commits=[commit("claude-lane[bot]", "x\n\nAgent-Vendor: claude")])
        self.h.ready_pull(number=7)
        self.h.scenario([{"stdout": envelope(good_result())}, {"stdout": "not json"}])
        self.assertEqual(self.h.run(mode="live"), 0)
        self.h.fake.events.clear()
        self.assertEqual(self.h.run(mode="dry-run"), 0)
        secrets = [INSTALL_TOKEN, AK_TOKEN, OAUTH_TOKEN] + key_secret_fragments() + sorted(self.h.fake.jwts)
        self.assertTrue(self.h.fake.jwts)
        haystacks = {"stdout": self.h.stdout, "stderr": self.h.stderr,
                     "receipts": json.dumps(self.h.fake.events), "receipt-posts": json.dumps(self.h.receipts())}
        excluded = {os.path.join(self.h.tmp, d) for d in ("secrets", "rec", "bin", "git", "src")}
        for dirpath, _, files in os.walk(self.h.tmp):
            if any(dirpath == e or dirpath.startswith(e + os.sep) for e in excluded):
                continue
            for name in files:
                path = os.path.join(dirpath, name)
                with open(path, "rb") as handle:
                    haystacks[path] = handle.read().decode("utf-8", "replace")
        self.assertTrue(any(k.endswith("reviews.jsonl") for k in haystacks))
        self.assertTrue(any(k.endswith("outcomes.jsonl") for k in haystacks))
        for name, text in haystacks.items():
            for secret in secrets:
                self.assertNotIn(secret, text, "secret found in %s" % name)
        self.assertEqual(os.listdir(os.path.join(self.h.tmp, "work")), [])
        self.h.assert_guards()

    def test_receipt_counters_capped_and_bounded(self):
        cfg = rconfig.load_config_text(json.dumps(dict(self.h.config)).encode())
        runner = cr.Runner(cfg, clock=lambda: dt.datetime(2026, 11, 23, 10, 44, 59, tzinfo=dt.timezone.utc))
        runner.counters["ready"] = 10 ** 9
        runner.counters["budget_stop"] = 3
        os.makedirs(cfg.state_dir, exist_ok=True)
        detail = runner.detail()
        self.assertEqual(detail["ready"], 100000)
        self.assertEqual(detail["budget_stop"], 1)
        self.assertEqual(detail["scheduled_at"], "2026-11-23T10:30:00Z")
        self.assertEqual(set(detail), set(cr.COUNTERS) | {"spend_microusd_today", "oldest_ready_minutes", "sla_breaches",
                                                          "scheduled_at", "started_at"})


@unittest.skipUnless(SANDBOX_DARWIN, "macOS-only: requires /usr/bin/sandbox-exec")
class SandboxReadBoundaryTests(unittest.TestCase):
    """AC 107: the shipped profile denies reads outside the clone/HOME/CLI roots."""

    def test_cat_inside_clone_succeeds_and_outside_fails(self):
        root = os.path.realpath(tempfile.mkdtemp(prefix="ak-reviewer-sbx-"))
        self.addCleanup(shutil.rmtree, root, True)
        clone, home, outside = (os.path.join(root, d) for d in ("clone", "home", "state"))
        for d in (clone, home, outside):
            os.makedirs(d)
        with open(os.path.join(clone, "inside.txt"), "w") as h:
            h.write("inside\n")
        with open(os.path.join(outside, "secret.txt"), "w") as h:
            h.write("secret\n")
        with open(cr.SANDBOX_PROFILE) as h:
            profile = cr.render_profile(h.read(), clone_dir=clone, home_dir=home, claude_dir="/bin", claude_real_dir="/bin")
        run = lambda path: subprocess.run(["/usr/bin/sandbox-exec", "-p", profile, "/bin/cat", path], cwd=clone,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={"PATH": "/usr/bin:/bin"})
        inside = run(os.path.join(clone, "inside.txt"))
        self.assertEqual((inside.returncode, inside.stdout), (0, b"inside\n"))
        denied = run(os.path.join(outside, "secret.txt"))
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(denied.stdout, b"")
        self.assertNotEqual(run(KEY_FILE).returncode, 0, "App key outside the roots is unreadable")
        listing = subprocess.run(["/usr/bin/sandbox-exec", "-p", profile, "/bin/ls", root], cwd=clone,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(listing.returncode, 0, "the parent directory listing stays denied")
        cwd = subprocess.run(["/usr/bin/sandbox-exec", "-p", profile, "/bin/pwd"], cwd=clone, stdout=subprocess.PIPE,
                             env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(cwd.stdout.decode().strip(), clone)




if __name__ == "__main__":
    unittest.main()
