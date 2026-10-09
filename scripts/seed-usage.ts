/**
 * Seed helper: POSTs collector dry-run facts to a running Mission Control
 * (requires DATABASE_URL + MC_TOKEN on the server).
 *
 *   python3 agents/usage-collector/collect_usage.py --dry-run --roots fixtures/hermes \
 *     --since 2026-09-28 --until 2026-10-06 --out .data/reconcile-facts.json
 *   MC_URL=http://127.0.0.1:3210 MC_TOKEN=dev npx tsx scripts/seed-usage.ts
 */
import fs from "fs";
import path from "path";

async function main() {
  const ROOT = process.cwd();
  const factsPath = path.join(ROOT, ".data", "reconcile-facts.json");
  if (!fs.existsSync(factsPath)) throw new Error("missing .data/reconcile-facts.json — run collector --out first");
  const mcUrl = (process.env.MC_URL || "http://127.0.0.1:3210").replace(/\/$/, "");
  const token = process.env.MC_TOKEN || "";
  const payload = JSON.parse(fs.readFileSync(factsPath, "utf8"));

  const fixture = JSON.parse(
    fs.readFileSync(path.join(ROOT, "tests/fixtures/openrouter-activity.json"), "utf8"),
  );
  // Attach OpenRouter fixture facts for reconcile tile in local demos
  const { fetchUsageFromFixture } = await import("../src/lib/providers/openrouter");
  const { getAccount } = await import("../src/lib/usage-accounts");
  const account = getAccount("openrouter-shared")!;
  const batch = await fetchUsageFromFixture(account, fixture);

  const body = {
    collected_at: payload.collected_at,
    kind: "backfill",
    facts: [...payload.facts, ...batch.facts],
    snapshot: batch.snapshot,
  };
  const res = await fetch(`${mcUrl}/api/usage/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ingest ${res.status}: ${text}`);
  console.log(text);
}
main();
