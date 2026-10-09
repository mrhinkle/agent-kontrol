#!/usr/bin/env python3
"""Optional reconciliation against REAL Hermes DBs (never in CI).

Set MC_HERMES_FIXTURE_ROOT to a directory with host/ and neuro/ slim state DBs
copied privately (not committed). Skipped when unset.

  MC_HERMES_FIXTURE_ROOT=/path/to/private/hermes-slim \\
    python3 -m unittest tests.integration.test_reconcile_real -v
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLLECTOR = ROOT / "agents" / "usage-collector" / "collect_usage.py"
OUT = ROOT / ".data" / "real-reconcile-facts.json"

PAID_TARGET = 53.62
SHADOW_TARGET = 618.85
TOLERANCE = 0.05


@unittest.skipUnless(
    os.environ.get("MC_HERMES_FIXTURE_ROOT"),
    "set MC_HERMES_FIXTURE_ROOT to run real-data reconcile (skipped in CI)",
)
class TestReconcileReal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures = Path(os.environ["MC_HERMES_FIXTURE_ROOT"])
        OUT.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            sys.executable, str(COLLECTOR),
            "--dry-run",
            "--roots", str(fixtures),
            "--since", "2026-09-28",
            "--until", "2026-10-06",
            "--out", str(OUT),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"collector failed: {proc.stderr}\n{proc.stdout}")
        cls.facts = json.loads(OUT.read_text())["facts"]

    def test_paid_within_5pct(self):
        paid = sum(f["paid_cost_usd"] for f in self.facts)
        delta = abs(paid - PAID_TARGET) / PAID_TARGET
        self.assertLessEqual(delta, TOLERANCE, f"paid {paid:.4f} vs {PAID_TARGET}")

    def test_shadow_within_5pct(self):
        shadow = sum(f["shadow_cost_usd"] for f in self.facts)
        delta = abs(shadow - SHADOW_TARGET) / SHADOW_TARGET
        self.assertLessEqual(delta, TOLERANCE, f"shadow {shadow:.4f} vs {SHADOW_TARGET}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
