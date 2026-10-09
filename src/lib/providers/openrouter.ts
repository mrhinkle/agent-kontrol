/**
 * OpenRouter adapter — Phase 1.
 * Uses management key from env (MC_OPENROUTER_MANAGEMENT_KEY).
 * When no key is present, callers may pass a fixture via fetchUsageFromFixture.
 */
import type { AccountRecord } from "../usage-accounts";
import type { UsageFact } from "../usage-types";
import type { AccountSnapshot, ProviderAdapter, ProviderUsageBatch } from "./types";

const ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

export interface OpenRouterActivityDay {
  date: string; // YYYY-MM-DD
  model?: string;
  endpoint?: string;
  usage?: number; // USD
  requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface OpenRouterFixture {
  activity: OpenRouterActivityDay[];
  credits?: { total_credits?: number; total_usage?: number };
}

function managementKey(): string | undefined {
  return process.env.MC_OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_MANAGEMENT_KEY;
}

export function activityToFacts(
  account: AccountRecord,
  activity: OpenRouterActivityDay[],
): UsageFact[] {
  return activity.map((day) => {
    const model = day.model || day.endpoint || "openrouter/unknown";
    const paid = Number(day.usage ?? 0);
    // Bucket per day+model for idempotency
    const session_id = `or-activity:${day.date}:${model}`;
    return {
      source: "provider_api",
      account_id: account.id,
      profile: null,
      session_id,
      model,
      billing_provider: "openrouter",
      billing_mode: "api",
      cron_job_id: null,
      task: null,
      api_call_count: Number(day.requests ?? 0),
      input_tokens: Number(day.prompt_tokens ?? 0),
      output_tokens: Number(day.completion_tokens ?? 0),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      paid_cost_usd: paid,
      shadow_cost_usd: 0,
      price_version: null,
      cost_status: "provider_activity",
      first_seen_at: `${day.date}T00:00:00Z`,
      last_seen_at: `${day.date}T23:59:59Z`,
      detail: { endpoint: day.endpoint ?? null },
    };
  });
}

export async function fetchUsageFromFixture(
  account: AccountRecord,
  fixture: OpenRouterFixture,
): Promise<ProviderUsageBatch> {
  const facts = activityToFacts(account, fixture.activity);
  const snapshot: AccountSnapshot | undefined = fixture.credits
    ? {
        account_id: account.id,
        collected_at: new Date().toISOString(),
        credits_remaining:
          fixture.credits.total_credits != null && fixture.credits.total_usage != null
            ? fixture.credits.total_credits - fixture.credits.total_usage
            : null,
        balance_usd: null,
        detail: { ...fixture.credits },
      }
    : undefined;
  return { facts, snapshot };
}

export const openRouterAdapter: ProviderAdapter = {
  id: "openrouter",
  async fetchUsage(account, since) {
    const key = managementKey();
    if (!key) {
      throw new Error(
        "MC_OPENROUTER_MANAGEMENT_KEY not set — use fetchUsageFromFixture in tests/prototype",
      );
    }
    const date = since.toISOString().slice(0, 10);
    const res = await fetch(`${ACTIVITY_URL}?date=${date}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`OpenRouter activity ${res.status}`);
    const data = (await res.json()) as { data?: OpenRouterActivityDay[] } | OpenRouterActivityDay[];
    const activity = Array.isArray(data) ? data : data.data ?? [];
    const facts = activityToFacts(account, activity);

    let snapshot: AccountSnapshot | undefined;
    try {
      const cred = await fetch(CREDITS_URL, { headers: { Authorization: `Bearer ${key}` } });
      if (cred.ok) {
        const c = (await cred.json()) as {
          data?: { total_credits?: number; total_usage?: number };
        };
        const d = c.data ?? {};
        snapshot = {
          account_id: account.id,
          collected_at: new Date().toISOString(),
          credits_remaining:
            d.total_credits != null && d.total_usage != null
              ? d.total_credits - d.total_usage
              : null,
          detail: d,
        };
      }
    } catch {
      // credits optional
    }
    return { facts, snapshot };
  },
  async fetchSnapshot(account) {
    const key = managementKey();
    if (!key) throw new Error("MC_OPENROUTER_MANAGEMENT_KEY not set");
    const cred = await fetch(CREDITS_URL, { headers: { Authorization: `Bearer ${key}` } });
    if (!cred.ok) throw new Error(`OpenRouter credits ${cred.status}`);
    const c = (await cred.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const d = c.data ?? {};
    return {
      account_id: account.id,
      collected_at: new Date().toISOString(),
      credits_remaining:
        d.total_credits != null && d.total_usage != null
          ? d.total_credits - d.total_usage
          : null,
      detail: d,
    };
  },
};
