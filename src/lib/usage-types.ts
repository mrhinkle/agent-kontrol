export const USAGE_SOURCES = [
  "hermes_state",
  "provider_api",
  "subscription_fee",
  "quota_snapshot",
  "claude_code",
] as const;

export type UsageSource = (typeof USAGE_SOURCES)[number];

export interface UsageFact {
  source: UsageSource;
  account_id: string;
  profile?: string | null;
  session_id?: string | null;
  model: string;
  billing_provider?: string | null;
  billing_mode?: string | null;
  cron_job_id?: string | null;
  cron_job_name?: string | null;
  task?: string | null;
  api_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  paid_cost_usd?: number;
  shadow_cost_usd?: number;
  price_version?: string | null;
  cost_status?: string | null;
  first_seen_at?: string | null;
  last_seen_at: string;
  detail?: Record<string, unknown> | null;
}

export interface UsageIngestInput {
  collected_at?: string;
  kind?: string;
  facts: UsageFact[];
}

export interface UsageBucket {
  key: string;
  label: string;
  paid_cost_usd: number;
  shadow_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  api_call_count: number;
  rows: number;
}

export interface TopSession {
  profile: string;
  session_id: string;
  model: string;
  paid_cost_usd: number;
  shadow_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  last_seen_at: string;
  cron_job_id?: string | null;
  cron_job_name?: string | null;
}

export interface UsageSummary {
  window: { since: string; until: string };
  fleet: {
    paid_cost_usd: number;
    shadow_cost_usd: number;
    subscription_fees_usd: number | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    api_call_count: number;
    rows: number;
    cache_hit_rate: number;
  };
  by_profile: UsageBucket[];
  by_cron: UsageBucket[];
  by_model: UsageBucket[];
  by_account: UsageBucket[];
  top_sessions: TopSession[];
  openrouter?: {
    activity_paid_usd: number | null;
    credits_remaining: number | null;
    reconcile_delta_pct: number | null;
    note: string;
  };
  providers?: ProviderCostSummary[];
  provider_window?: { since: string; until: string };
  claude?: ClaudeUsageSummary;
  grok?: GrokUsageSummary;
  collected_at: string | null;
  /** True only when DATABASE_URL is unset — never in production Neon reads. */
  demo?: boolean;
  /** True when usage_* tables are missing (Postgres 42P01) — migration not run. */
  setup_required?: boolean;
  /** Human-readable setup hint when setup_required. */
  setup_message?: string;
  /** Selected rolling window label when resolved via ?window=. */
  window_label?: string | null;
}

export interface ProviderCostSummary {
  account_id: string;
  label: string;
  cost_usd: number | null;
  coverage: "complete" | "partial" | "unverified" | "missing";
  collected_at: string | null;
  data_refreshed_at: string | null;
  credits_remaining: number | null;
  rows: number;
  note: string;
  daily: { date: string; cost_usd: number | null }[];
}

export interface ClaudeUsageSummary {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reported_estimate_usd: number | null;
  unpriced_requests: number;
  subscription_fees_usd: number | null;
  fee_records: number;
  billing_modes: { subscription: number; api: number; unknown: number };
  machines: { account_id: string; collected_at: string; status: "complete" | "partial" | "unverified"; since: string | null; until: string | null }[];
  /** API-equivalent value of the observed tokens. An estimate, never a charge. */
  shadow: ShadowCostSummary;
}

/**
 * What subscription usage would have cost at the vendor's published API prices.
 * `usd` is null, never 0, when no row in the window could be priced.
 */
export interface ShadowCostSummary {
  usd: number | null;
  status: "priced" | "partial" | "unavailable";
  unavailable_reason: "no_token_feed" | "no_rows" | "only_api_billed" | "no_priced_rows" | null;
  basis: "api_list_price";
  /** Collectors report one cache-write total, priced at the 5-minute rate: a lower bound. */
  cache_write_basis: "5m_rate_lower_bound";
  rate_version: string;
  rates_checked_at: string;
  priced_requests: number;
  unpriced_requests: number;
  unpriced: { missing_model: number; unknown_model: number; missing_tokens: number };
  /** Requests the operator marked as API-billed: already metered spend, so left out. */
  excluded_api_requests: number;
  /** Priced requests whose payment method was not recorded; included in `usd`. */
  unclassified_requests: number;
  unknown_models: string[];
  by_model: { model: string; requests: number; usd: number; long_prompt_requests: number; source_url: string }[];
}

export interface GrokUsageSummary {
  subscription_fees_usd: number | null;
  fee_records: number;
  openrouter_cost_usd: number | null;
  openrouter_coverage: ProviderCostSummary["coverage"];
  local_usage_status: "unavailable";
  /** Unavailable until a Grok token feed exists; rates are already in the table. */
  shadow: ShadowCostSummary;
}
