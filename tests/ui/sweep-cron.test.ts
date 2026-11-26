/**
 * Scheduled absence sweeper (#79): GET /api/sweep/cron, called by Vercel Cron
 * every 5 minutes. These tests cover who may call it, the no-database answer,
 * the schedule in vercel.json, and that the middleware leaves auth to the route.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { NextRequest } from "next/server";
import { GET, maxDuration } from "../../src/app/api/sweep/cron/route";
import { middleware } from "../../src/middleware";

const env = process.env as Record<string, string | undefined>;
const KEYS = ["CRON_SECRET", "MC_TOKEN", "MC_DASHBOARD_PASSWORD", "DATABASE_URL", "NODE_ENV"];

describe("GET /api/sweep/cron", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = env[k];
      delete env[k];
    }
    env.NODE_ENV = "test";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  });
  const get = (auth?: string) =>
    GET(new Request("http://127.0.0.1/api/sweep/cron", auth ? { headers: { authorization: auth } } : {}));

  it("an unauthenticated call is refused", async () => {
    env.CRON_SECRET = "cron-secret-value-1";
    env.MC_TOKEN = "mc-token-value-1";
    env.MC_DASHBOARD_PASSWORD = "dashboard-password-1";
    const res = await get();
    assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  });

  it("a wrong bearer is refused, and is not mistaken for the cron secret", async () => {
    env.CRON_SECRET = "cron-secret-value-1";
    env.MC_TOKEN = "mc-token-value-1";
    env.MC_DASHBOARD_PASSWORD = "dashboard-password-1";
    const res = await get("Bearer cron-secret-value-2");
    assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  });

  it("with no CRON_SECRET set, a bearer that would match an empty secret is refused", async () => {
    env.MC_TOKEN = "mc-token-value-1";
    env.MC_DASHBOARD_PASSWORD = "dashboard-password-1";
    const res = await get("Bearer ");
    assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  });

  it("CRON_SECRET is accepted; without a database nothing runs and it says so", async () => {
    env.CRON_SECRET = "cron-secret-value-1";
    env.MC_TOKEN = "mc-token-value-1";
    env.MC_DASHBOARD_PASSWORD = "dashboard-password-1";
    const res = await get("Bearer cron-secret-value-1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, demo: true, note: "DATABASE_URL not set; the sweeper did not run." });
  });

  it("MC_TOKEN is accepted for a manual run", async () => {
    env.CRON_SECRET = "cron-secret-value-1";
    env.MC_TOKEN = "mc-token-value-1";
    env.MC_DASHBOARD_PASSWORD = "dashboard-password-1";
    const res = await get("Bearer mc-token-value-1");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).demo, true);
  });

  it("fits a 60 s function", () => {
    assert.equal(maxDuration, 60);
  });
});

describe("sweep schedule and routing", () => {
  it("vercel.json runs the sweeper every 5 minutes at /api/sweep/cron", () => {
    const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] };
    const entries = cfg.crons.filter((c) => c.path === "/api/sweep/cron");
    assert.deepEqual(entries, [{ path: "/api/sweep/cron", schedule: "*/5 * * * *" }]);
  });

  it("the middleware passes /api/sweep/cron to the route, which checks auth itself", async () => {
    const saved = env.MC_DASHBOARD_PASSWORD;
    env.MC_DASHBOARD_PASSWORD = "dashboard-password-1";
    try {
      const res = await middleware(new NextRequest("http://localhost/api/sweep/cron"));
      assert.notEqual(res.status, 401);
      // The read-only status path and the manual POST path stay behind the middleware.
      assert.equal((await middleware(new NextRequest("http://localhost/api/sweep"))).status, 401);
    } finally {
      if (saved === undefined) delete env.MC_DASHBOARD_PASSWORD;
      else env.MC_DASHBOARD_PASSWORD = saved;
    }
  });
});
