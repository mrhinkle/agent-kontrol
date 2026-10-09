"""Paid vs shadow cost classification for a Hermes usage row."""
from __future__ import annotations

from typing import Any, Mapping, Optional, Tuple

from prices import PRICE_VERSION, list_cost_usd


def is_codex_included(row: Mapping[str, Any]) -> bool:
    """Codex subscription-included tokens → shadow cost, never paid."""
    provider = (row.get("billing_provider") or "").lower()
    if "openai-codex" in provider:
        return True
    mode = (row.get("billing_mode") or "").lower()
    status = (row.get("cost_status") or "").lower()
    # Defensive: only trust subscription_included+included when provider is empty/codex
    if mode == "subscription_included" and status == "included":
        if not provider or "codex" in provider or provider in ("", "auto"):
            # openrouter rows sometimes mis-tagged; if provider says openrouter, not included
            if "openrouter" in provider or provider.startswith("custom") or provider == "nous":
                return False
            return True
    return False


def classify_costs(row: Mapping[str, Any]) -> Tuple[float, float, str]:
    """Return (paid_usd, shadow_usd, price_version).

    Paid: Hermes estimated_cost_usd (preferred) then actual, then list recompute.
    Shadow: always list-price recompute for Codex-included rows.
    """
    inp = int(row.get("input_tokens") or 0)
    out = int(row.get("output_tokens") or 0)
    cr = int(row.get("cache_read_tokens") or 0)
    cw = int(row.get("cache_write_tokens") or 0)
    model = row.get("model")
    lc = list_cost_usd(model, inp, out, cr, cw)

    if is_codex_included(row):
        shadow = float(lc) if lc is not None else float(row.get("estimated_cost_usd") or 0.0)
        return 0.0, shadow, PRICE_VERSION

    # Paid path — prefer Hermes provider estimate (matches OpenRouter bill closely)
    actual = row.get("actual_cost_usd")
    estimated = row.get("estimated_cost_usd")
    if actual is not None and float(actual) > 0:
        paid = float(actual)
    elif estimated is not None:
        paid = float(estimated)
    elif lc is not None:
        paid = float(lc)
    else:
        paid = 0.0
    return paid, 0.0, PRICE_VERSION
