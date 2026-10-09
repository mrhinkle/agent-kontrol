#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agents" / "usage-collector"))
from cron_parse import parse_cron_job_id


class TestCronParse(unittest.TestCase):
    def test_full_cron_session(self):
        self.assertEqual(
            parse_cron_job_id("cron_276f85f1aa52_20261002_132350"),
            "276f85f1aa52",
        )

    def test_cron_in_noise(self):
        self.assertEqual(
            parse_cron_job_id("prefix cron_1382987ffc9c_20261001_084014 suffix"),
            "1382987ffc9c",
        )

    def test_job_fallback(self):
        self.assertEqual(parse_cron_job_id("job_newsletter_daily"), "newsletter_daily")

    def test_none(self):
        self.assertIsNone(parse_cron_job_id("", None, "approval", "20261002_185814_a1fda5"))

    def test_prefers_session_over_task(self):
        self.assertEqual(
            parse_cron_job_id("cron_abc123def456_20261005_010203", "approval"),
            "abc123def456",
        )


if __name__ == "__main__":
    unittest.main()
