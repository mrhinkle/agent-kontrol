/**
 * Skill drift receipts. Calls the drift route, then reads skill_drift and
 * events on the opt-in fixture. The report body is synthetic. This file
 * does not call a collector or GitHub.
 */
import assert from "node:assert/strict";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID, runWithActor } from "../src/lib/actor";
import { authCookieValue } from "../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../src/lib/credentials";
import { sql } from "../src/lib/db";
import { setDriftReadFaultForTests } from "../src/lib/skills/drift-report";
import { setSkillReceiptFaultForTests, SKILL_DRIFT_KIND } from "../src/lib/skills/store";
import { assertActorAdminFixture } from "./actor-admin-fixture";

const PASSWORD = "actor-admin-test-password";
const TOKEN = "actor-admin-drift-mc-token";
const DIR = "~/.codex/skills";
const SKILL_NAME = "akadm-secret-skill";
const SKILL_SHA = "ab".repeat(32);
const env = process.env as Record<string, string | undefined>;

function assertFixture(): string {
  return assertActorAdminFixture(process.env.DATABASE_URL);
}

type Receipt = {
  kind: string;
  title: string;
  detailText: string;
  detail: Record<string, unknown>;
  agentId: string | null;
};

async function receiptsFor(host: string): Promise<Receipt[]> {
  const rows = await sql()`
    select kind, title, detail::text as detail_text, detail, agent_id
    from events
    where kind = ${SKILL_DRIFT_KIND} and detail->>'host' = ${host}
    order by id
  `;
  return rows.map((row) => ({
    kind: String(row.kind),
    title: String(row.title ?? ""),
    detailText: String(row.detail_text),
    detail: row.detail as Record<string, unknown>,
    agentId: row.agent_id == null ? null : String(row.agent_id),
  }));
}

async function driftRow(host: string): Promise<{ dir: string; entries: { name?: string; sha?: string }[] } | null> {
  const rows = await sql()`
    select dir, entries from skill_drift where host = ${host}
  `;
  const row = rows[0];
  if (!row) return null;
  const entries = Array.isArray(row.entries) ? row.entries as { name?: string; sha?: string }[] : [];
  return { dir: String(row.dir), entries };
}

function assertSafeReceipt(receipt: Receipt, host: string, count: number): void {
  assert.equal(receipt.kind, SKILL_DRIFT_KIND);
  assert.equal(receipt.agentId, null);
  assert.equal(receipt.detail.operation, "drift_report");
  assert.equal(receipt.detail.host, host);
  assert.equal(receipt.detail.dir, DIR);
  assert.equal(receipt.detail.count, count);
  assert.equal(typeof receipt.detail.reported_at, "string");
  assert.equal(Object.prototype.hasOwnProperty.call(receipt.detail, "entries"), false);
  assert.equal(receipt.detailText.includes(SKILL_NAME), false);
  assert.equal(receipt.detailText.includes(SKILL_SHA), false);
  assert.equal(receipt.title.includes(SKILL_NAME), false);
  assert.notEqual(receipt.detail.actor_id, host);
  assert.notEqual(receipt.detail.actor_type, host);
}

