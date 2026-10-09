import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware, isUnprotectedWithRealData } from "../../src/middleware";

const env = process.env as Record<string, string | undefined>;
const KEYS = ["MC_DASHBOARD_PASSWORD", "MC_TOKEN", "DATABASE_URL", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

const req = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers });

describe("middleware with no dashboard password", () => {
  it("stays open in development", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "development";
    env.DATABASE_URL = "postgres://x";
    assert.equal(isUnprotectedWithRealData(), false);
    assert.notEqual((await middleware(req("/api/fleet"))).status, 503);
  });

  it("stays open in production without a database (demo deploy)", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "production";
    delete env.DATABASE_URL;
    assert.notEqual((await middleware(req("/api/fleet"))).status, 503);
  });

  it("refuses data routes in production with a database", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgres://x";
    assert.equal(isUnprotectedWithRealData(), true);
    assert.equal((await middleware(req("/api/fleet"))).status, 503);
    assert.equal((await middleware(req("/tasks"))).status, 503);
  });

  it("still lets token-authed agent routes through", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgres://x";
    assert.notEqual((await middleware(req("/api/ingest"))).status, 503);
    assert.notEqual((await middleware(req("/api/mcp"))).status, 503);
  });
});

describe("middleware with a dashboard password", () => {
  it("redirects pages and 401s API calls without a session", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    env.NODE_ENV = "production";
    const page = await middleware(req("/tasks"));
    assert.equal(page.status, 307);
    assert.equal((await middleware(req("/api/fleet"))).status, 401);
  });

  it("accepts the MC_TOKEN bearer on data routes", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    env.MC_TOKEN = "tok";
    const res = await middleware(req("/api/fleet", { authorization: "Bearer tok" }));
    assert.equal(res.status, 200);
  });
});
