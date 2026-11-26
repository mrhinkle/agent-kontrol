import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lookupShadowRate, shadowCostForFact } from "../../src/lib/shadow-rates";
import { aggregateUsageFacts } from "../../src/lib/usage-aggregate";
import { UsageCostPanels } from "../../src/components/usage-cost-panels";
import type { AccountSnapshot } from "../../src/lib/providers/types";
import type { UsageFact } from "../../src/lib/usage-types";

const period = { since: "2026-11-20T00:00:00.000Z", until: "2026-11-27T00:00:00.000Z" };
const M = 1_000_000;
const grok = (extra: Partial<UsageFact> = {}): UsageFact => ({
  source: "grok_cli", account_id: "grok-cli:test", profile: "test", session_id: "grok:x", model: "grok-4.7-build",
  billing_provider: "xai", billing_mode: "observation", api_call_count: 1, input_tokens: M, output_tokens: 0,
  cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, paid_cost_usd: 0, shadow_cost_usd: 0,
  cost_status: "local_unpriced", last_seen_at: "2026-11-25T12:00:00.000Z", detail: { billing_mode: "subscription" }, ...extra,
});
const snapshot = (status: "complete" | "partial", account = "grok-cli:test"): AccountSnapshot => ({
  account_id: account, collected_at: "2026-11-26T00:00:00.000Z", credits_remaining: null,
  detail: { coverage: { version: 1, provider: "grok_cli", status, since: period.since, until: period.until } },
} as AccountSnapshot);

describe("Grok rate aliases", () => {
  it("prices Grok Build model IDs at the standard grok-4.7 and grok-4.6 rates, by explicit alias only", () => {
    assert.equal(lookupShadowRate("grok-4.7-build")?.model, "grok-4.7");
    assert.equal(lookupShadowRate("grok-4.6-build")?.model, "grok-4.6");
    assert.equal(lookupShadowRate("xai/grok-4.7-build")?.model, "grok-4.7");
    for (const unknown of ["grok-4.7-build-2", "grok-4.5-build", "grok-4.7-fast"]) assert.equal(lookupShadowRate(unknown), null, unknown);
  });
});

