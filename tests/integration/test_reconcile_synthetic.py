#!/usr/bin/env python3
"""Synthetic fixture reconciliation — always runs in CI.

Fixtures from scripts/make-fixtures.py. Known totals:
  paid   = 12.50
  shadow = 28.40
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / "agents" / "usage-collector" / "collect_usage.py"
FIXTURES = ROOT / "fixtures" / "hermes"
OUT = ROOT / ".data" / "synth-reconcile-facts.json"

PAID_EXPECTED = 12.50
SHADOW_EXPECTED = 28.40
TOLERANCE = 0.001  # exact synthetic math


class TestReconcileSynthetic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            sys.executable, str(COLLECTOR),
            "--dry-run",
            "--roots", str(FIXTURES),
            "--since", "2026-09-28",
            "--until", "2026-10-06",
            "--out", str(OUT),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"collector failed: {proc.stderr}\n{proc.stdout}")
        cls.payload = json.loads(OUT.read_text())
        cls.facts = cls.payload["facts"]

    def test_paid_exact(self):
        paid = sum(f["paid_cost_usd"] for f in self.facts)
        self.assertAlmostEqual(paid, PAID_EXPECTED, places=2)

    def test_shadow_exact(self):
        shadow = sum(f["shadow_cost_usd"] for f in self.facts)
        self.assertAlmostEqual(shadow, SHADOW_EXPECTED, places=2)

    def test_profiles_are_synthetic(self):
        profiles = {f["profile"] for f in self.facts}
        self.assertEqual(
            profiles,
            {"host/alpha", "host/beta", "host/gamma", "neuro/gateway", "neuro/sidecar"},
        )
        # Never ship real fleet profile names in fixtures
        for bad in ("carmack", "neuro/neuro-root", "einstein", "gatsby"):
            self.assertFalse(any(bad in p for p in profiles), bad)

    def test_provider_cases_covered(self):
        providers = {f["billing_provider"] for f in self.facts}
        self.assertIn("openai-codex", providers)
        self.assertIn("openrouter", providers)
        self.assertTrue(any("fallback_chain" in p for p in providers))
        self.assertIn("nous", providers)
        self.assertIn("custom", providers)

    def test_cron_name_resolved(self):
        named = [f for f in self.facts if f.get("cron_job_id") == "aa11bb22cc33"]
        self.assertTrue(named)
        self.assertEqual(named[0].get("cron_job_name"), "synthetic-velocity")

    def test_missing_task_column_profile(self):
        side = [f for f in self.facts if f["profile"] == "neuro/sidecar"]
        self.assertTrue(side)
        self.assertEqual(side[0].get("task") or "", "")

    def test_large_paid_session(self):
        big = [f for f in self.facts if f["session_id"] == "sess_gamma_paid_big"]
        self.assertTrue(big)
        self.assertGreater(big[0]["paid_cost_usd"], 4.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
