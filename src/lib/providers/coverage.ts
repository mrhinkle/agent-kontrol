import { createHash } from "node:crypto";
import type { AccountSnapshot, ProviderUsageBatch } from "./types";
import type { UsageFact } from "../usage-types";

/** A report identity lets reads exclude rows removed by a later corrected report. */
export function completedBatch(
  account: string, provider: string, since: Date, until: Date, facts: UsageFact[],
  extra: Partial<AccountSnapshot> = {}, refreshedAt: string | null = null,
): ProviderUsageBatch {
  const collected_at = new Date().toISOString();
  const report_id = createHash("sha256").update(JSON.stringify([account, since, until, collected_at, facts])).digest("hex");
  return {
    facts: facts.map((fact) => ({ ...fact, detail: { ...fact.detail, report_id } })),
    snapshot: {
      ...extra, account_id: account, collected_at,
      detail: { ...extra.detail, coverage: {
        version: 1, provider, since: since.toISOString(), until: until.toISOString(),
        status: "complete", report_id, fact_count: facts.length, data_refreshed_at: refreshedAt,
      } },
    },
  };
}
