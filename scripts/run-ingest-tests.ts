/**
 * Store-adjacent tests that do not require Neon:
 * - hermes_state-only fleet headlines (double-count regression)
 * - recursive privacy guard
 * - idempotency key stability
 */
import { aggregateUsageFacts, isHermesState } from "../src/lib/usage-aggregate";
import { usageIdempotentKey } from "../src/lib/usage-key";
import { assertNoContent } from "../src/lib/usage-privacy";
import type { UsageFact } from "../src/lib/usage-types";
import fs from "fs";
import path from "path";

function fact(partial: Partial<UsageFact> & Pick<UsageFact, "source" | "account_id" | "model" | "last_seen_at">): UsageFact {
  return {
    profile: "host/alpha",
    session_id: "s1",
    billing_provider: "",
    billing_mode: "",
    task: "",
    paid_cost_usd: 0,
    shadow_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    api_call_count: 1,
    ...partial,
  };
}

async function main() {
  const hermes = fact({
    source: "hermes_state",
    account_id: "hermes-mac-mini",
    model: "gpt-5.6-sol",
    last_seen_at: "2026-10-01T12:00:00Z",
    paid_cost_usd: 10,
    shadow_cost_usd: 100,
    billing_provider: "openai-codex",
  });
  const provider = fact({
    source: "provider_api",
    account_id: "openrouter-shared",
    model: "anthropic/claude-sonnet-5.5",
    last_seen_at: "2026-10-01T12:00:00Z",
    paid_cost_usd: 999,
    shadow_cost_usd: 0,
    billing_provider: "openrouter",
    session_id: "or-activity:2026-10-01:x",
  });

  if (!isHermesState(hermes) || isHermesState(provider)) throw new Error("isHermesState");

  const summary = aggregateUsageFacts([hermes, provider], {
    since: "2026-09-28T00:00:00Z",
    until: "2026-10-06T00:00:00Z",
  });
  if (summary.fleet.paid_cost_usd !== 10) {
    throw new Error(`double-count regression: fleet paid=${summary.fleet.paid_cost_usd} (want 10)`);
  }
  if (summary.fleet.shadow_cost_usd !== 100) throw new Error("shadow");
  if (summary.fleet.rows !== 1) throw new Error("rows");
  if (summary.openrouter?.activity_paid_usd !== 999) throw new Error("provider tile");
  console.log("double_count_guard_ok", summary.fleet.paid_cost_usd, summary.openrouter?.activity_paid_usd);

  const k1 = usageIdempotentKey(hermes);
  const k2 = usageIdempotentKey({
    source: hermes.source,
    account_id: hermes.account_id,
    profile: hermes.profile,
    session_id: hermes.session_id,
    model: hermes.model,
    billing_provider: hermes.billing_provider,
    billing_mode: hermes.billing_mode,
    task: hermes.task,
  });
  if (k1 !== k2) throw new Error("idempotency key unstable");
  console.log("idempotent_key_ok");

  let privacyOk = false;
  try {
    assertNoContent({ prompt: "SECRET" });
  } catch (e: any) {
    privacyOk = String(e.message).includes("privacy");
  }
  if (!privacyOk) throw new Error("privacy");
  let nestedOk = false;
  try {
    assertNoContent({ meta: { messages: ["x"] } });
  } catch (e: any) {
    nestedOk = String(e.message).includes("privacy");
  }
  if (!nestedOk) throw new Error("nested privacy");
  console.log("privacy_ok");

  // Cron names present in fixture map for synthetic-velocity
  const namesPath = path.join(process.cwd(), "tests/fixtures/cron-job-names.json");
  const names = JSON.parse(fs.readFileSync(namesPath, "utf8"));
  if (names.by_id["aa11bb22cc33"] !== "synthetic-velocity") {
    throw new Error("cron name fixture missing synthetic-velocity");
  }
  console.log("cron_name_fixture_ok", names.by_id["aa11bb22cc33"]);

  // Spot-check cron_job_name enrichment from synthetic collector output
  const factsPath = path.join(process.cwd(), ".data", "synth-reconcile-facts.json");
  if (fs.existsSync(factsPath)) {
    const payload = JSON.parse(fs.readFileSync(factsPath, "utf8"));
    const named = (payload.facts as UsageFact[]).filter((f) => f.cron_job_id && f.cron_job_name);
    console.log("cron_enriched", named.length);
    if (named.length === 0) throw new Error("expected cron_job_name enrichment from synthetic fixtures");
    if (!named.some((f) => f.cron_job_name === "synthetic-velocity")) {
      throw new Error("expected synthetic-velocity cron name");
    }
  } else {
    console.log("cron_enrichment_skip (run test:reconcile first)");
  }
}

main();
