/**
 * Dashboard credential writes in demo mode record process-local activity.
 * They do not open a database. No-op and missing rows stay receipt-free.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DELETE, PATCH, POST } from "../../src/app/api/settings/credentials/route";
import { DASHBOARD_ACTOR_ID } from "../../src/lib/actor";
import { authCookieValue } from "../../src/lib/authcrypto";
import { CREDENTIAL_ADMIN_KINDS, resetCredentialsForTests } from "../../src/lib/credentials";
import { demoListActivity, resetDemoStoreForTests, type DemoActivityFilter } from "../../src/lib/demo-store";

const env = process.env as Record<string, string | undefined>;
const PASSWORD = "actor-admin-demo-password";
const saved = {
  DATABASE_URL: env.DATABASE_URL,
  NODE_ENV: env.NODE_ENV,
  MC_DASHBOARD_PASSWORD: env.MC_DASHBOARD_PASSWORD,
  MC_TOKEN: env.MC_TOKEN,
};

function restore(key: keyof typeof saved): void {
  const value = saved[key];
  if (value === undefined) delete env[key];
  else env[key] = value;
}

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_TOKEN;
  delete env.MC_DASHBOARD_PASSWORD;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  resetDemoStoreForTests();
});

afterEach(() => {
  resetCredentialsForTests();
  resetDemoStoreForTests();
  restore("DATABASE_URL");
  restore("NODE_ENV");
  restore("MC_DASHBOARD_PASSWORD");
  restore("MC_TOKEN");
});

function call(method: "POST" | "PATCH" | "DELETE", body: unknown, headers: Record<string, string> = {}) {
  const request = new Request("http://127.0.0.1/api/settings/credentials", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (method === "POST") return POST(request);
  if (method === "PATCH") return PATCH(request);
  return DELETE(request);
}

async function receipts(filter: Partial<DemoActivityFilter> = {}) {
  const rows = await demoListActivity({
    actor: filter.actor ?? null,
    kind: filter.kind ?? null,
    since: filter.since ?? null,
    until: filter.until ?? null,
  });
  return rows.filter((row) => row.kind.startsWith("credential_"));
}

function assertSafe(text: string, secret: string): void {
  assert.equal(text.includes(secret), false, "credential receipt contains secret material");
}

describe("demo credential administration receipts", () => {
  it("records a human actor for a validated session and skips no-op and missing rows", async () => {
    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    const cookie = `mc_auth=${await authCookieValue(PASSWORD)}`;
    const created = await call("POST", {
      label: "demo-human-label",
      scopes: ["fleet:read"],
      actor_id: "forged-actor",
      token: "akc_forged-token",
    }, { cookie });
    assert.equal(created.status, 200);
    const body = await created.json() as { credential: { id: string; token: string; token_prefix: string } };
    assert.match(body.credential.token, /^akc_/);

    assert.equal((await call("PATCH", { id: body.credential.id, rate_limit_per_minute: 17 }, { cookie })).status, 200);
    assert.equal((await call("PATCH", { id: body.credential.id, rate_limit_per_minute: 17 }, { cookie })).status, 200);
    assert.equal((await call("DELETE", { id: body.credential.id }, { cookie })).status, 200);
    assert.equal((await call("DELETE", { id: body.credential.id }, { cookie })).status, 200);
    assert.equal((await call("DELETE", { id: "missing-demo-credential" }, { cookie })).status, 404);
    assert.equal((await call("PATCH", { id: "missing-demo-credential", rate_limit_per_day: 20 }, { cookie })).status, 404);
    const denied = await call("POST", { label: "denied", scopes: ["fleet:read"] }, {
      cookie,
      authorization: "Bearer akc_not-a-session",
    });
    assert.equal(denied.status, 401);

    const rows = await receipts();
    assert.deepEqual(rows.map((row) => row.kind).sort(), [
      CREDENTIAL_ADMIN_KINDS.create,
      CREDENTIAL_ADMIN_KINDS.limits,
      CREDENTIAL_ADMIN_KINDS.revoke,
    ]);
    for (const row of rows) {
      assert.equal(row.actor_type, "human");
      assert.equal(row.actor_id, DASHBOARD_ACTOR_ID);
      assert.equal(row.detail?.credential_id, body.credential.id);
      const text = JSON.stringify(row.detail);
      assertSafe(text, body.credential.token);
      assertSafe(text, body.credential.token_prefix);
      assertSafe(text, cookie);
      assertSafe(text, "demo-human-label");
      assertSafe(text, "forged-actor");
      assertSafe(text, "akc_forged-token");
    }
    const limits = rows.find((row) => row.kind === CREDENTIAL_ADMIN_KINDS.limits);
    assert.deepEqual(limits?.detail?.rate_limit_per_minute, { from: 60, to: 17 });
  });

  it("records a null actor for the open dashboard and does not invent a person", async () => {
    const created = await call("POST", {
      label: "demo-open-label",
      scopes: ["fleet:read"],
      actor_type: "human",
      actor_id: DASHBOARD_ACTOR_ID,
    });
    assert.equal(created.status, 200);
    const body = await created.json() as { credential: { id: string; token: string; token_prefix: string } };
    const rows = await receipts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind, CREDENTIAL_ADMIN_KINDS.create);
    assert.equal(rows[0]?.actor_type, null);
    assert.equal(rows[0]?.actor_id, null);
    assert.equal(rows[0]?.detail?.credential_id, body.credential.id);
    const text = JSON.stringify(rows[0]?.detail);
    assertSafe(text, body.credential.token);
    assertSafe(text, body.credential.token_prefix);
    assertSafe(text, "demo-open-label");
    assert.equal(text.includes(`"actor_id":"${DASHBOARD_ACTOR_ID}"`), false);
  });
});
