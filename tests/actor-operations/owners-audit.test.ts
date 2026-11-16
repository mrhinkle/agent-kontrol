import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { actorOperationsFixture, closeActorOperationsPool, confirmActorOperationsFixture, withOwnedFixtureCleanup } from "./fixture";

/**
 * Owner replacement and discovery receipts. Opt in with AK_ACTOR_OPERATIONS_FIXTURE=1.
 * Without that flag this file does not import the database or open a pool.
 * A replace sends the owners already stored plus this file's rows, so cleanup
 * does not remove another test's owner.
 */
const OPT_IN = process.env.AK_ACTOR_OPERATIONS_FIXTURE === "1";
const LEGACY = "actor-ops-owners-legacy";
const BASE = `o${randomBytes(4).toString("hex")}`;
const KEPT = `${BASE}a`;
const DROPPED = `${BASE}b`;
const FAILED = `${BASE}c`;
const FIRST = `${BASE}d`;
const SECOND = `${BASE}e`;
const MARKED = `${BASE}f`;
const OPEN = `${BASE}g`;
const OWNERS = [KEPT, DROPPED, FAILED, FIRST, SECOND, MARKED, OPEN];

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
type Put = (req: Request) => Promise<Response>;
type Post = (req: Request) => Promise<Response>;

let sql: SqlTag;
let putOwners: Put;
let postDiscover: Post;
let createCredential: (input: { label: string; scopes: string[] }) => Promise<{ ok: true; token: string } | { ok: false; error: string }>;

function restoreEnv() {
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.driver === undefined) delete env.MC_DB_DRIVER;
  else env.MC_DB_DRIVER = saved.driver;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
  if (saved.password === undefined) delete env.MC_DASHBOARD_PASSWORD;
  else env.MC_DASHBOARD_PASSWORD = saved.password;
  if (saved.node === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved.node;
}

function ownerBody(name: string, activityDays = 30) {
  return { owner: name, activity_days: activityDays, include_forks: false, include_archived: false };
}

function auth(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function put(owners: ReturnType<typeof ownerBody>[], version: string | undefined, token: string | null) {
  return putOwners(new Request("http://localhost/api/settings/owners", {
    method: "PUT",
    headers: { "content-type": "application/json", ...auth(token) },
    body: JSON.stringify({
      owners,
      ...(version === undefined ? {} : { version }),
      actor_id: "forged-actor-label",
      actor_type: "human",
      source: "forged-source",
    }),
  }));
}

function discover(results: Record<string, unknown>[], token: string | null) {
  return postDiscover(new Request("http://localhost/api/settings/owners/discover", {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(token) },
    body: JSON.stringify({
      actor_id: "forged-actor-label",
      actor_type: "human",
      source: "forged-source",
      results,
    }),
  }));
}

function sweep(owner: string, sweptAt: string, ok: boolean, repoName: string | null) {
  if (!ok) {
    return { owner, ok: false, error: "gh repo list failed", swept_at: sweptAt, actor_id: "forged-actor-label" };
  }
  return {
    owner,
    ok: true,
    swept_at: sweptAt,
    actor_id: "forged-actor-label",
    repos: [{ name: repoName, pushedAt: sweptAt, isFork: false, isArchived: false }],
  };
}

async function settings(): Promise<{ version: string; owners: { owner: string; activity_days: number; include_forks: boolean; include_archived: boolean }[] }> {
  const rows = await sql`
    select owner, activity_days, include_forks, include_archived
    from watched_owners
    order by owner asc
  `;
  const owners = rows.map((row) => ({
    owner: String(row.owner),
    activity_days: Number(row.activity_days),
    include_forks: row.include_forks === true,
    include_archived: row.include_archived === true,
  }));
  const { ownerListVersion } = await import("../../src/lib/watched-owners");
  return {
    version: ownerListVersion(owners.map((owner) => ({
      owner: owner.owner,
      activityDays: owner.activity_days,
      includeForks: owner.include_forks,
      includeArchived: owner.include_archived,
    }))),
    owners,
  };
}

function withoutMine(owners: { owner: string; activity_days: number; include_forks: boolean; include_archived: boolean }[]) {
  return owners.filter((owner) => !OWNERS.includes(owner.owner)).map((owner) => ownerBody(owner.owner, owner.activity_days));
}

