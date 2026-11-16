import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { xaiManagementAdapter } from "../../src/lib/providers/xai";
import { subscriptionFee, literalConfig } from "../../src/lib/providers/collector";
import { getAccount } from "../../src/lib/usage-accounts";
import { aggregateUsageFacts } from "../../src/lib/usage-aggregate";
import { completedBatch } from "../../src/lib/providers/coverage";
import { UsageCostPanels } from "../../src/components/usage-cost-panels";
import { usageIdempotentKey } from "../../src/lib/usage-key";
import { DAY_MS } from "../../src/lib/providers/transport";
import type { UsageFact } from "../../src/lib/usage-types";

const env = { ...process.env }, fetcher = globalThis.fetch;
afterEach(() => { process.env = { ...env }; globalThis.fetch = fetcher; });
const until = new Date(); until.setUTCHours(0, 0, 0, 0);
const since = new Date(+until - 2 * DAY_MS);
const window = { since: since.toISOString(), until: until.toISOString() };
const account = getAccount("xai-api-team")!;
const response = (value: unknown) => new Response(JSON.stringify(value));
const point = (time: number, values: unknown[] = [1.25, 3]) => ({ timestamp: new Date(time).toISOString(), values });
const report = (dataPoints = [point(+since), point(+since + DAY_MS)], extra = {}) => ({ timeSeries: [{ group: [], dataPoints }], limitReached: false, ...extra });
const keys = () => { process.env.MC_XAI_MANAGEMENT_KEY = "management-canary"; process.env.MC_XAI_TEAM_ID = "private-team-canary"; };

it("reads xAI dollars and transactions, fixed host and exclusive UTC range, without token estimates or raw team IDs", async () => {
  keys();
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://management-api.x.ai/v1/billing/teams/private-team-canary/usage");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), { analyticsRequest: {
      timeRange: { startTime: window.since.slice(0, 19).replace("T", " "), endTime: window.until.slice(0, 19).replace("T", " "), timezone: "Etc/GMT" },
      timeUnit: "TIME_UNIT_DAY", values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }, { name: "transactions", aggregation: "AGGREGATION_SUM" }], groupBy: [], filters: [],
    } });
    return response(report([point(+since, [0.75973725, 7]), point(+since + DAY_MS, [0, 0])]));
  };
  const batch = await xaiManagementAdapter.fetchUsage(account, since, until);
  assert.equal(batch.facts.length, 2); assert.equal(batch.facts[0].paid_cost_usd, 0.75973725);
  assert.equal(batch.facts[0].api_call_count, 7); assert.equal(batch.facts[0].input_tokens, undefined);
  assert.equal(batch.facts[0].model, "xai-team-total");
  assert.doesNotMatch(JSON.stringify(batch), /management-canary|private-team-canary/);
  assert.equal(aggregateUsageFacts(batch.facts, { ...window, snapshots: [batch.snapshot!] }).providers?.[2].coverage, "complete");
});

it("never falls back to inference credentials and rejects unsafe team paths before requests", async () => {
  delete process.env.MC_XAI_MANAGEMENT_KEY; delete process.env.XAI_MANAGEMENT_KEY;
  process.env.XAI_API_KEY = "inference-canary";
  let calls = 0; globalThis.fetch = async () => { calls++; return response(report()); };
  await assert.rejects(() => xaiManagementAdapter.fetchUsage(account, since, until), /MANAGEMENT_KEY/);
  keys(); delete process.env.XAI_TEAM_ID;
  for (const team of ["", "../escape", "team/path", "team?x=1", "x".repeat(201)]) {
    process.env.MC_XAI_TEAM_ID = team;
    await assert.rejects(() => xaiManagementAdapter.fetchUsage(account, since, until), /TEAM_ID/);
  }
  assert.equal(calls, 0);
  assert.deepEqual(literalConfig("MC_XAI_MANAGEMENT_KEY=management\nMC_XAI_TEAM_ID=team\nXAI_API_KEY=secret"), { MC_XAI_MANAGEMENT_KEY: "management", MC_XAI_TEAM_ID: "team" });
});

