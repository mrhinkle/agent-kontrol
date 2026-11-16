import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { actorOperationsFixture, confirmActorOperationsFixture } from "./fixture";

/**
 * OTLP trace ingest actor receipts. Opt in with AK_ACTOR_OPERATIONS_FIXTURE=1.
 * Without that flag this file does not import the database, open a pool, or
 * register hooks that connect. It is outside tests/ui so the UI suite never
 * loads it. The fixture URL is fixed; ambient DATABASE_URL is not used.
 */
const OPT_IN = process.env.AK_ACTOR_OPERATIONS_FIXTURE === "1";
const LEGACY = "actor-ops-traces-legacy";
const AGENT = "forged-span-agent";
const traceIds: string[] = [];

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
let postTraces: Post;
let pruneSpans: () => Promise<void>;
let createCredential: (input: { label: string; scopes: string[] }) => Promise<{ ok: true; token: string; credential: { id: string } } | { ok: false; error: string }>;

function hex(bytes: number): string {
  const id = randomBytes(bytes).toString("hex");
  return /^0+$/.test(id) ? "1".repeat(bytes * 2) : id;
}

function ids(): { traceId: string; spanId: string } {
  const traceId = hex(16);
  traceIds.push(traceId);
  return { traceId, spanId: hex(8) };
}

function otlp(spans: { traceId: string; spanId: string; name?: string; parentSpanId?: string }[]) {
  return {
    actor_id: "forged-actor-label",
    actor_type: "human",
    source: "forged-source",
    host: "forged-host",
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "agent.id", value: { stringValue: AGENT } },
          { key: "host.name", value: { stringValue: "forged-host" } },
        ],
      },
      scopeSpans: [{
        spans: spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name ?? "secret-span-name",
          startTimeUnixNano: "1790000000000000000",
          attributes: [
            { key: "note", value: { stringValue: "secret-span-note" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "424242" } },
          ],
        })),
      }],
    }],
  };
}

function post(body: unknown, token: string | null, headers: Record<string, string> = {}) {
  const initHeaders: Record<string, string> = { "content-type": "application/json", ...headers };
  if (token) initHeaders.authorization = `Bearer ${token}`;
  const payload = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  return postTraces(new Request("http://localhost/api/v1/traces", {
    method: "POST",
    headers: initHeaders,
    body: payload,
  }));
}

async function spans(traceId: string) {
  return sql`
    select trace_id, span_id, agent_id, name, input_tokens::text as input_tokens, attributes
    from spans
    where trace_id = ${traceId}
    order by span_id
  `;
}

async function receipts(traceId: string) {
  return sql`
    select id::text as id, kind, title, detail
    from events
    where kind = 'traces.ingest' and detail::text like ${"%" + traceId + "%"}
    order by id
  `;
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  const detail = row.detail;
  if (typeof detail === "string") return JSON.parse(detail) as Record<string, unknown>;
  return detail as Record<string, unknown>;
}