async function ownerRow(name: string) {
  const rows = await sql`
    select owner, actor_type, actor_id, last_error, last_discovered_at
    from watched_owners
    where owner = ${name}
  `;
  return rows[0] ?? null;
}

async function repoCount(name: string): Promise<number> {
  const rows = await sql`
    select count(*)::int as n from watched_repos
    where lower(repo) like ${`${name.toLowerCase()}/%`}
  `;
  return Number(rows[0].n);
}

async function receipts(kind: string, name: string) {
  const rows = await sql`
    select id::text as id, kind, title, detail
    from events
    where kind = ${kind} and detail::text like ${"%" + name + "%"}
    order by events.id
  `;
  return rows.map(parseReceipt);
}

async function replaceReceipts() {
  const rows = await sql`
    select id::text as id, kind, title, detail
    from events
    where kind = 'owners.replace'
    order by events.id
  `;
  return rows.map(parseReceipt);
}

function parseReceipt(row: Record<string, unknown>) {
  return {
    ...row,
    id: String(row.id),
    detail: typeof row.detail === "string" ? JSON.parse(row.detail) as Record<string, unknown> : row.detail as Record<string, unknown>,
  };
}

function addedSince<T extends { id: string }>(before: { id: string }[], after: T[]): T[] {
  const seen = new Set(before.map((row) => row.id));
  return after.filter((row) => !seen.has(row.id));
}

