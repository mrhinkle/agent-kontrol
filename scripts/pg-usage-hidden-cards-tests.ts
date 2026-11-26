/** Run only from test:pg against its disposable database. Covers usage_hidden_cards. */
import assert from "node:assert/strict";
import { sql } from "../src/lib/db";
import { listHiddenCards, setCardsHidden } from "../src/lib/usage-hidden-store";
import { GET, PUT } from "../src/app/api/usage/hidden-cards/route";

const put = (body: unknown) => PUT(new Request("http://localhost/api/usage/hidden-cards", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

export async function testUsageHiddenCards() {
  await sql()`delete from usage_hidden_cards`;
  try {
    assert.deepEqual(await listHiddenCards(), []);
    assert.deepEqual(await setCardsHidden(["provider:xai-api-team", "grok:local"], true), ["grok:local", "provider:xai-api-team"]);
    // Hiding again is a no-op, not a duplicate or an error.
    assert.deepEqual(await setCardsHidden(["grok:local"], true), ["grok:local", "provider:xai-api-team"]);
    const rows = await sql()`select card_key, hidden_at from usage_hidden_cards order by card_key`;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.hidden_at), "hidden_at is set");

    // Persisted: a fresh read through the route sees the same list.
    const got = await (await GET(new Request("http://localhost/api/usage/hidden-cards"))).json();
    assert.deepEqual(got, { hidden: ["grok:local", "provider:xai-api-team"], demo: false });

    // Unhide through the route.
    const shown = await put({ cards: ["provider:xai-api-team"], hidden: false });
    assert.equal(shown.status, 200);
    assert.deepEqual((await shown.json()).hidden, ["grok:local"]);
    assert.deepEqual(await listHiddenCards(), ["grok:local"]);

    // A bad key is refused by the route and by the table's check constraint.
    const bad = await put({ cards: ["provider:../x"], hidden: true });
    assert.equal(bad.status, 400);
    await assert.rejects(sql()`insert into usage_hidden_cards (card_key) values ('claude:local')`);
    assert.deepEqual(await listHiddenCards(), ["grok:local"]);
  } finally {
    await sql()`delete from usage_hidden_cards`;
  }
}
