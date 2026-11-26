import { isConfigured, sql } from "./db";
import { isCardKey } from "./usage-hidden-cards";

/**
 * Hidden Usage cards, in usage_hidden_cards. Without a database (demo mode)
 * the set lives in this process only and is lost on restart.
 */
const demoHidden = new Set<string>();

/** Tests only: clear the demo set. */
export function resetDemoHiddenCardsForTests(): void {
  demoHidden.clear();
}

export async function listHiddenCards(): Promise<string[]> {
  if (!isConfigured()) return [...demoHidden].sort();
  const rows = await sql()`select card_key from usage_hidden_cards order by card_key`;
  return rows.map((r) => String(r.card_key)).filter(isCardKey);
}

export async function setCardsHidden(cards: string[], hidden: boolean): Promise<string[]> {
  if (!isConfigured()) {
    for (const card of cards) {
      if (hidden) demoHidden.add(card);
      else demoHidden.delete(card);
    }
    return listHiddenCards();
  }
  const db = sql();
  if (hidden) {
    await db`
      insert into usage_hidden_cards (card_key)
      select unnest(${cards}::text[])
      on conflict (card_key) do nothing
    `;
  } else {
    await db`delete from usage_hidden_cards where card_key = any(${cards}::text[])`;
  }
  return listHiddenCards();
}
