/** Run with npx tsx scripts/collect-provider-usage.ts --provider openrouter|anthropic|all|claude-fee. */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAccount } from "../src/lib/usage-accounts";
import { openRouterAdapter } from "../src/lib/providers/openrouter";
import { anthropicAdminAdapter } from "../src/lib/providers/anthropic";
import { DAY_MS, utcMidnight, validatePeriod } from "../src/lib/providers/transport";
import { fleetOrigin, loadConfig, privateOutput, publishBatch, subscriptionFee } from "../src/lib/providers/collector";
import type { ProviderUsageBatch } from "../src/lib/providers/types";

export async function collectProviderUsage(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    provider: { type: "string" }, days: { type: "string", default: "30" }, since: { type: "string" }, until: { type: "string" },
    "env-file": { type: "string" }, output: { type: "string" }, publish: { type: "boolean", default: false },
    "allow-loopback": { type: "boolean", default: false }, "fee-file": { type: "string" },
  } });
  if (!["openrouter", "anthropic", "all", "claude-fee"].includes(values.provider ?? "")) throw new Error("Choose --provider openrouter, anthropic, all or claude-fee");
  const config = loadConfig(values["env-file"]);
  // Adapters use only these explicitly allowlisted names, never inference keys.
  for (const [name, value] of Object.entries(config)) if (name !== "MC_TOKEN" && name !== "MC_URL") process.env[name] = value;
  const origin = config.MC_URL ? fleetOrigin(config.MC_URL, values["allow-loopback"]) : null;
  if (values.publish && (!origin || !config.MC_TOKEN)) throw new Error("MC_URL and MC_TOKEN are required to publish");
  const batches: ProviderUsageBatch[] = [];
  if (values.provider === "claude-fee") {
    if (!values["fee-file"]) throw new Error("--fee-file is required for a recorded Claude fee");
    batches.push(subscriptionFee(JSON.parse(readFileSync(values["fee-file"], "utf8"))));
  } else {
    if (values["fee-file"]) throw new Error("--fee-file only applies to claude-fee");
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("--days must be 1 to 30");
    const until = values.until ? new Date(values.until) : utcMidnight();
    const since = values.since ? new Date(values.since) : new Date(until.getTime() - days * DAY_MS);
    validatePeriod(since, until);
    if (values.provider === "openrouter" || values.provider === "all") batches.push(await openRouterAdapter.fetchUsage(getAccount("openrouter-shared")!, since, until));
    if (values.provider === "anthropic" || values.provider === "all") batches.push(await anthropicAdminAdapter.fetchUsage(getAccount("anthropic-api-org")!, since, until));
  }
  // All provider requests and validation finish before the first publish.
  if (values.output) privateOutput(values.output, { version: 1, batches });
  for (const batch of batches) {
    if (values.publish) await publishBatch(batch, origin!, config.MC_TOKEN);
    console.log(JSON.stringify({ action: values.publish ? "published" : "dry_run", account: batch.snapshot?.account_id ?? batch.facts[0]?.account_id, facts: batch.facts.length, destination: origin, coverage: batch.snapshot?.detail?.coverage ?? null }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectProviderUsage().catch(() => { console.error("Cost collection failed; nothing is complete until a non-demo import receipt is confirmed. Check credentials, date range and provider access. No secret or provider response is logged."); process.exitCode = 1; });
}
