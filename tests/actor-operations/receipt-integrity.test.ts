import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { actorOperationsFixture, closeActorOperationsPool, confirmActorOperationsFixture, withOwnedFixtureCleanup } from "./fixture";

/**
 * Silent receipt suppression. A BEFORE INSERT trigger that returns NULL
 * stores nothing and raises nothing. Opt in with AK_ACTOR_OPERATIONS_FIXTURE=1.
 * Without that flag this file does not import the database or open a pool.
 */
const OPT_IN = process.env.AK_ACTOR_OPERATIONS_FIXTURE === "1";
const PREFIX = `breceipt-${randomUUID().slice(0, 8)}`;

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  node: env.NODE_ENV,
};

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

let sql: SqlTag;
let withTransaction: <T>(fn: (tx: SqlTag) => Promise<T>) => Promise<T>;
let insertToolReceipt: (q: SqlTag, input: { kind: string; title: string; extra?: Record<string, unknown> }) => Promise<{ id: string; kind: string; at: string }>;
let recordToolReceipt: (input: { kind: string; title: string }) => Promise<{ id: string } | null>;
let setDecisionWriteback: (
  id: number,
  writeback: "written" | "not_written",
  revision: number,
  token: string | null,
  attribute?: boolean,
) => Promise<{ writeback: string | null; revision: number } | null>;
let setRepoOverride: (
  repo: string,
  patch: { pinned?: boolean; hidden?: boolean },
  receipt?: { kind: string; title: string },
) => Promise<boolean>;
let ToolReceiptError: new () => Error;

function repoName(name: string): string {
  return `${PREFIX}/${name}`;
}

async function arm(kind: string) {
  await sql`insert into ak_b_receipt_suppress (kind) values (${kind}) on conflict (kind) do nothing`;
}

async function disarm(kind: string) {
  await sql`delete from ak_b_receipt_suppress where kind = ${kind}`;
}

async function eventCount(kind: string): Promise<number> {
  const rows = await sql`select count(*)::int as n from events where kind = ${kind} and title like ${PREFIX + "%"}`;
  return Number(rows[0].n);
}

