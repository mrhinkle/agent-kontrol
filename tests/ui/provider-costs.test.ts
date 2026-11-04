import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { openRouterAdapter, activityToFacts } from "../../src/lib/providers/openrouter";
import { anthropicAdminAdapter, centsToUsd } from "../../src/lib/providers/anthropic";
import { getAccount } from "../../src/lib/usage-accounts";
import { providerWindowRange } from "../../src/lib/usage-window";
import { aggregateUsageFacts } from "../../src/lib/usage-aggregate";
import { providerCosts } from "../../src/lib/usage-costs";
import { getUsageSummary, ingestUsageBatch } from "../../src/lib/usage-store";
import { setSqlForTests } from "../../src/lib/db";
import type { UsageFact } from "../../src/lib/usage-types";
import type { AccountSnapshot } from "../../src/lib/providers/types";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UsageCostPanels } from "../../src/components/usage-cost-panels";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; setSqlForTests(null); });
const response = (data: unknown) => new Response(JSON.stringify(data));
const orAccount = getAccount("openrouter-shared")!, anthAccount = getAccount("anthropic-api-org")!;
const until = new Date(); until.setUTCHours(0, 0, 0, 0);
const since = new Date(until.getTime() - 2 * 86_400_000);
const day = since.toISOString().slice(0, 10);
const activity = (fields = {}) => ({ date: day, model: "anthropic/claude-sonnet-5", usage: 1.05, requests: 2, prompt_tokens: 10, completion_tokens: 5, ...fields });
const period = { since: "2026-11-02T00:00:00.000Z", until: "2026-11-04T00:00:00.000Z" };
const rid = "a".repeat(64);
const receipt = (fields = {}): AccountSnapshot => ({ account_id: "openrouter-shared", collected_at: "2026-11-04T01:00:00Z", detail: { coverage: { version: 1, provider: "openrouter", ...period, status: "complete", report_id: rid, fact_count: 1, ...fields } } });
const fact = (fields: Partial<UsageFact> = {}): UsageFact => ({ source: "provider_api", account_id: "openrouter-shared", model: "same", session_id: "day-model", paid_cost_usd: 3, last_seen_at: "2026-11-03T23:59:59.999Z", detail: { report_id: rid }, ...fields });

