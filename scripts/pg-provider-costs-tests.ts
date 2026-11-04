/** Run only from test:pg against its disposable schema. No migration is added. */
import assert from "node:assert/strict";
import { sql } from "../src/lib/db";
import { getUsageSummary, ingestUsageBatch } from "../src/lib/usage-store";
import { activityToFacts } from "../src/lib/providers/openrouter";
import { getAccount } from "../src/lib/usage-accounts";
import { usageIdempotentKey } from "../src/lib/usage-key";
import type { UsageFact } from "../src/lib/usage-types";

export async function testProviderCosts() {
  const window = { since: "2026-11-03T00:00:00.000Z", until: "2026-11-04T00:00:00.000Z" };
  const model = "cost-test/claude", report_id = "c".repeat(64);
  const account = getAccount("openrouter-shared")!;
  const old: UsageFact = { source: "provider_api", account_id: account.id, session_id: "or-activity:2026-11-03:cost-test/claude", model, billing_provider: "openrouter", billing_mode: "api", paid_cost_usd: 1, last_seen_at: "2026-11-03T23:59:59Z" };
  const local: UsageFact = { source: "claude_code", account_id: "claude-code:cost-test", session_id: "cost-test-request", model, billing_mode: "observation", api_call_count: 1, paid_cost_usd: 0, shadow_cost_usd: 4, cost_status: "local_reported_estimate", last_seen_at: "2026-11-03T12:00:00Z", detail: { billing_mode: "subscription" } };
  const snapshot = { account_id: account.id, collected_at: "2090-01-01T00:00:00.000Z", detail: { coverage: { version: 1, provider: "openrouter", ...window, status: "complete", report_id, fact_count: 1 } } };
  try {
    assert.equal(await ingestUsageBatch({ facts: [old, local] }), 2);
    const updated = activityToFacts(account, [1, 2].map((usage) => ({ date: "2026-11-03", model, usage, requests: 1, prompt_tokens: 5, completion_tokens: 3 })));
    assert.equal(updated[0].session_id, "or-activity:2026-11-03:cost-test/claude");
    updated[0].detail = { report_id };
    assert.equal(await ingestUsageBatch({ facts: updated, snapshot }), 1);
    const stored = await sql()`select paid_cost_usd from usage_facts where idempotency_key = ${usageIdempotentKey(old)}`;
    assert.equal(stored.length, 1); assert.equal(Number(stored[0].paid_cost_usd), 3);
    const first = await getUsageSummary(window);
    assert.equal(first.providers?.[0].coverage, "complete"); assert.equal(first.providers?.[0].cost_usd, 3);
    assert.equal(first.claude?.reported_estimate_usd, 4); assert.equal(first.claude?.billing_modes.subscription, 1);
    // PostgreSQL accepts the distinct source on the unchanged schema.
    const sources = await sql()`select source from usage_facts where account_id = 'claude-code:cost-test'`;
    assert.equal(sources[0].source, "claude_code");
    await assert.rejects(() => ingestUsageBatch({ facts: [{ ...updated[0], paid_cost_usd: 999 }], snapshot: { ...snapshot, collected_at: "invalid" } }));
    assert.equal((await getUsageSummary(window)).providers?.[0].cost_usd, 3, "snapshot failure rolled back updated facts");
    await ingestUsageBatch({ facts: [], snapshot: { ...snapshot, collected_at: "2090-01-02T00:00:00Z", detail: { coverage: { ...snapshot.detail.coverage, report_id: "d".repeat(64), fact_count: 0 } } } });
    const corrected = await getUsageSummary(window);
    assert.equal(corrected.providers?.[0].coverage, "complete"); assert.equal(corrected.providers?.[0].cost_usd, 0, "removed model does not survive correction");
  } finally {
    await sql()`delete from usage_facts where idempotency_key = ${usageIdempotentKey(old)} or account_id = 'claude-code:cost-test'`;
    await sql()`delete from account_snapshots where account_id = ${account.id} and collected_at >= '2090-01-01' and collected_at <= '2090-01-03'`;
  }
  console.log("provider_costs_pg_ok: legacy upsert, claude source, atomic rollback, persisted coverage, removed model");
}
