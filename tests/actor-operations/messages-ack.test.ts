import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { authCookieValue } from "../../src/lib/authcrypto";
import { actorOperationsFixture, closeActorOperationsPool, confirmActorOperationsFixture, withOwnedFixtureCleanup } from "./fixture";

/**
 * Message acknowledgement actor receipts. Opt in with AK_ACTOR_OPERATIONS_FIXTURE=1.
 * Without that flag this file does not import the database, open a pool, or
 * register hooks that connect. It is outside tests/ui so the UI suite never
 * loads it. The fixture URL is fixed; ambient DATABASE_URL is not used.
 */
const OPT_IN = process.env.AK_ACTOR_OPERATIONS_FIXTURE === "1";
const LEGACY = "actor-ops-messages-legacy";
const PREFIX = `bmsg-${randomUUID().slice(0, 8)}`;
const SECRET = "secret-message-body";
const PASSWORD = "actor-ops-messages-password";

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
};

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
type Handler = (req: Request) => Promise<Response>;
type Credential = { ok: true; token: string; credential: { id: string } } | { ok: false; error: string };

let sql: SqlTag;
let getMessages: Handler;
let patchMessages: Handler;
let mcpPost: Handler;
let createCredential: (input: {
  label: string;
  scopes: string[];
  rate_limit_per_minute?: number;
  rate_limit_per_day?: number;
}) => Promise<Credential>;

function agent(name: string): string {
  return `${PREFIX}-${name}`;
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  const detail = row.detail;
  if (typeof detail === "string") return JSON.parse(detail) as Record<string, unknown>;
  return detail as Record<string, unknown>;
}

async function plant(name: string, direction: "inbound" | "outbound"): Promise<string> {
  const rows = await sql`
    insert into messages (agent_id, body, created_by, direction, actor_type, actor_id)
    values (${agent(name)}, ${SECRET}, 'forged-actor-label', ${direction}, 'human', 'forged-row-actor')
    returning id::text as id
  `;
  return String(rows[0].id);
}

async function messageRow(id: string) {
  const rows = await sql`
    select id::text as id, agent_id, body, acked_at, delivered_at, read_by_dashboard_at, created_by
    from messages
    where id = ${id}::bigint
  `;
  return rows[0];
}

async function receipts(kind: string, messageId: string) {
  return sql`
    select id::text as id, kind, title, detail
    from events
    where kind = ${kind}
      and detail->'message_ids' ? ${messageId}
    order by id
  `;
}

async function eventCount(kind: string): Promise<number> {
  const rows = await sql`select count(*)::int as n from events where kind = ${kind}`;
  return Number(rows[0].n);
}

function authHeaders(token: string | null, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  return headers;
}

function get(name: string, opts: { ack?: boolean; conversation?: boolean; token?: string | null; cookie?: string }) {
  const url = new URL("http://localhost/api/messages");
  url.searchParams.set("agent_id", agent(name));
  url.searchParams.set("actor_id", "forged-actor-label");
  url.searchParams.set("source", "forged-source");
  url.searchParams.set("host", "forged-host");
  if (opts.ack) url.searchParams.set("ack", "true");
  if (opts.conversation) url.searchParams.set("conversation", "true");
  return getMessages(new Request(url, { headers: authHeaders(opts.token ?? null, opts.cookie) }));
}

function patch(name: string, opts: { token?: string | null; cookie?: string }) {
  return patchMessages(new Request("http://localhost/api/messages", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders(opts.token ?? null, opts.cookie) },
    body: JSON.stringify({
      agent_id: agent(name),
      actor_id: "forged-actor-label",
      actor_type: "human",
      source: "forged-source",
      host: "forged-host",
    }),
  }));
}

type Handle = { unref?: () => void };

function handles(): Handle[] {
  const getHandles = (process as unknown as { _getActiveHandles?: () => Handle[] })._getActiveHandles;
  return getHandles ? getHandles() : [];
}

async function checkInbox(token: string, name: string, ack: boolean) {
  const before = new Set(handles());
  try {
    return await mcpPost(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_inbox",
          arguments: {
            agent_id: agent(name),
            ack,
            actor_id: "forged-actor-label",
            source: "forged-source",
            host: "forged-host",
          },
        },
      }),
    }));
  } finally {
    for (const handle of handles()) {
      if (!before.has(handle)) handle.unref?.();
    }
  }
}

