import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../../src/app/api/velocity/route";
import { POST } from "../../src/app/api/velocity/ingest/route";
import { authCookieValue } from "../../src/lib/authcrypto";
import { setSqlForTests } from "../../src/lib/db";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { velocityFixture } from "./velocity-fixture";

const keys = ["MC_TOKEN", "MC_DASHBOARD_PASSWORD", "DATABASE_URL", "NODE_ENV"] as const;
let saved: (string | undefined)[];
const env = process.env as Record<string, string | undefined>;
beforeEach(() => { saved = keys.map((k) => env[k]); keys.forEach((k) => delete env[k]); env.NODE_ENV = "test"; resetCredentialsForTests(); });
afterEach(() => { keys.forEach((k, i) => { if (saved[i] === undefined) delete env[k]; else env[k] = saved[i]; }); setSqlForTests(null); resetCredentialsForTests(); });
const url = "https://dashboard.example/api/velocity";
function request(headers: Record<string, string> = {}, body: string = JSON.stringify(velocityFixture())) {
  return new Request(`${url}/ingest`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}
describe("private velocity routes", { concurrency: false }, () => {
  it("refuses anonymous and dev-open readers/writers", async () => {
    assert.equal((await GET(new Request(url))).status, 401);
    assert.equal((await POST(request())).status, 401);
  });
  it("requires same-origin operator writes and denies missing origin", async () => {
    env.MC_DASHBOARD_PASSWORD = "synthetic-test-password";
    const cookie = `mc_auth=${await authCookieValue(env.MC_DASHBOARD_PASSWORD)}`;
    assert.equal((await POST(request({ cookie }))).status, 403);
    assert.equal((await POST(request({ cookie, origin: "https://unrelated.example" }))).status, 403);
    // Auth succeeds, but absent storage must not pretend to save the capture.
    const res = await POST(request({ cookie, origin: "https://dashboard.example" }));
    assert.equal(res.status, 503); assert.match(res.headers.get("cache-control")!, /private, no-store/);
  });
  it("refuses a normal agent even with progress read scope", async () => {
    const issued = await createCredential({ label: "fixture", scopes: ["progress:read"] });
    assert.equal(issued.ok, true); if (!issued.ok) return;
    assert.equal((await GET(new Request(url, { headers: { authorization: `Bearer ${issued.token}` } }))).status, 403);
    assert.equal((await POST(request({ authorization: `Bearer ${issued.token}` }))).status, 403);
  });
  it("bounds actual bytes and rejects malformed or oversized captures before SQL", async () => {
    env.MC_TOKEN = "synthetic-collector";
    const headers = { authorization: "Bearer synthetic-collector" };
    assert.equal((await POST(request(headers, "{"))).status, 400);
    assert.equal((await POST(request(headers, " ".repeat(2 * 1024 * 1024 + 1)))).status, 413);
    const bad = velocityFixture(); bad.repositories[0].ci!.covered++;
    assert.equal((await POST(request(headers, JSON.stringify(bad)))).status, 400);
  });
  it("returns a real receipt for authenticated inserts and a safe storage failure otherwise", async () => {
    env.MC_TOKEN = "synthetic-collector"; env.DATABASE_URL = "postgres://synthetic.invalid/test";
    const headers = { authorization: "Bearer synthetic-collector" };
    let written = false;
    setSqlForTests(async (strings, ...values) => {
      assert.match(strings.join("?"), /^insert into velocity_benchmarks/);
      const stored = JSON.parse(values[8] as string);
      assert.equal(stored.summary.ci.revisions.mean, 3); written = true;
      return [{ id: values[0], recorded_at: "2026-01-04T00:00:00Z" }];
    });
    const response = await POST(request(headers)); assert.equal(response.status, 200); assert.equal(written, true);
    assert.match((await response.json()).id, /^[0-9a-f]{64}$/);
    setSqlForTests(async () => { throw new Error("private database details"); });
    const failed = await POST(request(headers)); assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /private database details/);
  });
});
