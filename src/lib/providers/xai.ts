/** Read-only xAI team analytics. USD and requests, never mixed billing units. */
import { createHash } from "node:crypto";
import type { ProviderAdapter } from "./types";
import type { UsageFact } from "../usage-types";
import { completedBatch } from "./coverage";
import { DAY_MS, jsonRequest, nonnegative, record, utcMidnight, usdSum, validatePeriod } from "./transport";

type Day = { start: number; cost: number; requests: number };
const time = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

async function report(key: string, team: string, since: Date, until: Date): Promise<Day[]> {
  const data = record(await jsonRequest(`https://management-api.x.ai/v1/billing/teams/${team}/usage`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ analyticsRequest: {
      timeRange: { startTime: time(since), endTime: time(until), timezone: "Etc/GMT" },
      timeUnit: "TIME_UNIT_DAY", values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }, { name: "transactions", aggregation: "AGGREGATION_SUM" }],
      groupBy: [], filters: [],
    } }),
  }));
  if (typeof data.limitReached !== "boolean" || !Array.isArray(data.timeSeries)) throw new Error("Invalid xAI report envelope");
  const days = (+until - +since) / DAY_MS;
  if (data.limitReached) {
    if (days <= 1) throw new Error("xAI daily report exceeded its row limit");
    const mid = new Date(+since + Math.floor(days / 2) * DAY_MS);
    // Discard truncated values; disjoint halves require at most 59 requests for 30 days.
    const left = await report(key, team, since, mid);
    return [...left, ...await report(key, team, mid, until)];
  }
  if (!data.timeSeries.length) return [];
  if (data.timeSeries.length !== 1) throw new Error("Unexpected xAI grouped report");
  const series = record(data.timeSeries[0]);
  for (const field of ["group", "groupLabels"]) {
    if (series[field] !== undefined && (!Array.isArray(series[field]) || series[field].length)) throw new Error("Unexpected xAI group dimension");
  }
  if (!Array.isArray(series.dataPoints) || series.dataPoints.length !== days) throw new Error("Incomplete xAI daily buckets");
  const seen = new Set<number>();
  return series.dataPoints.map((value) => {
    const row = record(value);
    const start = typeof row.timestamp === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(row.timestamp) ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(start) || start < +since || start >= +until || seen.has(start) || new Date(start).toISOString().slice(0, 10) !== String(row.timestamp).slice(0, 10)) throw new Error("Invalid xAI daily bucket");
    if (!Array.isArray(row.values) || row.values.length !== 2) throw new Error("Invalid xAI metric values");
    seen.add(start);
    return { start, cost: usdSum(0, nonnegative(row.values[0])), requests: nonnegative(row.values[1], true) };
  });
}

export const xaiManagementAdapter: ProviderAdapter = {
  id: "xai-management",
  async fetchUsage(account, since, until = utcMidnight()) {
    const key = process.env.MC_XAI_MANAGEMENT_KEY || process.env.XAI_MANAGEMENT_KEY;
    if (!key) throw new Error("MC_XAI_MANAGEMENT_KEY not set (management key required)");
    const team = process.env.MC_XAI_TEAM_ID || process.env.XAI_TEAM_ID;
    if (!team || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(team)) throw new Error("MC_XAI_TEAM_ID must be a path-safe team identifier");
    validatePeriod(since, until);
    const team_fingerprint = createHash("sha256").update(team).digest("hex");
    const rows = await report(key, team, since, until);
    const facts: UsageFact[] = rows.sort((a, b) => a.start - b.start).map((row) => ({
      source: "provider_api", account_id: account.id, model: "xai-team-total",
      session_id: `xai-usage:${team_fingerprint}:${new Date(row.start).toISOString().slice(0, 10)}`,
      billing_provider: "xai", billing_mode: "api", paid_cost_usd: row.cost, api_call_count: row.requests,
      cost_status: "provider_cost", first_seen_at: new Date(row.start).toISOString(), last_seen_at: new Date(row.start + DAY_MS - 1).toISOString(),
      detail: { team_fingerprint, scope: "all_team_resources", tokens: "not_collected" },
    }));
    return completedBatch(account.id, "xai", since, until, facts, { detail: { team_fingerprint, scope: "configured_team" } });
  },
};
