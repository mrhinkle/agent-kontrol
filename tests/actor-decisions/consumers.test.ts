import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { authCookieValue } from "../../src/lib/authcrypto";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID } from "../../src/lib/actor";
import {
  actorDecisionsFixture,
  closeActorDecisionsPool,
  confirmActorDecisionsFixture,
  withOwnedFixtureCleanup,
} from "./fixture";

/**
 * Event-consumer registration receipts. Opt in with AK_ACTOR_DECISIONS_FIXTURE=1.
 * Without that flag this file does not import the database or open a pool.
 * Target credentials are synthetic rows in the fixture database.
 */
const OPT_IN = process.env.AK_ACTOR_DECISIONS_FIXTURE === "1";
const LEGACY = "actor-decisions-legacy";
const PASSWORD = "actor-decisions-session";
const PREFIX = `akreg-${randomUUID().slice(0, 8)}`;
const LEAK = "PROMPT-BODY-SHOULD-NOT-LEAK";

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
};

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
type Post = (req: Request) => Promise<Response>;
type CreateCredential = (input: { label: string; scopes: string[] }) => Promise<
  { ok: true; token: string; credential: { id: string } } | { ok: false; error: string }
>;

let sql: SqlTag;
let postConsumers: Post;
let createCredential: CreateCredential;

function consumerId(name: string): string {
  return `${PREFIX}-${name}`;
}

function registration(name: string, credentialId: string, over: Record<string, unknown> = {}) {
  return {
    id: consumerId(name),
    credential_id: credentialId,
    repos: [`fixture/${PREFIX}`],
    event_types: ["push"],
    enabled: true,
    ...over,
  };
}

