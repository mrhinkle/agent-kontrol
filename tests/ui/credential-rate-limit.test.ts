import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { enforceApi, resolveApiAccess } from "../../src/lib/auth";
import { authCookieValue, signAccessToken } from "../../src/lib/authcrypto";
import {
  createCredential,
  listCredentials,
  resetCredentialsForTests,
  revokeCredential,
  setCredentialClockForTests,
  validateLimitsInput,
} from "../../src/lib/credentials";
import {
  DEFAULT_REQUESTS_PER_DAY,
  DEFAULT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_MAX,
  chargeCredentialRequest,
} from "../../src/lib/credential-rate-limit";
import { setSqlForTests, type Row } from "../../src/lib/db";

/**
 * Per-credential request quotas (issue #51), demo store. The real
 * Postgres path (row lock, database clock, concurrency) is covered in
 * scripts/run-pg-tests.ts. Prior art: tests/ui/agent-credentials.test.ts
 * (route handlers called with a Request) and tests/ui/watch-routes.test.ts.
 */

const env = process.env as Record<string, string | undefined>;
const KEYS = ["MC_TOKEN", "DATABASE_URL", "NODE_ENV", "MC_DASHBOARD_PASSWORD", "MC_OAUTH_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));

// mcp-handler leaves a session timer referenced after a successful request.
after(() => {
  const code = process.exitCode ?? 0;
  setImmediate(() => process.exit(code));
});

// 2026-10-29T12:34:10Z: 50 seconds left in the minute, 11h25m50s left in the UTC day.
const T0 = Date.UTC(2026, 9, 29, 12, 34, 10);
let now = T0;

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  delete env.MC_OAUTH_SECRET;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  now = T0;
  setCredentialClockForTests(() => now);
});

