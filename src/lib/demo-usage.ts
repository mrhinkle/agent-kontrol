/**
 * Demo Usage and Costs summary when DATABASE_URL is unset.
 * Uses SYNTHETIC totals (scripts/make-fixtures.py), never real fleet spend.
 * Production Neon path must never call this.
 */
import type { UsageSummary } from "./usage-types";

export function demoUsageSummary(opts: { since: string; until: string }): UsageSummary {
  return {
    window: { since: opts.since, until: opts.until },
    demo: true,
    fleet: {
      paid_cost_usd: 12.5,
      shadow_cost_usd: 28.4,
      subscription_fees_usd: 0,
      input_tokens: 10_776_000,
      output_tokens: 248_800,
      cache_read_tokens: 13_000_000,
      api_call_count: 56,
      rows: 11,
      cache_hit_rate: 13_000_000 / (10_776_000 + 13_000_000),
    },
    by_profile: [
      { key: "host/alpha", label: "host/alpha", paid_cost_usd: 4.0, shadow_cost_usd: 11.6, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 3 },
      { key: "host/beta", label: "host/beta", paid_cost_usd: 3.5, shadow_cost_usd: 14.8, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 3 },
      { key: "host/gamma", label: "host/gamma", paid_cost_usd: 5.0, shadow_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 3 },
      { key: "neuro/gateway", label: "neuro/gateway", paid_cost_usd: 0, shadow_cost_usd: 2.0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 1 },
      { key: "neuro/sidecar", label: "neuro/sidecar", paid_cost_usd: 0, shadow_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 1 },
    ],
    by_cron: [
      { key: "aa11bb22cc33", label: "synthetic-velocity (aa11bb22cc33)", paid_cost_usd: 0, shadow_cost_usd: 1.2, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 1 },
    ],
    by_model: [
      { key: "gpt-5.6-sol", label: "gpt-5.6-sol", paid_cost_usd: 0, shadow_cost_usd: 27.2, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 3 },
    ],
    by_account: [
      { key: "hermes-mac-mini:hermes_state", label: "hermes-mac-mini:hermes_state", paid_cost_usd: 12.5, shadow_cost_usd: 28.4, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, api_call_count: 0, rows: 11 },
    ],
    top_sessions: [],
    openrouter: {
      activity_paid_usd: null,
      credits_remaining: null,
      reconcile_delta_pct: null,
      note: "Demo mode — synthetic fixtures only (DATABASE_URL unset)",
    },
    collected_at: null,
  };
}