async function armReceiptFailure(messageId: string) {
  await sql`create table if not exists ak_b_messages_fail (message_id text primary key)`;
  await sql`delete from ak_b_messages_fail`;
  await sql`insert into ak_b_messages_fail (message_id) values (${messageId})`;
  await sql`
    create or replace function ak_b_messages_fail_receipt() returns trigger
    language plpgsql as $$
    begin
      if new.kind in ('messages.ack', 'messages.read')
         and exists (
           select 1 from ak_b_messages_fail f
           where new.detail->'message_ids' ? f.message_id
         ) then
        raise exception 'injected receipt failure';
      end if;
      return new;
    end;
    $$
  `;
  await sql`drop trigger if exists ak_b_messages_fail_receipt on events`;
  await sql`
    create trigger ak_b_messages_fail_receipt
    before insert on events
    for each row execute function ak_b_messages_fail_receipt()
  `;
}

function assertSafe(detail: Record<string, unknown>, actorType: string | null, actorId: string | null) {
  const text = JSON.stringify(detail);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(LEGACY), false);
  assert.equal(text.includes("forged-actor-label"), false);
  assert.equal(text.includes("forged-source"), false);
  assert.equal(text.includes("forged-host"), false);
  assert.equal(text.includes("forged-row-actor"), false);
  assert.equal(text.includes(PREFIX), false);
  assert.equal(detail.actor_type, actorType);
  assert.equal(detail.actor_id, actorId);
  assert.equal("agent_id" in detail, false);
  assert.equal("body" in detail, false);
}

