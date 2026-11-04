import { fetchUsageFromFixture, openRouterAdapter } from "../src/lib/providers/openrouter";
import { openAIAdminAdapter } from "../src/lib/providers/openai";
import { anthropicAdminAdapter } from "../src/lib/providers/anthropic";
import { xaiManagementAdapter } from "../src/lib/providers/xai";
import { getAccount } from "../src/lib/usage-accounts";
import fs from "fs";

async function main() {
  const account = getAccount("openrouter-shared")!;
  const fixture = JSON.parse(fs.readFileSync("tests/fixtures/openrouter-activity.json", "utf8"));
  const batch = await fetchUsageFromFixture(account, fixture);
  if (batch.facts.length !== fixture.activity.length) throw new Error("fact count");
  const paid = batch.facts.reduce((s, f) => s + (f.paid_cost_usd || 0), 0);
  if (Math.abs(paid - 26.62) > 0.001) throw new Error("paid sum " + paid);
  for (const f of batch.facts) {
    if (f.source !== "provider_api") throw new Error("source");
    if (f.account_id !== "openrouter-shared") throw new Error("account");
    if ("prompt" in (f.detail || {})) throw new Error("privacy");
  }
  if (!batch.snapshot || batch.snapshot.credits_remaining == null) throw new Error("snapshot");
  console.log("openrouter_fixture_ok", paid, batch.snapshot.credits_remaining);

  let threw = false;
  try {
    await openRouterAdapter.fetchUsage(account, new Date("2026-09-28"));
  } catch (e: any) {
    threw = String(e.message).includes("MC_OPENROUTER_MANAGEMENT_KEY");
  }
  if (!threw) throw new Error("expected missing-key error");
  console.log("openrouter_missing_key_ok");

  for (const [name, a] of [
    ["openai", openAIAdminAdapter],
  ] as const) {
    let ok = false;
    try {
      await a.fetchUsage(account, new Date());
    } catch (e: any) {
      ok = String(e.message).includes("Phase 2");
    }
    if (!ok) throw new Error(name + " stub");
  }
  let missingAdmin = false;
  try { await anthropicAdminAdapter.fetchUsage(getAccount("anthropic-api-org")!, new Date()); }
  catch (e: any) { missingAdmin = String(e.message).includes("MC_ANTHROPIC_ADMIN_KEY"); }
  if (!missingAdmin) throw new Error("expected missing Anthropic admin key");
  let missingXai = false;
  try { await xaiManagementAdapter.fetchUsage(getAccount("xai-api-team")!, new Date()); }
  catch (e: any) { missingXai = String(e.message).includes("MC_XAI_MANAGEMENT_KEY"); }
  if (!missingXai) throw new Error("expected missing xAI management key");
  console.log("xai_missing_management_ok");
  console.log("anthropic_missing_admin_ok");
  console.log("phase2_stubs_ok");
}
main();
