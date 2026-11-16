import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { NeonDbError } from "@neondatabase/serverless";
import { setSqlForTests } from "../../src/lib/db";

/**
 * A failing database call in /api/settings/credentials must log enough to
 * diagnose it (the SQLSTATE and the message) and nothing secret (the
 * connection URL, the Neon password, the token, the request body).
 * Prior art: tests/ui/agent-credentials.test.ts (route handlers called with a
 * Request, no dashboard password set) and tests/ui/api-errors.test.ts
 * (console.error captured).
 */

const env = process.env as Record<string, string | undefined>;
const KEYS = ["DATABASE_URL", "NODE_ENV", "MC_DASHBOARD_PASSWORD", "MC_TOKEN"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));

// Synthetic values: no real host, user or password.
const NEON_PASSWORD = "npg_Synth3ticPw42";
const DATABASE_URL = `postgresql://ak_owner:${NEON_PASSWORD}@ep-synthetic-000000.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const BODY_LABEL = "label-from-the-request-body";

const originalError = console.error;
let logged: string[] = [];

after(() => {
  const code = process.exitCode ?? 0;
  setImmediate(() => process.exit(code));
});

beforeEach(() => {
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  env.NODE_ENV = "test";
  env.DATABASE_URL = DATABASE_URL;
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
});

afterEach(() => {
  console.error = originalError;
  setSqlForTests(null);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

function failWith(err: unknown) {
  setSqlForTests(async () => {
    throw err;
  });
}

function assertNoSecrets(line: string) {
  assert.equal(line.includes(NEON_PASSWORD), false, "Neon password logged");
  assert.equal(line.includes("npg_"), false, "npg_ string logged");
  assert.equal(line.includes("postgresql://"), false, "connection URL logged");
  assert.equal(line.includes(DATABASE_URL), false, "DATABASE_URL logged");
  assert.equal(line.includes("akc_"), false, "agent credential logged");
  assert.equal(line.includes("Key (token_hash)"), false, "error detail logged");
}

describe("credentials route database errors", { concurrency: false }, () => {
  it("logs the SQLSTATE and a redacted message when listing fails", async () => {
    const err = new NeonDbError(
      `column "rate_limit_per_minute" does not exist (connecting to ${DATABASE_URL} with password ${NEON_PASSWORD})`,
    );
    err.code = "42703";
    err.detail = "Key (token_hash)=(0123abcd) already exists.";
    failWith(err);

    const { GET } = await import("../../src/app/api/settings/credentials/route");
    const res = await GET(new Request("http://localhost/api/settings/credentials"));

    assert.equal(res.status, 500);
    const listed = await res.json() as Record<string, unknown>;
    assert.equal(listed.error, "Could not list credentials.");
    assert.equal(listed.code, "internal_error");
    assert.equal(listed.retryable, true);
    assert.equal(typeof listed.fix, "string");
    assert.deepEqual(Object.keys(listed).sort(), ["code", "error", "fix", "retryable"]);
    assertNoSecrets(JSON.stringify(listed));
    assert.equal(logged.length, 1);
    const line = logged[0];
    assert.match(line, /^\[settings\/credentials\] list credentials NeonDbError/);
    assert.match(line, /code=42703/);
    assert.match(line, /column \\"rate_limit_per_minute\\" does not exist/);
    assert.match(line, /\[url\]/);
    assert.match(line, /\[redacted\]/);
    assertNoSecrets(line);
  });

  it("logs the wrapped driver code and leaves out the body when creating fails", async () => {
    const timeout = Object.assign(
      new Error("Connect Timeout Error (attempted address: ep-synthetic-000000.us-east-2.aws.neon.tech:443, timeout: 10000ms)"),
      { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    const fetchFailed = new TypeError("fetch failed", { cause: timeout });
    const err = new NeonDbError(`Error connecting to database: ${fetchFailed}`);
    err.sourceError = fetchFailed;
    failWith(err);

    const { POST } = await import("../../src/app/api/settings/credentials/route");
    const res = await POST(
      new Request("http://localhost/api/settings/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: BODY_LABEL, scopes: ["fleet:read"] }),
      }),
    );

    assert.equal(res.status, 500);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "Could not create the credential.");
    assert.equal(body.code, "internal_error");
    assert.equal(body.retryable, true);
    assert.equal(typeof body.fix, "string");
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "fix", "retryable"]);
    assertNoSecrets(JSON.stringify(body));
    assert.equal(logged.length, 1);
    const line = logged[0];
    assert.match(line, /^\[settings\/credentials\] create the credential NeonDbError/);
    assert.match(line, /Error connecting to database/);
    assert.match(line, /caused by TypeError message="fetch failed"/);
    assert.match(line, /caused by ConnectTimeoutError code=UND_ERR_CONNECT_TIMEOUT/);
    assert.equal(line.includes(BODY_LABEL), false, "request body logged");
    assertNoSecrets(line);
  });
});
