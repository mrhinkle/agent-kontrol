/** Versioned price table — keep in sync with agents/usage-collector/prices.py */

export const PRICE_VERSION = "2026-10-05";

export interface ModelPrice {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  notes?: string;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-5.6-sol": { model: "gpt-5.6-sol", input_per_mtok: 4.0, output_per_mtok: 20.0, cache_read_per_mtok: 0.4 },
  "gpt-5.6-luna": { model: "gpt-5.6-luna", input_per_mtok: 0.2, output_per_mtok: 1.2, cache_read_per_mtok: 0.02 },
  "deepseek/deepseek-v4-pro": {
    model: "deepseek/deepseek-v4-pro",
    input_per_mtok: 0.2088,
    output_per_mtok: 0.4176,
    cache_read_per_mtok: 0.0174,
    notes: "Current OpenRouter fallback",
  },
  "deepseek/deepseek-v4-pro-0813": {
    model: "deepseek/deepseek-v4-pro-0813",
    input_per_mtok: 0.4,
    output_per_mtok: 5.0,
    cache_read_per_mtok: 0.36,
    notes: "Historical only",
  },
};

const ALIASES: Record<string, string> = {
  "openai/gpt-5.6-sol": "gpt-5.6-sol",
  "openai/gpt-5.6-luna": "gpt-5.6-luna",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-pro-0813": "deepseek/deepseek-v4-pro-0813",
};

export function lookupPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  if (ALIASES[model] && MODEL_PRICES[ALIASES[model]]) return MODEL_PRICES[ALIASES[model]];
  const ml = model.toLowerCase();
  if (ml.includes("0813") && ml.includes("deepseek")) return MODEL_PRICES["deepseek/deepseek-v4-pro-0813"];
  if (ml.includes("deepseek") && ml.includes("v4-pro")) return MODEL_PRICES["deepseek/deepseek-v4-pro"];
  if (ml.includes("luna")) return MODEL_PRICES["gpt-5.6-luna"];
  if (ml.includes("sol")) return MODEL_PRICES["gpt-5.6-sol"];
  return null;
}

export function listCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens = 0,
): number | null {
  const p = lookupPrice(model);
  if (!p) return null;
  return (
    (inputTokens * p.input_per_mtok +
      outputTokens * p.output_per_mtok +
      cacheReadTokens * p.cache_read_per_mtok +
      cacheWriteTokens * p.input_per_mtok) /
    1_000_000
  );
}
