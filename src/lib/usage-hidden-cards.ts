import type { ShadowCostSummary, UsageSummary } from "./usage-types";

/**
 * Cards on the Usage and Costs page that the operator may hide because no
 * tracking or feed is connected. Display only: hiding never changes a total,
 * and nothing here turns a missing value into $0.
 *
 * Keys: `provider:<account_id>`, `grok:local`, `grok:openrouter`,
 * `grok:shadow`, `claude:shadow`. The same pattern is a check constraint on
 * usage_hidden_cards.card_key.
 */
export const CARD_KEY_RE = /^(provider:[a-z0-9._:-]{1,100}|grok:(local|openrouter|shadow)|claude:shadow)$/;
export const MAX_CARDS_PER_WRITE = 50;

export function isCardKey(value: unknown): value is string {
  return typeof value === "string" && CARD_KEY_RE.test(value);
}

/** No rows reached the estimate at all: nothing priced, unpriced, unclassified or left out. */
function shadowHasNoData(shadow: ShadowCostSummary | null | undefined): boolean {
  if (!shadow) return true;
  return shadow.usd === null && !shadow.by_model.length &&
    [shadow.priced_requests, shadow.unpriced_requests, shadow.excluded_api_requests, shadow.unclassified_requests].every((n) => n === 0);
}

/**
 * The cards that have no data source in this summary, keyed by card key, with
 * the label used on the hide control. A card that shows any figure, including
 * "N requests not priced", is not in this map and can never be hidden.
 */
export function hideableCards(data: UsageSummary): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of data.providers ?? []) {
    if (p.coverage === "missing" && p.cost_usd === null && p.rows === 0) out.set(`provider:${p.account_id}`, p.label);
  }
  const grok = data.grok;
  if (grok) {
    if (grok.local_usage_status === "unavailable" && grok.machines.length === 0 && grok.turns === 0) out.set("grok:local", "Local Grok CLI usage");
    if (grok.openrouter_coverage === "missing" && grok.openrouter_cost_usd === null) out.set("grok:openrouter", "Grok through OpenRouter");
    if (shadowHasNoData(grok.shadow)) out.set("grok:shadow", "Grok API-equivalent value");
  }
  if (data.claude && shadowHasNoData(data.claude.shadow)) out.set("claude:shadow", "Claude API-equivalent value");
  return out;
}

/** Stored keys that apply now: only those naming a card with no data in this summary. */
export function effectiveHidden(stored: Iterable<string>, data: UsageSummary): Set<string> {
  const hideable = hideableCards(data);
  return new Set([...stored].filter((key) => hideable.has(key)));
}

/** Parse a PUT body `{ cards: string[], hidden: boolean }`. */
export function parseHiddenCardsWrite(body: unknown):
  | { ok: true; cards: string[]; hidden: boolean }
  | { ok: false; field: "cards" | "hidden"; message: string } {
  const row = (body ?? {}) as { cards?: unknown; hidden?: unknown };
  if (typeof row.hidden !== "boolean") return { ok: false, field: "hidden", message: "hidden must be true or false." };
  if (!Array.isArray(row.cards) || row.cards.length === 0 || row.cards.length > MAX_CARDS_PER_WRITE) {
    return { ok: false, field: "cards", message: `cards must be a list of 1 to ${MAX_CARDS_PER_WRITE} card keys.` };
  }
  const bad = row.cards.find((c) => !isCardKey(c));
  if (bad !== undefined) return { ok: false, field: "cards", message: `Unknown card key: ${String(bad).slice(0, 120)}` };
  return { ok: true, cards: [...new Set(row.cards as string[])], hidden: row.hidden };
}