export async function testSkillDrift(): Promise<void> {
  assertFixture();
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    MC_DASHBOARD_PASSWORD: process.env.MC_DASHBOARD_PASSWORD,
    MC_TOKEN: process.env.MC_TOKEN,
    AK_SKILL_DRIFT_DIRS: process.env.AK_SKILL_DRIFT_DIRS,
  };
  const { POST } = await import("../src/app/api/skills/drift/route");
  const originalError = console.error;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST(new Request("http://127.0.0.1/api/skills/drift", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }));
  const report = (host: string, skills: { name: string; sha: string }[] = [{ name: SKILL_NAME, sha: SKILL_SHA }]) =>
    ({ host, dir: DIR, skills });

  try {
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    delete env.AK_SKILL_DRIFT_DIRS;
    env.NODE_ENV = "test";

    const forged = await post({ ...report("akadm-forged"), actor_id: "forged-actor", actor_type: "human" });
    assert.equal(forged.status, 400);
    assert.equal(await driftRow("akadm-forged"), null);
    assert.equal((await receiptsFor("akadm-forged")).length, 0);

    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    const cookie = `mc_auth=${await authCookieValue(PASSWORD)}`;
    const minted = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      createCredential({ label: "drift-denial", scopes: ["fleet:read"] }),
    );
    assert.equal(minted.ok, true);
    if (!minted.ok) return;
    const deniedBearer = await post(report("akadm-denied"), { authorization: `Bearer ${minted.token}`, cookie });
    assert.equal(deniedBearer.status, 403);
    assert.equal(await driftRow("akadm-denied"), null);
    const deniedBearerOnly = await post(report("akadm-denied"), { authorization: "Bearer not-the-token" });
    assert.equal(deniedBearerOnly.status, 401);
    assert.equal((await receiptsFor("akadm-denied")).length, 0);

    delete env.MC_DASHBOARD_PASSWORD;
    const open = await post(report("akadm-open", [
      { name: SKILL_NAME, sha: SKILL_SHA },
      { name: "akadm-other-skill", sha: "cd".repeat(32) },
    ]));
    assert.equal(open.status, 200);
    const openBody = await open.json() as { ok: boolean; driftCount: number; missing: unknown[]; extra: unknown[]; differs: unknown[] };
    assert.equal(openBody.ok, true);
    assert.equal(openBody.driftCount, openBody.missing.length + openBody.extra.length + openBody.differs.length);
    const openRow = await driftRow("akadm-open");
    assert.equal(openRow?.entries.length, 2);
    assert.equal(openRow?.entries.some((entry) => entry.name === SKILL_NAME && entry.sha === SKILL_SHA), true);
    const openReceipts = await receiptsFor("akadm-open");
    assert.equal(openReceipts.length, 1);
    assert.equal(openReceipts[0]?.detail.actor_type, null);
    assert.equal(openReceipts[0]?.detail.actor_id, null);
    assertSafeReceipt(openReceipts[0] as Receipt, "akadm-open", 2);

    const again = await post(report("akadm-open"));
    assert.equal(again.status, 200);
    const againRow = await driftRow("akadm-open");
    assert.equal(againRow?.entries.length, 1);
    const againReceipts = await receiptsFor("akadm-open");
    assert.equal(againReceipts.length, 2);
    assert.equal(againReceipts[1]?.detail.count, 1);
    assert.equal(againReceipts[1]?.detail.actor_id, null);

    const empty = await post(report("akadm-empty", []));
    assert.equal(empty.status, 200);
    assert.equal((await driftRow("akadm-empty"))?.entries.length, 0);
    const emptyReceipt = (await receiptsFor("akadm-empty"))[0];
    assert.ok(emptyReceipt);
    assertSafeReceipt(emptyReceipt, "akadm-empty", 0);
    assert.equal(emptyReceipt.detail.actor_type, null);

    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    const human = await post(report("akadm-human"), { cookie });
    assert.equal(human.status, 200);
    const humanReceipt = (await receiptsFor("akadm-human"))[0];
    assert.ok(humanReceipt);
    assert.equal(humanReceipt.detail.actor_type, "human");
    assert.equal(humanReceipt.detail.actor_id, DASHBOARD_ACTOR_ID);
    assertSafeReceipt(humanReceipt, "akadm-human", 1);
    assert.notEqual(humanReceipt.detail.actor_id, "akadm-human");

    delete env.MC_DASHBOARD_PASSWORD;
    env.MC_TOKEN = TOKEN;
    const legacy = await post(report("akadm-legacy"), { authorization: `Bearer ${TOKEN}` });
    assert.equal(legacy.status, 200);
    const legacyReceipt = (await receiptsFor("akadm-legacy"))[0];
    assert.ok(legacyReceipt);
    assert.equal(legacyReceipt.detail.actor_type, "agent");
    assert.equal(legacyReceipt.detail.actor_id, LEGACY_ACTOR_ID);
    assert.equal(legacyReceipt.detailText.includes(TOKEN), false);
    assertSafeReceipt(legacyReceipt, "akadm-legacy", 1);
    delete env.MC_TOKEN;

    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    console.error = () => {};
    setDriftReadFaultForTests(true);
    const compared = await post(report("akadm-compare"), { cookie });
    assert.equal(compared.status, 500);
    const comparedBody = await compared.json() as { code?: string };
    assert.equal(comparedBody.code, "internal_error");
    assert.equal(JSON.stringify(comparedBody).includes(SKILL_NAME), false);
    assert.equal(JSON.stringify(comparedBody).includes(SKILL_SHA), false);
    const comparedRow = await driftRow("akadm-compare");
    assert.equal(comparedRow?.entries.length, 1);
    const comparedReceipt = (await receiptsFor("akadm-compare"))[0];
    assert.ok(comparedReceipt);
    assert.equal(comparedReceipt.detail.actor_type, "human");
    assert.equal(comparedReceipt.detail.actor_id, DASHBOARD_ACTOR_ID);
    assertSafeReceipt(comparedReceipt, "akadm-compare", 1);
    setDriftReadFaultForTests(false);

    setSkillReceiptFaultForTests([SKILL_DRIFT_KIND]);
    const faulted = await post(report("akadm-fault"), { cookie });
    assert.equal(faulted.status, 500);
    assert.equal(await driftRow("akadm-fault"), null);
    assert.equal((await receiptsFor("akadm-fault")).length, 0);
    setSkillReceiptFaultForTests(null);

    await sql()`drop trigger if exists actor_admin_drift_suppress on events`;
    await sql()`drop function if exists actor_admin_drift_suppress()`;
    await sql()`
      create function actor_admin_drift_suppress() returns trigger
      language plpgsql as $fn$
      begin
        if new.kind = 'skill_drift_report' then
          return null;
        end if;
        return new;
      end
      $fn$
    `;
    await sql()`
      create trigger actor_admin_drift_suppress
      before insert on events
      for each row execute function actor_admin_drift_suppress()
    `;
    const suppressed = await post(report("akadm-suppress"), { cookie });
    assert.equal(suppressed.status, 500);
    assert.equal(await driftRow("akadm-suppress"), null, "a suppressed drift receipt rolls the drift row back");
    assert.equal((await receiptsFor("akadm-suppress")).length, 0);
    await sql()`drop trigger if exists actor_admin_drift_suppress on events`;
    await sql()`drop function if exists actor_admin_drift_suppress()`;
    console.error = originalError;

    const beforeDemo = await sql()`select count(*)::int as n from skill_drift where host = 'akadm-demo'`;
    delete env.MC_DASHBOARD_PASSWORD;
    delete env.MC_TOKEN;
    delete env.DATABASE_URL;
    const demo = await post(report("akadm-demo"));
    assert.equal(demo.status, 200);
    const demoBody = await demo.json() as { demo?: boolean };
    assert.equal(demoBody.demo, true);
    env.DATABASE_URL = saved.DATABASE_URL;
    const afterDemo = await sql()`select count(*)::int as n from skill_drift where host = 'akadm-demo'`;
    assert.equal(Number(afterDemo[0].n), Number(beforeDemo[0].n));
    assert.equal((await receiptsFor("akadm-demo")).length, 0);
  } finally {
    console.error = originalError;
    setDriftReadFaultForTests(false);
    setSkillReceiptFaultForTests(null);
    env.DATABASE_URL = saved.DATABASE_URL;
    await sql()`drop trigger if exists actor_admin_drift_suppress on events`;
    await sql()`drop function if exists actor_admin_drift_suppress()`;
    await sql()`delete from events where kind = ${SKILL_DRIFT_KIND} and detail->>'host' like 'akadm-%'`;
    await sql()`delete from skill_drift where host like 'akadm-%'`;
    await sql()`delete from events where detail->>'credential_id' in (select id from agent_credentials where label = 'drift-denial')`;
    await sql()`delete from agent_credentials where label = 'drift-denial'`;
    resetCredentialsForTests();
    if (saved.NODE_ENV === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved.NODE_ENV;
    if (saved.MC_DASHBOARD_PASSWORD === undefined) delete env.MC_DASHBOARD_PASSWORD;
    else env.MC_DASHBOARD_PASSWORD = saved.MC_DASHBOARD_PASSWORD;
    if (saved.MC_TOKEN === undefined) delete env.MC_TOKEN;
    else env.MC_TOKEN = saved.MC_TOKEN;
    if (saved.AK_SKILL_DRIFT_DIRS === undefined) delete env.AK_SKILL_DRIFT_DIRS;
    else env.AK_SKILL_DRIFT_DIRS = saved.AK_SKILL_DRIFT_DIRS;
    if (saved.DATABASE_URL === undefined) delete env.DATABASE_URL;
    else env.DATABASE_URL = saved.DATABASE_URL;
  }
}