describe("B trace ingest actor receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1") return;
    const fixture = actorOperationsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    const db = await import("../../src/lib/db");
    const route = await import("../../src/app/api/v1/traces/route");
    const store = await import("../../src/lib/trace-store");
    const credentials = await import("../../src/lib/credentials");
    sql = db.sql();
    postTraces = route.POST;
    pruneSpans = store.pruneSpans;
    createCredential = credentials.createCredential as typeof createCredential;
    await confirmActorOperationsFixture(sql, fixture.database);
  });

  after(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1" || !sql) {
      restoreEnv();
      return;
    }
    const seen = await sql`select current_database() as db, current_user as db_user`;
    if (seen[0]?.db === "ak_actor_operations" && seen[0]?.db_user === "ak_backlog_test") {
      await sql`drop trigger if exists ak_b_traces_fail_receipt on events`;
      await sql`drop function if exists ak_b_traces_fail_receipt()`;
      await sql`drop table if exists ak_b_traces_fail`;
      await sql`drop trigger if exists ak_b_traces_suppress_receipt on events`;
      await sql`drop function if exists ak_b_traces_suppress_receipt()`;
      await sql`drop table if exists ak_b_traces_suppress`;
      if (traceIds.length > 0) {
        await sql`delete from events where kind = 'traces.ingest' and detail::text like any(${traceIds.map((id) => `%${id}%`)}::text[])`;
        await sql`delete from spans where trace_id = any(${traceIds}::text[])`;
      }
      await sql`delete from agent_credentials where label = 'actor-ops-traces-denied'`;
    }
    restoreEnv();
  });

  it("stores the legacy principal for accepted spans and ignores forged labels", async () => {
    const good = ids();
    const other = ids();
    const res = await post(otlp([
      good,
      { ...other, name: "second-span" },
      { traceId: "bad", spanId: "1" },
    ]), LEGACY);
    assert.equal(res.status, 200);
    const body = await res.json() as { partialSuccess: { rejectedSpans: number; errorMessage?: string }; demo?: boolean };
    assert.equal(body.demo, undefined);
    assert.equal(body.partialSuccess.rejectedSpans, 1);
    assert.match(body.partialSuccess.errorMessage ?? "", /traceId/);

    for (const span of [good, other]) {
      const rows = await spans(span.traceId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].agent_id, AGENT);
      assert.equal(rows[0].input_tokens, "424242");
      assert.match(JSON.stringify(rows[0].attributes), /secret-span-note/);
      const proof = await receipts(span.traceId);
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.tool, "traces.ingest");
      assert.equal(detail.actor_type, "agent");
      assert.equal(detail.actor_id, "mc-token");
      assert.equal(detail.operation, "upsert");
      assert.deepEqual(detail.trace_ids, [good.traceId, other.traceId].sort());
      assert.deepEqual(detail.span_ids, [`${good.traceId}/${good.spanId}`, `${other.traceId}/${other.spanId}`].sort());
      const text = JSON.stringify(detail);
      assert.equal(text.includes("forged-actor-label"), false);
      assert.equal(text.includes("forged-source"), false);
      assert.equal(text.includes("forged-host"), false);
      assert.equal(text.includes(AGENT), false);
      assert.equal(text.includes("secret-span-name"), false);
      assert.equal(text.includes("secret-span-note"), false);
      assert.equal(text.includes("424242"), false);
      assert.equal(text.includes(LEGACY), false);
      assert.equal(text.includes("traceId must"), false);
    }
    assert.equal((await spans("bad")).length, 0);
  });

  it("accepts gzip and collapses a repeated span id to one row and one receipt", async () => {
    const span = ids();
    const payload = otlp([span, { ...span, name: "closed-later" }]);
    const res = await post(gzipSync(Buffer.from(JSON.stringify(payload))), LEGACY, { "content-encoding": "gzip" });
    assert.equal(res.status, 200);
    const body = await res.json() as { partialSuccess: Record<string, unknown> };
    assert.deepEqual(body.partialSuccess, {});
    const rows = await spans(span.traceId);
    assert.equal(rows.length, 1);
    const proof = await receipts(span.traceId);
    assert.equal(proof.length, 1);
    assert.deepEqual(detailOf(proof[0]).span_ids, [`${span.traceId}/${span.spanId}`]);
    assert.equal(detailOf(proof[0]).actor_id, "mc-token");
  });

  it("writes no receipt when every span is rejected", async () => {
    const before = await sql`select count(*)::int as n from events where kind = 'traces.ingest'`;
    const res = await post({
      resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{ traceId: "bad", spanId: "1", name: "junk" }] }] }],
    }, LEGACY);
    assert.equal(res.status, 200);
    const body = await res.json() as { partialSuccess: { rejectedSpans: number } };
    assert.equal(body.partialSuccess.rejectedSpans, 1);
    const after = await sql`select count(*)::int as n from events where kind = 'traces.ingest'`;
    assert.equal(after[0].n, before[0].n);
  });

  it("rejects an agent credential and a bad bearer without a span or receipt", async () => {
    const made = await createCredential({ label: "actor-ops-traces-denied", scopes: ["usage:read"] });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const span = ids();
    const denied = await post(otlp([span]), made.token);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { code?: string }).code, "insufficient_scope");
    const bad = await post(otlp([span]), "not-the-token");
    assert.equal(bad.status, 401);
    assert.equal((await spans(span.traceId)).length, 0);
    assert.equal((await receipts(span.traceId)).length, 0);
  });

  it("rejects a non-OTLP body before any write", async () => {
    const before = await sql`select count(*)::int as n from spans`;
    const res = await post({ a: 1 }, LEGACY);
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { code?: string }).code, "validation_failed");
    const after = await sql`select count(*)::int as n from spans`;
    assert.equal(after[0].n, before[0].n);
  });

  it("records a null actor for dev-open and does not invent an operator", async () => {
    delete env.MC_TOKEN;
    try {
      const span = ids();
      const res = await post(otlp([span]), null);
      assert.equal(res.status, 200);
      const proof = await receipts(span.traceId);
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.actor_type, null);
      assert.equal(detail.actor_id, null);
      assert.equal(JSON.stringify(detail).includes("operator"), false);
      assert.equal(JSON.stringify(detail).includes(AGENT), false);
    } finally {
      env.MC_TOKEN = LEGACY;
    }
  });

  it("drops the span when its receipt fails and keeps an earlier trace", async () => {
    const kept = ids();
    const keptRes = await post(otlp([kept]), LEGACY);
    assert.equal(keptRes.status, 200);
    const fail = ids();
    await sql`create table if not exists ak_b_traces_fail (trace_id text primary key)`;
    await sql`delete from ak_b_traces_fail`;
    await sql`insert into ak_b_traces_fail (trace_id) values (${fail.traceId})`;
    await sql`
      create or replace function ak_b_traces_fail_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'traces.ingest'
           and position((select trace_id from ak_b_traces_fail) in new.detail::text) > 0 then
          raise exception 'injected receipt failure';
        end if;
        return new;
      end;
      $$
    `;
    await sql`drop trigger if exists ak_b_traces_fail_receipt on events`;
    await sql`
      create trigger ak_b_traces_fail_receipt
      before insert on events
      for each row execute function ak_b_traces_fail_receipt()
    `;
    try {
      const res = await post(otlp([fail]), LEGACY);
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      assert.equal((await spans(kept.traceId)).length, 1);
      assert.equal((await receipts(kept.traceId)).length, 1);
      assert.equal(detailOf((await receipts(kept.traceId))[0]).actor_id, "mc-token");
      assert.equal((await spans(fail.traceId)).length, 0);
      assert.equal((await receipts(fail.traceId)).length, 0);
    } finally {
      await sql`drop trigger if exists ak_b_traces_fail_receipt on events`;
      await sql`drop function if exists ak_b_traces_fail_receipt()`;
      await sql`drop table if exists ak_b_traces_fail`;
    }
  });

  it("drops the span when its receipt is silently suppressed and keeps an earlier trace", async () => {
    const kept = ids();
    const keptRes = await post(otlp([kept]), LEGACY);
    assert.equal(keptRes.status, 200);
    const fail = ids();
    await sql`create table if not exists ak_b_traces_suppress (trace_id text primary key)`;
    await sql`delete from ak_b_traces_suppress`;
    await sql`insert into ak_b_traces_suppress (trace_id) values (${fail.traceId})`;
    await sql`
      create or replace function ak_b_traces_suppress_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'traces.ingest'
           and position((select trace_id from ak_b_traces_suppress) in new.detail::text) > 0 then
          return null;
        end if;
        return new;
      end;
      $$
    `;
    await sql`drop trigger if exists ak_b_traces_suppress_receipt on events`;
    await sql`
      create trigger ak_b_traces_suppress_receipt
      before insert on events
      for each row execute function ak_b_traces_suppress_receipt()
    `;
    try {
      const res = await post(otlp([fail]), LEGACY);
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "internal_error");
      assert.equal((await spans(kept.traceId)).length, 1);
      assert.equal((await receipts(kept.traceId)).length, 1);
      assert.equal((await spans(fail.traceId)).length, 0);
      assert.equal((await receipts(fail.traceId)).length, 0);
    } finally {
      await sql`drop trigger if exists ak_b_traces_suppress_receipt on events`;
      await sql`drop function if exists ak_b_traces_suppress_receipt()`;
      await sql`drop table if exists ak_b_traces_suppress`;
    }
  });

  it("prunes old spans without an actor receipt", async () => {
    const old = ids();
    const before = await sql`select count(*)::int as n from events where kind = 'traces.ingest'`;
    await sql`
      insert into spans (trace_id, span_id, agent_id, name, kind, status, started_at)
      values (${old.traceId}, ${hex(8)}, 'housekeeping', 'old', 'other', 'unset', '2020-01-01T00:00:00.000Z')
    `;
    await pruneSpans();
    assert.equal((await spans(old.traceId)).length, 0);
    const after = await sql`select count(*)::int as n from events where kind = 'traces.ingest'`;
    assert.equal(after[0].n, before[0].n);
  });

  it("answers demo mode without writing when the database is unset", async () => {
    const span = ids();
    const beforeSpans = await sql`select count(*)::int as n from spans where trace_id = ${span.traceId}`;
    delete env.DATABASE_URL;
    try {
      const res = await post(otlp([span]), LEGACY);
      assert.equal(res.status, 200);
      const body = await res.json() as { demo?: boolean; partialSuccess?: unknown };
      assert.equal(body.demo, true);
      assert.deepEqual(body.partialSuccess, {});
    } finally {
      env.DATABASE_URL = actorOperationsFixture().url;
    }
    const afterSpans = await sql`select count(*)::int as n from spans where trace_id = ${span.traceId}`;
    assert.equal(afterSpans[0].n, beforeSpans[0].n);
    assert.equal((await receipts(span.traceId)).length, 0);
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
