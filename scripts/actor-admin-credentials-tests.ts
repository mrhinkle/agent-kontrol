/**
 * Credential administration receipts. Calls the settings route and reads
 * agent_credentials plus events on the opt-in fixture database.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { DASHBOARD_ACTOR_ID, runWithActor } from "../src/lib/actor";
import { authCookieValue } from "../src/lib/authcrypto";
import {
  CREDENTIAL_ADMIN_KINDS,
  resetCredentialsForTests,
  setCredentialReceiptFaultForTests,
  updateCredentialLimits,
} from "../src/lib/credentials";
import { sql } from "../src/lib/db";

const PASSWORD = "actor-admin-test-password";
const KINDS = Object.values(CREDENTIAL_ADMIN_KINDS);

function assertFixture(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not the actor admin fixture");
  const url = new URL(raw);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "65438" ||
    url.username !== "ak_backlog_test" ||
    url.pathname !== "/ak_actor_admin"
  ) {
    throw new Error("refusing to run credential admin tests outside ak_actor_admin");
  }
}

const env = process.env as Record<string, string | undefined>;
type Env = Record<string, string | undefined>;

function snapshotEnv(): Env {
  return {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    MC_DASHBOARD_PASSWORD: process.env.MC_DASHBOARD_PASSWORD,
    MC_TOKEN: process.env.MC_TOKEN,
  };
}

function restoreEnv(saved: Env): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function cookieHeader(): Promise<string> {
  return `mc_auth=${await authCookieValue(PASSWORD)}`;
}

async function countEvents(): Promise<number> {
  const rows = await sql()`select count(*)::int as n from events where kind = any(${KINDS}::text[])`;
  return Number(rows[0].n);
}

async function receiptsFor(id: string): Promise<{ kind: string; title: string; detailText: string; detail: Record<string, unknown>; agentId: string | null }[]> {
  const rows = await sql()`
    select kind, title, detail::text as detail_text, detail, agent_id
    from events
    where detail->>'credential_id' = ${id}
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

async function credentialRow(id: string): Promise<Record<string, unknown> | null> {
  const rows = await sql()`
    select id, label, token_prefix, token_hash, scopes, revoked_at, rate_limit_per_minute, rate_limit_per_day,
      rate_minute_count, rate_day_count
    from agent_credentials
    where id = ${id}
  `;
  return rows[0] ?? null;
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function assertNoSecret(text: string, secret: string, label: string): void {
  assert.equal(text.includes(secret), false, `${label} leaked into the receipt`);
}

export async function testCredentialAdmin(): Promise<void> {
  assertFixture();
  const saved = snapshotEnv();
  const { GET, POST, PATCH, DELETE } = await import("../src/app/api/settings/credentials/route");
  const createdIds: string[] = [];
  const remember = (id: string) => {
    createdIds.push(id);
  };

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST(new Request("http://127.0.0.1/api/settings/credentials", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }));
  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    PATCH(new Request("http://127.0.0.1/api/settings/credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }));
  const del = (body: unknown, headers: Record<string, string> = {}) =>
    DELETE(new Request("http://127.0.0.1/api/settings/credentials", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }));

  try {
    delete process.env.MC_TOKEN;
    delete process.env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "test";
    const baseline = await countEvents();

    const open = await post({
      label: "CANARY-LABEL",
      scopes: ["fleet:read"],
      actor_id: "forged-actor-canary",
      actor_type: "human",
      token: "akc_forged-token-canary",
    });
    assert.equal(open.status, 200);
    const openBody = await open.json() as { credential: { id: string; token_prefix: string; token: string } };
    remember(openBody.credential.id);
    const openReceipts = await receiptsFor(openBody.credential.id);
    assert.equal(openReceipts.length, 1);
    assert.equal(openReceipts[0].kind, CREDENTIAL_ADMIN_KINDS.create);
    assert.equal(openReceipts[0].detail.actor_type, null);
    assert.equal(openReceipts[0].detail.actor_id, null);
    assert.equal(openReceipts[0].detail.operation, "create");
    assert.equal(openReceipts[0].detail.credential_id, openBody.credential.id);
    assert.deepEqual(openReceipts[0].detail.scopes, ["fleet:read"]);
    assert.equal(openReceipts[0].agentId, null);
    const openText = openReceipts[0].detailText + openReceipts[0].title;
    assertNoSecret(openText, openBody.credential.token, "token");
    assertNoSecret(openText, openBody.credential.token_prefix, "prefix");
    assertNoSecret(openText, sha256(openBody.credential.token), "hash");
    assertNoSecret(openText, "CANARY-LABEL", "label");
    assertNoSecret(openText, "forged-actor-canary", "forged actor");
    assertNoSecret(openText, "akc_forged-token-canary", "forged token field");
    const stored = await credentialRow(openBody.credential.id);
    assert.ok(stored);
    assert.equal(stored.token_hash, sha256(openBody.credential.token));
    assert.equal(String(stored.token_prefix), openBody.credential.token_prefix);

    process.env.MC_DASHBOARD_PASSWORD = PASSWORD;
    const cookie = await cookieHeader();
    const deniedBearer = await post(
      { label: "should-not-exist", scopes: ["fleet:read"] },
      { authorization: "Bearer akc_not-a-real-token", cookie },
    );
    assert.equal(deniedBearer.status, 401);
    const deniedScheme = await post(
      { label: "should-not-exist", scopes: ["fleet:read"] },
      { authorization: "Bearer ", cookie },
    );
    assert.equal(deniedScheme.status, 401);
    const deniedLegacy = await post(
      { label: "should-not-exist", scopes: ["fleet:read"] },
      { authorization: "Bearer legacy-token", cookie },
    );
    assert.equal(deniedLegacy.status, 401);
    const stray = await sql()`select count(*)::int as n from agent_credentials where label = 'should-not-exist'`;
    assert.equal(Number(stray[0].n), 0);

    const human = await post(
      { label: "CANARY-HUMAN", scopes: ["tasks:read", "fleet:read"], actor_id: "forged-actor-canary", rate_limit_per_minute: 12 },
      { cookie },
    );
    assert.equal(human.status, 200);
    const humanBody = await human.json() as { credential: { id: string; token_prefix: string; token: string; rate_limit_per_minute: number } };
    remember(humanBody.credential.id);
    assert.equal(humanBody.credential.rate_limit_per_minute, 12);
    const humanReceipts = await receiptsFor(humanBody.credential.id);
    assert.equal(humanReceipts.length, 1);
    assert.equal(humanReceipts[0].detail.actor_type, "human");
    assert.equal(humanReceipts[0].detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(humanReceipts[0].detail.rate_limit_per_minute, 12);
    const humanText = humanReceipts[0].detailText + humanReceipts[0].title;
    assertNoSecret(humanText, humanBody.credential.token, "human token");
    assertNoSecret(humanText, humanBody.credential.token_prefix, "human prefix");
    assertNoSecret(humanText, sha256(humanBody.credential.token), "human hash");
    assertNoSecret(humanText, cookie, "cookie");
    assertNoSecret(humanText, PASSWORD, "password");
    assertNoSecret(humanText, "forged-actor-canary", "forged human actor");

    await sql()`
      update agent_credentials
      set rate_minute_count = 4, rate_day_count = 9
      where id = ${humanBody.credential.id}
    `;
    const same = await patch(
      { id: humanBody.credential.id, rate_limit_per_minute: 12, actor_type: "agent" },
      { cookie },
    );
    assert.equal(same.status, 400, "a forged field is rejected before a write");
    assert.equal((await receiptsFor(humanBody.credential.id)).length, 1);

    const noop = await patch({ id: humanBody.credential.id, rate_limit_per_minute: 12 }, { cookie });
    assert.equal(noop.status, 200);
    assert.equal((await receiptsFor(humanBody.credential.id)).length, 1, "an unchanged limit writes no receipt");
    const afterNoop = await credentialRow(humanBody.credential.id);
    assert.equal(Number(afterNoop?.rate_minute_count), 4);
    assert.equal(Number(afterNoop?.rate_day_count), 9);

    const missingLimits = await patch({ id: "missing-credential-id", rate_limit_per_day: 20 }, { cookie });
    assert.equal(missingLimits.status, 404);
    const missingEvents = await sql()`
      select count(*)::int as n from events where detail->>'credential_id' = 'missing-credential-id'
    `;
    assert.equal(Number(missingEvents[0].n), 0);

    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    let limitsSettled = false;
    try {
      await holder.query("begin");
      await holder.query("select id from agent_credentials where id = $1 for update", [humanBody.credential.id]);
      const pending = runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
        updateCredentialLimits({
          id: humanBody.credential.id,
          rate_limit_per_minute: 15,
          rate_limit_per_day: null,
        }),
      ).then((row) => {
        limitsSettled = true;
        return row;
      });
      const started = Date.now();
      let sawWait = false;
      while (Date.now() - started < 2000 && !limitsSettled) {
        const waits = await holder.query(
          `select count(*)::int as n
           from pg_stat_activity
           where datname = current_database()
             and pid <> pg_backend_pid()
             and wait_event_type = 'Lock'`,
        );
        if (Number(waits.rows[0].n) > 0) {
          sawWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      assert.equal(limitsSettled, false, "a limits change must not finish while the credential row is locked");
      assert.equal(sawWait, true, "a limits change waits on the credential row lock");
      await holder.query("commit");
      const updated = await pending;
      assert.equal(updated?.rate_limit_per_minute, 15);
      assert.equal(updated?.rate_limit_per_day, 10000);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    const afterLimits = await credentialRow(humanBody.credential.id);
    assert.equal(Number(afterLimits?.rate_minute_count), 4, "a limit edit keeps the minute counter");
    assert.equal(Number(afterLimits?.rate_day_count), 9, "a limit edit keeps the day counter");
    const limitReceipts = await receiptsFor(humanBody.credential.id);
    assert.equal(limitReceipts.length, 2);
    const limitReceipt = limitReceipts[1];
    assert.equal(limitReceipt.kind, CREDENTIAL_ADMIN_KINDS.limits);
    assert.equal(limitReceipt.detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.deepEqual(limitReceipt.detail.rate_limit_per_minute, { from: 12, to: 15 });
    assert.deepEqual(limitReceipt.detail.rate_limit_per_day, { from: 10000, to: 10000 });
    assertNoSecret(limitReceipt.detailText, humanBody.credential.token, "limits token");
    assertNoSecret(limitReceipt.detailText, String(afterLimits?.token_prefix), "limits prefix");
    assertNoSecret(limitReceipt.detailText, String(afterLimits?.token_hash), "limits hash");

    const revoked = await del(
      { id: humanBody.credential.id, actor_id: "forged-actor-canary" },
      { cookie },
    );
    assert.equal(revoked.status, 200);
    const revokedBody = await revoked.json() as { credential: { revoked_at: string } };
    assert.ok(revokedBody.credential.revoked_at);
    const once = await receiptsFor(humanBody.credential.id);
    assert.equal(once.filter((row) => row.kind === CREDENTIAL_ADMIN_KINDS.revoke).length, 1);
    const revokeReceipt = once.find((row) => row.kind === CREDENTIAL_ADMIN_KINDS.revoke);
    assert.ok(revokeReceipt);
    assert.equal(revokeReceipt.detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(revokeReceipt.detail.operation, "revoke");
    assertNoSecret(revokeReceipt.detailText, "forged-actor-canary", "forged revoke actor");
    assertNoSecret(revokeReceipt.detailText, humanBody.credential.token, "revoke token");

    const again = await del({ id: humanBody.credential.id }, { cookie });
    assert.equal(again.status, 200);
    const againBody = await again.json() as { credential: { revoked_at: string } };
    assert.equal(againBody.credential.revoked_at, revokedBody.credential.revoked_at);
    assert.equal((await receiptsFor(humanBody.credential.id)).filter((row) => row.kind === CREDENTIAL_ADMIN_KINDS.revoke).length, 1);

    const absent = await del({ id: "missing-credential-id" }, { cookie });
    assert.equal(absent.status, 404);
    assert.equal(Number((await sql()`
      select count(*)::int as n from events where detail->>'credential_id' = 'missing-credential-id'
    `)[0].n), 0);

    const beforeFault = await countEvents();
    const beforeRows = Number((await sql()`select count(*)::int as n from agent_credentials`)[0].n);
    setCredentialReceiptFaultForTests([CREDENTIAL_ADMIN_KINDS.create]);
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((item) => String(item)).join(" "));
    };
    try {
      const fault = await post({ label: "fault-create", scopes: ["fleet:read"] }, { cookie });
      assert.equal(fault.status, 500);
      const faultBody = await fault.json() as Record<string, unknown>;
      assert.equal(faultBody.code, "internal_error");
      assert.equal(JSON.stringify(faultBody).includes("akc_"), false);
    } finally {
      console.error = originalError;
      setCredentialReceiptFaultForTests(null);
    }
    assert.equal(await countEvents(), beforeFault, "a failed create receipt leaves no event");
    assert.equal(Number((await sql()`select count(*)::int as n from agent_credentials`)[0].n), beforeRows);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].includes("akc_"), false);

    setCredentialReceiptFaultForTests([CREDENTIAL_ADMIN_KINDS.revoke]);
    const live = await post({ label: "fault-revoke", scopes: ["fleet:read"] }, { cookie });
    assert.equal(live.status, 200);
    const liveBody = await live.json() as { credential: { id: string } };
    remember(liveBody.credential.id);
    const revokeFault = await del({ id: liveBody.credential.id }, { cookie });
    assert.equal(revokeFault.status, 500);
    const still = await credentialRow(liveBody.credential.id);
    assert.equal(still?.revoked_at, null, "a failed revoke receipt rolls the revocation back");
    assert.equal((await receiptsFor(liveBody.credential.id)).some((row) => row.kind === CREDENTIAL_ADMIN_KINDS.revoke), false);
    setCredentialReceiptFaultForTests(null);

    const beforeList = await countEvents();
    const listed = await GET(new Request("http://127.0.0.1/api/settings/credentials", { headers: { cookie } }));
    assert.equal(listed.status, 200);
    assert.equal(await countEvents(), beforeList, "listing credentials writes no receipt");

    delete process.env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "production";
    const closed = await post({ label: "prod-open", scopes: ["fleet:read"] });
    assert.equal(closed.status, 401);
    const prodRows = await sql()`select count(*)::int as n from agent_credentials where label = 'prod-open'`;
    assert.equal(Number(prodRows[0].n), 0);

    env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;
    resetCredentialsForTests();
    const demo = await post({ label: "demo-open", scopes: ["fleet:read"], actor_id: "forged-actor-canary" });
    assert.equal(demo.status, 200);
    const demoBody = await demo.json() as { credential: { id: string; token: string } };
    assert.match(demoBody.credential.token, /^akc_/);
    process.env.DATABASE_URL = saved.DATABASE_URL;
    const demoEvents = await receiptsFor(demoBody.credential.id);
    assert.equal(demoEvents.length, 0, "demo mode does not invent an events receipt");
    const demoStored = await credentialRow(demoBody.credential.id);
    assert.equal(demoStored, null);
    resetCredentialsForTests();

    assert.equal(await countEvents(), baseline + 5, "three creates, one limits edit, and one revoke");
  } finally {
    setCredentialReceiptFaultForTests(null);
    resetCredentialsForTests();
    restoreEnv(saved);
    if (createdIds.length > 0) {
      await sql()`delete from events where detail->>'credential_id' = any(${createdIds}::text[])`;
      await sql()`delete from agent_credentials where id = any(${createdIds}::text[])`;
    }
  }
}
