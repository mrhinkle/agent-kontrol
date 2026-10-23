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

  it("serves the public agent docs while data routes stay refused", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgres://x";
    assert.notEqual((await middleware(req("/llms.txt"))).status, 503);
    assert.notEqual((await middleware(req("/docs/mcp.md"))).status, 503);
    assert.notEqual((await middleware(req("/docs/api.md"))).status, 503);
    assert.notEqual((await middleware(req("/docs/agents.md"))).status, 503);
    assert.equal((await middleware(req("/api/fleet"))).status, 503);
    assert.equal((await middleware(req("/docs/deploy.md"))).status, 503);
    assert.equal((await middleware(req("/tasks"))).status, 503);
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

  it("forwards an agent-credential bearer to API routes and still blocks pages", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    env.MC_TOKEN = "tok";
    const headers = { authorization: "Bearer akc_example-not-a-secret" };
    assert.equal((await middleware(req("/api/fleet", headers))).status, 200);
    assert.equal((await middleware(req("/tasks", headers))).status, 307);
  });

  it("still 401s a non-credential bearer on API routes", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    env.MC_TOKEN = "tok";
    assert.equal((await middleware(req("/api/fleet", { authorization: "Bearer nope" }))).status, 401);
  });

  it("lets only the agent index and the three markdown docs through the gate", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    env.NODE_ENV = "production";
    delete env.MC_TOKEN;
    for (const path of ["/llms.txt", "/docs/mcp.md", "/docs/api.md", "/docs/agents.md", "/login", "/api/mcp", "/api/ingest"]) {
      assert.equal((await middleware(req(path))).status, 200, path);
    }
    assert.equal((await middleware(req("/llms.txt?from=agent"))).status, 200);
    const gatedPages = [
      "/tasks",
      "/help",
      "/help/mcp",
      "/",
      "/settings",
      "/docs",
      "/docs/deploy.md",
      "/docs/MCP.md",
      "/docs/mcp.mdx",
      "/docs/mcp.md/extra",
      "/llms.txt.bak",
      "/llms.txt/",
      "/docs/%2e%2e%2fpackage.json",
    ];
    for (const path of gatedPages) {
      const res = await middleware(req(path));
      assert.equal(res.status, 307, path);
      assert.match(new URL(res.headers.get("location") ?? "", "http://localhost").pathname, /^\/login\/?$/, path);
    }
    for (const path of ["/api/fleet", "/api/memory", "/api/tasks"]) {
      assert.equal((await middleware(req(path))).status, 401, path);
    }
    const escaped = await middleware(req("/docs/../package.json"));
    assert.equal(escaped.status, 307);
  });
});
