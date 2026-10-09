#!/usr/bin/env python3
"""Privacy: collector must never select or emit prompt/content fields."""
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents" / "usage-collector"))
from collect_usage import ALLOWED_USAGE_COLS, read_usage_rows, row_to_fact
from cron_parse import FORBIDDEN_CONTENT_KEYS


class TestPrivacy(unittest.TestCase):
    def test_allowed_cols_have_no_content(self):
        for c in ALLOWED_USAGE_COLS:
            self.assertNotIn(c.lower(), FORBIDDEN_CONTENT_KEYS)

    def test_fact_json_has_no_content_keys(self):
        row = {
            "session_id": "s1",
            "model": "gpt-5.6-luna",
            "billing_provider": "openai-codex",
            "billing_mode": "subscription_included",
            "task": "approval",
            "api_call_count": 1,
            "input_tokens": 10,
            "output_tokens": 2,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "reasoning_tokens": 0,
            "estimated_cost_usd": 0,
            "actual_cost_usd": 0,
            "cost_status": "included",
            "cost_source": "none",
            "first_seen": 1790553600.0,
            "last_seen": 1790553600.0,
            "billing_base_url": "https://chatgpt.com/backend-api/codex",
        }
        fact = row_to_fact("host/alpha", row)
        blob = json.dumps(fact)
        for bad in FORBIDDEN_CONTENT_KEYS:
            self.assertNotIn(f'"{bad}"', blob)

    def test_refuses_content_column(self):
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "bad.db"
            con = sqlite3.connect(str(db))
            con.execute(
                """CREATE TABLE session_model_usage (
                    session_id TEXT, model TEXT, billing_provider TEXT DEFAULT '',
                    billing_base_url TEXT DEFAULT '', billing_mode TEXT DEFAULT '',
                    task TEXT DEFAULT '', api_call_count INT DEFAULT 0,
                    input_tokens INT DEFAULT 0, output_tokens INT DEFAULT 0,
                    cache_read_tokens INT DEFAULT 0, cache_write_tokens INT DEFAULT 0,
                    reasoning_tokens INT DEFAULT 0, estimated_cost_usd REAL DEFAULT 0,
                    actual_cost_usd REAL DEFAULT 0, cost_status TEXT, cost_source TEXT,
                    first_seen REAL, last_seen REAL, prompt TEXT
                )"""
            )
            con.execute(
                "INSERT INTO session_model_usage (session_id, model, last_seen, prompt) VALUES ('s','m',1,'SECRET')"
            )
            con.commit()
            con.close()
            with self.assertRaises(RuntimeError) as ctx:
                read_usage_rows(db, None, None)
            self.assertIn("content-like", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
