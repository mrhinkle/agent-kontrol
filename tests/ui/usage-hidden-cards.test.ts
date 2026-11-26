import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aggregateUsageFacts } from "../../src/lib/usage-aggregate";
import { CARD_KEY_RE, effectiveHidden, hideableCards, isCardKey, parseHiddenCardsWrite } from "../../src/lib/usage-hidden-cards";
import { resetDemoHiddenCardsForTests } from "../../src/lib/usage-hidden-store";
import { authorizeRoute } from "../../src/lib/scopes";
import { UsageCostPanels } from "../../src/components/usage-cost-panels";
import { GET, PUT } from "../../src/app/api/usage/hidden-cards/route";
import type { UsageSummary } from "../../src/lib/usage-types";

const period = { since: "2026-11-20T00:00:00.000Z", until: "2026-11-27T00:00:00.000Z" };
const ALL_UNTRACKED = ["claude:shadow", "grok:local", "grok:openrouter", "grok:shadow", "provider:anthropic-api-org", "provider:openrouter-shared", "provider:xai-api-team"];

/** No feed connected anywhere: every untracked card is hideable. */
const empty = (): UsageSummary => aggregateUsageFacts([], { ...period, provider_window: period, snapshots: [], collected_at: null } as never);

/** OpenRouter, Claude shadow and the Grok CLI feed have data; the rest do not. */
function partlyTracked(): UsageSummary {
  const s = empty();
  const or = s.providers!.find((p) => p.account_id === "openrouter-shared")!;
  Object.assign(or, { coverage: "complete", cost_usd: 12.34, rows: 3, daily: [{ date: "2026-11-25", cost_usd: 12.34 }] });
  for (const p of s.providers!) if (p !== or) p.daily = [{ date: "2026-11-25", cost_usd: null }];
  Object.assign(s.claude!.shadow, { usd: 56.78, status: "priced", unavailable_reason: null, priced_requests: 9 });
  Object.assign(s.grok!, { local_usage_status: "complete", turns: 2, model_calls: 4, machines: [{ account_id: "grok-cli:m1", collected_at: period.until, status: "complete", since: null, until: null }] });
  return s;
}

const html = (data: UsageSummary, hidden: string[] = [], onSetHidden?: (c: string[], h: boolean) => void) =>
  renderToStaticMarkup(createElement(UsageCostPanels, { data, hidden, onSetHidden }));

/** Expand function components (the panels use no hooks) to reach the real buttons and their handlers. */
function buttons(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) { for (const n of node) buttons(n, out); return out; }
  if (!isValidElement(node)) return out;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return buttons((el.type as (p: unknown) => ReactNode)(el.props), out);
  if (el.type === "button") out.push(el);
  return buttons(el.props.children as ReactNode, out);
}
const panelButtons = (data: UsageSummary, hidden: string[], onSetHidden: (c: string[], h: boolean) => void) =>
  buttons(UsageCostPanels({ data, hidden, onSetHidden }) as ReactNode);

