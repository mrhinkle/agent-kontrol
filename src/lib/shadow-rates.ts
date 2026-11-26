/**
 * Shadow-cost rate table: vendor API list prices used to estimate what flat-rate
 * subscription usage (Claude Max, SuperGrok) would have cost on the metered API.
 *
 * A shadow cost is an estimate, never a charge. It is computed when the usage
 * summary is read and is never stored, so correcting a rate here reprices every
 * row immediately. Every rate names the page it came from; when a vendor changes
 * prices, add the new numbers, bump SHADOW_RATE_VERSION and re-check every row.
 *
 * Separate from usage-prices.ts, which mirrors the Hermes collector's Python table.
 */
import type { UsageFact } from "./usage-types";

/** USD per million tokens. */
export interface TokenRates {
  input: number;
  output: number;
  cache_read: number;
  /** 5-minute cache write. Collectors that report one cache-write total are priced here. */
  cache_write_5m: number;
  cache_write_1h: number;
}

export interface ShadowRate {
  model: string;
  vendor: "anthropic" | "xai";
  rates: TokenRates;
  /** A request whose prompt passes the threshold pays these rates for all its tokens. */
  prompt_tier?: { threshold_tokens: number; inclusive: boolean; rates: TokenRates };
  source_url: string;
  notes?: string;
}

export const SHADOW_RATE_VERSION = "2026-11-26";
/** Date every rate below was read from its source page. */
export const SHADOW_RATES_CHECKED_AT = "2026-11-26";

const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const XAI_PRICING = "https://docs.x.ai/docs/pricing";

const claude = (model: string, input: number, w5: number, w1: number, read: number, output: number, notes?: string): ShadowRate => ({
  model, vendor: "anthropic", source_url: ANTHROPIC_PRICING, notes,
  rates: { input, output, cache_read: read, cache_write_5m: w5, cache_write_1h: w1 },
});

/**
 * xAI lists no separate cache-write price; cache creation is priced as input.
 * Reasoning tokens are billed as output tokens under the model's standard rates.
 */
const grok = (model: string, input: number, cached: number, output: number, long: [number, number, number]): ShadowRate => ({
  model, vendor: "xai", source_url: XAI_PRICING,
  notes: "No separate cache-write price; cache creation priced as input. Global endpoint rates (the US endpoint is 1.1x).",
  rates: { input, output, cache_read: cached, cache_write_5m: input, cache_write_1h: input },
  prompt_tier: { threshold_tokens: 200_000, inclusive: true, rates: { input: long[0], output: long[2], cache_read: long[1], cache_write_5m: long[0], cache_write_1h: long[0] } },
});

export const SHADOW_RATES: readonly ShadowRate[] = [
  claude("claude-fable-5-2", 8, 10, 16, 0.2, 40),
  claude("claude-mythos-5-2", 8, 10, 16, 0.2, 40),
  claude("claude-fable-5-1", 10, 12.5, 20, 0.25, 50),
  claude("claude-mythos-5-1", 10, 12.5, 20, 0.25, 50),
  claude("claude-fable-5", 10, 12.5, 20, 1, 50),
  claude("claude-mythos-5", 10, 12.5, 20, 1, 50),
  claude("claude-opus-5-5", 4, 5, 8, 0.2, 20),
  claude("claude-opus-5", 5, 6.25, 10, 0.5, 25),
  claude("claude-opus-4-8", 5, 6.25, 10, 0.5, 25),
  claude("claude-opus-4-7", 5, 6.25, 10, 0.5, 25),
  claude("claude-opus-4-6", 5, 6.25, 10, 0.5, 25),
  claude("claude-opus-4-5", 5, 6.25, 10, 0.5, 25),
  claude("claude-opus-4-1", 15, 18.75, 30, 1.5, 75, "Retired on the Claude API."),
  claude("claude-opus-4", 15, 18.75, 30, 1.5, 75, "Retired on the Claude API."),
  claude("claude-sonnet-5-5", 2, 2.5, 4, 0.1, 10),
  claude("claude-sonnet-5", 2, 2.5, 4, 0.2, 10),
  claude("claude-sonnet-4-6", 3, 3.75, 6, 0.3, 15),
  claude("claude-sonnet-4-5", 3, 3.75, 6, 0.3, 15),
  claude("claude-sonnet-4", 3, 3.75, 6, 0.3, 15, "Retired on the Claude API."),
  {
    ...claude("claude-haiku-5-5", 0.1, 0.125, 0.2, 0.01, 0.5, "Prompts over 100,000 tokens (input plus cache reads and writes) pay the higher rates."),
    prompt_tier: { threshold_tokens: 100_000, inclusive: false, rates: { input: 0.5, output: 2.5, cache_read: 0.05, cache_write_5m: 0.625, cache_write_1h: 1 } },
  },
  claude("claude-haiku-4-5", 1, 1.25, 2, 0.1, 5),
  grok("grok-4.7", 2, 0.5, 6, [4, 1, 12]),
  grok("grok-4.6", 2, 0.5, 6, [4, 1, 12]),
  grok("grok-4.5", 2, 0.3, 6, [4, 0.6, 12]),
  grok("grok-4.3", 1.25, 0.2, 2.5, [2.5, 0.4, 5]),
  grok("grok-4.20-0309-reasoning", 1.25, 0.2, 2.5, [2.5, 0.4, 5]),
  grok("grok-4.20-0309-non-reasoning", 1.25, 0.2, 2.5, [2.5, 0.4, 5]),
  grok("grok-4.20-multi-agent-0309", 1.25, 0.2, 2.5, [2.5, 0.4, 5]),
];

