/**
 * Real Postgres proof for the decision write-back retry receipt.
 * Database ak_actor_author only. Never points at another fixture database.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { POST as postWriteback } from "../../src/app/api/decisions/[id]/writeback/route";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID } from "../../src/lib/actor";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential } from "../../src/lib/credentials";
import { clearGitHubWriteClientForTests, setGitHubWriteClientForTests } from "../../src/lib/decision-writeback";

const URL = "postgresql://ak_backlog_test@127.0.0.1:65438/ak_actor_author";
const pool = new Pool({ connectionString: URL });
const q = (text: string, params: unknown[] = []) => pool.query(text, params);
const env = process.env as Record<string, string | undefined>;
const keys = ["DATABASE_URL", "MC_DB_DRIVER", "MC_TOKEN", "MC_DASHBOARD_PASSWORD", "NODE_ENV", "GH_TOKEN", "GITHUB_TOKEN"];
const saved = Object.fromEntries(keys.map((key) => [key, env[key]]));
const LEGACY = "writeback-author-synthetic-token";
const PASSWORD = "writeback-author-synthetic-password";
const SECRET = "comment body must not leak";
let cookie = "";
const oldError = console.error;

function restoreEnv() {
  for (const key of keys) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
}

async function insertDecision(key: string, status = "decided") {
  const res = await q(
    `insert into decisions (key, source, repo, number, title, status, decision, revision)
     values ($1, 'github-label', 'acme/actorwb', 9, 'Ship', $2, $3, 1)
     returning id, revision`,
    [key, status, SECRET],
  );
  return res.rows[0] as { id: string; revision: number };
}

function post(id: string, body: unknown, headers: Record<string, string> = {}) {
  return postWriteback(new Request(`http://localhost/api/decisions/${id}/writeback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

async function receiptCount(id: string) {
  const res = await q(
    "select count(*)::int n from events where kind = 'decision_writeback' and detail->>'decision_id' = $1",
    [id],
  );
  return res.rows[0].n as number;
}

async function latestReceipt(id: string) {
  const res = await q(
    `select detail from events
     where kind = 'decision_writeback' and detail->>'decision_id' = $1
     order by id desc limit 1`,
    [id],
  );
  return res.rows[0]?.detail as { actor_type: string | null; actor_id: string | null; writeback: string; revision: number; tool: string } | undefined;
}

async function rowOf(id: string) {
  const res = await q("select status, writeback, revision from decisions where id = $1", [id]);
  return res.rows[0] as { status: string; writeback: string | null; revision: number };
}

before(async () => {
  assert.equal((await q("select current_database() as db")).rows[0].db, "ak_actor_author");
  Object.assign(env, {
    DATABASE_URL: URL,
    MC_DB_DRIVER: "pg",
    MC_TOKEN: LEGACY,
    MC_DASHBOARD_PASSWORD: PASSWORD,
    NODE_ENV: "test",
  });
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  setGitHubWriteClientForTests(null);
  cookie = await authCookieValue(PASSWORD);
  console.error = () => {};
});

after(async () => {
  console.error = oldError;
  await q("drop trigger if exists actor_wb_reject on events");
  await q("drop function if exists actor_wb_reject()");
  await q("delete from events where kind = 'decision_writeback' and detail->>'decision_id' in (select id::text from decisions where key like 'github:acme/actorwb%' or key like 'agent:actorwb/%')");
  await q("delete from decisions where key like 'github:acme/actorwb%' or key like 'agent:actorwb/%'");
  await q("delete from agent_credentials where label like 'writeback-author-%'");
  clearGitHubWriteClientForTests();
  await pool.end();
  await (globalThis as unknown as { __mcPgPool?: Pool }).__mcPgPool?.end();
  restoreEnv();
});

describe("real PostgreSQL decision write-back receipts", { concurrency: false }, () => {
  it("stores human, legacy, agent, and dev-open actors and ignores a forged body", async () => {
    const issued = await createCredential({
      label: "writeback-author-agent",
      scopes: ["decisions:write"],
      rate_limit_per_minute: 1000,
      rate_limit_per_day: 1000,
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const identities: { name: string; headers: Record<string, string>; type: string | null; id: string | null }[] = [
      { name: "human", headers: { cookie: `mc_auth=${cookie}` }, type: "human", id: DASHBOARD_ACTOR_ID },
      { name: "legacy", headers: { authorization: `Bearer ${LEGACY}` }, type: "agent", id: LEGACY_ACTOR_ID },
      { name: "agent", headers: { authorization: `Bearer ${issued.token}` }, type: "agent", id: issued.credential.id },
      { name: "dev", headers: {}, type: null, id: null },
    ];
    for (const identity of identities) {
      if (identity.name === "dev") delete env.MC_DASHBOARD_PASSWORD;
      else env.MC_DASHBOARD_PASSWORD = PASSWORD;
      const row = await insertDecision(`github:acme/actorwb#${1100 + identities.indexOf(identity)}`);
      const res = await post(String(row.id), {
        actor_id: "forged-root",
        actor_type: "human",
        decided_by: "forged-root",
        decision: "forged comment",
      }, identity.headers);
      assert.equal(res.status, 200, await res.clone().text());
      const stored = await rowOf(String(row.id));
      assert.equal(stored.writeback, "not_written");
      assert.equal(stored.status, "decided");
      const detail = await latestReceipt(String(row.id));
      assert.ok(detail);
      assert.equal(detail.actor_type, identity.type);
      assert.equal(detail.actor_id, identity.id);
      assert.equal(detail.tool, "decision_writeback");
      assert.equal(detail.writeback, "not_written");
      assert.equal(detail.revision, stored.revision);
      assert.equal(JSON.stringify(detail).includes("forged"), false);
      assert.equal(JSON.stringify(detail).includes(SECRET), false);
    }
    env.MC_DASHBOARD_PASSWORD = PASSWORD;
  });

  it("denial, stale revision, a non-decided row, and a key with no issue write no receipt", async () => {
    const row = await insertDecision("github:acme/actorwb#deny");
    const before = await receiptCount(String(row.id));
    assert.equal((await post(String(row.id), {}, {})).status, 401);
    const narrow = await createCredential({
      label: "writeback-author-narrow",
      scopes: ["memory:write"],
      rate_limit_per_minute: 1000,
    });
    assert.equal(narrow.ok, true);
    if (!narrow.ok) return;
    assert.equal((await post(String(row.id), {}, { authorization: `Bearer ${narrow.token}` })).status, 403);
    assert.equal((await post(String(row.id), { expected_revision: 0 }, { authorization: `Bearer ${LEGACY}` })).status, 409);
    const open = await insertDecision("github:acme/actorwb#open", "open");
    assert.equal((await post(String(open.id), {}, { authorization: `Bearer ${LEGACY}` })).status, 409);
    const noTarget = await q(
      `insert into decisions (key, source, title, status, decision, revision)
       values ('agent:actorwb/slug', 'agent', 'Local', 'decided', $1, 1) returning id`,
      [SECRET],
    );
    const noTargetId = String(noTarget.rows[0].id);
    const skipped = await post(noTargetId, {}, { authorization: `Bearer ${LEGACY}` });
    assert.equal(skipped.status, 200, await skipped.clone().text());
    assert.equal(await receiptCount(String(row.id)), before);
    assert.equal(await receiptCount(String(open.id)), 0);
    assert.equal(await receiptCount(noTargetId), 0);
    assert.equal((await rowOf(String(row.id))).writeback, null);
    assert.equal((await rowOf(noTargetId)).writeback, null);
  });

  it("rolls the write-back stamp back when the receipt is rejected", async () => {
    const row = await insertDecision("github:acme/actorwb#1201");
    await q(`
      create function actor_wb_reject() returns trigger language plpgsql as $$
      begin
        if NEW.kind = 'decision_writeback' then
          raise exception 'synthetic receipt rejection';
        end if;
        return NEW;
      end $$;
      create trigger actor_wb_reject before insert on events
      for each row execute function actor_wb_reject()
    `);
    const res = await post(String(row.id), {}, { authorization: `Bearer ${LEGACY}` });
    assert.equal(res.status, 500);
    const stored = await rowOf(String(row.id));
    assert.equal(stored.status, "decided");
    assert.equal(stored.writeback, null);
    assert.equal(await receiptCount(String(row.id)), 0);
    await q("drop trigger actor_wb_reject on events");
    await q("drop function actor_wb_reject()");
  });
});
