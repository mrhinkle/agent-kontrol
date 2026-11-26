import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lookupShadowRate, shadowCostForFact, SHADOW_RATES, SHADOW_RATE_VERSION } from "../../src/lib/shadow-rates";
import { shadowCosts } from "../../src/lib/usage-costs";
import { aggregateUsageFacts } from "../../src/lib/usage-aggregate";
import { UsageCostPanels } from "../../src/components/usage-cost-panels";
import type { UsageFact } from "../../src/lib/usage-types";

const period = { since: "2026-11-20T00:00:00.000Z", until: "2026-11-27T00:00:00.000Z" };
const M = 1_000_000;
const local = (extra: Partial<UsageFact> = {}): UsageFact => ({
  source: "claude_code", account_id: "claude-code:test", session_id: "cc:x", model: "claude-opus-5-5",
  billing_mode: "observation", api_call_count: 1, input_tokens: 1000, output_tokens: 500,
  cache_read_tokens: 0, cache_write_tokens: 0, paid_cost_usd: 0, shadow_cost_usd: 0,
  cost_status: "local_unpriced", last_seen_at: "2026-11-25T12:00:00.000Z", detail: { billing_mode: "subscription" }, ...extra,
});

describe("shadow rate table", () => {
  it("is dated and every rate names an https source and finite non-negative prices", () => {
    assert.match(SHADOW_RATE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    const seen = new Set<string>();
    for (const rate of SHADOW_RATES) {
      assert.ok(!seen.has(rate.model), `duplicate ${rate.model}`); seen.add(rate.model);
      assert.match(rate.source_url, /^https:\/\/(platform\.claude\.com|docs\.x\.ai)\//);
      for (const r of [rate.rates, rate.prompt_tier?.rates].filter(Boolean)) {
        for (const v of Object.values(r!)) assert.ok(Number.isFinite(v) && v >= 0, `${rate.model} ${v}`);
      }
    }
  });

  it("matches the published prices checked 2026-11-26", () => {
    const r = (m: string) => lookupShadowRate(m)!.rates;
    assert.deepEqual(r("claude-opus-5-5"), { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 });
    assert.deepEqual(r("claude-fable-5-2"), { input: 8, output: 40, cache_read: 0.2, cache_write_5m: 10, cache_write_1h: 16 });
    assert.deepEqual(r("claude-fable-5-1"), { input: 10, output: 50, cache_read: 0.25, cache_write_5m: 12.5, cache_write_1h: 20 });
    assert.deepEqual(r("claude-sonnet-5-5"), { input: 2, output: 10, cache_read: 0.1, cache_write_5m: 2.5, cache_write_1h: 4 });
    assert.deepEqual(r("claude-sonnet-5"), { input: 2, output: 10, cache_read: 0.2, cache_write_5m: 2.5, cache_write_1h: 4 });
    assert.deepEqual(r("claude-haiku-5-5"), { input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2 });
    assert.deepEqual(lookupShadowRate("claude-haiku-5-5")!.prompt_tier, { threshold_tokens: 100_000, inclusive: false, rates: { input: 0.5, output: 2.5, cache_read: 0.05, cache_write_5m: 0.625, cache_write_1h: 1 } });
    assert.deepEqual(r("grok-4.7"), { input: 2, output: 6, cache_read: 0.5, cache_write_5m: 2, cache_write_1h: 2 });
    assert.deepEqual(lookupShadowRate("grok-4.7")!.prompt_tier?.rates, { input: 4, output: 12, cache_read: 1, cache_write_5m: 4, cache_write_1h: 4 });
    assert.deepEqual(r("grok-4.3"), { input: 1.25, output: 2.5, cache_read: 0.2, cache_write_5m: 1.25, cache_write_1h: 1.25 });
  });

  it("looks up exact IDs, routing prefixes and snapshot dates, and nothing else", () => {
    assert.equal(lookupShadowRate("claude-opus-5-5")?.rates.input, 4);
    assert.equal(lookupShadowRate("anthropic/claude-sonnet-5-5")?.rates.cache_read, 0.1);
    assert.equal(lookupShadowRate("claude-haiku-4-5-20251001")?.model, "claude-haiku-4-5");
    assert.equal(lookupShadowRate("x-ai/grok-4.7")?.rates.output, 6);
    assert.equal(lookupShadowRate("grok-4.7")?.vendor, "xai");
    for (const miss of [null, undefined, "", "  ", "claude-opus-5-5-preview", "claude-opus", "gpt-5.6-sol", "grok-4.7-fast", "grok-code-fast-1", "x-ai/grok-4.7-20261101"]) {
      assert.equal(lookupShadowRate(miss as string), null, String(miss));
    }
  });
});

describe("shadowCostForFact", () => {
  it("prices every token type at the vendor rate, cache writes at the 5-minute rate", () => {
    const cost = shadowCostForFact(local({ input_tokens: M, output_tokens: M, cache_read_tokens: M, cache_write_tokens: M }));
    assert.deepEqual(cost, { status: "priced", usd: 4 + 20 + 0.2 + 5, model: "claude-opus-5-5", tier: "standard" });
  });

  it("applies the Haiku 5.5 tier only above 100,000 prompt tokens, counting cache reads and writes", () => {
    const at = shadowCostForFact(local({ model: "claude-haiku-5-5", input_tokens: 50_000, cache_read_tokens: 40_000, cache_write_tokens: 10_000, output_tokens: 0 }));
    assert.equal(at.status === "priced" && at.tier, "standard");
    const over = shadowCostForFact(local({ model: "claude-haiku-5-5", input_tokens: 50_001, cache_read_tokens: 40_000, cache_write_tokens: 10_000, output_tokens: M }));
    assert.equal(over.status === "priced" && over.tier, "long_prompt");
    assert.equal(over.status === "priced" && over.usd, Math.round((50_001 * 0.5 + 40_000 * 0.05 + 10_000 * 0.625 + M * 2.5) / M * 1e10) / 1e10);
  });

  it("applies the Grok long-context tier at 200,000 prompt tokens inclusive, cached input at its own rate", () => {
    const below = shadowCostForFact(local({ model: "grok-4.7", input_tokens: 199_999, output_tokens: 0 }));
    assert.equal(below.status === "priced" && below.tier, "standard");
    const at = shadowCostForFact(local({ model: "grok-4.7", input_tokens: 100_000, cache_read_tokens: 100_000, output_tokens: 0 }));
    assert.deepEqual(at, { status: "priced", usd: (100_000 * 4 + 100_000 * 1) / M, model: "grok-4.7", tier: "long_prompt" });
  });

  it("is unavailable, never $0, without a model, with an unknown model or without token counts", () => {
    assert.deepEqual(shadowCostForFact(local({ model: "" })), { status: "unavailable", reason: "missing_model" });
    assert.deepEqual(shadowCostForFact(local({ model: undefined as unknown as string })), { status: "unavailable", reason: "missing_model" });
    assert.deepEqual(shadowCostForFact(local({ model: "claude-future-9" })), { status: "unavailable", reason: "unknown_model" });
    assert.deepEqual(shadowCostForFact(local({ input_tokens: undefined })), { status: "unavailable", reason: "missing_tokens" });
    assert.deepEqual(shadowCostForFact(local({ output_tokens: Number.NaN })), { status: "unavailable", reason: "missing_tokens" });
    assert.deepEqual(shadowCostForFact(local({ input_tokens: -1 })), { status: "unavailable", reason: "missing_tokens" });
    assert.deepEqual(shadowCostForFact(local({ input_tokens: 0, output_tokens: 0 })), { status: "unavailable", reason: "missing_tokens" });
    for (const bad of [null, Number.NaN, -5, "12"]) {
      assert.deepEqual(shadowCostForFact(local({ cache_read_tokens: bad as unknown as number })), { status: "unavailable", reason: "missing_tokens" }, `read ${bad}`);
      assert.deepEqual(shadowCostForFact(local({ cache_write_tokens: bad as unknown as number })), { status: "unavailable", reason: "missing_tokens" }, `write ${bad}`);
    }
  });

  it("treats an absent cache counter as zero, as Anthropic omits unused ones", () => {
    const cost = shadowCostForFact(local({ input_tokens: M, output_tokens: 0, cache_read_tokens: undefined, cache_write_tokens: undefined }));
    assert.deepEqual(cost, { status: "priced", usd: 4, model: "claude-opus-5-5", tier: "standard" });
  });
});

describe("shadowCosts summary", () => {
  it("reports null, not 0, when nothing could be priced, and says why", () => {
    const none = shadowCosts([local({ model: "claude-future-9", api_call_count: 3 }), local({ input_tokens: 0, output_tokens: 0 })]);
    assert.equal(none.usd, null); assert.equal(none.status, "unavailable"); assert.equal(none.unavailable_reason, "no_priced_rows");
    assert.deepEqual(none.unpriced, { missing_model: 0, unknown_model: 3, missing_tokens: 1 });
    assert.equal(none.unpriced_requests, 4); assert.deepEqual(none.unknown_models, ["claude-future-9"]);
    const empty = shadowCosts([]);
    assert.equal(empty.usd, null); assert.equal(empty.unavailable_reason, "no_rows");
    const feed = shadowCosts([], { noFeed: true });
    assert.equal(feed.usd, null); assert.equal(feed.unavailable_reason, "no_token_feed");
  });

  it("totals priced rows by model and marks a window with unpriced rows partial", () => {
    const s = shadowCosts([
      local({ input_tokens: M, output_tokens: 0 }),
      local({ model: "claude-sonnet-5-5", input_tokens: 0, output_tokens: M, api_call_count: 2 }),
      local({ model: "claude-future-9" }),
    ]);
    assert.equal(s.status, "partial"); assert.equal(s.usd, 14); assert.equal(s.priced_requests, 3); assert.equal(s.unpriced_requests, 1);
    assert.deepEqual(s.by_model.map((m) => [m.model, m.requests, m.usd]), [["claude-sonnet-5-5", 2, 10], ["claude-opus-5-5", 1, 4]]);
    assert.equal(s.cache_write_basis, "5m_rate_lower_bound"); assert.equal(s.rate_version, SHADOW_RATE_VERSION);
  });

  it("leaves API-billed rows out as metered spend and counts unclassified rows it priced", () => {
    const s = shadowCosts([
      local({ input_tokens: M, output_tokens: 0, detail: { billing_mode: "api" }, api_call_count: 2 }),
      local({ input_tokens: M, output_tokens: 0, detail: { billing_mode: "unknown" } }),
      local({ input_tokens: M, output_tokens: 0 }),
    ]);
    assert.equal(s.usd, 8); assert.equal(s.priced_requests, 2); assert.equal(s.excluded_api_requests, 2); assert.equal(s.unclassified_requests, 1);
    const onlyApi = shadowCosts([local({ detail: { billing_mode: "api" } })]);
    assert.equal(onlyApi.usd, null); assert.equal(onlyApi.status, "unavailable"); assert.equal(onlyApi.excluded_api_requests, 1); assert.equal(onlyApi.unavailable_reason, "only_api_billed");
    const html = renderToStaticMarkup(createElement(UsageCostPanels, { data: aggregateUsageFacts([
      local({ detail: { billing_mode: "api" } }), local({ detail: { billing_mode: "unknown" } }),
    ], period) }));
    assert.match(html, /1 API-billed request\(s\) left out/); assert.match(html, /Includes 1 request\(s\) with no recorded payment method/);
  });
});

describe("usage summary and panels", () => {
  it("adds Claude shadow cost without touching paid totals, provider billing or Hermes attribution", () => {
    const hermes = local({ source: "hermes_state", account_id: "hermes-mac-mini", profile: "p", paid_cost_usd: 10, shadow_cost_usd: 100 });
    const base = aggregateUsageFacts([hermes], period);
    const data = aggregateUsageFacts([hermes, local({ input_tokens: M, output_tokens: 0 })], period);
    for (const key of ["fleet", "by_profile", "by_cron", "by_model", "top_sessions", "providers"] as const) assert.deepEqual(data[key], base[key]);
    assert.equal(data.claude?.shadow.usd, 4); assert.equal(data.claude?.shadow.status, "priced");
    assert.equal(data.grok?.shadow.usd, null); assert.equal(data.grok?.shadow.unavailable_reason, "no_token_feed");
  });

  it("renders the estimate labelled as not a charge, and unpriced usage as unavailable rather than $0.00", () => {
    const priced = renderToStaticMarkup(createElement(UsageCostPanels, { data: aggregateUsageFacts([local({ input_tokens: M, output_tokens: 0 })], period) }));
    assert.match(priced, /API-equivalent value \(estimate\)/); assert.match(priced, /\$4\.00/);
    assert.match(priced, /Not a charge\. Anthropic API list prices checked 2026-11-26/); assert.match(priced, /lower bound/);
    assert.match(priced, /No xAI token feed yet/);
    const unpriced = renderToStaticMarkup(createElement(UsageCostPanels, { data: aggregateUsageFacts([local({ model: "claude-future-9" })], period) }));
    assert.match(unpriced, /Not available/); assert.match(unpriced, /1 request\(s\) not priced: 1 unknown model/);
    assert.doesNotMatch(unpriced, /\$0\.00/);
  });
});
