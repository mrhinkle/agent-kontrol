/**
 * Pure aggregation helpers — used by the Neon store and by regression tests
 * that prove provider_api rows cannot inflate fleet headlines.
 */
import type { TopSession, UsageBucket, UsageFact, UsageSummary } from "./usage-types";

export function isHermesState(f: Pick<UsageFact, "source">): boolean {
  return f.source === "hermes_state";
}

export function isOpenRouterProvider(bp: string | null | undefined): boolean {
  const s = (bp || "").toLowerCase();
  return s.includes("openrouter") || s.includes("fallback_chain");
}

function bucketize(
  facts: UsageFact[],
  keyFn: (f: UsageFact) => string,
  labelFn?: (key: string, f: UsageFact) => string,
): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  for (const f of facts) {
    const key = keyFn(f) || "(none)";
    let b = map.get(key);
    if (!b) {
      b = {
        key,
        label: labelFn ? labelFn(key, f) : key,
        paid_cost_usd: 0,
        shadow_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        api_call_count: 0,
        rows: 0,
      };
      map.set(key, b);
    }
    b.paid_cost_usd += Number(f.paid_cost_usd ?? 0);
    b.shadow_cost_usd += Number(f.shadow_cost_usd ?? 0);
    b.input_tokens += Number(f.input_tokens ?? 0);
    b.output_tokens += Number(f.output_tokens ?? 0);
    b.cache_read_tokens += Number(f.cache_read_tokens ?? 0);
    b.api_call_count += Number(f.api_call_count ?? 0);
    b.rows += 1;
  }
  return Array.from(map.values()).sort(
    (a, b) => b.paid_cost_usd + b.shadow_cost_usd - (a.paid_cost_usd + a.shadow_cost_usd),
  );
}

export function aggregateUsageFacts(
  facts: UsageFact[],
  opts: {
    since: string;
    until: string;
    collected_at?: string | null;
    openrouter?: UsageSummary["openrouter"];
  },
): UsageSummary {
  const agentFacts = facts.filter(isHermesState);
  const paid = agentFacts.reduce((s, f) => s + Number(f.paid_cost_usd ?? 0), 0);
  const shadow = agentFacts.reduce((s, f) => s + Number(f.shadow_cost_usd ?? 0), 0);
  const input = agentFacts.reduce((s, f) => s + Number(f.input_tokens ?? 0), 0);
  const output = agentFacts.reduce((s, f) => s + Number(f.output_tokens ?? 0), 0);
  const cache = agentFacts.reduce((s, f) => s + Number(f.cache_read_tokens ?? 0), 0);
  const calls = agentFacts.reduce((s, f) => s + Number(f.api_call_count ?? 0), 0);
  const denom = input + cache;
  const cache_hit_rate = denom > 0 ? cache / denom : 0;

  const sessionMap = new Map<string, TopSession>();
  for (const f of agentFacts) {
    const k = `${f.profile}|${f.session_id}|${f.model}`;
    let s = sessionMap.get(k);
    if (!s) {
      s = {
        profile: f.profile ?? "",
        session_id: f.session_id ?? "",
        model: f.model,
        paid_cost_usd: 0,
        shadow_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        last_seen_at: f.last_seen_at,
        cron_job_id: f.cron_job_id,
        cron_job_name: f.cron_job_name,
      };
      sessionMap.set(k, s);
    }
    s.paid_cost_usd += Number(f.paid_cost_usd ?? 0);
    s.shadow_cost_usd += Number(f.shadow_cost_usd ?? 0);
    s.input_tokens += Number(f.input_tokens ?? 0);
    s.output_tokens += Number(f.output_tokens ?? 0);
    s.cache_read_tokens += Number(f.cache_read_tokens ?? 0);
    if (f.last_seen_at > s.last_seen_at) s.last_seen_at = f.last_seen_at;
    if (f.cron_job_name) s.cron_job_name = f.cron_job_name;
  }

  const hermesOpenrouterPaid = agentFacts
    .filter((f) => isOpenRouterProvider(f.billing_provider))
    .reduce((s, f) => s + Number(f.paid_cost_usd ?? 0), 0);
  const providerPaid = facts
    .filter((f) => f.source === "provider_api" && f.account_id === "openrouter-shared")
    .reduce((s, f) => s + Number(f.paid_cost_usd ?? 0), 0);

  let reconcile_delta_pct: number | null = null;
  if (providerPaid > 0) {
    reconcile_delta_pct = ((hermesOpenrouterPaid - providerPaid) / providerPaid) * 100;
  }

  const openrouter = opts.openrouter ?? {
    activity_paid_usd: providerPaid > 0 ? providerPaid : null,
    credits_remaining: null,
    reconcile_delta_pct,
    note:
      providerPaid > 0
        ? "Hermes openrouter-attributed paid vs OpenRouter /activity"
        : "OpenRouter adapter not yet ingested",
  };

  return {
    window: { since: opts.since, until: opts.until },
    fleet: {
      paid_cost_usd: paid,
      shadow_cost_usd: shadow,
      subscription_fees_usd: 0,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cache,
      api_call_count: calls,
      rows: agentFacts.length,
      cache_hit_rate,
    },
    by_profile: bucketize(agentFacts, (f) => f.profile || "(unknown)"),
    by_cron: bucketize(
      agentFacts.filter((f) => f.cron_job_id),
      (f) => f.cron_job_id || "(none)",
      (key, f) => (f.cron_job_name ? `${f.cron_job_name} (${key})` : key),
    ),
    by_model: bucketize(agentFacts, (f) => f.model),
    by_account: bucketize(facts, (f) => `${f.account_id}:${f.source}`),
    top_sessions: Array.from(sessionMap.values())
      .sort((a, b) => b.paid_cost_usd + b.shadow_cost_usd - (a.paid_cost_usd + a.shadow_cost_usd))
      .slice(0, 15),
    openrouter,
    collected_at: opts.collected_at ?? null,
  };
}