describe("provider metadata contracts", () => {
  it("sums endpoint rows into the existing identity and excludes external BYOK charges", () => {
    const rows = activityToFacts(orAccount, [activity({ byok_usage_inference: 100, cached_tokens: 3 }), activity({ usage: 2 })]);
    assert.equal(rows.length, 1); assert.equal(rows[0].paid_cost_usd, 3.05);
    assert.equal(rows[0].api_call_count, 4); assert.equal(rows[0].cache_read_tokens, 3);
    assert.equal(rows[0].session_id, `or-activity:${day}:anthropic/claude-sonnet-5`);
    assert.deepEqual(rows[0].detail, { byok_inference_usd: 100 });
    for (const invalid of [{ usage: undefined }, { usage: -1 }, { requests: "2" }, { date: "2026-02-30" }, { model: "secret text" }]) assert.throws(() => activityToFacts(orAccount, [activity(invalid)]));
  });
  it("fetches the full OpenRouter report, filters range, and preserves unknown optional credits", async () => {
    process.env.MC_OPENROUTER_MANAGEMENT_KEY = "fake-management";
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input); calls.push(url);
      assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      if (url.includes("credits")) return new Response("secret-provider-error", { status: 403 });
      assert.equal(url, "https://openrouter.ai/api/v1/activity");
      return response({ data: [activity({ usage: 0 }), activity({ date: new Date(since.getTime() - 86_400_000).toISOString().slice(0, 10), usage: 9 })] });
    };
    const batch = await openRouterAdapter.fetchUsage(orAccount, since, until);
    assert.equal(batch.facts.length, 1); assert.equal(batch.facts[0].paid_cost_usd, 0);
    assert.equal(batch.snapshot?.credits_remaining, null);
    assert.equal((batch.snapshot!.detail!.coverage as any).status, "complete");
    assert.equal(calls.length, 2);
    await assert.rejects(() => openRouterAdapter.fetchUsage(orAccount, new Date(until.getTime() - 31 * 86_400_000), until), /30 complete/);
    await assert.rejects(() => openRouterAdapter.fetchUsage(orAccount, new Date(since.getTime() + 1), until), /complete UTC/);
  });
  it("requires an actual OpenRouter data array and records successful empty reports", async () => {
    process.env.MC_OPENROUTER_MANAGEMENT_KEY = "fake-management";
    globalThis.fetch = async () => response({});
    await assert.rejects(() => openRouterAdapter.fetchUsage(orAccount, since, until), /data/);
    globalThis.fetch = async (url) => response(String(url).includes("credits") ? { data: { total_credits: 10, total_usage: 4 } } : { data: [] });
    const batch = await openRouterAdapter.fetchUsage(orAccount, since, until);
    assert.equal(batch.facts.length, 0); assert.equal(batch.snapshot?.credits_remaining, 6);
    assert.equal((batch.snapshot!.detail!.coverage as any).fact_count, 0);
  });
  it("does not use inference keys as admin or management keys", async () => {
    delete process.env.MC_OPENROUTER_MANAGEMENT_KEY; delete process.env.OPENROUTER_MANAGEMENT_KEY;
    delete process.env.MC_ANTHROPIC_ADMIN_KEY; delete process.env.ANTHROPIC_ADMIN_KEY;
    process.env.ANTHROPIC_API_KEY = "inference-canary"; process.env.OPENROUTER_API_KEY = "inference-canary";
    let calls = 0; globalThis.fetch = async () => { calls++; return response({}); };
    await assert.rejects(() => anthropicAdminAdapter.fetchUsage(anthAccount, since, until), /ADMIN_KEY/);
    await assert.rejects(() => openRouterAdapter.fetchUsage(orAccount, since, until), /MANAGEMENT_KEY/);
    assert.equal(calls, 0);
  });
  it("parses decimal cents and rejects absent currency, negative, infinite and malformed values", () => {
    assert.equal(centsToUsd("105"), 1.05); assert.equal(centsToUsd("1"), 0.01); assert.equal(centsToUsd("41280.000000"), 412.8);
    for (const n of ["-1", "1e5", 105, undefined, "", "Infinity"]) assert.throws(() => centsToUsd(n));
  });
  it("paginates both Anthropic reports and joins usage, cache counts and unallocated costs", async () => {
    process.env.MC_ANTHROPIC_ADMIN_KEY = "fake-admin";
    const start = since.toISOString(), end = new Date(since.getTime() + 86_400_000).toISOString();
    const bucket = (model: string | null) => ({ starting_at: start, ending_at: end, group: { model } });
    const seen: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)); seen.push(url.pathname + url.searchParams.get("page"));
      assert.equal(url.searchParams.get("time_bucket_width"), "1d"); assert.equal(url.searchParams.get("group_by[]"), "model");
      assert.equal((init?.headers as any)["anthropic-beta"], "analytics-usage-cost-2026-08-24");
      if (url.pathname.endsWith("usage")) return response({ data: [{ ...bucket("claude-sonnet-5"), usage: { uncached_input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 90, cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 7 }, requests: 3 } }], has_more: false });
      return url.searchParams.has("page") ? response({ data: [{ ...bucket(null), cost: { amount: "1", currency: "USD" } }], has_more: false }) : response({ data: [{ ...bucket("claude-sonnet-5"), cost: { amount: "105", currency: "USD" } }], has_more: true, next_page: "next" });
    };
    const batch = await anthropicAdminAdapter.fetchUsage(anthAccount, since, until);
    assert.equal(seen.length, 3); assert.equal(batch.facts.length, 2);
    assert.equal(batch.facts[0].paid_cost_usd, 1.05); assert.equal(batch.facts[0].cache_write_tokens, 12); assert.equal(batch.facts[0].cache_read_tokens, 90);
    assert.equal(batch.facts[1].model, "(unallocated)"); assert.equal(batch.facts[1].paid_cost_usd, 0.01); assert.equal(batch.facts[1].api_call_count, undefined);
  });
  it("fails closed on later-page errors, repeated or missing cursors, missing counters and currency", async () => {
    process.env.MC_ANTHROPIC_ADMIN_KEY = "fake-admin";
    for (const second of [{ data: [], has_more: true, next_page: "again" }, { data: [], has_more: true }, { data: null, has_more: false }]) {
      let n = 0;
      globalThis.fetch = async () => response(++n === 1 ? { data: [], has_more: true, next_page: "again" } : second);
      await assert.rejects(() => anthropicAdminAdapter.fetchUsage(anthAccount, since, until)); assert.equal(n, 2);
    }
    const bucket = { starting_at: since.toISOString(), ending_at: new Date(since.getTime() + 86_400_000).toISOString(), group: { model: "claude-sonnet-5" } };
    for (const currency of [undefined, "EUR"]) {
      globalThis.fetch = async (url) => response({ data: String(url).includes("/cost?") ? [{ ...bucket, cost: { amount: "105", currency } }] : [], has_more: false });
      await assert.rejects(() => anthropicAdminAdapter.fetchUsage(anthAccount, since, until), /USD/);
    }
    globalThis.fetch = async () => response({ data: [{ ...bucket, usage: {} }], has_more: false });
    await assert.rejects(() => anthropicAdminAdapter.fetchUsage(anthAccount, since, until));
  });
});