describe("B owner discovery and replacement receipts", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1") return;
    const fixture = actorOperationsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    delete env.MC_DASHBOARD_PASSWORD;
    const db = await import("../../src/lib/db");
    const route = await import("../../src/app/api/settings/owners/route");
    const discoverRoute = await import("../../src/app/api/settings/owners/discover/route");
    const credentials = await import("../../src/lib/credentials");
    sql = db.sql();
    putOwners = route.PUT;
    postDiscover = discoverRoute.POST;
    createCredential = credentials.createCredential as typeof createCredential;
    await confirmActorOperationsFixture(sql, fixture.database);
  });

  after(async () => {
    try {
      if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1" || !sql) return;
      const fixture = actorOperationsFixture();
      await withOwnedFixtureCleanup(sql, fixture.database, async () => {
        await sql`drop trigger if exists ak_b_owners_suppress_receipt on events`;
        await sql`drop function if exists ak_b_owners_suppress_receipt()`;
        await sql`drop trigger if exists ak_b_owners_suppress_marker on watched_owners`;
        await sql`drop function if exists ak_b_owners_suppress_marker()`;
        await sql`drop table if exists ak_b_owners_suppress`;
        for (const name of OWNERS) {
          await sql`delete from events where kind in ('owners.replace', 'owners.discover') and detail::text like ${"%" + name + "%"}`;
          await sql`delete from watched_repos where lower(repo) like ${`${name.toLowerCase()}/%`}`;
          await sql`delete from watched_owners where owner = ${name}`;
        }
        await sql`delete from agent_credentials where label = ${BASE + "-denied"}`;
      });
    } finally {
      await closeActorOperationsPool();
      restoreEnv();
    }
  });

  it("receipts a replacement, including the owners it deletes, and ignores a stale list", async () => {
    const denied = await createCredential({ label: `${BASE}-denied`, scopes: ["tasks:write"] });
    assert.equal(denied.ok, true);
    if (!denied.ok) return;
    const before = await settings();
    const beforeReceipts = await replaceReceipts();
    const deniedRes = await put([...withoutMine(before.owners), ownerBody(KEPT)], before.version, denied.token);
    assert.equal(deniedRes.status, 403);
    assert.equal(await ownerRow(KEPT), null);
    assert.equal((await replaceReceipts()).length, beforeReceipts.length);

    const saved = await put([...withoutMine(before.owners), ownerBody(KEPT), ownerBody(DROPPED)], before.version, LEGACY);
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    const kept = await ownerRow(KEPT);
    const dropped = await ownerRow(DROPPED);
    assert.equal(kept?.actor_type, "agent");
    assert.equal(kept?.actor_id, "mc-token");
    assert.equal(dropped?.actor_type, "agent");
    assert.equal(dropped?.actor_id, "mc-token");
    const afterSave = await replaceReceipts();
    assert.equal(addedSince(beforeReceipts, afterSave).length, 0);

    const stale = await put([...withoutMine(before.owners), ownerBody(KEPT, 7)], before.version, LEGACY);
    assert.equal(stale.status, 409);
    assert.equal((await ownerRow(KEPT))?.actor_id, "mc-token");
    assert.equal((await ownerRow(KEPT))?.actor_type, "agent");
    assert.equal((await replaceReceipts()).length, beforeReceipts.length);

    const current = await settings();
    const removed = await put(withoutMine(current.owners), current.version, LEGACY);
    assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()));
    assert.equal(await ownerRow(DROPPED), null);
    assert.equal(await ownerRow(KEPT), null);
    const deletion = addedSince(afterSave, await replaceReceipts());
    assert.equal(deletion.length, 1);
    assert.deepEqual(deletion[0].detail.deleted_owners, [DROPPED, KEPT].sort());
    assert.equal(deletion[0].detail.actor_id, "mc-token");
    const survivors = await settings();
    assert.deepEqual(survivors.owners.map((owner) => owner.owner), before.owners.map((owner) => owner.owner));
  });

  it("records a null actor for dev-open and does not invent an operator", async () => {
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    try {
      const before = await settings();
      const beforeReceipts = await replaceReceipts();
      const saved = await put([...withoutMine(before.owners), ownerBody(OPEN)], before.version, null);
      assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
      const row = await ownerRow(OPEN);
      assert.equal(row?.actor_type, null);
      assert.equal(row?.actor_id, null);
      assert.equal(addedSince(beforeReceipts, await replaceReceipts()).length, 0);
      assert.equal(JSON.stringify(row).includes("operator"), false);
      assert.equal(JSON.stringify(row).includes("forged"), false);
    } finally {
      env.MC_TOKEN = LEGACY;
    }
  });

  it("receipts an applied discovery and an error state without replacing the configuring actor", async () => {
    const before = await settings();
    const saved = await put([
      ...withoutMine(before.owners),
      ownerBody(KEPT),
      ownerBody(FAILED),
    ], before.version, LEGACY);
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    const configuring = await ownerRow(KEPT);
    const sweptAt = new Date().toISOString();
    const applied = await discover([
      sweep(KEPT, sweptAt, true, `app${KEPT}`),
      sweep(FAILED, sweptAt, false, null),
    ], LEGACY);
    assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()));
    const body = await applied.json() as { results: { owner: string; ok: boolean; error: string | null }[] };
    assert.equal(body.results.find((row) => row.owner === KEPT)?.ok, true);
    assert.equal(body.results.find((row) => row.owner === FAILED)?.ok, false);

    const kept = await ownerRow(KEPT);
    assert.equal(kept?.actor_type, configuring?.actor_type);
    assert.equal(kept?.actor_id, configuring?.actor_id);
    assert.equal(kept?.last_error, null);
    assert.ok(kept?.last_discovered_at);
    assert.equal(await repoCount(KEPT), 1);
    const success = await receipts("owners.discover", KEPT);
    assert.equal(success.length, 1);
    assert.equal(success[0].detail.actor_id, "mc-token");
    assert.equal(success[0].detail.operation, "apply");
    assert.equal(success[0].detail.owner, KEPT);
    assert.deepEqual(success[0].detail.added, [`${KEPT.toLowerCase()}/app${KEPT}`]);
    assert.equal(JSON.stringify(success[0].detail).includes("forged"), false);

    const failed = await ownerRow(FAILED);
    assert.equal(failed?.actor_id, "mc-token");
    assert.equal(failed?.last_error, "The collector did not complete the repository listing.");
    assert.equal(String(failed?.last_error).includes("gh repo list failed"), false);
    assert.equal(failed?.last_discovered_at, null);
    assert.equal(await repoCount(FAILED), 0);
    const errorProof = await receipts("owners.discover", FAILED);
    assert.equal(errorProof.length, 1);
    assert.equal(errorProof[0].detail.operation, "error");
    assert.deepEqual(errorProof[0].detail.added, []);
    assert.equal(JSON.stringify(errorProof[0].detail).includes("gh repo list failed"), false);

    const older = new Date(Date.parse(sweptAt) - 60_000).toISOString();
    const stale = await discover([sweep(KEPT, older, true, `other${KEPT}`)], LEGACY);
    assert.equal(stale.status, 200, JSON.stringify(await stale.clone().json()));
    const staleBody = await stale.json() as { results: { skipped?: string; added: number }[] };
    assert.equal(staleBody.results[0]?.skipped, "stale");
    assert.equal(staleBody.results[0]?.added, 0);
    assert.equal(await repoCount(KEPT), 1);
    assert.equal((await receipts("owners.discover", KEPT)).length, 1);
  });

  it("keeps an earlier owner when a later receipt is suppressed", async () => {
    const before = await settings();
    const saved = await put([
      ...withoutMine(before.owners),
      ownerBody(FIRST),
      ownerBody(SECOND),
    ], before.version, LEGACY);
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    await sql`create table if not exists ak_b_owners_suppress (owner text primary key)`;
    await sql`delete from ak_b_owners_suppress`;
    await sql`insert into ak_b_owners_suppress (owner) values (${SECOND})`;
    await sql`
      create or replace function ak_b_owners_suppress_receipt() returns trigger
      language plpgsql as $$
      begin
        if new.kind = 'owners.discover'
           and new.detail->>'owner' = (select owner from ak_b_owners_suppress) then
          return null;
        end if;
        return new;
      end;
      $$
    `;
    await sql`drop trigger if exists ak_b_owners_suppress_receipt on events`;
    await sql`
      create trigger ak_b_owners_suppress_receipt
      before insert on events
      for each row execute function ak_b_owners_suppress_receipt()
    `;
    const sweptAt = new Date().toISOString();
    try {
      const res = await discover([
        sweep(FIRST, sweptAt, true, `app${FIRST}`),
        sweep(SECOND, sweptAt, true, `app${SECOND}`),
      ], LEGACY);
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "internal_error");
      assert.equal(JSON.stringify(body).includes("forged"), false);
      assert.equal(JSON.stringify(body).includes(SECOND), false);
    } finally {
      await sql`drop trigger if exists ak_b_owners_suppress_receipt on events`;
      await sql`drop function if exists ak_b_owners_suppress_receipt()`;
      await sql`delete from ak_b_owners_suppress`;
    }
    assert.equal(await repoCount(FIRST), 1);
    assert.equal((await receipts("owners.discover", FIRST)).length, 1);
    assert.equal((await ownerRow(SECOND))?.last_discovered_at, null);
    assert.equal(await repoCount(SECOND), 0);
    assert.equal((await receipts("owners.discover", SECOND)).length, 0);
  });

  it("stores nothing when the owner marker update is suppressed", async () => {
    const before = await settings();
    const saved = await put([...withoutMine(before.owners), ownerBody(MARKED)], before.version, LEGACY);
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    const prior = await ownerRow(MARKED);
    await sql`create table if not exists ak_b_owners_suppress (owner text primary key)`;
    await sql`delete from ak_b_owners_suppress`;
    await sql`insert into ak_b_owners_suppress (owner) values (${MARKED})`;
    await sql`
      create or replace function ak_b_owners_suppress_marker() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'UPDATE' and new.owner = (select owner from ak_b_owners_suppress) then
          return null;
        end if;
        return new;
      end;
      $$
    `;
    await sql`drop trigger if exists ak_b_owners_suppress_marker on watched_owners`;
    await sql`
      create trigger ak_b_owners_suppress_marker
      before update on watched_owners
      for each row execute function ak_b_owners_suppress_marker()
    `;
    try {
      const res = await discover([sweep(MARKED, new Date().toISOString(), true, `app${MARKED}`)], LEGACY);
      assert.equal(res.status, 500);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "internal_error");
      const text = JSON.stringify(body);
      assert.equal(text.includes(`app${MARKED}`), false);
      assert.equal(text.includes("owner discovery marker was not stored"), false);
      assert.equal(text.includes("injected"), false);
    } finally {
      await sql`drop trigger if exists ak_b_owners_suppress_marker on watched_owners`;
      await sql`drop function if exists ak_b_owners_suppress_marker()`;
      await sql`drop table if exists ak_b_owners_suppress`;
    }
    const row = await ownerRow(MARKED);
    assert.equal(row?.last_error, prior?.last_error);
    assert.equal(row?.last_discovered_at, prior?.last_discovered_at);
    assert.equal(await repoCount(MARKED), 0);
    assert.equal((await receipts("owners.discover", MARKED)).length, 0);
  });
});