afterEach(() => {
  resetCredentialsForTests();
  setSqlForTests(null);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

async function issue(scopes: string[], limits: { perMinute?: number; perDay?: number } = {}) {
  const created = await createCredential({
    label: "quota test",
    scopes,
    rate_limit_per_minute: limits.perMinute,
    rate_limit_per_day: limits.perDay,
  });
  if (!created.ok) throw new Error(created.error);
  return created;
}

const fleetReq = (token: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/fleet", { headers: { authorization: `Bearer ${token}`, ...headers } });

async function fleetStatus(token: string, headers?: Record<string, string>): Promise<number> {
  const { GET } = await import("../../src/app/api/fleet/route");
  return (await GET(fleetReq(token, headers))).status;
}

describe("limits: defaults and validation", { concurrency: false }, () => {
  it("defaults a new credential to 60 per minute and 10,000 per day", async () => {
    const created = await issue(["fleet:read"]);
    assert.equal(DEFAULT_REQUESTS_PER_MINUTE, 60);
    assert.equal(DEFAULT_REQUESTS_PER_DAY, 10_000);
    assert.equal(created.credential.rate_limit_per_minute, 60);
    assert.equal(created.credential.rate_limit_per_day, 10_000);
    const listed = await listCredentials();
    assert.equal(listed[0]?.rate_limit_per_minute, 60);
    assert.equal(listed[0]?.rate_limit_per_day, 10_000);
  });

  it("rejects a limit that is not a whole number from 1 to 1,000,000, and has no unlimited value", async () => {
    for (const bad of [0, -1, 1.5, "60", 1_000_001, Number.NaN, Number.POSITIVE_INFINITY, true, [], {}]) {
      const perMinute = await createCredential({ label: "x", scopes: ["fleet:read"], rate_limit_per_minute: bad });
      assert.equal(perMinute.ok, false, `per minute ${String(bad)}`);
      const perDay = await createCredential({ label: "x", scopes: ["fleet:read"], rate_limit_per_day: bad });
      assert.equal(perDay.ok, false, `per day ${String(bad)}`);
    }
    const edge = await createCredential({
      label: "x",
      scopes: ["fleet:read"],
      rate_limit_per_minute: 1,
      rate_limit_per_day: RATE_LIMIT_MAX,
    });
    assert.equal(edge.ok, true);
  });

  it("validates a PATCH body: id plus at least one limit, nothing else", () => {
    assert.equal(validateLimitsInput({ id: "a", rate_limit_per_minute: 5 }).ok, true);
    assert.equal(validateLimitsInput({ id: "a", rate_limit_per_day: 5 }).ok, true);
    for (const bad of [
      null,
      [],
      "x",
      { id: "a" },
      { rate_limit_per_minute: 5 },
      { id: "", rate_limit_per_minute: 5 },
      { id: 7, rate_limit_per_minute: 5 },
      { id: "a", rate_limit_per_minute: null },
      { id: "a", rate_limit_per_minute: "5" },
      { id: "a", rate_limit_per_minute: 0 },
      { id: "a", rate_limit_per_day: -3 },
      { id: "a", rate_limit_per_day: 2.5 },
      { id: "a", rate_limit_per_day: 1_000_001 },
      { id: "a", rate_limit_per_minute: 5, label: "renamed" },
      { id: "a", rate_limit_per_minute: 5, rate_minute_count: 0 },
    ]) {
      assert.equal(validateLimitsInput(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe("limits: window math", { concurrency: false }, () => {
  it("allows the per-minute cap, then 429 until the next clock minute", async () => {
    const c = await issue(["fleet:read"], { perMinute: 3, perDay: 100 });
    for (let i = 0; i < 3; i++) {
      assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
    }
    const limited = await chargeCredentialRequest(fleetReq(c.token), c.credential.id);
    assert.equal(limited.status, "limited");
    if (limited.status !== "limited") return;
    assert.equal(limited.window, "minute");
    assert.equal(limited.limit, 3);
    assert.equal(limited.retryAfterSec, 50);

    now = T0 + 49_800; // 0.2 s before the minute ends: Retry-After rounds up to 1.
    const edge = await chargeCredentialRequest(fleetReq(c.token), c.credential.id);
    assert.equal(edge.status === "limited" && edge.retryAfterSec, 1);

    now = T0 + 50_000; // 12:35:00, a new minute.
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
  });

  it("allows the per-day cap, then 429 until 00:00 UTC", async () => {
    const c = await issue(["fleet:read"], { perMinute: 100, perDay: 2 });
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
    now += 120_000;
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
    now += 120_000;
    const limited = await chargeCredentialRequest(fleetReq(c.token), c.credential.id);
    assert.equal(limited.status, "limited");
    if (limited.status !== "limited") return;
    assert.equal(limited.window, "day");
    const midnight = Date.UTC(2026, 9, 30, 0, 0, 0);
    assert.equal(limited.retryAfterSec, Math.ceil((midnight - now) / 1000));
    now = midnight;
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
  });

  it("reports the longest wait when both windows are full, and a denial consumes neither", async () => {
    const c = await issue(["fleet:read"], { perMinute: 2, perDay: 3 });
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
    // Ten denials in this minute. If a denial counted against the day, the
    // next minute would already be over the day cap.
    for (let i = 0; i < 10; i++) {
      const denied = await chargeCredentialRequest(fleetReq(c.token), c.credential.id);
      assert.equal(denied.status === "limited" && denied.window, "minute");
    }
    now = T0 + 50_000;
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "ok");
    // The minute has 1 used of 2, the day 3 of 3: only the day is exhausted.
    const dayOnly = await chargeCredentialRequest(fleetReq(c.token), c.credential.id);
    assert.equal(dayOnly.status === "limited" && dayOnly.window, "day");

    const both = await issue(["fleet:read"], { perMinute: 1, perDay: 1 });
    assert.equal((await chargeCredentialRequest(fleetReq(both.token), both.credential.id)).status, "ok");
    const full = await chargeCredentialRequest(fleetReq(both.token), both.credential.id);
    assert.equal(full.status, "limited");
    if (full.status !== "limited") return;
    assert.equal(full.window, "day");
    assert.ok(full.retryAfterSec > 60, "Retry-After waits for the day, not just the minute");
  });

  it("keeps separate counters per credential", async () => {
    const a = await issue(["fleet:read"], { perMinute: 1 });
    const b = await issue(["fleet:read"], { perMinute: 1 });
    assert.equal((await chargeCredentialRequest(fleetReq(a.token), a.credential.id)).status, "ok");
    assert.equal((await chargeCredentialRequest(fleetReq(a.token), a.credential.id)).status, "limited");
    assert.equal((await chargeCredentialRequest(fleetReq(b.token), b.credential.id)).status, "ok");
  });

  it("rejects a credential revoked or expired before the charge", async () => {
    const c = await issue(["fleet:read"]);
    await revokeCredential(c.credential.id);
    assert.equal((await chargeCredentialRequest(fleetReq(c.token), c.credential.id)).status, "reject");
    const exp = await createCredential({
      label: "x",
      scopes: ["fleet:read"],
      expires_at: new Date(T0 + 1_000).toISOString(),
    });
    if (!exp.ok) throw new Error(exp.error);
    now = T0 + 1_000;
    assert.equal((await chargeCredentialRequest(fleetReq(exp.token), exp.credential.id)).status, "reject");
    assert.equal((await chargeCredentialRequest(fleetReq("akc_x"), "no-such-id")).status, "reject");
  });
});

describe("limits: REST, MCP and watch answer the same 429", { concurrency: false }, () => {
  async function assertRateLimited(res: Response) {
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After ${res.headers.get("retry-after")}`);
    const body = await res.json();
    assert.equal(body.code, "rate_limited");
    assert.equal(body.retryable, true);
    assert.equal(body.retry_after, retryAfter);
    assert.equal(body.window, "minute");
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.fix, "string");
  }

  it("REST: GET /api/fleet answers 200 up to the cap, then 429 rate_limited with Retry-After", async () => {
    const c = await issue(["fleet:read"], { perMinute: 2 });
    const { GET } = await import("../../src/app/api/fleet/route");
    assert.equal((await GET(fleetReq(c.token))).status, 200);
    assert.equal((await GET(fleetReq(c.token))).status, 200);
    const res = await GET(fleetReq(c.token));
    await assertRateLimited(res);
  });

  it("REST: a 403 scope denial and a 401 cost nothing", async () => {
    const c = await issue(["fleet:read"], { perMinute: 1 });
    const { POST } = await import("../../src/app/api/tasks/route");
    for (let i = 0; i < 3; i++) {
      const denied = await POST(
        new Request("http://localhost/api/tasks", {
          method: "POST",
          headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
          body: JSON.stringify({ title: "synthetic" }),
        }),
      );
      assert.equal(denied.status, 403);
    }
    assert.equal(await fleetStatus(c.token), 200);
  });

  it("watch: GET /api/watch/beats is charged after the scope check, then 429", async () => {
    const c = await issue(["watch:read"], { perMinute: 1 });
    const { GET } = await import("../../src/app/api/watch/beats/route");
    const req = () =>
      new Request("http://localhost/api/watch/beats", { headers: { authorization: `Bearer ${c.token}` } });
    // Demo mode has no beat store, so the first call passes auth and answers 503 setup_required.
    const first = await GET(req());
    assert.notEqual(first.status, 429);
    assert.notEqual(first.status, 401);
    const second = await GET(req());
    await assertRateLimited(second);
    assert.equal(second.headers.get("cache-control"), "no-store");

    const writerOnly = await issue(["watch:write"], { perMinute: 1 });
    const scopeDenied = () =>
      GET(new Request("http://localhost/api/watch/beats", { headers: { authorization: `Bearer ${writerOnly.token}` } }));
    assert.equal((await scopeDenied()).status, 403);
    assert.equal((await scopeDenied()).status, 403, "a 403 does not use the quota");
  });

  it("MCP: initialize is one request, then 429; a scope 403 costs nothing", async () => {
    const c = await issue(["fleet:read"], { perMinute: 2 });
    const { POST } = await import("../../src/app/api/[transport]/route");
    const rpc = (body: unknown) =>
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    const scopeDenied = await POST(
      rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "create_task", arguments: { title: "x" } } }),
    );
    assert.equal(scopeDenied.status, 403);
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "quota-test", version: "0" } },
    };
    assert.equal((await POST(rpc(init))).status, 200);
    // A batch of two tool calls is one HTTP request, one unit.
    const batch = await POST(
      rpc([
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_fleet_status", arguments: {} } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_fleet_status", arguments: {} } },
      ]),
    );
    assert.notEqual(batch.status, 429);
    await assertRateLimited(await POST(rpc(init)));
  });
});

describe("limits: one charge per request, and who is metered", { concurrency: false }, () => {
  it("charges once when auth runs twice, or twice at once, for the same Request", async () => {
    const c = await issue(["fleet:read"], { perMinute: 1 });
    const req = fleetReq(c.token);
    const [a, b] = await Promise.all([resolveApiAccess(req), resolveApiAccess(req)]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(await enforceApi(req), null);
    const next = await resolveApiAccess(fleetReq(c.token));
    assert.equal(next.ok === false && next.status, 429);
  });

  it("an akc_ bearer wins over a valid session cookie, so a cookie cannot skip the quota", async () => {
    env.MC_DASHBOARD_PASSWORD = "test-dashboard-password";
    const cookie = `mc_auth=${await authCookieValue("test-dashboard-password")}`;
    const c = await issue(["fleet:read"], { perMinute: 1 });
    assert.equal(await fleetStatus(c.token, { cookie }), 200);
    assert.equal(await fleetStatus(c.token, { cookie }), 429);
    assert.equal(await fleetStatus("akc_not-a-real-credential", { cookie }), 401);
    const { GET } = await import("../../src/app/api/fleet/route");
    for (let i = 0; i < 5; i++) {
      const res = await GET(new Request("http://localhost/api/fleet", { headers: { cookie } }));
      assert.equal(res.status, 200, "the session alone is not metered");
    }
  });

  it("does not meter MC_TOKEN, dev-open, or OAuth", async () => {
    env.MC_TOKEN = "test-mc-token";
    env.MC_OAUTH_SECRET = "oauth-test-secret";
    for (let i = 0; i < 70; i++) assert.equal(await fleetStatus("test-mc-token"), 200);
    const { GET } = await import("../../src/app/api/fleet/route");
    for (let i = 0; i < 70; i++) {
      assert.equal((await GET(new Request("http://localhost/api/fleet"))).status, 200);
    }
    const jwt = await signAccessToken(
      {
        iss: "http://localhost:3000",
        aud: "http://localhost:3000/api/mcp",
        sub: "oauth-client",
        client_id: "oauth-client",
        scope: "mcp",
        typ: "access",
      },
      3600,
    );
    const { POST } = await import("../../src/app/api/[transport]/route");
    for (let i = 0; i < 65; i++) {
      const res = await POST(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${jwt}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }),
      );
      assert.notEqual(res.status, 429);
      assert.notEqual(res.status, 401);
    }
  });
});

describe("limits: store errors fail closed", { concurrency: false }, () => {
  /**
   * A database that resolves the credential and then fails the quota lock.
   * Nothing falls back to process memory: the answer is 503.
   */
  async function plantFailingQuotaStore() {
    const c = await issue(["fleet:read", "watch:read"]);
    const hash = (await import("node:crypto")).createHash("sha256").update(c.token).digest("hex");
    env.DATABASE_URL = "postgresql://quota-test.invalid/none";
    const row: Row = {
      id: c.credential.id,
      label: "x",
      token_prefix: c.token.slice(0, 8),
      token_hash: hash,
      scopes: ["fleet:read", "watch:read"],
      created_at: new Date(T0).toISOString(),
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      rate_limit_per_minute: 60,
      rate_limit_per_day: 10_000,
    };
    setSqlForTests(async (strings) => {
      const text = strings.join("?");
      if (/where token_hash =/.test(text)) return [row];
      if (/for update/.test(text)) throw new Error("simulated quota store outage");
      return [];
    });
    return c;
  }

  it("REST, watch and MCP answer 503 credential_store_unavailable", async () => {
    const c = await plantFailingQuotaStore();
    const { GET: fleet } = await import("../../src/app/api/fleet/route");
    const rest = await fleet(fleetReq(c.token));
    assert.equal(rest.status, 503);
    assert.equal((await rest.json()).error, "credential_store_unavailable");

    const { GET: beats } = await import("../../src/app/api/watch/beats/route");
    const watch = await beats(
      new Request("http://localhost/api/watch/beats", { headers: { authorization: `Bearer ${c.token}` } }),
    );
    assert.equal(watch.status, 503);
    assert.equal((await watch.json()).error, "credential_store_unavailable");

    const { POST } = await import("../../src/app/api/[transport]/route");
    const mcp = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${c.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    );
    assert.equal(mcp.status, 503);
    assert.equal((await mcp.json()).error, "credential_store_unavailable");
  });
});

describe("limits: Settings", { concurrency: false }, () => {
  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost/api/settings/credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("PATCH changes the limits, keeps the counted requests, and is dashboard-session only", async () => {
    env.MC_TOKEN = "test-mc-token";
    const c = await issue(["fleet:read"], { perMinute: 2 });
    const { PATCH } = await import("../../src/app/api/settings/credentials/route");
    assert.equal(await fleetStatus(c.token), 200);
    assert.equal(await fleetStatus(c.token), 200);
    assert.equal(await fleetStatus(c.token), 429);

    for (const bearer of ["test-mc-token", c.token, "eyJhbGciOiJIUzI1NiJ9.e30.x"]) {
      const res = await PATCH(patch({ id: c.credential.id, rate_limit_per_minute: 500 }, { authorization: `Bearer ${bearer}` }));
      assert.equal(res.status, 401);
    }
    assert.equal((await PATCH(patch({ id: c.credential.id, rate_limit_per_minute: 0 }))).status, 400);
    assert.equal((await PATCH(patch({ id: c.credential.id, label: "x", rate_limit_per_minute: 5 }))).status, 400);
    assert.equal((await PATCH(patch({ id: "no-such-credential", rate_limit_per_minute: 5 }))).status, 404);
    assert.equal((await listCredentials())[0]?.rate_limit_per_minute, 2, "rejected edits change nothing");

    const raised = await PATCH(patch({ id: c.credential.id, rate_limit_per_minute: 3 }));
    assert.equal(raised.status, 200);
    const body = await raised.json();
    assert.equal(body.credential.rate_limit_per_minute, 3);
    assert.equal(body.credential.rate_limit_per_day, 10_000, "an omitted limit keeps its value");
    // Two requests are already counted this minute: one more fits, then 429.
    assert.equal(await fleetStatus(c.token), 200);
    assert.equal(await fleetStatus(c.token), 429);

    env.MC_DASHBOARD_PASSWORD = "test-dashboard-password";
    assert.equal((await PATCH(patch({ id: c.credential.id, rate_limit_per_day: 50 }))).status, 401);
    const cookie = `mc_auth=${await authCookieValue("test-dashboard-password")}`;
    assert.equal((await PATCH(patch({ id: c.credential.id, rate_limit_per_day: 50 }, { cookie }))).status, 200);
  });

  it("POST accepts limits on create and rejects bad ones", async () => {
    const { POST } = await import("../../src/app/api/settings/credentials/route");
    const make = (body: unknown) =>
      POST(
        new Request("http://localhost/api/settings/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const ok = await make({ label: "x", scopes: ["fleet:read"], rate_limit_per_minute: 5, rate_limit_per_day: 50 });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.credential.rate_limit_per_minute, 5);
    assert.equal(okBody.credential.rate_limit_per_day, 50);
    assert.equal((await make({ label: "x", scopes: ["fleet:read"], rate_limit_per_day: 0 })).status, 400);
  });
});
