"""Versioned model price table for Usage and Costs.

Matches Agent Kontrol issue #12 seed version 2026-10-05.
Amounts are USD per 1,000,000 tokens.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

PRICE_VERSION = "2026-10-05"

@dataclass(frozen=True)
class ModelPrice:
    model: str
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float
    notes: str = ""

# Canonical seeds from the spec. Aliases resolved in lookup().
PRICES: dict[str, ModelPrice] = {
    "gpt-5.6-sol": ModelPrice("gpt-5.6-sol", 4.00, 20.00, 0.40, "Codex list"),
    "gpt-5.6-luna": ModelPrice("gpt-5.6-luna", 0.20, 1.20, 0.02, "Codex list"),
    "deepseek/deepseek-v4-pro": ModelPrice(
        "deepseek/deepseek-v4-pro", 0.2088, 0.4176, 0.0174, "Current OpenRouter fallback"
    ),
    "deepseek/deepseek-v4-pro-0813": ModelPrice(
        "deepseek/deepseek-v4-pro-0813", 0.40, 5.00, 0.36, "Historical only"
    ),
}

# Common aliases seen in Hermes session_model_usage.model
ALIASES = {
    "openai/gpt-5.6-sol": "gpt-5.6-sol",
    "openai/gpt-5.6-luna": "gpt-5.6-luna",
    "sol": "gpt-5.6-sol",
    "luna": "gpt-5.6-luna",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
    "deepseek-v4-pro-0813": "deepseek/deepseek-v4-pro-0813",
}


def lookup(model: Optional[str]) -> Optional[ModelPrice]:
    if not model:
        return None
    m = model.strip()
    if m in PRICES:
        return PRICES[m]
    if m in ALIASES:
        return PRICES[ALIASES[m]]
    ml = m.lower()
    if ml in PRICES:
        return PRICES[ml]
    if ml in ALIASES:
        return PRICES[ALIASES[ml]]
    # Soft match: prefer more specific (0813 before base deepseek)
    if "0813" in ml and "deepseek" in ml:
        return PRICES["deepseek/deepseek-v4-pro-0813"]
    if "deepseek" in ml and "v4-pro" in ml:
        return PRICES["deepseek/deepseek-v4-pro"]
    if "luna" in ml:
        return PRICES["gpt-5.6-luna"]
    if "sol" in ml:
        return PRICES["gpt-5.6-sol"]
    return None


def list_cost_usd(
    model: Optional[str],
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> Optional[float]:
    """Compute list-price USD. Hermes stores input_tokens as non-cached input."""
    p = lookup(model)
    if p is None:
        return None
    # cache_write billed at input rate when no dedicated cache-write price
    cache_write_rate = p.input_per_mtok
    total = (
        input_tokens * p.input_per_mtok
        + output_tokens * p.output_per_mtok
        + cache_read_tokens * p.cache_read_per_mtok
        + cache_write_tokens * cache_write_rate
    ) / 1_000_000.0
    return total