describe("B message acknowledgement actor receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1") return;
    const fixture = actorOperationsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    delete env.MC_DASHBOARD_PASSWORD;
    const db = await import("../../src/lib/db");
    const origInterval = global.setInterval;
    global.setInterval = ((fn: TimerHandler, ms?: number) => {
      const timer = origInterval(fn, ms);
      (timer as Handle).unref?.();
      return timer;
    }) as typeof setInterval;
    try {
      const route = await import("../../src/app/api/messages/route");
      const mcp = await import(pathToFileURL(path.join(process.cwd(), "src/app/api/[transport]/route.ts")).href);
      const credentials = await import("../../src/lib/credentials");
      sql = db.sql();
      getMessages = route.GET;
      patchMessages = route.PATCH;
      mcpPost = mcp.POST;
      createCredential = credentials.createCredential as typeof createCredential;
    } finally {
      global.setInterval = origInterval;
    }
    await confirmActorOperationsFixture(sql, fixture.database);
  });

  after(async () => {
    try {
      if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1" || !sql) return;
      const fixture = actorOperationsFixture();
      await withOwnedFixtureCleanup(sql, fixture.database, async () => {
        await sql`drop trigger if exists ak_b_messages_fail_receipt on events`;
        await sql`drop function if exists ak_b_messages_fail_receipt()`;
        await sql`drop table if exists ak_b_messages_fail`;
        const needle = `${PREFIX}%`;
        await sql`
          delete from events e
          where e.kind in ('messages.ack', 'messages.read')
            and exists (
              select 1 from messages m
              where m.agent_id like ${needle}
                and e.detail->'message_ids' ? m.id::text
            )
        `;
        await sql`delete from messages where agent_id like ${needle}`;
        await sql`delete from agent_credentials where label like ${needle}`;
      });
    } finally {
      await closeActorOperationsPool();
      restoreEnv();
    }
  });

  it("stores the legacy principal for the messages an ack actually updates", async () => {
    const first = await plant("legacy", "inbound");
    const second = await plant("legacy", "inbound");
    const outbound = await plant("legacy", "outbound");
    const res = await get("legacy", { ack: true, token: LEGACY });
    assert.equal(res.status, 200);
    const body = await res.json() as { messages: { id: number; acked_at: string | null; body: string }[]; demo?: boolean };
    assert.equal(body.demo, undefined);
    assert.deepEqual(body.messages.map((row) => row.id).sort((a, b) => a - b), [Number(first), Number(second)].sort((a, b) => a - b));
    assert.equal(body.messages.every((row) => row.acked_at), true);

    for (const id of [first, second]) {
      const row = await messageRow(id);
      assert.equal(row.body, SECRET);
      assert.ok(row.acked_at);
      assert.ok(row.delivered_at);
      const proof = await receipts("messages.ack", id);
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.tool, "messages.ack");
      assert.equal(detail.operation, "ack");
      assert.deepEqual(detail.message_ids, [first, second].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)));
      assertSafe(detail, "agent", "mc-token");
    }
    const left = await messageRow(outbound);
    assert.equal(left.acked_at, null);
    assert.equal((await receipts("messages.ack", outbound)).length, 0);
    assert.equal((await receipts("messages.read", outbound)).length, 0);

    const again = await get("legacy", { ack: true, token: LEGACY });
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json() as { messages: unknown[] }).messages, []);
    assert.equal((await receipts("messages.ack", first)).length, 1);
  });

  it("leaves reads and zero matches without a receipt", async () => {
    const pending = await plant("quiet", "inbound");
    const beforeAck = await eventCount("messages.ack");
    const beforeRead = await eventCount("messages.read");
    const listed = await get("quiet", { token: LEGACY });
    assert.equal(listed.status, 200);
    const conversation = await get("quiet", { conversation: true, token: LEGACY });
    assert.equal(conversation.status, 200);
    const empty = await get("nobody", { ack: true, token: LEGACY });
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json() as { messages: unknown[] }).messages, []);
    const row = await messageRow(pending);
    assert.equal(row.acked_at, null);
    assert.equal(row.read_by_dashboard_at, null);
    assert.equal(await eventCount("messages.ack"), beforeAck);
    assert.equal(await eventCount("messages.read"), beforeRead);
    assert.equal((await receipts("messages.ack", pending)).length, 0);
  });

  it("uses the credential id as the actor and rejects a missing scope", async () => {
    const reader = await createCredential({
      label: `${PREFIX}-reader`,
      scopes: ["messages:read"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    const writer = await createCredential({
      label: `${PREFIX}-writer`,
      scopes: ["messages:write"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(reader.ok, true);
    assert.equal(writer.ok, true);
    if (!reader.ok || !writer.ok) return;
    const id = await plant("scoped", "inbound");
    const denied = await get("scoped", { ack: true, token: writer.token });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code?: string }).code, "insufficient_scope");
    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    try {
      const bad = await get("scoped", { ack: true, token: "not-the-token" });
      assert.equal(bad.status, 401);
    } finally {
      delete env.MC_DASHBOARD_PASSWORD;
    }
    assert.equal((await messageRow(id)).acked_at, null);
    assert.equal((await receipts("messages.ack", id)).length, 0);

    const allowed = await get("scoped", { ack: true, token: reader.token });
    assert.equal(allowed.status, 200);
    assert.ok((await messageRow(id)).acked_at);
    const proof = await receipts("messages.ack", id);
    assert.equal(proof.length, 1);
    const detail = detailOf(proof[0]);
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, reader.credential.id);
    assert.notEqual(detail.actor_id, agent("scoped"));
    assertSafe(detail, "agent", reader.credential.id);
  });

  it("records a null actor for dev-open and does not invent an operator", async () => {
    const id = await plant("open", "inbound");
    delete env.MC_TOKEN;
    try {
      const res = await get("open", { ack: true, token: null });
      assert.equal(res.status, 200);
      const proof = await receipts("messages.ack", id);
      assert.equal(proof.length, 1);
      assertSafe(detailOf(proof[0]), null, null);
      assert.equal(JSON.stringify(detailOf(proof[0])).includes("operator"), false);
    } finally {
      env.MC_TOKEN = LEGACY;
    }
  });

  it("stores the dashboard principal for outbound reads and ignores forged labels", async () => {
    const outbound = await plant("drawer", "outbound");
    const inbound = await plant("drawer", "inbound");
    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    try {
      const cookie = await authCookieValue(PASSWORD);
      const before = await eventCount("messages.read");
      const none = await patch("empty-drawer", { token: null, cookie: `mc_auth=${cookie}` });
      assert.equal(none.status, 200);
      assert.equal((await none.json() as { updated: number }).updated, 0);
      assert.equal(await eventCount("messages.read"), before);
      const res = await patch("drawer", { token: null, cookie: `mc_auth=${cookie}` });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { updated: number }).updated, 1);
      const row = await messageRow(outbound);
      assert.ok(row.read_by_dashboard_at);
      assert.equal((await messageRow(inbound)).read_by_dashboard_at, null);
      const proof = await receipts("messages.read", outbound);
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.tool, "messages.read");
      assert.equal(detail.operation, "read");
      assert.deepEqual(detail.message_ids, [outbound]);
      assertSafe(detail, "human", "operator");
      assert.equal((await receipts("messages.read", inbound)).length, 0);
      assert.equal(await eventCount("messages.read"), before + 1);
    } finally {
      delete env.MC_DASHBOARD_PASSWORD;
    }
  });

  it("rejects an agent credential on the dashboard read route", async () => {
    const reader = await createCredential({
      label: `${PREFIX}-patch-denied`,
      scopes: ["messages:read"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(reader.ok, true);
    if (!reader.ok) return;
    const id = await plant("patch-denied", "outbound");
    const denied = await patch("patch-denied", { token: reader.token });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code?: string }).code, "insufficient_scope");
    assert.equal((await messageRow(id)).read_by_dashboard_at, null);
    assert.equal((await receipts("messages.read", id)).length, 0);
  });

  it("acks through check_inbox with the caller principal and skips ack false", async () => {
    const held = await plant("inbox", "inbound");
    const before = await eventCount("messages.ack");
    const skipped = await checkInbox(LEGACY, "inbox", false);
    assert.equal(skipped.status, 200);
    const skippedText = await skipped.text();
    assert.match(skippedText, new RegExp(`#${held}`));
    assert.equal((await messageRow(held)).acked_at, null);
    assert.equal(await eventCount("messages.ack"), before);
    assert.equal((await receipts("messages.ack", held)).length, 0);

    const taken = await checkInbox(LEGACY, "inbox", true);
    assert.equal(taken.status, 200);
    assert.match(await taken.text(), new RegExp(`#${held}`));
    assert.ok((await messageRow(held)).acked_at);
    const proof = await receipts("messages.ack", held);
    assert.equal(proof.length, 1);
    assertSafe(detailOf(proof[0]), "agent", "mc-token");

    const reader = await createCredential({
      label: `${PREFIX}-inbox`,
      scopes: ["messages:read"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(reader.ok, true);
    if (!reader.ok) return;
    const other = await plant("inbox-cred", "inbound");
    const credited = await checkInbox(reader.token, "inbox-cred", true);
    assert.equal(credited.status, 200);
    const detail = detailOf((await receipts("messages.ack", other))[0]);
    assert.equal(detail.actor_id, reader.credential.id);
    assert.notEqual(detail.actor_id, agent("inbox-cred"));
  });

  it("rolls one acknowledgement back when its receipt fails and keeps an earlier one", async () => {
    const kept = await plant("keep", "inbound");
    const keptRes = await get("keep", { ack: true, token: LEGACY });
    assert.equal(keptRes.status, 200);
    const failed = await plant("fail", "inbound");
    await armReceiptFailure(failed);
    try {
      const res = await get("fail", { ack: true, token: LEGACY });
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      assert.equal((await messageRow(failed)).acked_at, null);
      assert.equal((await receipts("messages.ack", failed)).length, 0);
      assert.ok((await messageRow(kept)).acked_at);
      assert.equal((await receipts("messages.ack", kept)).length, 1);
      assert.equal(detailOf((await receipts("messages.ack", kept))[0]).actor_id, "mc-token");
    } finally {
      await sql`drop trigger if exists ak_b_messages_fail_receipt on events`;
      await sql`drop function if exists ak_b_messages_fail_receipt()`;
      await sql`drop table if exists ak_b_messages_fail`;
    }
  });

  it("rolls one dashboard read back when its receipt fails and keeps an earlier one", async () => {
    const kept = await plant("read-keep", "outbound");
    const keptRes = await patch("read-keep", { token: LEGACY });
    assert.equal(keptRes.status, 200);
    const failed = await plant("read-fail", "outbound");
    await armReceiptFailure(failed);
    try {
      const res = await patch("read-fail", { token: LEGACY });
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      assert.equal((await messageRow(failed)).read_by_dashboard_at, null);
      assert.equal((await receipts("messages.read", failed)).length, 0);
      assert.ok((await messageRow(kept)).read_by_dashboard_at);
      assert.equal((await receipts("messages.read", kept)).length, 1);
    } finally {
      await sql`drop trigger if exists ak_b_messages_fail_receipt on events`;
      await sql`drop function if exists ak_b_messages_fail_receipt()`;
      await sql`drop table if exists ak_b_messages_fail`;
    }
  });

  it("answers demo mode without writing when the database is unset", async () => {
    const before = await eventCount("messages.ack");
    delete env.DATABASE_URL;
    try {
      const res = await get("demo", { ack: true, token: LEGACY });
      assert.equal(res.status, 200);
      const body = await res.json() as { demo?: boolean; messages: unknown[] };
      assert.equal(body.demo, true);
      assert.deepEqual(body.messages, []);
    } finally {
      env.DATABASE_URL = actorOperationsFixture().url;
    }
    assert.equal(await eventCount("messages.ack"), before);
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
  if (saved.password === undefined) delete env.MC_DASHBOARD_PASSWORD;
  else env.MC_DASHBOARD_PASSWORD = saved.password;
}
