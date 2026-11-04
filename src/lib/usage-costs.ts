/** Provider invoices and local Claude observations never enter Hermes attribution. */
import type { AccountSnapshot } from "./providers/types";
import type { ClaudeUsageSummary, ProviderCostSummary, UsageFact } from "./usage-types";

const DAY = 86_400_000;
const accounts = [
  { id: "openrouter-shared", provider: "openrouter", label: "OpenRouter", note: "Provider-reported inference charges. External BYOK costs are excluded." },
  { id: "anthropic-api-org", provider: "anthropic", label: "Claude API", note: "After discounts, before credits. Separate Priority Tier commitment fees are not included." },
];

type Coverage = { since: string; until: string; status: "complete" | "partial"; report_id?: string; fact_count?: number; data_refreshed_at?: string | null };
function coverage(snapshot: AccountSnapshot | undefined, provider: string): Coverage | null {
  const v = snapshot?.detail?.coverage as Record<string, unknown> | undefined;
  if (!v || v.version !== 1 || v.provider !== provider || !["complete", "partial"].includes(String(v.status)) ||
      typeof v.since !== "string" || typeof v.until !== "string" || !Number.isFinite(Date.parse(v.since)) ||
      !Number.isFinite(Date.parse(v.until)) || Date.parse(v.since) >= Date.parse(v.until)) return null;
  return v as unknown as Coverage;
}
const within = (f: UsageFact, since: string, until: string) => Date.parse(f.last_seen_at) >= Date.parse(since) && Date.parse(f.last_seen_at) < Date.parse(until);
const sum = (facts: UsageFact[], field: keyof UsageFact) => facts.reduce((total, f) => total + Number(f[field] ?? 0), 0);
const money = (facts: UsageFact[]) => Math.round(sum(facts, "paid_cost_usd") * 1e10) / 1e10;

/** Keep the legacy account breakdown aligned with authoritative report corrections too. */
export function currentProviderFacts(facts: UsageFact[], snapshots: AccountSnapshot[]): UsageFact[] {
  const reportIds = new Map<string, string>();
  for (const account of accounts) {
    const snapshot = snapshots.filter((s) => s.account_id === account.id).sort((a, b) => b.collected_at.localeCompare(a.collected_at))[0];
    const receipt = coverage(snapshot, account.provider);
    if (receipt?.report_id) reportIds.set(account.id, receipt.report_id);
  }
  return facts.filter((f) => f.source !== "provider_api" || !reportIds.has(f.account_id) || f.detail?.report_id === reportIds.get(f.account_id));
}

export function providerCosts(facts: UsageFact[], snapshots: AccountSnapshot[], window: { since: string; until: string }): ProviderCostSummary[] {
  return accounts.map((account) => {
    const snapshot = snapshots.filter((s) => s.account_id === account.id).sort((a, b) => b.collected_at.localeCompare(a.collected_at))[0];
    const receipt = coverage(snapshot, account.provider);
    const all = facts.filter((f) => f.source === "provider_api" && f.account_id === account.id);
    const report = receipt?.report_id ? all.filter((f) => f.detail?.report_id === receipt.report_id) : all;
    const validReceipt = !!receipt && receipt.status === "complete" && /^[a-f0-9]{64}$/.test(receipt.report_id ?? "") &&
      Number.isSafeInteger(receipt.fact_count) && receipt.fact_count === report.length;
    const selected = report.filter((f) => within(f, window.since, window.until));
    const known = selected.filter((f) => f.cost_status !== "provider_usage_only");
    const dayWindow = Date.parse(window.since) % DAY === 0 && Date.parse(window.until) % DAY === 0 && Date.parse(window.until) > Date.parse(window.since);
    const covers = (start: string, end: string) => dayWindow && validReceipt && Date.parse(receipt!.since) <= Date.parse(start) && Date.parse(receipt!.until) >= Date.parse(end);
    const status = covers(window.since, window.until) ? "complete" : validReceipt ? "partial" : all.length || snapshot ? "unverified" : "missing";
    const daily: ProviderCostSummary["daily"] = [];
    for (let t = Date.parse(window.since); t < Date.parse(window.until) && daily.length < 31; t += DAY) {
      const start = new Date(t).toISOString(), end = new Date(t + DAY).toISOString();
      const rows = known.filter((f) => within(f, start, end));
      daily.push({ date: start.slice(0, 10), cost_usd: rows.length || covers(start, end) ? money(rows) : null });
    }
    return {
      account_id: account.id, label: account.label, coverage: status,
      cost_usd: known.length || status === "complete" ? money(known) : null,
      collected_at: snapshot?.collected_at ?? null,
      data_refreshed_at: typeof receipt?.data_refreshed_at === "string" ? receipt.data_refreshed_at : null,
      credits_remaining: snapshot?.credits_remaining ?? null,
      rows: selected.length, note: account.note + (dayWindow ? "" : " Only daily buckets are available for this partial-day query."), daily,
    };
  });
}

export function claudeUsage(facts: UsageFact[], snapshots: AccountSnapshot[], window: { since: string; until: string }): ClaudeUsageSummary {
  const rows = facts.filter((f) => f.source === "claude_code" && within(f, window.since, window.until));
  const priced = rows.filter((f) => f.cost_status === "local_reported_estimate");
  const fees = facts.filter((f) => f.source === "subscription_fee" && f.account_id === "claude-subscription" && within(f, window.since, window.until));
  const modes = { subscription: 0, api: 0, unknown: 0 };
  for (const f of rows) {
    const mode = f.detail?.billing_mode;
    modes[mode === "subscription" || mode === "api" ? mode : "unknown"] += f.api_call_count ?? 1;
  }
  return {
    requests: sum(rows, "api_call_count"), input_tokens: sum(rows, "input_tokens"), output_tokens: sum(rows, "output_tokens"),
    cache_read_tokens: sum(rows, "cache_read_tokens"), cache_write_tokens: sum(rows, "cache_write_tokens"),
    reported_estimate_usd: priced.length ? sum(priced, "shadow_cost_usd") : null,
    unpriced_requests: sum(rows.filter((f) => f.cost_status !== "local_reported_estimate"), "api_call_count"),
    subscription_fees_usd: fees.length ? money(fees) : null, fee_records: fees.length, billing_modes: modes,
    machines: snapshots.filter((s) => s.account_id.startsWith("claude-code:")).map((s) => {
      const c = coverage(s, "claude_code");
      return { account_id: s.account_id, collected_at: s.collected_at, status: c?.status ?? "unverified", since: c?.since ?? null, until: c?.until ?? null };
    }),
  };
}
