import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";

/**
 * Progress ingest actor receipts. Opt in with AK_ACTOR_OPERATIONS_FIXTURE=1.
 * Without that flag this file does not import the database, open a pool, or
 * register hooks that connect. It is outside tests/ui so the UI suite never
 * loads it. The fixture URL is fixed; ambient DATABASE_URL is not used.
 */
const OPT_IN = process.env.AK_ACTOR_OPERATIONS_FIXTURE === "1";
const FIXTURE_URL = "postgres://ak_backlog_test@127.0.0.1:65438/ak_actor_operations";
const LEGACY = "actor-ops-progress-legacy";
const PREFIX = `bprog-${randomUUID().slice(0, 8)}`;

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
let postProgress: Post;
let createCredential: (input: { label: string; scopes: string[] }) => Promise<{ ok: true; token: string; credential: { id: string } } | { ok: false; error: string }>;

function repo(name: string): string {
  return `${PREFIX}/${name}`;
}

function post(body: unknown, token: string | null, url = "http://localhost/api/progress/ingest") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return postProgress(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function snapshots(name: string) {
  return sql`
    select id::text as id, repo, kind, open_issues, detail
    from repo_snapshots
    where repo = ${repo(name)}
    order by id
  `;
}

async function receipts(name: string) {
  return sql`
    select id::text as id, kind, title, detail
    from events
    where kind = 'progress.ingest' and detail->>'repo' = ${repo(name)}
    order by id
  `;
}

function detailOf(row: Record<string, unknown>): Record<string, unknown> {
  const detail = row.detail;
  if (typeof detail === "string") return JSON.parse(detail) as Record<string, unknown>;
  return detail as Record<string, unknown>;
}

describe("B progress ingest actor receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1") return;
    env.DATABASE_URL = FIXTURE_URL;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    const db = await import("../../src/lib/db");
    const route = await import("../../src/app/api/progress/ingest/route");
    const credentials = await import("../../src/lib/credentials");
    sql = db.sql();
    postProgress = route.POST;
    createCredential = credentials.createCredential as typeof createCredential;
    await sql`select 1 as ok`;
  });

  after(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1" || !sql) {
      restoreEnv();
      return;
    }
    await sql`drop trigger if exists ak_b_progress_fail_receipt on events`;
    await sql`drop function if exists ak_b_progress_fail_receipt()`;
    await sql`drop table if exists ak_b_progress_fail_repo`;
    await sql`delete from events where kind = 'progress.ingest' and detail->>'repo' like ${PREFIX + "/%"}`;
    await sql`delete from repo_snapshots where repo like ${PREFIX + "/%"}`;
    await sql`delete from agent_credentials where label = ${PREFIX + "-denied"}`;
    restoreEnv();
  });

  it("stores the legacy principal with each accepted row and ignores forged labels", async () => {
    const at = "2026-11-15T12:00:00.000Z";
    const res = await post({
      collected_at: at,
      kind: "tick",
      actor_id: "forged-actor-label",
      actor_type: "human",
      source: "forged-source",
      host: "forged-host",
      agent_id: "forged-agent",
      repos: [
        { repo: repo("one"), open_issues: 3, detail: { notes: "secret-note-not-in-receipt" } },
        { repo: repo("two"), open_issues: 4, detail: { notes: "secret-note-not-in-receipt" } },
        { repo: "", open_issues: 9 },
      ],
    }, LEGACY);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; written: number };
    assert.equal(body.ok, true);
    assert.equal(body.written, 2);

    for (const name of ["one", "two"]) {
      const rows = await snapshots(name);
      assert.equal(rows.length, 1);
      const proof = await receipts(name);
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.tool, "progress.ingest");
      assert.equal(detail.actor_type, "agent");
      assert.equal(detail.actor_id, "mc-token");
      assert.equal(detail.operation, "upsert");
      assert.equal(detail.snapshot_id, rows[0].id);
      assert.equal(detail.repo, repo(name));
      assert.equal(detail.collected_at, at);
      assert.equal(detail.snapshot_kind, "tick");
      const text = JSON.stringify(detail);
      assert.equal(text.includes("forged-actor-label"), false);
      assert.equal(text.includes("forged-source"), false);
      assert.equal(text.includes("forged-host"), false);
      assert.equal(text.includes("forged-agent"), false);
      assert.equal(text.includes("secret-note-not-in-receipt"), false);
      assert.equal(text.includes(LEGACY), false);
    }
    const blank = await sql`select count(*)::int as n from repo_snapshots where repo = ''`;
    assert.equal(Number(blank[0].n), 0);
  });

  it("attributes an in-place correction and writes nothing for a kind-guard skip", async () => {
    const at = "2026-11-15T13:00:00.000Z";
    const first = await post({ collected_at: at, kind: "tick", repos: [{ repo: repo("guard"), open_issues: 1 }] }, LEGACY);
    assert.equal((await first.json() as { written: number }).written, 1);
    const second = await post({ collected_at: at, kind: "daily", repos: [{ repo: repo("guard"), open_issues: 8 }] }, LEGACY);
    assert.equal((await second.json() as { written: number }).written, 1);
    const skipped = await post({
      collected_at: at,
      kind: "activity",
      repos: [{ repo: repo("guard"), open_issues: 99, detail: { activity: { status: "complete" } } }],
    }, LEGACY);
    assert.equal((await skipped.json() as { written: number }).written, 0);

    const rows = await snapshots("guard");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "daily");
    assert.equal(Number(rows[0].open_issues), 8);
    const proof = await receipts("guard");
    assert.equal(proof.length, 2);
    assert.deepEqual(proof.map((row) => detailOf(row).snapshot_kind), ["tick", "daily"]);
  });

  it("rejects an agent credential and a bad bearer without a snapshot or receipt", async () => {
    const made = await createCredential({ label: `${PREFIX}-denied`, scopes: ["progress:read"] });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const at = "2026-11-15T14:00:00.000Z";
    const denied = await post({ collected_at: at, repos: [{ repo: repo("denied") }] }, made.token);
    assert.equal(denied.status, 403);
    const bad = await post({ collected_at: at, repos: [{ repo: repo("denied") }] }, "not-the-token");
    assert.equal(bad.status, 401);
    assert.equal((await snapshots("denied")).length, 0);
    assert.equal((await receipts("denied")).length, 0);
  });

  it("rejects invalid input before any write", async () => {
    const badTime = await post({ collected_at: "not-a-date", repos: [{ repo: repo("invalid") }] }, LEGACY);
    assert.equal(badTime.status, 400);
    const empty = await post({ repos: [] }, LEGACY);
    assert.equal(empty.status, 400);
    assert.equal((await snapshots("invalid")).length, 0);
    assert.equal((await receipts("invalid")).length, 0);
  });

  it("records a null actor for dev-open and does not invent an operator", async () => {
    delete env.MC_TOKEN;
    try {
      const at = "2026-11-15T15:00:00.000Z";
      const res = await post({
        collected_at: at,
        repos: [{ repo: repo("open"), actor_id: "forged-actor-label" }],
      }, null);
      assert.equal(res.status, 200);
      const proof = await receipts("open");
      assert.equal(proof.length, 1);
      const detail = detailOf(proof[0]);
      assert.equal(detail.actor_type, null);
      assert.equal(detail.actor_id, null);
      assert.equal(detail.repo, repo("open"));
      assert.equal(JSON.stringify(detail).includes("forged-actor-label"), false);
      assert.equal(JSON.stringify(detail).includes("operator"), false);
    } finally {
      env.MC_TOKEN = LEGACY;
    }
  });

  it("drops a snapshot when its receipt fails and keeps an earlier row", async () => {
    await sql`
      create table if not exists ak_b_progress_fail_repo (
        repo text primary key
      )
    `;
    await sql`delete from ak_b_progress_fail_repo`;
    await sql`insert into ak_b_progress_fail_repo (repo) values (${repo("second")})`;
    await sql`
      create or replace function ak_b_progress_fail_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'progress.ingest'
           and new.detail->>'repo' = (select repo from ak_b_progress_fail_repo) then
          raise exception 'injected receipt failure';
        end if;
        return new;
      end;
      $$
    `;
    await sql`
      drop trigger if exists ak_b_progress_fail_receipt on events
    `;
    await sql`
      create trigger ak_b_progress_fail_receipt
      before insert on events
      for each row execute function ak_b_progress_fail_receipt()
    `;
    try {
      const at = "2026-11-15T16:00:00.000Z";
      const res = await post({
        collected_at: at,
        repos: [
          { repo: repo("first"), open_issues: 1 },
          { repo: repo("second"), open_issues: 2 },
        ],
      }, LEGACY);
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string; error?: string };
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("injected"), false);
      const first = await snapshots("first");
      assert.equal(first.length, 1);
      assert.equal((await receipts("first")).length, 1);
      assert.equal(detailOf((await receipts("first"))[0]).actor_id, "mc-token");
      assert.equal((await snapshots("second")).length, 0);
      assert.equal((await receipts("second")).length, 0);
    } finally {
      await sql`drop trigger if exists ak_b_progress_fail_receipt on events`;
      await sql`drop function if exists ak_b_progress_fail_receipt()`;
      await sql`drop table if exists ak_b_progress_fail_repo`;
    }
  });

  it("answers demo mode without writing when the database is unset", async () => {
    const beforeSnaps = await sql`select count(*)::int as n from repo_snapshots where repo like ${PREFIX + "/%"}`;
    const beforeEvents = await sql`select count(*)::int as n from events where kind = 'progress.ingest' and detail->>'repo' like ${PREFIX + "/%"}`;
    delete env.DATABASE_URL;
    try {
      const res = await post({ repos: [{ repo: repo("demo") }] }, LEGACY);
      assert.equal(res.status, 200);
      const body = await res.json() as { demo?: boolean; written?: number };
      assert.equal(body.demo, true);
      assert.equal(body.written, undefined);
    } finally {
      env.DATABASE_URL = FIXTURE_URL;
    }
    const afterSnaps = await sql`select count(*)::int as n from repo_snapshots where repo like ${PREFIX + "/%"}`;
    const afterEvents = await sql`select count(*)::int as n from events where kind = 'progress.ingest' and detail->>'repo' like ${PREFIX + "/%"}`;
    assert.equal(afterSnaps[0].n, beforeSnaps[0].n);
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