const BY_MODEL = new Map(SHADOW_RATES.map((rate) => [rate.model, rate]));

/**
 * Explicit aliases only. Grok Build reports its models as `grok-4.x-build`. The Grok
 * CLI's own cost figure (costUsdTicks) matches the standard grok-4.7/4.6 rates on the
 * median turn, not the "Grok 4.7 Fast (Cursor and Grok Build only)" listing, which
 * comes out at twice that figure. Decided with the operator on 2026-11-26.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["grok-4.7-build", "grok-4.7"],
  ["grok-4.6-build", "grok-4.6"],
]);

/**
 * Exact model ID after removing a routing prefix (`anthropic/`, `x-ai/`, `xai/`) or
 * an Anthropic snapshot date suffix (`-YYYYMMDD`), or a listed alias. No partial or fuzzy matching:
 * an unrecognised model is unpriced, never priced as a lookalike.
 */
export function lookupShadowRate(model: string | null | undefined): ShadowRate | null {
  if (typeof model !== "string") return null;
  const bare = model.trim().replace(/^(?:anthropic|x-ai|xai)\//, "");
  if (!bare) return null;
  const alias = ALIASES.get(bare);
  if (alias) return BY_MODEL.get(alias) ?? null;
  return BY_MODEL.get(bare) ?? (/^claude-.*-\d{8}$/.test(bare) ? BY_MODEL.get(bare.replace(/-\d{8}$/, "")) ?? null : null);
}

export type ShadowUnavailableReason = "missing_model" | "unknown_model" | "missing_tokens";

export type ShadowCost =
  | { status: "priced"; usd: number; model: string; tier: "standard" | "long_prompt" }
  | { status: "unavailable"; reason: ShadowUnavailableReason };

type TokenFact = Pick<UsageFact, "model" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "api_call_count">;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * API-equivalent value of one usage row. Cache writes are priced at the 5-minute
 * rate because collectors report a single write total; that makes the estimate a
 * lower bound when 1-hour writes occur. Unavailable, never $0, when the model is
 * missing or unknown, input or output counts are missing, a cache counter is invalid,
 * or the row carries no tokens at all.
 *
 * A row that rolls up several model calls (Grok CLI records tokens per turn) decides the
 * long-prompt tier on the average prompt per call. The tier applies per call, so this
 * under-counts when only a few of the calls were long.
 */
export function shadowCostForFact(fact: TokenFact): ShadowCost {
  if (typeof fact.model !== "string" || !fact.model.trim()) return { status: "unavailable", reason: "missing_model" };
  const rate = lookupShadowRate(fact.model);
  if (!rate) return { status: "unavailable", reason: "unknown_model" };
  const input = count(fact.input_tokens), output = count(fact.output_tokens);
  if (input === null || output === null) return { status: "unavailable", reason: "missing_tokens" };
  // Anthropic omits cache counters a request did not use, so an absent counter is zero.
  // A present but invalid one (null, NaN, negative) means the counts are unknown.
  const cache = (value: unknown) => value === undefined ? 0 : count(value);
  const read = cache(fact.cache_read_tokens), write = cache(fact.cache_write_tokens);
  if (read === null || write === null) return { status: "unavailable", reason: "missing_tokens" };
  // Stored counters default to zero, so an all-zero row is a row without usage data.
  if (input + output + read + write === 0) return { status: "unavailable", reason: "missing_tokens" };
  const calls = typeof fact.api_call_count === "number" && Number.isFinite(fact.api_call_count) && fact.api_call_count > 1 ? fact.api_call_count : 1;
  const prompt = (input + read + write) / calls;
  const tier = rate.prompt_tier;
  const long = !!tier && (tier.inclusive ? prompt >= tier.threshold_tokens : prompt > tier.threshold_tokens);
  const r = long ? tier!.rates : rate.rates;
  const usd = (input * r.input + output * r.output + read * r.cache_read + write * r.cache_write_5m) / 1_000_000;
  return { status: "priced", usd: Math.round(usd * 1e10) / 1e10, model: rate.model, tier: long ? "long_prompt" : "standard" };
}
