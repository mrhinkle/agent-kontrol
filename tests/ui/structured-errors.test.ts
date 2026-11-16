import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { POST as registerConsumer } from "../../src/app/api/events/consumers/route";
import { GET as openStream } from "../../src/app/api/events/stream/route";
import { DELETE as deleteCredentialRoute, GET as listCredentialsRoute, PATCH as patchCredentialRoute, POST as createCredentialRoute } from "../../src/app/api/settings/credentials/route";
import { POST as ingestHistory } from "../../src/app/api/velocity/ingest/route";
import { GET as readHistory } from "../../src/app/api/velocity/route";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row, type SqlTag } from "../../src/lib/db";
import type { Scope } from "../../src/lib/scopes";
import { velocityFixture } from "./velocity-fixture";

const keys = ["MC_TOKEN", "MC_DASHBOARD_PASSWORD", "DATABASE_URL", "NODE_ENV"] as const;
const env = process.env as Record<string, string | undefined>;
let saved: (string | undefined)[];
const originalError = console.error;

beforeEach(() => {
  saved = keys.map((k) => env[k]);
  keys.forEach((k) => delete env[k]);
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  setSqlForTests(null);
  console.error = () => {};
});
afterEach(() => {
  keys.forEach((k, i) => { if (saved[i] === undefined) delete env[k]; else env[k] = saved[i]; });
  setSqlForTests(null);
  resetCredentialsForTests();
  console.error = originalError;
});

function assertEnvelope(body: Record<string, unknown>, expected: { error: string; code: string; retryable: boolean }) {
  assert.equal(body.error, expected.error);
  assert.equal(body.code, expected.code);
  assert.equal(body.retryable, expected.retryable);
  assert.equal(typeof body.fix, "string");
  assert.ok((body.fix as string).length > 0);
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

const credentialUrl = "https://dashboard.example/api/settings/credentials";
function credentialRequest(method: string, body?: string, headers: Record<string, string> = {}) {
  return new Request(credentialUrl, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body });
}