describe("cost summaries and visible evidence", () => {
  it("pins complete UTC days separately from a rolling window across midnight", () => {
    assert.deepEqual(providerWindowRange("24h", new Date("2026-11-04T00:30:00Z")), { since: "2026-11-03T00:00:00.000Z", until: "2026-11-04T00:00:00.000Z" });
  });
  it("distinguishes measured zero, missing, partial and stale or incomplete reports", () => {
    assert.equal(providerCosts([], [], period)[0].cost_usd, null);
    const empty = providerCosts([], [receipt({ fact_count: 0 })], period)[0];
    assert.equal(empty.cost_usd, 0); assert.equal(empty.coverage, "complete");
    const zero = providerCosts([fact({ paid_cost_usd: 0 })], [receipt()], period)[0];
    assert.equal(zero.cost_usd, 0); assert.equal(zero.coverage, "complete");
    assert.equal(providerCosts([fact()], [], period)[0].coverage, "unverified");
    const partial = providerCosts([fact()], [receipt({ since: "2026-11-03T00:00:00Z" })], period)[0];
    assert.equal(partial.cost_usd, 3); assert.equal(partial.coverage, "partial"); assert.equal(partial.daily[0].cost_usd, null);
    assert.equal(providerCosts([], [receipt()], period)[0].coverage, "unverified");
    // A correction removed the previously nonzero model: do not carry it into the new complete empty report.
    const corrected = providerCosts([fact({ detail: { report_id: "b".repeat(64) }, paid_cost_usd: 99 })], [receipt({ fact_count: 0 })], period)[0];
    assert.equal(corrected.cost_usd, 0); assert.equal(corrected.coverage, "complete");
    const removed = aggregateUsageFacts([fact({ detail: { report_id: "b".repeat(64) }, paid_cost_usd: 99 })], { ...period, snapshots: [receipt({ fact_count: 0 })] });
    assert.deepEqual(removed.by_account, [], "removed report rows cannot survive in the legacy account breakdown");
    const partialDay = providerCosts([fact()], [receipt()], { since: "2026-11-03T12:00:00Z", until: period.until })[0];
    assert.notEqual(partialDay.coverage, "complete"); assert.match(partialDay.note, /partial-day query/);
  });
  it("keeps ALL Hermes attribution unchanged and never turns local estimates into provider charges", () => {
    const hermes = fact({ source: "hermes_state", account_id: "hermes-mac-mini", profile: "same", cron_job_id: "cron", paid_cost_usd: 10, shadow_cost_usd: 100 });
    const base = aggregateUsageFacts([hermes], period);
    const mixed = aggregateUsageFacts([hermes, fact(), fact({ source: "claude_code", account_id: "claude-code:mac", paid_cost_usd: 0, shadow_cost_usd: 4, api_call_count: 1, cost_status: "local_reported_estimate", detail: { billing_mode: "subscription" } })], period);
    for (const key of ["fleet", "by_profile", "by_cron", "by_model", "top_sessions"] as const) assert.deepEqual(mixed[key], base[key]);
    assert.equal(mixed.claude?.reported_estimate_usd, 4); assert.equal(mixed.claude?.billing_modes.subscription, 1); assert.equal(mixed.claude?.subscription_fees_usd, null);
    assert.equal(mixed.providers?.[1].cost_usd, null);
  });
  it("renders provider-only and fee-only data, currency semantics and unknown estimates", () => {
    const data = aggregateUsageFacts([fact(), fact({ source: "subscription_fee", account_id: "claude-subscription", paid_cost_usd: 7 })], { ...period, snapshots: [receipt()] });
    assert.equal(data.fleet.rows, 0);
    const html = renderToStaticMarkup(createElement(UsageCostPanels, { data }));
    assert.match(html, /\$3\.00/); assert.match(html, /\$7\.00/); assert.match(html, /After discounts, before credits/);
    assert.match(html, /Not available/); assert.doesNotMatch(html, /\$10\.00/);
  });
  it("uses persisted snapshot metadata through the actual read path", async () => {
    process.env.DATABASE_URL = "postgres://fixture";
    const statements: string[] = [];
    setSqlForTests(async (strings) => {
      const query = strings.join("?"); statements.push(query);
      if (query.includes("from account_snapshots")) return [receipt({ fact_count: 0 })];
      return [];
    });
    const result = await getUsageSummary({ ...period, window: "24h" });
    assert.equal(result.providers?.[0].cost_usd, 0); assert.equal(result.providers?.[0].coverage, "complete");
    assert.ok(statements.some((s) => s.includes("repeatable read"))); assert.equal(statements.at(-1), "commit");
  });
  it("rolls back facts if the coverage snapshot cannot be persisted", async () => {
    process.env.DATABASE_URL = "postgres://fixture";
    const statements: string[] = [];
    setSqlForTests(async (strings) => {
      const query = strings.join("?"); statements.push(query);
      if (query.includes("insert into account_snapshots")) throw new Error("snapshot failed");
      return [];
    });
    await assert.rejects(() => ingestUsageBatch({ facts: [fact()], snapshot: receipt() }), /snapshot failed/);
    assert.ok(statements.some((s) => s.includes("insert into usage_facts"))); assert.equal(statements.at(-1), "rollback");
  });
});