function post(body: unknown, auth: { token?: string | null; cookie?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  return postConsumers(new Request("http://localhost/api/events/consumers", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

async function seedCredential(name: string, scopes: string[], state: { revoked?: boolean; expired?: boolean } = {}) {
  const id = `${PREFIX}-cred-${name}`;
  await sql`
    insert into agent_credentials (id, label, token_prefix, token_hash, scopes, revoked_at, expires_at)
    values (
      ${id},
      ${`${PREFIX}-${name}`},
      'syn',
      ${`${PREFIX}-hash-${name}`},
      ${scopes}::text[],
      ${state.revoked ? new Date().toISOString() : null},
      ${state.expired ? "2000-01-01T00:00:00.000Z" : null}
    )
  `;
  return id;
}

async function consumerRows(id: string) {
  return sql`
    select id, credential_id, repos, event_types, enabled, generation::text as generation
    from event_stream_consumers
    where id = ${id}
  `;
}

async function receiptsFor(id: string) {
  return sql`
    select id::text as id, kind, title, detail
    from events
    where kind = 'event_consumer.register' and detail->>'consumer_id' = ${id}
    order by events.id
  `;
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  const detail = row.detail;
  if (typeof detail === "string") return JSON.parse(detail) as Record<string, unknown>;
  return detail as Record<string, unknown>;
}

function assertNoLeak(value: unknown) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(LEAK), false);
  assert.equal(text.includes("forged-actor"), false);
  assert.equal(text.includes(LEGACY), false);
  assert.equal(text.includes(PASSWORD), false);
  assert.equal(text.includes("-hash-"), false);
}

describe("event consumer registration receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_DECISIONS_FIXTURE !== "1") return;
    const fixture = actorDecisionsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    delete env.MC_DASHBOARD_PASSWORD;
    const db = await import("../../src/lib/db");
    const route = await import("../../src/app/api/events/consumers/route");
    const credentials = await import("../../src/lib/credentials");
    sql = db.sql();
    postConsumers = route.POST;
    createCredential = credentials.createCredential as CreateCredential;
    await confirmActorDecisionsFixture(sql, fixture.database);
  });

  after(async () => {
    try {
      if (process.env.AK_ACTOR_DECISIONS_FIXTURE !== "1" || !sql) return;
      const fixture = actorDecisionsFixture();
      await withOwnedFixtureCleanup(sql, fixture.database, async () => {
        await dropReceiptTrigger();
        await sql`delete from events where kind = 'event_consumer.register' and detail->>'consumer_id' like ${PREFIX + "%"}`;
        await sql`
          delete from events
          where kind = 'credential_create'
            and detail->>'credential_id' in (
              select id from agent_credentials where label like ${PREFIX + "%"}
            )
        `;
        await sql`delete from event_stream_consumers where id like ${PREFIX + "%"} or credential_id like ${PREFIX + "%"}`;
        await sql`delete from agent_credentials where id like ${PREFIX + "%"} or label like ${PREFIX + "%"}`;
      });
    } finally {
      await closeActorDecisionsPool();
      restoreEnv();
    }
  });

  it("stores the legacy principal and keeps the target credential off the actor", async () => {
    const credentialId = await seedCredential("main", ["events:read"]);
    const body = registration("main", credentialId);
    const res = await post(body, { token: LEGACY });
    assert.equal(res.status, 200);
    const json = await res.json() as { ok: boolean; consumer: Record<string, unknown>; receipt?: unknown };
    assert.equal(json.ok, true);
    assert.deepEqual(Object.keys(json).sort(), ["consumer", "ok"]);
    assert.equal(json.consumer.credential_id, credentialId);
    const rows = await consumerRows(consumerId("main"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].credential_id, credentialId);
    assert.equal(rows[0].generation, "0");
    assert.equal(rows[0].enabled, true);
    assert.deepEqual(rows[0].repos, body.repos);
    assert.deepEqual(rows[0].event_types, body.event_types);
    const proof = await receiptsFor(consumerId("main"));
    assert.equal(proof.length, 1);
    assert.equal(proof[0].kind, "event_consumer.register");
    assert.equal(proof[0].title, "Event consumer registered");
    const detail = detailOf(proof[0]);
    assert.equal(detail.tool, "event_consumer.register");
    assert.equal(detail.operation, "register");
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
    assert.notEqual(detail.actor_id, credentialId);
    assert.equal(detail.consumer_id, consumerId("main"));
    assert.equal(detail.credential_id, credentialId);
    assert.equal(detail.generation, "0");
    assert.equal(detail.enabled, true);
    assert.deepEqual(detail.repos, body.repos);
    assert.deepEqual(detail.event_types, body.event_types);
    assertNoLeak(detail);
  });

  it("attributes a session principal and refuses dev-open, an agent credential, and forged fields", async () => {
    const credentialId = await seedCredential("session", ["events:read"]);
    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    try {
      const cookie = await authCookieValue(PASSWORD);
      const session = await post(registration("session", credentialId), { cookie: `mc_auth=${cookie}` });
      assert.equal(session.status, 200);
      const detail = detailOf((await receiptsFor(consumerId("session")))[0]);
      assert.equal(detail.actor_type, "human");
      assert.equal(detail.actor_id, DASHBOARD_ACTOR_ID);
      assert.equal(detail.credential_id, credentialId);
      assert.notEqual(detail.actor_id, credentialId);
      assertNoLeak(detail);

      const missing = await post(registration("missing-auth", credentialId), {});
      assert.equal(missing.status, 401);
      assert.equal((await consumerRows(consumerId("missing-auth"))).length, 0);
      assert.equal((await receiptsFor(consumerId("missing-auth"))).length, 0);
    } finally {
      delete env.MC_DASHBOARD_PASSWORD;
    }

    const made = await createCredential({ label: `${PREFIX}-caller`, scopes: ["events:read"] });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const denied = await post(registration("agent", credentialId), { token: made.token });
    assert.equal(denied.status, 403);
    assert.equal((await consumerRows(consumerId("agent"))).length, 0);
    assert.equal((await receiptsFor(consumerId("agent"))).length, 0);
    const badBearer = await post(registration("bad-bearer", credentialId), { token: "akc_not-a-real-token" });
    assert.equal(badBearer.status, 401);
    assert.equal((await consumerRows(consumerId("bad-bearer"))).length, 0);

    delete env.MC_TOKEN;
    try {
      const open = await post(registration("dev-open", credentialId), {});
      assert.equal(open.status, 401);
      assert.equal((await consumerRows(consumerId("dev-open"))).length, 0);
      assert.equal((await receiptsFor(consumerId("dev-open"))).length, 0);
    } finally {
      env.MC_TOKEN = LEGACY;
    }

    const forged = await post({
      ...registration("forged", credentialId),
      actor_id: "forged-actor",
      actor_type: "human",
      requested_by: LEAK,
    }, { token: LEGACY });
    assert.equal(forged.status, 400);
    const forgedBody = await forged.json() as { error: string };
    assert.equal(forgedBody.error, "invalid_consumer");
    assert.equal((await consumerRows(consumerId("forged"))).length, 0);
    assert.equal((await receiptsFor(consumerId("forged"))).length, 0);
  });

  it("rejects an ineligible target and a duplicate binding without a receipt", async () => {
    const eligible = await seedCredential("eligible", ["events:read"]);
    const wrong = await seedCredential("wrong", ["tasks:read"]);
    const revoked = await seedCredential("revoked", ["events:read"], { revoked: true });
    const expired = await seedCredential("expired", ["events:read"], { expired: true });
    const first = await post(registration("bound", eligible), { token: LEGACY });
    assert.equal(first.status, 200);
    const before = await consumerRows(consumerId("bound"));
    assert.equal(before[0].generation, "0");

    for (const [name, credentialId] of [
      ["missing", `${PREFIX}-cred-absent`],
      ["wrong", wrong],
      ["revoked", revoked],
      ["expired", expired],
    ] as const) {
      const res = await post(registration(name, credentialId), { token: LEGACY });
      assert.equal(res.status, 400, name);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "credential_not_eligible");
      assert.equal((await consumerRows(consumerId(name))).length, 0);
      assert.equal((await receiptsFor(consumerId(name))).length, 0);
    }

    const duplicate = await post(registration("other", eligible), { token: LEGACY });
    assert.equal(duplicate.status, 409);
    const duplicateBody = await duplicate.json() as { error: string; code: string };
    assert.equal(duplicateBody.error, "credential_already_bound");
    assert.equal(duplicateBody.code, "conflict");
    assert.equal((await consumerRows(consumerId("other"))).length, 0);
    assert.equal((await receiptsFor(consumerId("other"))).length, 0);
    const after = await consumerRows(consumerId("bound"));
    assert.equal(after[0].generation, "0");
    assert.equal(after[0].credential_id, eligible);
    assert.equal((await receiptsFor(consumerId("bound"))).length, 1);
  });

  it("receipts a same-id generation bump and does not treat it as a no-op", async () => {
    const credentialId = await seedCredential("bump", ["events:read"]);
    const first = await post(registration("bump", credentialId), { token: LEGACY });
    assert.equal(first.status, 200);
    const secondBody = registration("bump", credentialId, { event_types: ["status"] });
    const second = await post(secondBody, { token: LEGACY });
    assert.equal(second.status, 200);
    const row = await consumerRows(consumerId("bump"));
    assert.equal(row[0].generation, "1");
    assert.deepEqual(row[0].event_types, ["status"]);
    const proof = await receiptsFor(consumerId("bump"));
    assert.equal(proof.length, 2);
    assert.equal(detailOf(proof[0]).generation, "0");
    assert.deepEqual(detailOf(proof[0]).event_types, ["push"]);
    assert.equal(detailOf(proof[1]).generation, "1");
    assert.deepEqual(detailOf(proof[1]).event_types, ["status"]);
    assert.equal(detailOf(proof[1]).actor_id, LEGACY_ACTOR_ID);
    assert.equal(detailOf(proof[1]).credential_id, credentialId);
    assertNoLeak(detailOf(proof[1]));
  });

  it("attributes two concurrent registrations separately", async () => {
    const leftId = await seedCredential("left", ["events:read"]);
    const rightId = await seedCredential("right", ["events:read"]);
    const [left, right] = await Promise.all([
      post(registration("left", leftId), { token: LEGACY }),
      post(registration("right", rightId), { token: LEGACY }),
    ]);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    for (const [name, credentialId] of [["left", leftId], ["right", rightId]] as const) {
      const proof = await receiptsFor(consumerId(name));
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.consumer_id, consumerId(name));
      assert.equal(detail.credential_id, credentialId);
      assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
      assert.notEqual(detail.actor_id, credentialId);
      assert.equal((await consumerRows(consumerId(name)))[0].generation, "0");
    }
  });

  it("rolls a registration back when its receipt fails or is suppressed", async () => {
    const credentialId = await seedCredential("rollback", ["events:read"]);
    const kept = await post(registration("kept", credentialId), { token: LEGACY });
    assert.equal(kept.status, 200);
    const other = await seedCredential("rollback-new", ["events:read"]);
    await installReceiptTrigger("fail", consumerId("fail"));
    try {
      const failed = await post(registration("fail", other), { token: LEGACY });
      assert.equal(failed.status, 503);
      const body = await failed.json() as { error: string; code: string };
      assert.equal(body.error, "stream_unavailable");
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      assert.equal((await consumerRows(consumerId("fail"))).length, 0);
      assert.equal((await receiptsFor(consumerId("fail"))).length, 0);
      assert.equal((await consumerRows(consumerId("kept")))[0].generation, "0");
    } finally {
      await dropReceiptTrigger();
    }

    const before = await receiptsFor(consumerId("kept"));
    await installReceiptTrigger("suppress", consumerId("kept"));
    try {
      const suppressed = await post(registration("kept", credentialId, { event_types: ["status"] }), { token: LEGACY });
      assert.equal(suppressed.status, 503);
      const row = await consumerRows(consumerId("kept"));
      assert.equal(row[0].generation, "0");
      assert.deepEqual(row[0].event_types, ["push"]);
      assert.equal((await receiptsFor(consumerId("kept"))).length, before.length);
    } finally {
      await dropReceiptTrigger();
    }
  });

  it("answers an unconfigured database without writing", async () => {
    const credentialId = await seedCredential("demo", ["events:read"]);
    const beforeConsumers = await sql`select count(*)::int as n from event_stream_consumers where id like ${PREFIX + "%"}`;
    const beforeEvents = await sql`
      select count(*)::int as n from events
      where kind = 'event_consumer.register' and detail->>'consumer_id' like ${PREFIX + "%"}
    `;
    delete env.DATABASE_URL;
    try {
      const res = await post(registration("demo", credentialId), { token: LEGACY });
      assert.equal(res.status, 503);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "stream_not_configured");
    } finally {
      env.DATABASE_URL = actorDecisionsFixture().url;
    }
    const afterConsumers = await sql`select count(*)::int as n from event_stream_consumers where id like ${PREFIX + "%"}`;
    const afterEvents = await sql`
      select count(*)::int as n from events
      where kind = 'event_consumer.register' and detail->>'consumer_id' like ${PREFIX + "%"}
    `;
    assert.equal(afterConsumers[0].n, beforeConsumers[0].n);
    assert.equal(afterEvents[0].n, beforeEvents[0].n);
    assert.equal((await consumerRows(consumerId("demo"))).length, 0);
  });
});

