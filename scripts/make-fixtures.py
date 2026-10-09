#!/usr/bin/env python3
"""Generate SYNTHETIC Hermes usage fixtures for CI.

Deterministic, seeded. No real fleet data. Same session_model_usage schema
shape the collector expects (including a neuro profile missing the `task` column).

  python3 scripts/make-fixtures.py
  # writes fixtures/hermes/{host,neuro}/*.db and tests/fixtures/cron-job-names.json

Expected collector totals for --since 2026-09-28 --until 2026-10-06
(with agents/usage-collector prices.py / pricing.py):
  paid   = 12.50   (OpenRouter/custom/nous estimated costs)
  shadow = 28.40   (Codex list-price recomputes)
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "fixtures" / "hermes"
CRON_JSON = ROOT / "tests" / "fixtures" / "cron-job-names.json"

# Epoch seconds inside Sep 28 – Oct 6 2026 UTC
T0 = 1790553600.0  # 2026-09-28T00:00:00Z
DAY = 86400.0

USAGE_SQL = """
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '',
    api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    cost_status TEXT,
    cost_source TEXT,
    first_seen REAL,
    last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
)
"""

# Schema without task column (neuro quirk)
USAGE_SQL_NO_TASK = """
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT '',
    api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0,
    cost_status TEXT,
    cost_source TEXT,
    first_seen REAL,
    last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode)
)
"""

# Rows: (session_id, model, billing_provider, billing_base_url, billing_mode, task,
#        api_calls, in, out, cache_r, cache_w, reasoning, est, act, status, source, first, last)
# Shadow math (list): sol $4/$20/$0.40, luna $0.20/$1.20/$0.02 per MTok
#   alpha codex sol: 2M in + 0.1M out + 1M cache = 8 + 2 + 0.4 = 10.40 shadow
#   alpha cron luna: 5M in + 0 + 10M cache = 1.0 + 0 + 0.2 = 1.20 shadow
#   beta codex sol big: 4M in + 0.2M out + 5M cache = 16 + 4 + 2 = 22.00 shadow? wait reduce
# Actually target shadow 28.40:
#   10.40 + 1.20 + 16.80 = 28.40
#   gamma codex: 3M in + 0.15M out + 3M cache = 12 + 3 + 1.2 = 16.20 → adjust
#   alpha: 2M/0.1M/1M sol = 8+2+0.4 = 10.40
#   alpha cron: 5M luna in + 10M cache = 1+0.2 = 1.20
#   beta: 4M sol in + 0.1M out + 2M cache = 16+2+0.8 = 18.80 → too much
#   beta: 3M sol in + 0.1M out + 2M cache = 12+2+0.8 = 14.80; total 10.4+1.2+14.8=26.4
#   gateway: 0.5M sol in + 0 + 0 = 2.0; total 28.4 ✓

ROWS_HOST_ALPHA = [
    # Codex included (shadow)
    ("sess_alpha_codex_001", "gpt-5.6-sol", "openai-codex",
     "https://example.test/codex", "subscription_included", "",
     10, 2_000_000, 100_000, 1_000_000, 0, 0, 0.0, 0.0, "included", "none",
     T0 + 1 * DAY, T0 + 1 * DAY + 100),
    # Cron session → job aa11bb22cc33 "synthetic-velocity"
    ("cron_aa11bb22cc33_20261001_120000", "gpt-5.6-luna", "openai-codex",
     "https://example.test/codex", "subscription_included", "",
     5, 5_000_000, 0, 10_000_000, 0, 0, 0.0, 0.0, "included", "none",
     T0 + 3 * DAY, T0 + 3 * DAY + 50),
    # OpenRouter paid (use estimated)
    ("sess_alpha_or_001", "anthropic/claude-sonnet-5.5", "openrouter",
     "https://openrouter.ai/api/v1/", "", "title_generation",
     3, 50_000, 5_000, 0, 0, 0, 4.00, 0.0, "estimated", "provider_models_api",
     T0 + 2 * DAY, T0 + 2 * DAY + 10),
]

ROWS_HOST_BETA = [
    # Large Codex session (shadow > $5 of list value for alert cases)
    ("sess_beta_codex_big", "gpt-5.6-sol", "openai-codex",
     "https://example.test/codex", "subscription_included", "",
     20, 3_000_000, 100_000, 2_000_000, 0, 500, 0.0, 0.0, "included", "none",
     T0 + 4 * DAY, T0 + 4 * DAY + 200),
    # fallback_chain openrouter paid
    ("sess_beta_fb_001", "deepseek/deepseek-v4-pro", "fallback_chain[0](openrouter)",
     "https://openrouter.ai/api/v1/", "", "",
     2, 10_000, 2_000, 0, 0, 0, 1.50, 0.0, "estimated", "provider_models_api",
     T0 + 4 * DAY + 500, T0 + 4 * DAY + 600),
    # custom provider paid
    ("sess_beta_custom_001", "openai/gpt-5.6-sol", "custom",
     "https://example.test/custom", "", "approval",
     1, 5_000, 1_000, 0, 0, 0, 2.00, 0.0, "estimated", "provider_models_api",
     T0 + 5 * DAY, T0 + 5 * DAY + 10),
]

ROWS_HOST_GAMMA = [
    # nous paid
    ("sess_gamma_nous_001", "z-ai/glm-5.2", "nous",
     "https://example.test/nous", "", "",
     1, 8_000, 500, 0, 0, 0, 0.50, 0.0, "estimated", "provider_models_api",
     T0 + 5 * DAY + 100, T0 + 5 * DAY + 200),
    # custom:nous-research-credits
    ("sess_gamma_nouscred_001", "openai/gpt-5.6-luna", "custom:nous-research-credits",
     "https://example.test/nous", "", "",
     1, 2_000, 200, 0, 0, 0, 0.25, 0.0, "estimated", "provider_models_api",
     T0 + 5 * DAY + 300, T0 + 5 * DAY + 400),
    # Paid session totaling > $5 alone (alert case)
    ("sess_gamma_paid_big", "anthropic/claude-sonnet-5.5", "openrouter",
     "https://openrouter.ai/api/v1/", "", "",
     8, 200_000, 40_000, 0, 0, 0, 4.25, 0.0, "estimated", "provider_models_api",
     T0 + 6 * DAY, T0 + 6 * DAY + 100),
]

ROWS_NEURO_GATEWAY = [
    # Codex shadow remainder: 0.5M sol in = $2.00
    ("sess_gw_codex_001", "gpt-5.6-sol", "openai-codex",
     "https://example.test/codex", "subscription_included", "",
     4, 500_000, 0, 0, 0, 0, 0.0, 0.0, "included", "none",
     T0 + 2 * DAY + 1000, T0 + 2 * DAY + 1100),
]

# No task column
ROWS_NEURO_SIDECAR = [
    ("sess_side_or_001", "deepseek/deepseek-v4-pro-0813", "openrouter",
     "https://openrouter.ai/api/v1/", "",
     1, 1_000, 100, 0, 0, 0, 0.00, 0.0, "", "",
     T0 + 3 * DAY + 100, T0 + 3 * DAY + 200),
]

CRON_NAMES = {
    "by_profile": {
        "host/alpha": {"aa11bb22cc33": "synthetic-velocity"},
        "host/beta": {"bb22cc33dd44": "synthetic-daily"},
        "host/gamma": {},
        "neuro/gateway": {"cc33dd44ee55": "gateway-brief"},
        "neuro/sidecar": {},
    },
    "by_id": {
        "aa11bb22cc33": "synthetic-velocity",
        "bb22cc33dd44": "synthetic-daily",
        "cc33dd44ee55": "gateway-brief",
    },
}


def write_db(path: Path, rows: list, with_task: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(str(path))
    con.execute(USAGE_SQL if with_task else USAGE_SQL_NO_TASK)
    if with_task:
        con.executemany(
            "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows,
        )
    else:
        # rows without task field (index 5)
        slim = []
        for r in rows:
            # ROWS_NEURO_SIDECAR already omits task
            slim.append(r)
        con.executemany(
            "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            slim,
        )
    con.commit()
    con.close()
    print(f"wrote {path.relative_to(ROOT)} ({len(rows)} rows)")


def main() -> None:
    # Wipe old fixture tree (including any real DBs)
    if OUT.exists():
        import shutil
        shutil.rmtree(OUT)
    write_db(OUT / "host" / "alpha.db", ROWS_HOST_ALPHA)
    write_db(OUT / "host" / "beta.db", ROWS_HOST_BETA)
    write_db(OUT / "host" / "gamma.db", ROWS_HOST_GAMMA)
    write_db(OUT / "neuro" / "gateway.db", ROWS_NEURO_GATEWAY)
    write_db(OUT / "neuro" / "sidecar.db", ROWS_NEURO_SIDECAR, with_task=False)
    CRON_JSON.parent.mkdir(parents=True, exist_ok=True)
    CRON_JSON.write_text(json.dumps(CRON_NAMES, indent=2) + "\n")
    print(f"wrote {CRON_JSON.relative_to(ROOT)}")
    print("SYNTHETIC expected: paid=12.50 shadow=28.40 (window Sep28–Oct6)")


if __name__ == "__main__":
    main()