describe("safe collection and publication", () => {
  it("rejects unsafe destinations and treats env files literally", async () => {
    const { fleetOrigin, literalConfig } = await import("../../src/lib/providers/collector");
    for (const url of ["http://fleet.peripety.com", "https://u:p@fleet.peripety.com", "https://fleet.peripety.com/path", "https://fleet.peripety.com?token=secret", "https://fleet.peripety.com/#secret", "file:///tmp/x", "http://127.0.0.1"]) assert.throws(() => fleetOrigin(url));
    assert.equal(fleetOrigin("https://fleet.peripety.com/"), "https://fleet.peripety.com");
    assert.equal(fleetOrigin("http://127.0.0.1:3123", true), "http://127.0.0.1:3123");
    assert.deepEqual(literalConfig('MC_TOKEN="$(echo canary)"\nIGNORED=secret\nMC_URL=https://fleet.peripety.com'), { MC_TOKEN: "$(echo canary)", MC_URL: "https://fleet.peripety.com" });
  });
  it("requires a non-demo exact-count receipt, including empty batches", async () => {
    const { publishBatch, validateReceipt } = await import("../../src/lib/providers/collector");
    for (const bad of [{ ok: true, demo: true, written: 1 }, { ok: true, written: 0 }, { ok: false, written: 1 }, { ok: true }]) assert.throws(() => validateReceipt(bad, 1));
    validateReceipt({ ok: true, written: 0 }, 0);
    let sent: any;
    globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return response({ ok: true, written: 1 }); };
    await publishBatch({ facts: [fact()] }, "https://fleet.peripety.com", "fake-token");
    assert.equal(sent.facts.length, 1);
    globalThis.fetch = async () => response({ ok: true, demo: true, written: 1 });
    await assert.rejects(() => publishBatch({ facts: [fact()] }, "https://fleet.peripety.com", "fake-token"));
  });
  it("does not publish any provider on a later report failure", async () => {
    const { collectProviderUsage } = await import("../../scripts/collect-provider-usage");
    process.env.MC_URL = "https://fleet.peripety.com"; process.env.MC_TOKEN = "fake-token";
    process.env.MC_ANTHROPIC_ADMIN_KEY = "fake-admin";
    process.env.MC_OPENROUTER_MANAGEMENT_KEY = "fake-management";
    let posts = 0;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") { posts++; return response({ ok: true, written: 0 }); }
      const url = String(input);
      if (url.includes("openrouter")) return response(url.includes("credits") ? { data: { total_credits: 1, total_usage: 0 } } : { data: [] });
      return url.includes("page=next") ? new Response("secret-canary", { status: 503 }) : response({ data: [], has_more: true, next_page: "next" });
    };
    await assert.rejects(() => collectProviderUsage(["--provider", "all", "--publish"])); assert.equal(posts, 0);
  });
  it("rejects all redirects without contacting their destination or exposing raw errors", async () => {
    const { createServer } = await import("node:http");
    const { jsonRequest } = await import("../../src/lib/providers/transport");
    let secondHops = 0;
    const server = createServer((req, res) => {
      if (req.url === "/target") { secondHops++; res.end("secret-canary"); return; }
      res.writeHead(Number(req.url!.slice(1)), { Location: "/target" }); res.end("secret-canary");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      for (const status of [301, 302, 303, 307, 308]) await assert.rejects(() => jsonRequest(`http://127.0.0.1:${port}/${status}`), (e: Error) => !e.message.includes("secret-canary"));
      assert.equal(secondHops, 0);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("records actual fee metadata idempotently, never assumes price or exposes invoice ids", async () => {
    const { subscriptionFee } = await import("../../src/lib/providers/collector");
    const input = { invoice_id: "private-invoice-canary", paid_at: "2026-11-03T12:00:00Z", amount_usd: 7, currency: "USD" };
    const batch = subscriptionFee(input, new Date("2026-11-04"));
    assert.equal(batch.facts[0].paid_cost_usd, 7); assert.equal(batch.facts[0].last_seen_at, "2026-11-03T12:00:00.000Z");
    assert.equal(subscriptionFee({ ...input, amount_usd: 8 }).facts[0].session_id, batch.facts[0].session_id);
    assert.doesNotMatch(JSON.stringify(batch), /private-invoice-canary/);
    for (const invalid of [{ currency: "EUR" }, { amount_usd: -1 }, { paid_at: "invalid" }, { paid_at: "2999-01-01T00:00:00Z" }, { unexpected: "content" }]) assert.throws(() => subscriptionFee({ ...input, ...invalid }));
  });
});