it("rejects missing, duplicate, sparse, grouped, outside or invalid xAI buckets instead of reporting zero", async () => {
  keys();
  const invalid = [ {}, { timeSeries: [] }, { timeSeries: null, limitReached: false },
    report([], { limitReached: "false" }), report([]), report([point(+since)]),
    report([point(+since), point(+since)]), report([point(+since), point(+until)]),
    report([point(+since + 1), point(+since + DAY_MS)]),
    report(undefined, { timeSeries: [{ group: ["model"], dataPoints: [point(+since)] }] }),
    report(undefined, { timeSeries: [{ group: [], dataPoints: [] }, { group: [], dataPoints: [] }] }),
    ...[[undefined, 1], [-1, 1], ["1", 1], [1, 0.5], [1], [1, 1, 1]].map((v) => report([point(+since, v), point(+since + DAY_MS)])),
  ];
  for (const value of invalid) {
    globalThis.fetch = async () => response(value);
    await assert.rejects(() => xaiManagementAdapter.fetchUsage(account, since, until));
  }
  globalThis.fetch = async () => response({ timeSeries: [], limitReached: false });
  const quiet = await xaiManagementAdapter.fetchUsage(account, since, until);
  const summary = aggregateUsageFacts(quiet.facts, { ...window, snapshots: [quiet.snapshot!] });
  assert.equal(summary.providers?.[2].coverage, "complete"); assert.equal(summary.providers?.[2].cost_usd, 0);
});

it("splits truncated reports without overlap, caps at 59 requests for 30 days, and discards partial values", async () => {
  keys(); let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const range = JSON.parse(String(init?.body)).analyticsRequest.timeRange;
    const a = Date.parse(range.startTime.replace(" ", "T") + "Z"), b = Date.parse(range.endTime.replace(" ", "T") + "Z");
    return response(b - a > DAY_MS ? report([point(a, [9999, 999])], { limitReached: true }) : report([point(a, [0.1, 1])]));
  };
  const start = new Date(+until - 30 * DAY_MS);
  const batch = await xaiManagementAdapter.fetchUsage(account, start, until);
  assert.equal(calls, 59); assert.equal(batch.facts.length, 30); assert.equal(new Set(batch.facts.map((f) => f.session_id)).size, 30);
  const summary = aggregateUsageFacts(batch.facts, { since: start.toISOString(), until: window.until, snapshots: [batch.snapshot!] });
  assert.equal(summary.providers?.[2].cost_usd, 3);
  globalThis.fetch = async () => response(report([], { limitReached: true }));
  await assert.rejects(() => xaiManagementAdapter.fetchUsage(account, new Date(+until - DAY_MS), until), /limit/);
});

it("never publishes after a later xAI slice fails, including all-provider collection", async () => {
  keys(); process.env.MC_TOKEN = "fake"; process.env.MC_URL = "https://fleet.peripety.com";
  process.env.MC_OPENROUTER_MANAGEMENT_KEY = "fake"; process.env.MC_ANTHROPIC_ADMIN_KEY = "fake";
  let xai = 0, writes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://fleet.peripety.com")) { writes++; return response({ ok: true, written: 0 }); }
    if (String(url).includes("openrouter")) return response({ data: [] });
    if (String(url).includes("anthropic")) return response({ data: [], has_more: false });
    xai++;
    return xai === 1 ? response(report([], { limitReached: true })) : xai === 2 ? response(report([point(+since)])) : new Response("secret-canary", { status: 403 });
  };
  const { collectProviderUsage } = await import("../../scripts/collect-provider-usage");
  await assert.rejects(() => collectProviderUsage(["--provider", "all", "--since", window.since, "--until", window.until, "--publish"]), (e: Error) => !e.message.includes("secret-canary"));
  assert.equal(xai, 3); assert.equal(writes, 0);
});

