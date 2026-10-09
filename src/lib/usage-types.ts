export type UsageSource =
  | "hermes_state"
  | "provider_api"
  | "subscription_fee"
  | "quota_snapshot";

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
    subscription_fees_usd: number;
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
