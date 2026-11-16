import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { actorOperationsFixture, confirmActorOperationsFixture } from "./fixture";

/**
 * Watch beat actor receipts. Opt in with AK_ACTOR_OPERATIONS_FIXTURE=1.
 * Without that flag this file does not import the database, open a pool, or
 * register hooks that connect. It is outside tests/ui so the UI suite never
 * loads it. The fixture URL is fixed; ambient DATABASE_URL is not used.
 * WATCH_SOURCE_CREDENTIAL_IDS_JSON is set only in this process.
 */
const OPT_IN = process.env.AK_ACTOR_OPERATIONS_FIXTURE === "1";
const LEGACY = "actor-ops-watch-legacy";
const PREFIX = `bwatch-${randomUUID().slice(0, 8)}`;
const SECRET = "secret-beat-detail";

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  node: env.NODE_ENV,
  watch: env.WATCH_SOURCE_CREDENTIAL_IDS_JSON,
};

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
type Post = (req: Request) => Promise<Response>;
type Credential = { ok: true; token: string; credential: { id: string } } | { ok: false; error: string };

let sql: SqlTag;
let postBeat: Post;
let createCredential: (input: {
  label: string;
  scopes: string[];
  rate_limit_per_minute?: number;
  rate_limit_per_day?: number;
}) => Promise<Credential>;
let priorWatcher: Record<string, unknown> | null = null;

