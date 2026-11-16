import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { actorOperationsFixture, confirmActorOperationsFixture } from "./fixture";
import { usageIdempotentKey } from "../../src/lib/usage-key";
import type { UsageFact } from "../../src/lib/usage-types";

/**
 * Usage ingest actor receipts. Opt in with AK_ACTOR_OPERATIONS_FIXTURE=1.
 * Without that flag this file does not import the database, open a pool, or
 * register hooks that connect. It is outside tests/ui so the UI suite never
 * loads it. The fixture URL is fixed; ambient DATABASE_URL is not used.
 */
const OPT_IN = process.env.AK_ACTOR_OPERATIONS_FIXTURE === "1";
const LEGACY = "actor-ops-usage-legacy";
const PREFIX = `busage-${randomUUID().slice(0, 8)}`;

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  node: env.NODE_ENV,
};

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
type Post = (req: Request) => Promise<Response>;

let sql: SqlTag;
let postUsage: Post;
let createCredential: (input: { label: string; scopes: string[] }) => Promise<{ ok: true; token: string; credential: { id: string } } | { ok: false; error: string }>;

function account(name: string): string {
  return `${PREFIX}-${name}`;
}

function fact(name: string, extra: Partial<UsageFact> = {}): UsageFact {
  return {
    source: "hermes_state",
    model: "b-usage-model",
    profile: "b-profile",
    session_id: "b-session",
    task: "b-task",
    last_seen_at: "2026-11-15T12:00:00.000Z",
    input_tokens: 424242,
    paid_cost_usd: 7,
    detail: { note: "secret-usage-note" },
    ...extra,
    account_id: extra.account_id ?? account(name),
  };
}

