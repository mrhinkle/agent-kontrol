/** OpenRouter's management API reports the last 30 completed UTC days. */
import type { AccountRecord } from "../usage-accounts";
import type { UsageFact } from "../usage-types";
import type { AccountSnapshot, ProviderAdapter, ProviderUsageBatch } from "./types";
import { completedBatch } from "./coverage";
import { DAY_MS, jsonRequest, modelName, nonnegative, record, utcDay, utcMidnight, usdSum, validatePeriod } from "./transport";

const ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export interface OpenRouterActivityDay { date: string; model?: string; endpoint?: string; usage?: number; requests?: number; prompt_tokens?: number; completion_tokens?: number; }
export interface OpenRouterFixture { activity: unknown[]; credits?: { total_credits?: number; total_usage?: number }; }

function managementKey(): string {
  const key = process.env.MC_OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) throw new Error("MC_OPENROUTER_MANAGEMENT_KEY not set (management key required)");
  return key;
}

export function activityToFacts(account: AccountRecord, activity: unknown[]): UsageFact[] {
  const grouped = new Map<string, UsageFact>();
  for (const item of activity) {
    const row = record(item), day = utcDay(row.date), model = modelName(row.model);
    // Preserve the original identity so a full report corrects old endpoint collisions.
    const id = `or-activity:${day}:${model}`;
    const paid = nonnegative(row.usage);
    const requests = nonnegative(row.requests, true);
    const input = nonnegative(row.prompt_tokens, true), output = nonnegative(row.completion_tokens, true);
    const cached = row.cached_tokens == null ? 0 : nonnegative(row.cached_tokens, true);
    const reasoning = row.reasoning_tokens == null ? 0 : nonnegative(row.reasoning_tokens, true);
    const byok = row.byok_usage_inference == null ? 0 : nonnegative(row.byok_usage_inference);
    let fact = grouped.get(id);
    if (!fact) {
      fact = {
        source: "provider_api", account_id: account.id, session_id: id, model,
        billing_provider: "openrouter", billing_mode: "api", api_call_count: 0,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
        paid_cost_usd: 0, shadow_cost_usd: 0, cost_status: "provider_activity",
        first_seen_at: `${day}T00:00:00.000Z`,
        last_seen_at: new Date(Date.parse(day) + DAY_MS - 1).toISOString(),
        detail: { byok_inference_usd: 0 },
      };
      grouped.set(id, fact);
    }
    fact.paid_cost_usd = usdSum(fact.paid_cost_usd!, paid);
    fact.api_call_count = nonnegative(fact.api_call_count! + requests, true);
    fact.input_tokens = nonnegative(fact.input_tokens! + input, true);
    fact.output_tokens = nonnegative(fact.output_tokens! + output, true);
    fact.cache_read_tokens = nonnegative(fact.cache_read_tokens! + cached, true);
    fact.reasoning_tokens = nonnegative(fact.reasoning_tokens! + reasoning, true);
    fact.detail!.byok_inference_usd = usdSum(Number(fact.detail!.byok_inference_usd), byok);
  }
  return [...grouped.values()];
}

function creditsSnapshot(account: AccountRecord, value: unknown): AccountSnapshot {
  const row = record(value);
  const total = nonnegative(row.total_credits), usage = nonnegative(row.total_usage);
  return { account_id: account.id, collected_at: new Date().toISOString(), credits_remaining: total - usage };
}

/** Legacy synthetic fixture helper. It is deliberately not a coverage receipt. */
export async function fetchUsageFromFixture(account: AccountRecord, fixture: OpenRouterFixture): Promise<ProviderUsageBatch> {
  return { facts: activityToFacts(account, fixture.activity), snapshot: fixture.credits ? creditsSnapshot(account, fixture.credits) : undefined };
}

export const openRouterAdapter: ProviderAdapter = {
  id: "openrouter",
  async fetchUsage(account, since, until = utcMidnight()) {
    const key = managementKey();
    const today = utcMidnight();
    validatePeriod(since, until);
    if (since.getTime() < today.getTime() - 30 * DAY_MS) throw new Error("OpenRouter activity only covers the last 30 complete UTC days");
    // No date filter: that parameter selects just ONE day, not a range.
    const response = record(await jsonRequest(ACTIVITY_URL, { headers: { Authorization: `Bearer ${key}` } }));
    if (!Array.isArray(response.data)) throw new Error("OpenRouter activity data[] missing");
    const all = activityToFacts(account, response.data);
    const facts = all.filter((f) => Date.parse(f.first_seen_at!) >= since.getTime() && Date.parse(f.first_seen_at!) < until.getTime());
    let snapshot: Partial<AccountSnapshot> = { credits_remaining: null };
    try { snapshot = await this.fetchSnapshot!(account); } catch { /* Usage is valid even if balance is unavailable. */ }
    return completedBatch(account.id, "openrouter", since, until, facts, snapshot);
  },
  async fetchSnapshot(account) {
    const key = managementKey();
    const response = record(await jsonRequest(CREDITS_URL, { headers: { Authorization: `Bearer ${key}` } }));
    return creditsSnapshot(account, response.data);
  },
};