function post(body: unknown, token: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return postBeat(new Request("http://localhost/api/watch/beat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

function beat(source: string, status = "ok", detail = SECRET) {
  return { source, status, detail, beat_at: "2026-11-15T12:00:00Z" };
}

function bind(map: Record<string, string[]>) {
  env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = JSON.stringify(map);
}

async function row(source: string) {
  return sql`
    select source, status, detail, beat_at, received_at
    from watch_beats
    where source = ${source}
  `;
}

async function receipts(source: string) {
  return sql`
    select id::text as id, kind, title, detail
    from events
    where kind = 'watch.beat' and detail->>'source' = ${source}
    order by id
  `;
}

function detailOf(record: Record<string, unknown>): Record<string, unknown> {
  const detail = record.detail;
  if (typeof detail === "string") return JSON.parse(detail) as Record<string, unknown>;
  return detail as Record<string, unknown>;
}

describe("B watch beat actor receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1") return;
    const fixture = actorOperationsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    delete env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
    const db = await import("../../src/lib/db");
    const route = await import("../../src/app/api/watch/beat/route");
    const credentials = await import("../../src/lib/credentials");
    sql = db.sql();
    postBeat = route.POST;
    createCredential = credentials.createCredential as typeof createCredential;
    await confirmActorOperationsFixture(sql, fixture.database);
    const existing = await row("watcher");
    priorWatcher = existing[0] ?? null;
  });

  after(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1" || !sql) {
      restoreEnv();
      return;
    }
    const seen = await sql`select current_database() as db, current_user as db_user`;
    if (seen[0]?.db === "ak_actor_operations" && seen[0]?.db_user === "ak_backlog_test") {
      await sql`drop trigger if exists ak_b_watch_fail_receipt on events`;
      await sql`drop function if exists ak_b_watch_fail_receipt()`;
      await sql`drop table if exists ak_b_watch_fail_source`;
      await sql`delete from events where kind = 'watch.beat' and detail->>'source' in ('watcher', 'macbook')`;
      await sql`delete from watch_beats where source = 'macbook'`;
      if (priorWatcher) {
        await sql`
          insert into watch_beats (source, status, detail, beat_at, received_at)
          values (
            'watcher',
            ${priorWatcher.status},
            ${priorWatcher.detail},
            ${priorWatcher.beat_at},
            ${priorWatcher.received_at}
          )
          on conflict (source) do update set
            status = excluded.status,
            detail = excluded.detail,
            beat_at = excluded.beat_at,
            received_at = excluded.received_at
        `;
      } else {
        await sql`delete from watch_beats where source = 'watcher'`;
      }
      await sql`delete from agent_credentials where label like ${PREFIX + "%"}`;
    }
    restoreEnv();
  });

  it("stores the credential actor, not the source, and omits the beat detail", async () => {
    const writer = await createCredential({
      label: `${PREFIX}-writer`,
      scopes: ["watch:write"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(writer.ok, true);
    if (!writer.ok) return;
    bind({ watcher: [writer.credential.id] });
    const res = await post(beat("watcher", "ok", SECRET), writer.token);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { ok?: boolean }).ok, true);
    const stored = await row("watcher");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "ok");
    assert.equal(stored[0].detail, SECRET);
    assert.ok(stored[0].received_at);
    const proof = await receipts("watcher");
    assert.equal(proof.length, 1);
    const detail = detailOf(proof[0]);
    assert.equal(detail.tool, "watch.beat");
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, writer.credential.id);
    assert.equal(detail.operation, "upsert");
    assert.equal(detail.source, "watcher");
    assert.equal(detail.actor_id === detail.source, false);
    const text = JSON.stringify(detail);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(writer.token), false);
    assert.equal(text.includes("forged-actor-label"), false);
    assert.equal("status" in detail, false);
    assert.equal("detail" in detail, false);
  });

  it("keeps both actors when a second bound credential overwrites the beat", async () => {
    const first = await createCredential({
      label: `${PREFIX}-first`,
      scopes: ["watch:write"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    const second = await createCredential({
      label: `${PREFIX}-second`,
      scopes: ["watch:write"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    bind({ watcher: [first.credential.id, second.credential.id] });
    const opened = await post(beat("watcher", "held", "first-detail"), first.token);
    assert.equal(opened.status, 200);
    await sql`update watch_beats set received_at = received_at - interval '1 hour' where source = 'watcher'`;
    const rotated = await post(beat("watcher", "failing", "second-detail"), second.token);
    assert.equal(rotated.status, 200);
    const stored = await row("watcher");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "failing");
    assert.equal(stored[0].detail, "second-detail");
    const refreshed = await sql`
      select received_at > clock_timestamp() - interval '10 minutes' as fresh
      from watch_beats where source = 'watcher'
    `;
    assert.equal(refreshed[0].fresh, true);
    const proof = await receipts("watcher");
    assert.equal(proof.length, 3);
    const actors = proof.map((record) => detailOf(record).actor_id);
    assert.equal(actors.includes(first.credential.id), true);
    assert.equal(actors.includes(second.credential.id), true);
    assert.equal(actors.filter((id) => id === second.credential.id).length, 1);
    assert.equal(JSON.stringify(proof).includes("second-detail"), false);
    assert.equal(JSON.stringify(proof).includes(second.token), false);
  });

  it("rejects a legacy token, a narrow scope, an unbound credential, and a forged field without a write", async () => {
    const beforeMac = await row("macbook");
    const narrow = await createCredential({
      label: `${PREFIX}-narrow`,
      scopes: ["watch:read"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    const unbound = await createCredential({
      label: `${PREFIX}-unbound`,
      scopes: ["watch:write"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(narrow.ok && unbound.ok, true);
    if (!narrow.ok || !unbound.ok) return;
    const writer = await sql`select id from agent_credentials where label = ${PREFIX + "-writer"}`;
    bind({ watcher: [String(writer[0].id)] });
    const legacy = await post(beat("macbook"), LEGACY);
    assert.equal(legacy.status, 401);
    const denied = await post(beat("macbook"), narrow.token);
    assert.equal(denied.status, 403);
    const foreign = await post(beat("macbook"), unbound.token);
    assert.equal(foreign.status, 403);
    const forged = await post({ ...beat("watcher"), actor_id: "forged-actor-label", host: "forged-host" }, unbound.token);
    assert.equal(forged.status, 400);
    const badTime = await post({ ...beat("watcher"), beat_at: "not-a-date" }, unbound.token);
    assert.equal(badTime.status, 400);
    delete env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
    const unconfigured = await post(beat("watcher"), unbound.token);
    assert.equal(unconfigured.status, 503);
    assert.equal((await row("macbook")).length, beforeMac.length);
    const watcherProof = await receipts("watcher");
    assert.equal(watcherProof.length, 3);
    assert.equal(JSON.stringify(watcherProof).includes("forged-actor-label"), false);
    assert.equal((await receipts("macbook")).length, 0);
  });

  it("does not treat dev-open as an operator", async () => {
    const before = (await receipts("watcher")).length;
    delete env.MC_TOKEN;
    delete env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
    try {
      const res = await post(beat("watcher", "ok", "open-detail"), null);
      assert.equal(res.status, 401);
      assert.equal((await receipts("watcher")).length, before);
      assert.equal(JSON.stringify(await receipts("watcher")).includes("operator"), false);
    } finally {
      env.MC_TOKEN = LEGACY;
    }
  });

  it("rolls the overwrite back when the receipt fails and keeps the earlier actor", async () => {
    const issued = await createCredential({
      label: `${PREFIX}-writer-again`,
      scopes: ["watch:write"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    bind({ watcher: [issued.credential.id] });
    const before = await row("watcher");
    const beforeReceipts = await receipts("watcher");
    await sql`create table if not exists ak_b_watch_fail_source (source text primary key)`;
    await sql`delete from ak_b_watch_fail_source`;
    await sql`insert into ak_b_watch_fail_source (source) values ('watcher')`;
    await sql`
      create or replace function ak_b_watch_fail_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'watch.beat'
           and new.detail->>'source' = (select source from ak_b_watch_fail_source) then
          raise exception 'injected receipt failure';
        end if;
        return new;
      end;
      $$
    `;
    await sql`drop trigger if exists ak_b_watch_fail_receipt on events`;
    await sql`
      create trigger ak_b_watch_fail_receipt
      before insert on events
      for each row execute function ak_b_watch_fail_receipt()
    `;
    try {
      const res = await post(beat("watcher", "paused", "failed-detail"), issued.token);
      assert.equal(res.status, 503);
      const body = await res.json() as { code?: string; error?: string };
      assert.equal(body.code, "setup_required");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      const stored = await row("watcher");
      assert.equal(stored[0].status, before[0].status);
      assert.equal(stored[0].detail, before[0].detail);
      const proof = await receipts("watcher");
      assert.equal(proof.length, beforeReceipts.length);
      assert.equal(JSON.stringify(proof).includes("failed-detail"), false);
    } finally {
      await sql`drop trigger if exists ak_b_watch_fail_receipt on events`;
      await sql`drop function if exists ak_b_watch_fail_receipt()`;
      await sql`drop table if exists ak_b_watch_fail_source`;
    }
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
  if (saved.watch === undefined) delete env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
  else env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = saved.watch;
}
