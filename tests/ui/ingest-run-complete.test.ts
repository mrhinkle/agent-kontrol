import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { POST } from "../../src/app/api/ingest/route";
import { setSqlForTests } from "../../src/lib/db";

const FIXTURE_URL = "postgresql://ak_backlog_test@127.0.0.1:65438/ak_release_candidate_author";
const TOKEN = "ingest-run-test-token";

describe("POST /api/ingest malformed run_complete", () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousToken = process.env.MC_TOKEN;
  const previousDriver = process.env.MC_DB_DRIVER;

  afterEach(() => {
    setSqlForTests(null);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousToken === undefined) delete process.env.MC_TOKEN;
    else process.env.MC_TOKEN = previousToken;
    if (previousDriver === undefined) delete process.env.MC_DB_DRIVER;
    else process.env.MC_DB_DRIVER = previousDriver;
  });

  it("returns the Q6 400 contract and does not query or echo the detail", async () => {
    let calls = 0;
    process.env.DATABASE_URL = FIXTURE_URL;
    process.env.MC_DB_DRIVER = "pg";
    process.env.MC_TOKEN = TOKEN;
    setSqlForTests(async () => {
      calls += 1;
      throw new Error("sql must not run");
    });
    const response = await POST(new Request("https://dashboard.example/api/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: "lane-test",
        kind: "run_complete",
        detail: { secret: "run-ingest-secret", schema: "mc.run.v2" },
      }),
    }));
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["cause", "code", "error", "fix", "retryable"]);
    assert.equal(body.error, "invalid completed-run metadata");
    assert.equal(body.code, "validation_failed");
    assert.equal(body.cause, "The completed-run detail did not match the run schema.");
    assert.equal(body.fix, "Send a completed run with schema mc.run.v2 and the required run fields. The rejected detail was not stored.");
    assert.equal(body.retryable, false);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("run-ingest-secret"), false);
    assert.equal(serialized.includes(TOKEN), false);
  });
});