describe("silent tool-receipt suppression", { skip: !OPT_IN, concurrency: 1 }, () => {
  before(async () => {
    if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1") return;
    const fixture = actorOperationsFixture();
    env.DATABASE_URL = fixture.url;
    env.MC_DB_DRIVER = "pg";
    env.NODE_ENV = "test";
    const db = await import("../../src/lib/db");
    const receipts = await import("../../src/lib/tool-receipt");
    const store = await import("../../src/lib/store");
    const decisions = await import("../../src/lib/decisions");
    const repos = await import("../../src/lib/watched-repos");
    sql = db.sql();
    withTransaction = db.withTransaction;
    insertToolReceipt = receipts.insertToolReceipt;
    recordToolReceipt = store.recordToolReceipt;
    setDecisionWriteback = decisions.setDecisionWriteback as typeof setDecisionWriteback;
    setRepoOverride = repos.setRepoOverride;
    ToolReceiptError = receipts.ToolReceiptError;
    await confirmActorOperationsFixture(sql, fixture.database);
    await sql`
      create table if not exists ak_b_receipt_suppress (
        kind text primary key
      )
    `;
    await sql`delete from ak_b_receipt_suppress`;
    await sql`
      create or replace function ak_b_receipt_suppress() returns trigger
      language plpgsql as $$
      begin
        if exists (select 1 from ak_b_receipt_suppress where kind = new.kind) then
          return null;
        end if;
        return new;
      end;
      $$
    `;
    await sql`drop trigger if exists ak_b_receipt_suppress on events`;
    await sql`
      create trigger ak_b_receipt_suppress
      before insert on events
      for each row execute function ak_b_receipt_suppress()
    `;
  });

  after(async () => {
    try {
      if (process.env.AK_ACTOR_OPERATIONS_FIXTURE !== "1" || !sql) return;
      const fixture = actorOperationsFixture();
      await withOwnedFixtureCleanup(sql, fixture.database, async () => {
        await sql`drop trigger if exists ak_b_receipt_suppress on events`;
        await sql`drop function if exists ak_b_receipt_suppress()`;
        await sql`drop table if exists ak_b_receipt_suppress`;
        await sql`delete from events where kind in ('receipt.probe', 'receipt.probe.side', 'receipt.besteffort', 'decision_writeback', 'set_repo_override') and (title like ${PREFIX + "%"} or detail->>'repo' like ${PREFIX + "/%"} or detail->>'decision_id' in (select id::text from decisions where key like ${PREFIX + "%"}))`;
        await sql`delete from decisions where key like ${PREFIX + "%"}`;
        await sql`delete from watched_repos where repo like ${PREFIX + "/%"}`;
      });
    } finally {
      await closeActorOperationsPool();
      if (saved.db === undefined) delete env.DATABASE_URL;
      else env.DATABASE_URL = saved.db;
      if (saved.driver === undefined) delete env.MC_DB_DRIVER;
      else env.MC_DB_DRIVER = saved.driver;
      if (saved.node === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = saved.node;
    }
  });

  it("rolls a companion write back when the receipt insert is suppressed", async () => {
    await arm("receipt.probe");
    try {
      await assert.rejects(
        () => withTransaction(async (tx) => {
          await tx`
            insert into events (agent_id, session_id, kind, title, detail)
            values (null, null, 'receipt.probe.side', ${PREFIX + " side"}, '{}'::jsonb)
          `;
          await insertToolReceipt(tx, { kind: "receipt.probe", title: `${PREFIX} probe` });
        }),
        (err: unknown) => err instanceof ToolReceiptError,
      );
    } finally {
      await disarm("receipt.probe");
    }
    assert.equal(await eventCount("receipt.probe"), 0);
    assert.equal(await eventCount("receipt.probe.side"), 0);
  });

  it("returns null from the post-commit wrapper and stores nothing when the insert is suppressed", async () => {
    const stored = await recordToolReceipt({ kind: "receipt.besteffort", title: `${PREFIX} kept` });
    assert.equal(typeof stored?.id, "string");
    assert.equal(await eventCount("receipt.besteffort"), 1);
    await arm("receipt.besteffort");
    try {
      assert.equal(await recordToolReceipt({ kind: "receipt.besteffort", title: `${PREFIX} missing` }), null);
    } finally {
      await disarm("receipt.besteffort");
    }
    assert.equal(await eventCount("receipt.besteffort"), 1);
  });

  it("rolls a decision write-back stamp back when its receipt is suppressed", async () => {
    const key = `${PREFIX}-decision`;
    const inserted = await sql`
      insert into decisions (key, source, title, status, decision, revision)
      values (${key}, 'github-label', 'Ship', 'decided', 'yes', 1)
      returning id::text as id, revision
    `;
    const id = Number(inserted[0].id);
    assert.equal(Number.isSafeInteger(id), true);
    const stamped = await setDecisionWriteback(id, "written", 1, null, true);
    assert.equal(stamped?.writeback, "written");
    assert.equal(stamped?.revision, 2);
    const proofs = await sql`
      select count(*)::int as n from events
      where kind = 'decision_writeback' and detail->>'decision_id' = ${String(id)}
    `;
    assert.equal(Number(proofs[0].n), 1);

    const other = await sql`
      insert into decisions (key, source, title, status, decision, revision)
      values (${key + "-suppressed"}, 'github-label', 'Ship', 'decided', 'yes', 1)
      returning id::text as id
    `;
    const otherId = Number(other[0].id);
    await arm("decision_writeback");
    try {
      await assert.rejects(
        () => setDecisionWriteback(otherId, "not_written", 1, null, true),
        (err: unknown) => err instanceof ToolReceiptError,
      );
    } finally {
      await disarm("decision_writeback");
    }
    const row = await sql`select writeback, revision from decisions where id = ${otherId}`;
    assert.equal(row[0].writeback, null);
    assert.equal(Number(row[0].revision), 1);
    const missing = await sql`
      select count(*)::int as n from events
      where kind = 'decision_writeback' and detail->>'decision_id' = ${String(otherId)}
    `;
    assert.equal(Number(missing[0].n), 0);
    const kept = await sql`select writeback, revision from decisions where id = ${id}`;
    assert.equal(kept[0].writeback, "written");
    assert.equal(Number(kept[0].revision), 2);
  });

  it("rolls a repo pin back when its receipt is suppressed and still skips a missing repo", async () => {
    const name = repoName("pin");
    await sql`
      insert into watched_repos (repo, label, short, color)
      values (${name}, 'Pin', ${PREFIX.slice(0, 12)}, '#2563eb')
    `;
    const saved = await setRepoOverride(name, { pinned: true }, {
      kind: "set_repo_override",
      title: `${PREFIX} pin`,
    });
    assert.equal(saved, true);
    const pinned = await sql`select pinned from watched_repos where repo = ${name}`;
    assert.equal(pinned[0].pinned, true);

    const hidden = repoName("hide");
    await sql`
      insert into watched_repos (repo, label, short, color)
      values (${hidden}, 'Hide', ${PREFIX.slice(0, 10) + "h"}, '#2563eb')
    `;
    await arm("set_repo_override");
    try {
      await assert.rejects(
        () => setRepoOverride(hidden, { hidden: true }, { kind: "set_repo_override", title: `${PREFIX} hide` }),
        (err: unknown) => err instanceof ToolReceiptError,
      );
    } finally {
      await disarm("set_repo_override");
    }
    const row = await sql`select hidden, pinned from watched_repos where repo = ${hidden}`;
    assert.equal(row[0].hidden, false);
    assert.equal(row[0].pinned, false);
    const proofs = await sql`
      select detail->>'repo' as repo
      from events
      where kind = 'set_repo_override' and title like ${PREFIX + "%"}
    `;
    assert.deepEqual(proofs.map((item) => item.repo), [name]);

    assert.equal(await setRepoOverride(repoName("absent"), { pinned: true }, {
      kind: "set_repo_override",
      title: `${PREFIX} absent`,
    }), false);
    const absent = await sql`
      select count(*)::int as n from events
      where kind = 'set_repo_override' and title = ${PREFIX + " absent"}
    `;
    assert.equal(Number(absent[0].n), 0);
  });
});