it("keeps team identities distinct and only the latest configured team report visible", async () => {
  keys(); globalThis.fetch = async () => response(report());
  const first = await xaiManagementAdapter.fetchUsage(account, since, until);
  process.env.MC_XAI_TEAM_ID = "another-team";
  const second = await xaiManagementAdapter.fetchUsage(account, since, until);
  assert.notEqual(usageIdempotentKey(first.facts[0]), usageIdempotentKey(second.facts[0]));
  second.snapshot!.collected_at = "2090-01-01T00:00:00Z";
  const data = aggregateUsageFacts([...first.facts, ...second.facts], { ...window, snapshots: [first.snapshot!, second.snapshot!] });
  assert.equal(data.providers?.[2].cost_usd, 2.5); assert.equal(data.providers?.[2].coverage, "complete");
  assert.equal(data.by_account.find((r) => r.key === `${account.id}:provider_api`)?.paid_cost_usd, 2.5);
});

it("isolates Grok fees and OpenRouter subset, removes corrected rows, and distinguishes missing from measured zero", () => {
  const input = { invoice_id: "private-invoice", paid_at: new Date(+since + 1000).toISOString(), amount_usd: 12, currency: "USD" };
  const fee = subscriptionFee(input, until, "grok"), claudeFee = subscriptionFee(input, until);
  assert.equal(fee.facts[0].account_id, "supergrok-subscription");
  assert.notEqual(usageIdempotentKey(fee.facts[0]), usageIdempotentKey(claudeFee.facts[0]));
  assert.equal(usageIdempotentKey(subscriptionFee({ ...input, amount_usd: 15 }, until, "grok").facts[0]), usageIdempotentKey(fee.facts[0]));
  assert.doesNotMatch(JSON.stringify(fee), /private-invoice/);
  const f: UsageFact = { source: "provider_api", account_id: "openrouter-shared", model: "x-ai/grok-4.1-fast", session_id: "or-grok", paid_cost_usd: 3, cost_status: "provider_activity", last_seen_at: new Date(+until - 1).toISOString() };
  const batch = completedBatch("openrouter-shared", "openrouter", since, until, [f, { ...f, model: "anthropic/claude", session_id: "or-claude", paid_cost_usd: 5 }]);
  const baseline = aggregateUsageFacts(batch.facts, { ...window, snapshots: [batch.snapshot!] });
  const data = aggregateUsageFacts([...batch.facts, ...fee.facts], { ...window, snapshots: [batch.snapshot!] });
  assert.equal(data.grok?.openrouter_cost_usd, 3); assert.equal(data.providers?.[0].cost_usd, 8);
  assert.equal(data.grok?.subscription_fees_usd, 12); assert.equal(data.claude?.subscription_fees_usd, null);
  assert.deepEqual(data.fleet, { ...baseline.fleet, subscription_fees_usd: 12 });
  for (const key of ["by_profile", "by_model", "by_cron", "top_sessions", "claude", "providers"] as const) assert.deepEqual(data[key], baseline[key]);
  const html = renderToStaticMarkup(createElement(UsageCostPanels, { data }));
  assert.match(html, /Included in OpenRouter/); assert.match(html, /inherited or rolled-up usage/); assert.doesNotMatch(html, /\$23\.00/);
  const missing = aggregateUsageFacts([], window); assert.equal(missing.grok?.openrouter_cost_usd, null);
  const correction = completedBatch("openrouter-shared", "openrouter", since, until, []);
  const corrected = aggregateUsageFacts(batch.facts, { ...window, snapshots: [correction.snapshot!] });
  assert.equal(corrected.grok?.openrouter_cost_usd, 0); assert.equal(corrected.grok?.openrouter_coverage, "complete");
  const unverified = aggregateUsageFacts([{ ...f, model: "anthropic/claude" }], window);
  assert.equal(unverified.grok?.openrouter_cost_usd, null);
});