function post(body: unknown, token: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return postUsage(new Request("http://localhost/api/usage/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

async function facts(name: string) {
  return sql`
    select id::text as id, account_id, idempotency_key, paid_cost_usd::text as paid_cost_usd, input_tokens::text as input_tokens, detail
    from usage_facts
    where account_id = ${account(name)}
    order by id
  `;
}

async function snapshots(name: string) {
  return sql`
    select id::text as id, account_id, collected_at, balance_usd::text as balance_usd
    from account_snapshots
    where account_id = ${account(name)}
    order by id
  `;
}

async function receiptsFor(name: string) {
  const needle = `%${account(name)}%`;
  return sql`
    select id::text as id, kind, title, detail
    from events
    where kind = 'usage.ingest' and detail::text like ${needle}
    order by id
  `;
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  const detail = row.detail;
  if (typeof detail === "string") return JSON.parse(detail) as Record<string, unknown>;
  return detail as Record<string, unknown>;
}

describe("B usage ingest actor receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1") return;
    const fixture = actorOperationsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    const db = await import("../../src/lib/db");
    const route = await import("../../src/app/api/usage/ingest/route");
    const credentials = await import("../../src/lib/credentials");
    sql = db.sql();
    postUsage = route.POST;
    createCredential = credentials.createCredential as typeof createCredential;
    await confirmActorOperationsFixture(sql, fixture.database);
  });

  after(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1" || !sql) {
      restoreEnv();
      return;
    }
    await sql`drop trigger if exists ak_b_usage_fail_receipt on events`;
    await sql`drop function if exists ak_b_usage_fail_receipt()`;
    await sql`drop table if exists ak_b_usage_fail_account`;
    const needle = `${PREFIX}%`;
    await sql`delete from events where kind = 'usage.ingest' and detail::text like ${"%" + PREFIX + "%"}`;
    await sql`delete from usage_facts where account_id like ${needle}`;
    await sql`delete from account_snapshots where account_id like ${needle}`;
    await sql`delete from agent_credentials where label = ${PREFIX + "-denied"}`;
    restoreEnv();
  });

  it("stores the legacy principal for facts and the snapshot and ignores forged labels", async () => {
    const at = "2026-11-15T12:00:00.000Z";
    const bodyFact = fact("one");
    const res = await post({
      collected_at: at,
      actor_id: "forged-actor-label",
      actor_type: "human",
      source: "forged-source",
      host: "forged-host",
      agent_id: "forged-agent",
      facts: [bodyFact],
      snapshot: {
        account_id: account("one"),
        collected_at: at,
        balance_usd: 3,
        detail: { note: "secret-snapshot-note", actor_id: "forged-actor-label" },
      },
    }, LEGACY);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; written: number };
    assert.equal(body.ok, true);
    assert.equal(body.written, 1);

    const rows = await facts("one");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idempotency_key, usageIdempotentKey(bodyFact));
    const snaps = await snapshots("one");
    assert.equal(snaps.length, 1);
    const proof = await receiptsFor("one");
    assert.equal(proof.length, 1);
    const detail = detailOf(proof[0]);
    assert.equal(detail.tool, "usage.ingest");
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, "mc-token");
    assert.equal(detail.operation, "upsert");
    assert.deepEqual(detail.fact_ids, [rows[0].id]);
    assert.deepEqual(detail.idempotency_keys, [rows[0].idempotency_key]);
    assert.equal(detail.snapshot_id, snaps[0].id);
    assert.equal(detail.snapshot_account_id, account("one"));
    assert.equal(detail.snapshot_collected_at, at);
    const text = JSON.stringify(detail);
    assert.equal(text.includes("forged-actor-label"), false);
    assert.equal(text.includes("forged-source"), false);
    assert.equal(text.includes("forged-host"), false);
    assert.equal(text.includes("forged-agent"), false);
    assert.equal(text.includes("secret-usage-note"), false);
    assert.equal(text.includes("secret-snapshot-note"), false);
    assert.equal(text.includes(LEGACY), false);
    assert.equal(text.includes("424242"), false);
    assert.equal("paid_cost_usd" in detail, false);
    assert.equal("input_tokens" in detail, false);
  });

  it("keeps one fact row when a batch repeats an idempotency key and lists that id once", async () => {
    const first = fact("dup", { paid_cost_usd: 1, input_tokens: 10 });
    const second = fact("dup", { paid_cost_usd: 9, input_tokens: 80 });
    const res = await post({ facts: [first, second] }, LEGACY);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { written: number }).written, 2);
    const rows = await facts("dup");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].paid_cost_usd, "9");
    const proof = await receiptsFor("dup");
    assert.equal(proof.length, 1);
    const detail = detailOf(proof[0]);
    assert.deepEqual(detail.fact_ids, [rows[0].id]);
    assert.deepEqual(detail.idempotency_keys, [usageIdempotentKey(first)]);
    assert.equal(detail.snapshot_id, null);
    assert.equal(detail.actor_id, "mc-token");
    assert.equal(JSON.stringify(detail).includes("80"), false);
  });

  it("writes a snapshot-only receipt and writes nothing for an empty batch", async () => {
    const at = "2026-11-15T18:00:00.000Z";
    const empty = await post({ facts: [] }, LEGACY);
    assert.equal(empty.status, 200);
    assert.equal((await empty.json() as { written: number }).written, 0);
    const snap = await post({
      facts: [],
      snapshot: { account_id: account("snap-only"), collected_at: at, balance_usd: 1 },
    }, LEGACY);
    assert.equal(snap.status, 200);
    assert.equal((await snap.json() as { written: number }).written, 0);
    const snaps = await snapshots("snap-only");
    assert.equal(snaps.length, 1);
    const proof = await receiptsFor("snap-only");
    assert.equal(proof.length, 1);
    const detail = detailOf(proof[0]);
    assert.deepEqual(detail.fact_ids, []);
    assert.deepEqual(detail.idempotency_keys, []);
    assert.equal(detail.snapshot_id, snaps[0].id);
    assert.equal(detail.actor_id, "mc-token");
    const stray = await sql`
      select count(*)::int as n from events
      where kind = 'usage.ingest' and detail::text like ${"%" + PREFIX + "%"} and detail->>'snapshot_account_id' is null and detail->'fact_ids' = '[]'::jsonb
    `;
    assert.equal(Number(stray[0].n), 0);
  });

  it("rejects an agent credential and a bad bearer without a fact or receipt", async () => {
    const made = await createCredential({ label: `${PREFIX}-denied`, scopes: ["usage:read"] });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const denied = await post({ facts: [fact("denied")] }, made.token);
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json() as { code?: string };
    assert.equal(deniedBody.code, "insufficient_scope");
    const bad = await post({ facts: [fact("denied")] }, "not-the-token");
    assert.equal(bad.status, 401);
    assert.equal((await facts("denied")).length, 0);
    assert.equal((await receiptsFor("denied")).length, 0);
  });

  it("rejects invalid and private input before any write", async () => {
    const badTime = await post({ collected_at: "not-a-date", facts: [fact("invalid")] }, LEGACY);
    assert.equal(badTime.status, 400);
    const missing = await post({ collected_at: "2026-11-15T12:00:00.000Z" }, LEGACY);
    assert.equal(missing.status, 400);
    const leaked = "SECRET-PROMPT-BODY";
    const privacy = await post({
      facts: [
        fact("private"),
        fact("private-two", { detail: { prompt: leaked } }),
      ],
    }, LEGACY);
    assert.equal(privacy.status, 400);
    const privacyBody = await privacy.json() as { code?: string };
    assert.equal(privacyBody.code, "validation_failed");
    assert.equal(JSON.stringify(privacyBody).includes(leaked), false);
    assert.equal((await facts("invalid")).length, 0);
    assert.equal((await facts("private")).length, 0);
    assert.equal((await facts("private-two")).length, 0);
    assert.equal((await receiptsFor("private")).length, 0);
    assert.equal((await receiptsFor("invalid")).length, 0);
  });

  it("rolls the whole batch back when a later fact is not a write", async () => {
    const res = await post({
      facts: [fact("partial"), { source: "hermes_state", account_id: account("partial-skip"), last_seen_at: "2026-11-15T12:00:00.000Z" }],
    }, LEGACY);
    assert.equal(res.status, 500);
    const body = await res.json() as { code?: string };
    assert.equal(body.code, "internal_error");
    assert.equal(JSON.stringify(body).includes("Incomplete"), false);
    assert.equal((await facts("partial")).length, 0);
    assert.equal((await receiptsFor("partial")).length, 0);
  });

  it("records a null actor for dev-open and does not invent an operator", async () => {
    delete env.MC_TOKEN;
    try {
      const res = await post({
        facts: [fact("open")],
        actor_id: "forged-actor-label",
      }, null);
      assert.equal(res.status, 200);
      const proof = await receiptsFor("open");
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.actor_type, null);
      assert.equal(detail.actor_id, null);
      assert.equal(JSON.stringify(detail).includes("forged-actor-label"), false);
      assert.equal(JSON.stringify(detail).includes("operator"), false);
    } finally {
      env.MC_TOKEN = LEGACY;
    }
  });

  it("drops facts and the snapshot together when the receipt fails and keeps an earlier batch", async () => {
    const kept = await post({
      facts: [fact("keep")],
      snapshot: { account_id: account("keep"), collected_at: "2026-11-15T19:00:00.000Z", balance_usd: 2 },
    }, LEGACY);
    assert.equal(kept.status, 200);
    await sql`
      create table if not exists ak_b_usage_fail_account (
        account_id text primary key
      )
    `;
    await sql`delete from ak_b_usage_fail_account`;
    await sql`insert into ak_b_usage_fail_account (account_id) values (${account("fail")})`;
    await sql`
      create or replace function ak_b_usage_fail_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'usage.ingest'
           and new.detail->>'snapshot_account_id' = (select account_id from ak_b_usage_fail_account) then
          raise exception 'injected receipt failure';
        end if;
        return new;
      end;
      $$
    `;
    await sql`drop trigger if exists ak_b_usage_fail_receipt on events`;
    await sql`
      create trigger ak_b_usage_fail_receipt
      before insert on events
      for each row execute function ak_b_usage_fail_receipt()
    `;
    try {
      const res = await post({
        facts: [fact("fail")],
        snapshot: { account_id: account("fail"), collected_at: "2026-11-15T19:30:00.000Z", balance_usd: 4 },
      }, LEGACY);
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      assert.equal((await facts("keep")).length, 1);
      assert.equal((await snapshots("keep")).length, 1);
      assert.equal((await receiptsFor("keep")).length, 1);
      assert.equal(detailOf((await receiptsFor("keep"))[0]).actor_id, "mc-token");
      assert.equal((await facts("fail")).length, 0);
      assert.equal((await snapshots("fail")).length, 0);
      assert.equal((await receiptsFor("fail")).length, 0);
    } finally {
      await sql`drop trigger if exists ak_b_usage_fail_receipt on events`;
      await sql`drop function if exists ak_b_usage_fail_receipt()`;
      await sql`drop table if exists ak_b_usage_fail_account`;
    }
  });

  it("answers demo mode without writing when the database is unset", async () => {
    const beforeFacts = await sql`select count(*)::int as n from usage_facts where account_id like ${PREFIX + "%"}`;
    const beforeEvents = await sql`select count(*)::int as n from events where kind = 'usage.ingest' and detail::text like ${"%" + PREFIX + "%"}`;
    delete env.DATABASE_URL;
    try {
      const res = await post({ facts: [fact("demo")] }, LEGACY);
      assert.equal(res.status, 200);
      const body = await res.json() as { demo?: boolean; written?: number };
      assert.equal(body.demo, true);
      assert.equal(body.written, undefined);
    } finally {
      env.DATABASE_URL = actorOperationsFixture().url;
    }
    const afterFacts = await sql`select count(*)::int as n from usage_facts where account_id like ${PREFIX + "%"}`;
    const afterEvents = await sql`select count(*)::int as n from events where kind = 'usage.ingest' and detail::text like ${"%" + PREFIX + "%"}`;
    assert.equal(afterFacts[0].n, beforeFacts[0].n);
    assert.equal(afterEvents[0].n, beforeEvents[0].n);
  });
});

function restoreEnv() {
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.driver === undefined) delete env.MC_DB_DRIVER;
  else env.MC_DB_DRIVER = saved.driver;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
  if (saved.node === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved.node;
}