async function installReceiptTrigger(mode: "fail" | "suppress", which: string) {
  await sql`drop trigger if exists ak_reg_fail_receipt on events`;
  await sql`drop trigger if exists ak_reg_suppress_receipt on events`;
  await sql`create table if not exists ak_reg_fail_id (id text primary key)`;
  await sql`create table if not exists ak_reg_suppress_id (id text primary key)`;
  if (mode === "fail") {
    await sql`delete from ak_reg_fail_id`;
    await sql`insert into ak_reg_fail_id (id) values (${which})`;
    await sql`
      create or replace function ak_reg_fail_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'event_consumer.register'
           and new.detail->>'consumer_id' in (select id from ak_reg_fail_id) then
          raise exception 'injected receipt failure';
        end if;
        return new;
      end;
      $$
    `;
    await sql`
      create trigger ak_reg_fail_receipt
      before insert on events
      for each row execute function ak_reg_fail_receipt()
    `;
    return;
  }
  await sql`delete from ak_reg_suppress_id`;
  await sql`insert into ak_reg_suppress_id (id) values (${which})`;
  await sql`
    create or replace function ak_reg_suppress_receipt() returns trigger
    language plpgsql as $$
    begin
      if new.kind = 'event_consumer.register'
         and new.detail->>'consumer_id' in (select id from ak_reg_suppress_id) then
        return null;
      end if;
      return new;
    end;
    $$
  `;
  await sql`
    create trigger ak_reg_suppress_receipt
    before insert on events
    for each row execute function ak_reg_suppress_receipt()
  `;
}

async function dropReceiptTrigger() {
  await sql`drop trigger if exists ak_reg_fail_receipt on events`;
  await sql`drop trigger if exists ak_reg_suppress_receipt on events`;
  await sql`drop function if exists ak_reg_fail_receipt()`;
  await sql`drop function if exists ak_reg_suppress_receipt()`;
  await sql`drop table if exists ak_reg_fail_id`;
  await sql`drop table if exists ak_reg_suppress_id`;
}

function restoreEnv() {
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.driver === undefined) delete env.MC_DB_DRIVER;
  else env.MC_DB_DRIVER = saved.driver;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
  if (saved.node === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved.node;
  if (saved.password === undefined) delete env.MC_DASHBOARD_PASSWORD;
  else env.MC_DASHBOARD_PASSWORD = saved.password;
}