describe("structured errors for the remaining API families", { concurrency: false }, () => {
  it("keeps credential validation, missing records, and dashboard auth in the envelope", async () => {
    const badJson = await createCredentialRoute(credentialRequest("POST", "{"));
    assert.equal(badJson.status, 400);
    assertEnvelope(await jsonBody(badJson), { error: "Request body must be JSON.", code: "invalid_json", retryable: false });

    const missing = await createCredentialRoute(credentialRequest("POST", JSON.stringify({ scopes: ["fleet:read"] })));
    assert.equal(missing.status, 400);
    const missingBody = await jsonBody(missing);
    assertEnvelope(missingBody, { error: "label is required", code: "missing_field", retryable: false });
    assert.deepEqual(missingBody.fields, { label: "label is required" });

    const unknownScope = await createCredentialRoute(credentialRequest("POST", JSON.stringify({ label: "desk", scopes: ["nope"] })));
    assert.equal(unknownScope.status, 400);
    const unknownBody = await jsonBody(unknownScope);
    assertEnvelope(unknownBody, { error: "unknown scope", code: "validation_failed", retryable: false });
    assert.deepEqual(unknownBody.fields, { scopes: "unknown scope" });

    const missingId = await deleteCredentialRoute(credentialRequest("DELETE", "{}"));
    assert.equal(missingId.status, 400);
    const missingIdBody = await jsonBody(missingId);
    assertEnvelope(missingIdBody, { error: "id is required", code: "missing_field", retryable: false });
    assert.deepEqual(missingIdBody.fields, { id: "id is required" });

    const absent = await patchCredentialRoute(credentialRequest("PATCH", JSON.stringify({ id: "missing-credential", rate_limit_per_minute: 5 })));
    assert.equal(absent.status, 404);
    assertEnvelope(await jsonBody(absent), { error: "credential not found", code: "not_found", retryable: false });

    const bearer = await listCredentialsRoute(credentialRequest("GET", undefined, { authorization: "Bearer not-a-session" }));
    assert.equal(bearer.status, 401);
    assertEnvelope(await jsonBody(bearer), { error: "unauthorized", code: "unauthorized", retryable: false });
  });

  it("leaves a successful credential list and one-time token response unchanged", async () => {
    const created = await createCredentialRoute(credentialRequest("POST", JSON.stringify({ label: "desk", scopes: ["fleet:read"] })));
    assert.equal(created.status, 200);
    const createdBody = await jsonBody(created);
    const credential = createdBody.credential as { token?: string };
    assert.match(credential.token ?? "", /^akc_/);
    assert.equal(Object.hasOwn(createdBody, "code"), false);

    const listed = await listCredentialsRoute(credentialRequest("GET"));
    assert.equal(listed.status, 200);
    const listedText = await listed.text();
    const listedBody = JSON.parse(listedText) as { credentials: unknown[] };
    assert.equal(Array.isArray(listedBody.credentials), true);
    assert.equal(listedBody.credentials.length, 1);
    assert.equal(listedText.includes(credential.token ?? "missing-token"), false);
    assert.equal(Object.hasOwn(listedBody, "code"), false);
  });

  it("envelopes stream auth, scope, and configuration failures without starting a stream", async () => {
    const anonymous = await openStream(new Request("https://dashboard.example/api/events/stream"));
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("www-authenticate"), null);
    assert.equal(anonymous.headers.get("content-type")?.includes("text/event-stream"), false);
    const anonymousBody = await jsonBody(anonymous);
    assertEnvelope(anonymousBody, { error: "unauthorized", code: "unauthorized", retryable: false });
    assert.match(String(anonymousBody.fix), /akc_/);

    env.MC_TOKEN = "akc_legacy_stream_token_value";
    const legacy = await openStream(new Request("https://dashboard.example/api/events/stream?consumer=inbox", {
      headers: { authorization: "Bearer akc_legacy_stream_token_value" },
    }));
    assert.equal(legacy.status, 403);
    assertEnvelope(await jsonBody(legacy), { error: "consumer_forbidden", code: "forbidden", retryable: false });
    delete env.MC_TOKEN;

    const narrow = await createCredential({ label: "narrow", scopes: ["fleet:read"] });
    assert.equal(narrow.ok, true);
    if (!narrow.ok) return;
    const denied = await openStream(new Request("https://dashboard.example/api/events/stream?consumer=inbox", {
      headers: { authorization: `Bearer ${narrow.token}` },
    }));
    assert.equal(denied.status, 403);
    const deniedBody = await jsonBody(denied);
    assert.equal(deniedBody.code, "insufficient_scope");
    assert.match(String(deniedBody.error), /events:read/);
    assert.equal(deniedBody.retryable, false);

    const reader = await createCredential({ label: "reader", scopes: ["events:read"] });
    assert.equal(reader.ok, true);
    if (!reader.ok) return;
    const unconfigured = await openStream(new Request("https://dashboard.example/api/events/stream?consumer=inbox", {
      headers: { authorization: `Bearer ${reader.token}` },
    }));
    assert.equal(unconfigured.status, 503);
    assertEnvelope(await jsonBody(unconfigured), { error: "stream_not_configured", code: "setup_required", retryable: false });

    env.MC_TOKEN = "operator-token";
    const consumersDown = await registerConsumer(new Request("https://dashboard.example/api/events/consumers", {
      method: "POST",
      headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(consumersDown.status, 503);
    assertEnvelope(await jsonBody(consumersDown), { error: "stream_not_configured", code: "setup_required", retryable: false });
  });

  it("envelopes consumer registration failures and still returns the consumer on success", async () => {
    env.MC_TOKEN = "operator-token";
    env.DATABASE_URL = "postgres://structured-errors.invalid/test";
    const post = (body: string, headers: Record<string, string> = {}) => registerConsumer(new Request("https://dashboard.example/api/events/consumers", {
      method: "POST",
      headers: { authorization: "Bearer operator-token", "content-type": "application/json", ...headers },
      body,
    }));

    const bad = await post("{");
    assert.equal(bad.status, 400);
    assertEnvelope(await jsonBody(bad), { error: "invalid_json", code: "invalid_json", retryable: false });

    const huge = await post("x".repeat(16_385));
    assert.equal(huge.status, 413);
    assertEnvelope(await jsonBody(huge), { error: "too_large", code: "payload_too_large", retryable: false });

    const empty = await post("{}");
    assert.equal(empty.status, 400);
    assertEnvelope(await jsonBody(empty), { error: "invalid_consumer", code: "validation_failed", retryable: false });

    const registration = {
      id: "inbox",
      credential_id: "cred123",
      repos: ["Example/alpha"],
      event_types: ["push"],
      enabled: true,
    };
    setSqlForTests(async () => []);
    const ineligible = await post(JSON.stringify(registration));
    assert.equal(ineligible.status, 400);
    assertEnvelope(await jsonBody(ineligible), { error: "credential_not_eligible", code: "validation_failed", retryable: false });

    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    setSqlForTests(async () => { throw new Error("password=inbox-secret"); });
    const unavailable = await post(JSON.stringify(registration));
    assert.equal(unavailable.status, 503);
    const unavailableBody = await jsonBody(unavailable);
    assertEnvelope(unavailableBody, { error: "stream_unavailable", code: "internal_error", retryable: true });
    assert.equal(JSON.stringify(unavailableBody).includes("inbox-secret"), false);
    assert.ok(logs.length > 0);
    assert.equal(logs.every((args) => args.every((arg) => typeof arg === "string")), true);
    assert.equal(logs.flat().join(" ").includes("inbox-secret"), false);

    setSqlForTests(async (strings) => {
      const text = strings.join("?");
      if (text.includes("select id from agent_credentials")) return [{ id: "cred123" }];
      return [];
    });
    const savedConsumer = await post(JSON.stringify(registration));
    assert.equal(savedConsumer.status, 200);
    const savedBody = await jsonBody(savedConsumer);
    assert.equal(savedBody.ok, true);
    assert.equal((savedBody.consumer as { id?: string }).id, "inbox");
    assert.equal(Object.hasOwn(savedBody, "code"), false);

    delete env.DATABASE_URL;
    setSqlForTests(null);
    const agent = await createCredential({ label: "agent", scopes: ["events:read"] as Scope[] });
    assert.equal(agent.ok, true);
    if (!agent.ok) return;
    const forbidden = await registerConsumer(new Request("https://dashboard.example/api/events/consumers", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify(registration),
    }));
    assert.equal(forbidden.status, 403);
    const forbiddenBody = await jsonBody(forbidden);
    assert.equal(forbiddenBody.code, "insufficient_scope");
    assert.equal(forbiddenBody.error, "This route is not available to an agent credential.");
    assert.equal(forbiddenBody.retryable, false);
  });

  it("keeps stream cursor failures, store outages, and the event-stream response distinct", async () => {
    const issued = await createCredential({ label: "reader", scopes: ["events:read"] as Scope[] });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const hash = createHash("sha256").update(issued.token).digest("hex");
    env.DATABASE_URL = "postgres://structured-errors.invalid/test";
    const credential: Row = {
      id: issued.credential.id,
      label: "reader",
      token_prefix: issued.token.slice(0, 8),
      token_hash: hash,
      scopes: ["events:read"],
      created_at: "2026-11-15T00:00:00.000Z",
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      rate_limit_per_minute: 60,
      rate_limit_per_day: 10_000,
    };
    const quota: Row = {
      now: "2026-11-15T00:00:00.000Z",
      minute_start: "2026-11-15T00:00:00.000Z",
      day_start: "2026-11-15T00:00:00.000Z",
      revoked: false,
      expired: false,
      rate_limit_per_minute: 60,
      rate_limit_per_day: 10_000,
      minute_used: 0,
      day_used: 0,
      minute_left: 30,
      day_left: 3600,
    };
    const route = (path: string, headers: Record<string, string> = {}) => openStream(new Request(`https://dashboard.example${path}`, {
      headers: { authorization: `Bearer ${issued.token}`, ...headers },
    }));
    const authSql: SqlTag = async (strings) => {
      const text = strings.join("?");
      if (text.includes("token_hash")) return [credential];
      if (text.includes("event_stream_consumers")) return [{ id: "inbox", repos: ["Example/alpha"], event_types: ["push"], generation: "1" }];
      if (text.includes("for update")) return [{ id: credential.id }];
      if (text.includes("rate_limit_per_minute")) return [quota];
      return [];
    };

    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    setSqlForTests(async (strings) => {
      if (strings.join("?").includes("token_hash")) throw new Error("password=inbox-secret");
      return [];
    });
    const store = await route("/api/events/stream?consumer=inbox");
    assert.equal(store.status, 503);
    assert.equal(store.headers.get("www-authenticate"), null);
    const storeBody = await jsonBody(store);
    assertEnvelope(storeBody, { error: "credential_store_unavailable", code: "credential_store_unavailable", retryable: true });
    assert.equal(JSON.stringify(storeBody).includes("inbox-secret"), false);
    assert.equal(logs.flat().join(" ").includes("inbox-secret"), false);

    logs.length = 0;
    setSqlForTests(async (strings) => {
      const text = strings.join("?");
      if (text.includes("event_stream_consumers")) throw new Error("password=inbox-secret");
      return authSql(strings);
    });
    const down = await route("/api/events/stream?consumer=inbox");
    assert.equal(down.status, 503);
    const downBody = await jsonBody(down);
    assertEnvelope(downBody, { error: "stream_unavailable", code: "internal_error", retryable: true });
    assert.equal(JSON.stringify(downBody).includes("inbox-secret"), false);
    assert.equal(down.headers.get("content-type")?.includes("text/event-stream"), false);
    assert.ok(logs.length > 0);
    assert.equal(logs.flat().join(" ").includes("inbox-secret"), false);

    setSqlForTests(authSql);
    const conflict = await route("/api/events/stream?consumer=inbox&since=inbox:1", { "last-event-id": "inbox:2" });
    assert.equal(conflict.status, 400);
    assertEnvelope(await jsonBody(conflict), { error: "cursor_conflict", code: "validation_failed", retryable: false });

    const foreign = await route("/api/events/stream?consumer=inbox&since=other:1");
    assert.equal(foreign.status, 403);
    assertEnvelope(await jsonBody(foreign), { error: "foreign_cursor", code: "forbidden", retryable: false });

    const ac = new AbortController();
    ac.abort();
    const live = await openStream(new Request("https://dashboard.example/api/events/stream?consumer=inbox", {
      headers: { authorization: `Bearer ${issued.token}` },
      signal: ac.signal,
    }));
    assert.equal(live.status, 200);
    assert.match(live.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(live.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(live.headers.get("x-accel-buffering"), "no");
    const frame = await live.text();
    assert.equal(frame.includes("stream_error"), false);
    assert.equal(frame.includes("\"code\""), false);
  });

  it("envelopes velocity validation, absence, forbidden import, and storage failure", async () => {
    env.MC_TOKEN = "synthetic-collector";
    const read = (series?: string) => readHistory(new Request(`https://dashboard.example/api/velocity${series ? `?series=${series}` : ""}`, {
      headers: { authorization: "Bearer synthetic-collector" },
    }));
    const invalid = await read("NOPE");
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers.get("cache-control") ?? "", /private, no-store/);
    assertEnvelope(await jsonBody(invalid), { error: "Invalid benchmark series.", code: "validation_failed", retryable: false });

    const missingStore = await read();
    assert.equal(missingStore.status, 503);
    assert.match(missingStore.headers.get("cache-control") ?? "", /private, no-store/);
    assertEnvelope(await jsonBody(missingStore), {
      error: "Benchmark history storage is not configured.",
      code: "setup_required",
      retryable: false,
    });

    env.DATABASE_URL = "postgres://structured-errors.invalid/test";
    setSqlForTests(async () => []);
    const empty = await read();
    assert.equal(empty.status, 200);
    assert.match(empty.headers.get("cache-control") ?? "", /private, no-store/);
    const emptyBody = await jsonBody(empty);
    assert.deepEqual(emptyBody.series, []);
    assert.equal(emptyBody.selectedKey, null);
    assert.equal(Object.hasOwn(emptyBody, "code"), false);

    const hidden = await read("ab".repeat(32));
    assert.equal(hidden.status, 503);
    const hiddenBody = await jsonBody(hidden);
    assertEnvelope(hiddenBody, {
      error: "Benchmark history is unavailable. The approved history storage must be installed before captures can be saved.",
      code: "setup_required",
      retryable: true,
    });
    assert.equal(JSON.stringify(hiddenBody).includes("Unknown benchmark series"), false);

    env.MC_DASHBOARD_PASSWORD = "synthetic-test-password";
    const cookie = `mc_auth=${await authCookieValue("synthetic-test-password")}`;
    const blocked = await ingestHistory(new Request("https://dashboard.example/api/velocity/ingest", {
      method: "POST",
      headers: { cookie, origin: "https://unrelated.example", "content-type": "application/json" },
      body: JSON.stringify(velocityFixture()),
    }));
    assert.equal(blocked.status, 403);
    assert.match(blocked.headers.get("cache-control") ?? "", /private, no-store/);
    assertEnvelope(await jsonBody(blocked), { error: "Import must come from this dashboard.", code: "forbidden", retryable: false });

    const badCapture = await ingestHistory(new Request("https://dashboard.example/api/velocity/ingest", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-collector", "content-type": "application/json" },
      body: "{",
    }));
    assert.equal(badCapture.status, 400);
    assert.match(badCapture.headers.get("cache-control") ?? "", /private, no-store/);
    const badCaptureBody = await jsonBody(badCapture);
    assert.equal(badCaptureBody.code, "invalid_json");
    assert.equal(badCaptureBody.error, "invalid JSON");
    assert.equal(badCaptureBody.retryable, false);

    const logs: unknown[][] = [];
    console.error = (...args: unknown[]) => { logs.push(args); };
    setSqlForTests(async () => { throw new Error("password=inbox-secret"); });
    const failed = await ingestHistory(new Request("https://dashboard.example/api/velocity/ingest", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-collector", "content-type": "application/json" },
      body: JSON.stringify(velocityFixture()),
    }));
    assert.equal(failed.status, 503);
    assert.match(failed.headers.get("cache-control") ?? "", /private, no-store/);
    const failedBody = await jsonBody(failed);
    assertEnvelope(failedBody, {
      error: "The capture could not be saved. Retry the same file after history storage is available; identical imports are safe to repeat.",
      code: "internal_error",
      retryable: true,
    });
    assert.equal(JSON.stringify(failedBody).includes("inbox-secret"), false);
    assert.equal(logs.flat().join(" ").includes("inbox-secret"), false);
    assert.equal(logs.every((args) => args.every((arg) => typeof arg === "string")), true);
  });
});