describe("multi-call rows", () => {
  it("decides the long-prompt tier on the average prompt per call, not the turn total", () => {
    // A 46-call turn: 5.1M prompt tokens in all, about 111K per call, so standard rates.
    const turn = { model: "grok-4.7-build", api_call_count: 46, input_tokens: 200_371, cache_read_tokens: 4_920_192, cache_write_tokens: 0, output_tokens: 43_486 };
    const cost = shadowCostForFact(turn);
    assert.equal(cost.status, "priced");
    if (cost.status !== "priced") return;
    assert.equal(cost.tier, "standard");
    assert.equal(cost.usd, Math.round((200_371 * 2 + 4_920_192 * 0.5 + 43_486 * 6) / M * 1e10) / 1e10);
    // The same totals in one call pass 200K and pay the long-prompt rates.
    const single = shadowCostForFact({ ...turn, api_call_count: 1 });
    assert.equal(single.status === "priced" && single.tier, "long_prompt");
    // Average exactly at the inclusive threshold is long.
    const edge = shadowCostForFact({ model: "grok-4.7", api_call_count: 2, input_tokens: 400_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
    assert.equal(edge.status === "priced" && edge.tier, "long_prompt");
  });

  it("leaves single-request Claude rows unchanged", () => {
    const claude = shadowCostForFact({ model: "claude-haiku-5-5", api_call_count: 1, input_tokens: 100_001, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
    assert.equal(claude.status === "priced" && claude.tier, "long_prompt");
  });
});

describe("grokUsage", () => {
  it("prices Grok CLI rows, keeps Grok's own figure as a cross-check, and leaves paid totals alone", () => {
    const hermes = grok({ source: "hermes_state", account_id: "hermes-mac-mini", model: "x", paid_cost_usd: 10, shadow_cost_usd: 100 });
    const base = aggregateUsageFacts([hermes], { ...period, snapshots: [] });
    const rows = [
      grok({ api_call_count: 10, shadow_cost_usd: 2, cost_status: "local_reported_estimate" }),
      grok({ session_id: "grok:y", model: "grok-4.6-build", input_tokens: 0, output_tokens: M, reasoning_tokens: 500 }),
      grok({ session_id: "grok:old", last_seen_at: "2026-11-01T00:00:00.000Z" }),
      grok({ session_id: "grok:api", detail: { billing_mode: "api" }, shadow_cost_usd: 7, cost_status: "local_reported_estimate" }),
    ];
    const data = aggregateUsageFacts([hermes, ...rows], { ...period, snapshots: [snapshot("complete")] });
    for (const key of ["fleet", "by_profile", "by_cron", "by_model", "top_sessions", "providers"] as const) assert.deepEqual(data[key], base[key]);
    const g = data.grok!;
    assert.equal(g.local_usage_status, "complete");
    assert.equal(g.turns, 3); assert.equal(g.model_calls, 12); assert.equal(g.reasoning_tokens, 500);
    assert.equal(g.reported_estimate_usd, 2);
    // 1M input at $2 plus 1M output at $6; the API-marked row is left out and counted.
    assert.equal(g.shadow.usd, 8); assert.equal(g.shadow.status, "priced");
    assert.equal(g.shadow.priced_requests, 11); assert.equal(g.shadow.excluded_api_requests, 1);
    assert.deepEqual(g.shadow.by_model.map((m) => m.model), ["grok-4.6", "grok-4.7"]);
    assert.equal(data.claude?.shadow.unavailable_reason, "no_rows");
  });

  it("is unavailable with no collection, and no_rows (not $0) for a quiet scanned window", () => {
    const none = aggregateUsageFacts([], { ...period, snapshots: [] }).grok!;
    assert.equal(none.local_usage_status, "unavailable");
    assert.equal(none.shadow.usd, null); assert.equal(none.shadow.unavailable_reason, "no_token_feed");
    assert.equal(none.reported_estimate_usd, null);
    const quiet = aggregateUsageFacts([], { ...period, snapshots: [snapshot("complete")] }).grok!;
    assert.equal(quiet.local_usage_status, "complete");
    assert.equal(quiet.shadow.usd, null); assert.equal(quiet.shadow.unavailable_reason, "no_rows");
  });

  it("reports partial when any machine's newest scan was partial or unverified", () => {
    const partial = aggregateUsageFacts([grok()], { ...period, snapshots: [snapshot("complete"), snapshot("partial", "grok-cli:mini")] }).grok!;
    assert.equal(partial.local_usage_status, "partial");
    assert.equal(partial.machines.length, 2);
  });

  it("keeps OpenRouter Grok spend out of the shadow value", () => {
    const routed = grok({ source: "provider_api", account_id: "openrouter-shared", model: "x-ai/grok-4.7", paid_cost_usd: 5, cost_status: "provider_reported" });
    const g = aggregateUsageFacts([routed], { ...period, snapshots: [] }).grok!;
    assert.equal(g.shadow.unavailable_reason, "no_token_feed"); assert.equal(g.turns, 0);
  });

  it("renders calls, the estimate, Grok's own figure and the per-call tier note", () => {
    const html = renderToStaticMarkup(createElement(UsageCostPanels, {
      data: aggregateUsageFacts([grok({ api_call_count: 46, shadow_cost_usd: 1.25, cost_status: "local_reported_estimate" })], { ...period, snapshots: [snapshot("complete")] }),
    }));
    assert.match(html, /Local Grok CLI usage/); assert.match(html, /46 calls/);
    assert.match(html, /Not a charge\. xAI API list prices checked 2026-11-26/); assert.match(html, /\$2\.00/);
    assert.match(html, /recorded its own estimate of \$1\.25/);
    assert.match(html, /average prompt per call/);
    assert.match(html, /test · scan complete/);
    assert.doesNotMatch(html, /No xAI token feed yet/);
  });
});