describe("which cards can be hidden", () => {
  it("offers every card with no tracking or feed", () => {
    assert.deepEqual([...hideableCards(empty()).keys()].sort(), ALL_UNTRACKED);
  });

  it("never offers a card that has data", () => {
    const keys = [...hideableCards(partlyTracked()).keys()].sort();
    assert.deepEqual(keys, ["grok:openrouter", "grok:shadow", "provider:anthropic-api-org", "provider:xai-api-team"]);
  });

  it("treats an estimate with only unpriced rows as data, not as empty", () => {
    const s = empty();
    Object.assign(s.claude!.shadow, { usd: null, status: "unavailable", unavailable_reason: "no_priced_rows", unpriced_requests: 3 });
    Object.assign(s.grok!.shadow, { usd: null, excluded_api_requests: 2 });
    const keys = hideableCards(s);
    assert.equal(keys.has("claude:shadow"), false);
    assert.equal(keys.has("grok:shadow"), false);
    for (const extra of [{ unclassified_requests: 1 }, { by_model: [{ model: "claude-opus-5-5", requests: 1, usd: 0.01, long_prompt_requests: 0, source_url: "https://platform.claude.com/x" }] }]) {
      const only = empty();
      Object.assign(only.claude!.shadow, extra);
      assert.equal(hideableCards(only).has("claude:shadow"), false, JSON.stringify(extra));
    }
  });

  it("ignores a stored key once its card has data, so the card shows again", () => {
    assert.deepEqual([...effectiveHidden(ALL_UNTRACKED, partlyTracked())].sort(), ["grok:openrouter", "grok:shadow", "provider:anthropic-api-org", "provider:xai-api-team"]);
    const markup = html(partlyTracked(), ALL_UNTRACKED, () => {});
    assert.match(markup, /OpenRouter<\/h3>/);
    assert.match(markup, /\$56\.78/);
    assert.match(markup, /Local Grok CLI usage/);
    assert.doesNotMatch(markup, /data-hide-card="provider:openrouter-shared"/);
    assert.doesNotMatch(markup, /data-hide-card="claude:shadow"/);
  });

  it("keeps the key pattern in step with the table's check constraint", () => {
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    assert.ok(schema.includes(`check (card_key ~ '${CARD_KEY_RE.source}')`), "schema.sql check matches CARD_KEY_RE");
    assert.ok(fs.readFileSync("supabase/migrations/20261126_usage_hidden_cards.sql", "utf8").includes(`check (card_key ~ '${CARD_KEY_RE.source}')`), "migration check matches CARD_KEY_RE");
    for (const k of ALL_UNTRACKED) assert.ok(isCardKey(k), k);
    for (const k of ["", "claude:local", "provider:", "provider:A", "provider:../x", "grok:shadow ", 7]) assert.equal(isCardKey(k), false, String(k));
  });
});

describe("hide and unhide on the card", () => {
  it("draws a Hide button on each untracked card and none without a handler", () => {
    const markup = html(empty(), [], () => {});
    for (const k of ALL_UNTRACKED) assert.match(markup, new RegExp(`data-hide-card="${k}"`), k);
    assert.match(markup, /aria-label="Hide Claude API: no data source connected"/);
    assert.doesNotMatch(html(empty()), /data-hide-card/);
  });

  it("hides a card when its button is clicked", () => {
    const calls: [string[], boolean][] = [];
    const hideXai = panelButtons(empty(), [], (c, h) => calls.push([c, h])).find((b) => b.props["data-hide-card"] === "provider:xai-api-team")!;
    (hideXai.props.onClick as () => void)();
    assert.deepEqual(calls, [[["provider:xai-api-team"], true]]);

    const markup = html(empty(), ["provider:xai-api-team"], () => {});
    assert.doesNotMatch(markup, /Grok API \(xAI\)<\/h3>/);
    assert.match(markup, /Claude API<\/h3>/);
    assert.match(markup, /1 box with no data source hidden: Grok API \(xAI\)\. Totals are unchanged\./);
    assert.match(markup, /Show 1 hidden/);
  });

  it("shows every hidden card again from Show N hidden", () => {
    const calls: [string[], boolean][] = [];
    const show = panelButtons(empty(), ["grok:local", "claude:shadow"], (c, h) => calls.push([c, h])).find((b) => "data-show-hidden" in b.props)!;
    (show.props.onClick as () => void)();
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0][0].sort(), calls[0][1]], [["claude:shadow", "grok:local"], false]);
    const after = html(empty(), [], () => {});
    assert.match(after, /Local Grok CLI usage/);
    assert.doesNotMatch(after, /Show \d+ hidden/);
  });

  it("does not count a stale key for a card with data in Show N hidden", () => {
    const markup = html(partlyTracked(), ["provider:openrouter-shared", "grok:openrouter"], () => {});
    assert.match(markup, /Show 1 hidden/);
  });
});

describe("hiding is display only", () => {
  it("leaves the data, the daily provider table and every figure unchanged", () => {
    const data = partlyTracked();
    const before = structuredClone(data);
    const visible = html(data, [], () => {});
    const hidden = html(data, ALL_UNTRACKED, () => {});
    assert.deepEqual(data, before, "rendering with hidden cards does not mutate the summary");

    const daily = (m: string) => m.slice(m.indexOf("<details"), m.indexOf("</details>"));
    assert.equal(daily(hidden), daily(visible), "the daily provider table keeps every provider");
    assert.match(daily(hidden), /Grok API \(xAI\)/);

    const amounts = (m: string): string[] => [...(m.match(/\$[\d,]+\.\d{2}/g) ?? [])].sort();
    assert.deepEqual(amounts(hidden), amounts(visible), "no dollar figure is added, dropped or changed");
    assert.ok(amounts(hidden).includes("$12.34") && amounts(hidden).includes("$56.78"));
    assert.equal(amounts(hidden).filter((a) => a === "$0.00").length, amounts(visible).filter((a) => a === "$0.00").length, "nothing unavailable becomes $0");
  });
});

