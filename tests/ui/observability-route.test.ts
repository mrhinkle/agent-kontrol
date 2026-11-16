import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GET } from "../../src/app/api/observability/route";
import { setSqlForTests } from "../../src/lib/db";
import { openApiDocument } from "../../src/lib/openapi";
import { authorizeRoute } from "../../src/lib/scopes";

const FIXTURE_URL = "postgresql://ak_backlog_test@127.0.0.1:65438/ak_release_candidate_author";

describe("GET /api/observability", () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousDriver = process.env.MC_DB_DRIVER;

  afterEach(() => {
    setSqlForTests(null);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousDriver === undefined) delete process.env.MC_DB_DRIVER;
    else process.env.MC_DB_DRIVER = previousDriver;
  });

  it("stays off the agent scope table and keeps usage:read on GET /api/usage", () => {
    const agent = { kind: "agent" as const, id: "agent-1", scopes: ["usage:read", "fleet:read"] };
    const denied = authorizeRoute(agent, "GET", "/api/observability");
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, "insufficient_scope");
      assert.equal(denied.body.error, "This route is not available to an agent credential.");
      assert.equal(denied.body.retryable, false);
      assert.equal(typeof denied.body.fix, "string");
    }
    assert.equal(authorizeRoute(agent, "GET", "/api/usage").ok, true);
    assert.equal(authorizeRoute(agent, "GET", "/api/decisions").ok, false);
    const decisionReader = { kind: "agent" as const, id: "agent-2", scopes: ["decisions:read"] };
    assert.equal(authorizeRoute(decisionReader, "GET", "/api/decisions").ok, true);
    assert.equal(authorizeRoute(decisionReader, "GET", "/api/observability").ok, false);
    assert.equal(authorizeRoute({ kind: "session" }, "GET", "/api/observability").ok, true);
    assert.equal(authorizeRoute({ kind: "legacy" }, "GET", "/api/observability").ok, true);
  });

  it("returns the Q6 503 contract and does not copy the store exception", async () => {
    process.env.DATABASE_URL = FIXTURE_URL;
    process.env.MC_DB_DRIVER = "pg";
    setSqlForTests(async () => {
      throw new Error("password=observability-secret host=prod.example");
    });
    const response = await GET(new Request("https://dashboard.example/api/observability"));
    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["cause", "code", "error", "fix", "retryable"]);
    assert.equal(body.error, "Run metrics unavailable");
    assert.equal(body.code, "internal_error");
    assert.equal(body.cause, "The run store did not answer.");
    assert.equal(body.fix, "Retry the request. If it keeps failing, check the server logs.");
    assert.equal(body.retryable, true);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("observability-secret"), false);
    assert.equal(serialized.includes("prod.example"), false);
    const spec = openApiDocument().paths as Record<string, { get?: { responses?: Record<string, unknown> } }>;
    assert.ok(spec["/api/observability"]?.get?.responses?.["503"]);
  });
});
