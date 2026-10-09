#!/usr/bin/env python3
"""Unit tests: pricing math, paid vs shadow, price table."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents" / "usage-collector"))

from prices import PRICE_VERSION, list_cost_usd, lookup
from pricing import classify_costs, is_codex_included


class TestPriceTable(unittest.TestCase):
    def test_sol_luna_deepseek_seeds(self):
        sol = lookup("gpt-5.6-sol")
        self.assertEqual(sol.input_per_mtok, 4.0)
        self.assertEqual(sol.output_per_mtok, 20.0)
        self.assertEqual(sol.cache_read_per_mtok, 0.40)
        luna = lookup("gpt-5.6-luna")
        self.assertEqual((luna.input_per_mtok, luna.output_per_mtok, luna.cache_read_per_mtok), (0.20, 1.20, 0.02))
        base = lookup("deepseek/deepseek-v4-pro")
        self.assertAlmostEqual(base.input_per_mtok, 0.2088)
        self.assertAlmostEqual(base.cache_read_per_mtok, 0.0174)
        hist = lookup("deepseek/deepseek-v4-pro-0813")
        self.assertEqual(hist.output_per_mtok, 5.0)
        self.assertEqual(hist.cache_read_per_mtok, 0.36)

    def test_aliases(self):
        self.assertEqual(lookup("openai/gpt-5.6-sol").model, "gpt-5.6-sol")
        self.assertEqual(lookup("openai/gpt-5.6-luna").model, "gpt-5.6-luna")

    def test_list_cost_math(self):
        # 1M input + 1M output + 1M cache on sol = 4+20+0.4 = 24.4
        c = list_cost_usd("gpt-5.6-sol", 1_000_000, 1_000_000, 1_000_000)
        self.assertAlmostEqual(c, 24.4)
        # luna small
        c = list_cost_usd("gpt-5.6-luna", 1_000_000, 0, 0)
        self.assertAlmostEqual(c, 0.20)


class TestClassify(unittest.TestCase):
    def test_codex_is_shadow(self):
        row = {
            "model": "gpt-5.6-sol",
            "billing_provider": "openai-codex",
            "billing_mode": "subscription_included",
            "cost_status": "included",
            "input_tokens": 1_000_000,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "estimated_cost_usd": 0.0,
        }
        self.assertTrue(is_codex_included(row))
        paid, shadow, ver = classify_costs(row)
        self.assertEqual(paid, 0.0)
        self.assertAlmostEqual(shadow, 4.0)
        self.assertEqual(ver, PRICE_VERSION)

    def test_openrouter_uses_estimated(self):
        row = {
            "model": "anthropic/claude-sonnet-5.5",
            "billing_provider": "openrouter",
            "billing_mode": "",
            "cost_status": "estimated",
            "input_tokens": 1000,
            "output_tokens": 100,
            "cache_read_tokens": 0,
            "estimated_cost_usd": 1.23,
            "actual_cost_usd": 0.0,
        }
        self.assertFalse(is_codex_included(row))
        paid, shadow, _ = classify_costs(row)
        self.assertAlmostEqual(paid, 1.23)
        self.assertEqual(shadow, 0.0)

    def test_openrouter_mis_tagged_subscription_still_paid(self):
        row = {
            "model": "anthropic/claude-sonnet-5.5",
            "billing_provider": "openrouter",
            "billing_mode": "subscription_included",
            "cost_status": "estimated",
            "input_tokens": 10,
            "output_tokens": 10,
            "cache_read_tokens": 0,
            "estimated_cost_usd": 0.5,
        }
        self.assertFalse(is_codex_included(row))
        paid, shadow, _ = classify_costs(row)
        self.assertAlmostEqual(paid, 0.5)
        self.assertEqual(shadow, 0.0)


if __name__ == "__main__":
    unittest.main()
