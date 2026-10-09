#!/usr/bin/env python3
"""Idempotent key stability for hermes usage rows."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents" / "usage-collector"))
from collect_usage import row_to_fact


def key(fact):
    return "|".join([
        fact["source"], fact["account_id"], fact.get("profile") or "",
        fact.get("session_id") or "", fact["model"],
        fact.get("billing_provider") or "", fact.get("billing_mode") or "",
        fact.get("task") or "",
    ])


class TestIdempotency(unittest.TestCase):
    def test_same_row_same_key(self):
        row = {
            "session_id": "cron_276f85f1aa52_20261002_132350",
            "model": "gpt-5.6-sol",
            "billing_provider": "openai-codex",
            "billing_mode": "subscription_included",
            "task": "",
            "api_call_count": 2,
            "input_tokens": 100,
            "output_tokens": 10,
            "cache_read_tokens": 50,
            "cache_write_tokens": 0,
            "reasoning_tokens": 0,
            "estimated_cost_usd": 0,
            "actual_cost_usd": 0,
            "cost_status": "included",
            "first_seen": 1790553600.0,
            "last_seen": 1790553700.0,
            "billing_base_url": "",
            "cost_source": "none",
        }
        a = row_to_fact("host/alpha", row)
        b = row_to_fact("host/alpha", {**row, "api_call_count": 99, "input_tokens": 999})
        self.assertEqual(key(a), key(b))
        self.assertEqual(a["cron_job_id"], "276f85f1aa52")

    def test_task_distinguishes(self):
        base = {
            "session_id": "s1", "model": "gpt-5.6-sol",
            "billing_provider": "openai-codex", "billing_mode": "subscription_included",
            "api_call_count": 1, "input_tokens": 1, "output_tokens": 1,
            "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0,
            "estimated_cost_usd": 0, "actual_cost_usd": 0, "cost_status": "included",
            "first_seen": 1.0, "last_seen": 1.0, "billing_base_url": "", "cost_source": "",
        }
        a = row_to_fact("host/x", {**base, "task": "approval"})
        b = row_to_fact("host/x", {**base, "task": "compression"})
        self.assertNotEqual(key(a), key(b))


if __name__ == "__main__":
    unittest.main()
