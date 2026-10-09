/**
 * Non-secret account registry for Usage and Costs.
 * Secret values live only in env vars named by `secret_env`.
 * See Agent Kontrol issue #12.
 */

export type BillingType = "api" | "subscription" | "credits" | "agent_logged";

export interface AccountRecord {
  id: string;
  provider:
    | "openrouter"
    | "openai"
    | "anthropic"
    | "xai"
    | "deepseek"
    | "nous"
    | "hermes";
  label: string;
  billing_type: BillingType;
  monthly_fee_usd?: number | null;
  currency: "usd";
  secret_env?: string;
  secret_kind?: "admin" | "management" | "api_readonly" | "oauth_refresh";
  reconcile_with?: string[];
  notes?: string;
  active?: boolean;
}

export const USAGE_ACCOUNTS: AccountRecord[] = [
  {
    id: "hermes-mac-mini",
    provider: "hermes",
    label: "Hermes Mac Mini (agent-logged)",
    billing_type: "agent_logged",
    currency: "usd",
    notes: "System of record for profile/cron attribution and Codex shadow.",
    active: true,
  },
  {
    id: "openrouter-shared",
    provider: "openrouter",
    label: "OpenRouter shared key",
    billing_type: "credits",
    currency: "usd",
    secret_env: "MC_OPENROUTER_MANAGEMENT_KEY",
    secret_kind: "management",
    reconcile_with: ["hermes-mac-mini"],
    notes: "Phase 1 provider adapter. One key across ~11 profiles.",
    active: true,
  },
  {
    id: "openai-api-org",
    provider: "openai",
    label: "OpenAI API Platform (org)",
    billing_type: "api",
    currency: "usd",
    secret_env: "MC_OPENAI_ADMIN_KEY",
    secret_kind: "admin",
    notes: "Phase 2. Requires Admin API key — not a project key.",
    active: false,
  },
  {
    id: "chatgpt-subscription",
    provider: "openai",
    label: "ChatGPT / Codex subscription",
    billing_type: "subscription",
    monthly_fee_usd: null,
    currency: "usd",
    notes: "Phase 2/3. Fee + Hermes shadow + quota windows. Operator fills fee.",
    active: true,
  },
  {
    id: "anthropic-api-org",
    provider: "anthropic",
    label: "Anthropic Claude Platform (org)",
    billing_type: "api",
    currency: "usd",
    secret_env: "MC_ANTHROPIC_ADMIN_KEY",
    secret_kind: "admin",
    notes: "Phase 2. Skip gracefully if no org Admin access.",
    active: false,
  },
  {
    id: "claude-subscription",
    provider: "anthropic",
    label: "Claude Pro/Max subscription",
    billing_type: "subscription",
    monthly_fee_usd: null,
    currency: "usd",
    notes: "Phase 2/3. Consumer seat — no Admin Usage API.",
    active: true,
  },
  {
    id: "xai-api-team",
    provider: "xai",
    label: "xAI API team",
    billing_type: "api",
    currency: "usd",
    secret_env: "MC_XAI_MANAGEMENT_KEY",
    secret_kind: "management",
    notes: "Phase 2 Management API.",
    active: false,
  },
  {
    id: "supergrok-subscription",
    provider: "xai",
    label: "SuperGrok subscription",
    billing_type: "subscription",
    monthly_fee_usd: null,
    currency: "usd",
    notes: "Phase 2/3. Consumer entitlement ≠ API team billing.",
    active: true,
  },
  {
    id: "deepseek-direct",
    provider: "deepseek",
    label: "DeepSeek direct (optional)",
    billing_type: "credits",
    currency: "usd",
    secret_env: "MC_DEEPSEEK_API_KEY",
    secret_kind: "api_readonly",
    notes: "Optional Phase 2 if any traffic bypasses OpenRouter.",
    active: false,
  },
  {
    id: "nous-portal",
    provider: "nous",
    label: "Nous Portal credits",
    billing_type: "credits",
    currency: "usd",
    secret_env: "MC_NOUS_OAUTH_REFRESH",
    secret_kind: "oauth_refresh",
    notes: "Credits balance adapter only until Nous ships activity export.",
    active: false,
  },
];

export function getAccount(id: string): AccountRecord | undefined {
  return USAGE_ACCOUNTS.find((a) => a.id === id);
}
