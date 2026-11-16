/** Anthropic Console Usage and Cost Analytics. Amounts are cents, after discounts, before credits. */
import type { ProviderAdapter } from "./types";
import type { UsageFact } from "../usage-types";
import { completedBatch } from "./coverage";
import { DAY_MS, jsonRequest, modelName, nonnegative, record, utcMidnight, usdSum, validatePeriod } from "./transport";

const BASE = "https://api.anthropic.com/v1/organizations/analytics/";
// Reserved label cannot pass modelName() and therefore cannot collide with a real model.
const UNALLOCATED = "(unallocated)";

export function centsToUsd(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error("Invalid or negative USD cents amount");
  return nonnegative(Number(value) / 100);
}

async function report(kind: "usage" | "cost", key: string, since: Date, until: Date) {
  const rows: Record<string, unknown>[] = [], cursors = new Set<string>();
  let page: string | null = null, refreshed: string | null = null;
  for (let n = 0; n < 100; n++) {
    const url = new URL(`${BASE}${kind}`);
    for (const [k, v] of Object.entries({ starting_at: since.toISOString(), ending_at: until.toISOString(), time_bucket_width: "1d", "group_by[]": "model", order_by: "time", order: "asc", limit: "1000" })) url.searchParams.set(k, v);
    if (page) url.searchParams.set("page", page);
    const data = record(await jsonRequest(url.href, { headers: {
      "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "analytics-usage-cost-2026-08-24",
    } }));
    if (!Array.isArray(data.data) || typeof data.has_more !== "boolean") throw new Error("Invalid Anthropic page");
    rows.push(...data.data.map(record));
    if (data.data_refreshed_at != null) {
      if (typeof data.data_refreshed_at !== "string" || !Number.isFinite(Date.parse(data.data_refreshed_at))) throw new Error("Invalid report freshness");
      if (!refreshed || Date.parse(data.data_refreshed_at) < Date.parse(refreshed)) refreshed = data.data_refreshed_at;
    }
    if (!data.has_more) return { rows, refreshed };
    if (typeof data.next_page !== "string" || !data.next_page || data.next_page.length > 4096 || cursors.has(data.next_page)) throw new Error("Missing or repeated Anthropic cursor");
    cursors.add(data.next_page); page = data.next_page;
  }
  throw new Error("Anthropic report exceeded 100 pages");
}

export const anthropicAdminAdapter: ProviderAdapter = {
  id: "anthropic-admin",
  async fetchUsage(account, since, until = utcMidnight()) {
    const key = process.env.MC_ANTHROPIC_ADMIN_KEY || process.env.ANTHROPIC_ADMIN_KEY;
    if (!key) throw new Error("MC_ANTHROPIC_ADMIN_KEY not set (Console admin key required)");
    validatePeriod(since, until);
    if (since.getTime() < Math.max(Date.parse("2026-01-01"), Date.now() - 365 * DAY_MS)) throw new Error("Anthropic report date is outside the supported history");
    // Both complete before constructing or publishing any batch.
    const usage = await report("usage", key, since, until);
    const cost = await report("cost", key, since, until);
    const facts = new Map<string, UsageFact>();
    for (const [kind, data] of [["usage", usage], ["cost", cost]] as const) {
      const seen = new Set<string>();
      for (const row of data.rows) {
        const start = typeof row.starting_at === "string" ? Date.parse(row.starting_at) : NaN;
        const end = typeof row.ending_at === "string" ? Date.parse(row.ending_at) : NaN;
        if (!Number.isFinite(start) || start % DAY_MS || end - start !== DAY_MS || start < since.getTime() || end > until.getTime()) throw new Error("Invalid Anthropic daily bucket");
        const group = record(row.group);
        if (!("model" in group)) throw new Error("Missing model dimension");
        const model = group.model === null ? UNALLOCATED : modelName(group.model);
        const id = `anthropic-analytics:${new Date(start).toISOString().slice(0, 10)}:${model}`;
        if (seen.has(id)) throw new Error("Duplicate Anthropic daily model bucket");
        seen.add(id);
        let fact = facts.get(id);
        if (!fact) {
          fact = { source: "provider_api", account_id: account.id, session_id: id, model,
            billing_provider: "anthropic", billing_mode: "api", first_seen_at: new Date(start).toISOString(),
            last_seen_at: new Date(end - 1).toISOString(), cost_status: "provider_usage_only", detail: { cost_reported: false } };
          facts.set(id, fact);
        }
        const metrics = record(row[kind]);
        if (kind === "cost") {
          if (metrics.currency !== "USD") throw new Error("Anthropic cost currency must be USD");
          fact.paid_cost_usd = usdSum(0, centsToUsd(metrics.amount));
          fact.cost_status = "provider_cost"; fact.detail!.cost_reported = true;
        } else {
          const cache = record(metrics.cache_creation);
          fact.input_tokens = nonnegative(metrics.uncached_input_tokens, true);
          fact.output_tokens = nonnegative(metrics.output_tokens, true);
          fact.cache_read_tokens = nonnegative(metrics.cache_read_input_tokens, true);
          fact.cache_write_tokens = nonnegative(nonnegative(cache.ephemeral_1h_input_tokens, true) + nonnegative(cache.ephemeral_5m_input_tokens, true), true);
          fact.api_call_count = nonnegative(metrics.requests, true);
        }
      }
    }
    const freshness = [usage.refreshed, cost.refreshed].filter((v): v is string => !!v).sort();
    return completedBatch(account.id, "anthropic", since, until, [...facts.values()], {}, freshness[0] ?? null);
  },
};