describe("GET/PUT /api/usage/hidden-cards without a database", () => {
  const url = "http://localhost/api/usage/hidden-cards";
  const put = (body: unknown) => PUT(new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  let saved: { db?: string; pw?: string };
  before(() => { saved = { db: process.env.DATABASE_URL, pw: process.env.MC_DASHBOARD_PASSWORD }; delete process.env.DATABASE_URL; delete process.env.MC_DASHBOARD_PASSWORD; resetDemoHiddenCardsForTests(); });
  afterEach(() => {
    resetDemoHiddenCardsForTests();
    if (saved.db !== undefined) process.env.DATABASE_URL = saved.db;
    if (saved.pw !== undefined) process.env.MC_DASHBOARD_PASSWORD = saved.pw;
  });

  it("persists a hide across reads and removes it on unhide", async () => {
    delete process.env.DATABASE_URL; delete process.env.MC_DASHBOARD_PASSWORD;
    const hid = await put({ cards: ["grok:local", "provider:xai-api-team", "grok:local"], hidden: true });
    assert.equal(hid.status, 200);
    assert.deepEqual(await hid.json(), { hidden: ["grok:local", "provider:xai-api-team"], demo: true });
    assert.deepEqual((await (await GET(new Request(url))).json()).hidden, ["grok:local", "provider:xai-api-team"]);
    const shown = await put({ cards: ["grok:local"], hidden: false });
    assert.deepEqual((await shown.json()).hidden, ["provider:xai-api-team"]);
    assert.deepEqual((await (await GET(new Request(url))).json()).hidden, ["provider:xai-api-team"]);
  });

  it("refuses bad bodies and writes nothing", async () => {
    delete process.env.DATABASE_URL; delete process.env.MC_DASHBOARD_PASSWORD;
    for (const body of ["{", { cards: ["claude:local"], hidden: true }, { cards: [], hidden: true }, { cards: ["grok:local"], hidden: "yes" }, { cards: Array(51).fill("grok:local"), hidden: true }, { cards: [{ toString: null }], hidden: true }, { cards: [7], hidden: true }]) {
      const res = await put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await (await GET(new Request(url))).json()).hidden, []);
  });

  it("names a string key in the error and never stringifies an object key", () => {
    assert.deepEqual(parseHiddenCardsWrite({ cards: [{ toString: null }], hidden: true }), { ok: false, field: "cards", message: "Each card key must be a string." });
    assert.deepEqual(parseHiddenCardsWrite({ cards: ["claude:local"], hidden: true }), { ok: false, field: "cards", message: "Unknown card key: claude:local" });
  });

  it("parses a valid write and de-duplicates its keys", () => {
    assert.deepEqual(parseHiddenCardsWrite({ cards: ["grok:shadow", "grok:shadow"], hidden: false }), { ok: true, cards: ["grok:shadow"], hidden: false });
  });

  it("needs the dashboard session when a password is set, and writes nothing without it", async () => {
    delete process.env.DATABASE_URL;
    process.env.MC_DASHBOARD_PASSWORD = "test-only-password";
    try {
      assert.equal((await GET(new Request(url))).status, 401);
      assert.equal((await put({ cards: ["grok:local"], hidden: true })).status, 401);
    } finally {
      delete process.env.MC_DASHBOARD_PASSWORD;
    }
    assert.deepEqual((await (await GET(new Request(url))).json()).hidden, []);
  });

  it("is not granted to any agent credential", () => {
    const agent = { kind: "agent" as const, id: "akc_test", scopes: ["usage:read", "status:write", "messages:write"] };
    for (const method of ["GET", "PUT"]) assert.equal(authorizeRoute(agent, method, "/api/usage/hidden-cards").ok, false, method);
    assert.equal(authorizeRoute({ kind: "session" }, "PUT", "/api/usage/hidden-cards").ok, true);
  });
});
