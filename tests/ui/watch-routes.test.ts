import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { enforceApi } from "../../src/lib/auth";
import { authCookieValue, signAccessToken } from "../../src/lib/authcrypto";
import {
  createCredential,
  plantCredentialForTests,
  resetCredentialsForTests,
} from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { openApiDocument } from "../../src/lib/openapi";
import { SCOPES, scopeForRoute } from "../../src/lib/scopes";
import { isJsonContentType } from "../../src/app/api/watch/access";
import { POST } from "../../src/app/api/watch/beat/route";
import { GET } from "../../src/app/api/watch/beats/route";
import { loadWatchSourceBindings } from "../../src/lib/watch-sources";

/**
 * Failure cases for mrhinkle/agent-kontrol#82. A rejected call must not insert.
 * age_s on the GET body is the value readBeats returned, not a clock computed
 * from beat_at.
 */

const env = process.env as Record<string, string | undefined>;
const KEYS = [
  "MC_DASHBOARD_PASSWORD",
  "MC_TOKEN",
  "DATABASE_URL",
  "NODE_ENV",
  "MC_COOKIE_SECRET",
  "MC_OAUTH_SECRET",
  "WATCH_SOURCE_CREDENTIAL_IDS_JSON",
] as const;
const saved: Record<string, string | undefined> = {};

const BEAT = {
  source: "mini",
  status: "ok",
  detail: "scheduler healthy",
  beat_at: "2026-10-27T12:34:56Z",
};

type Query = { text: string; values: unknown[] };
let queries: Query[] = [];
let readRows: Row[] = [];

function beatWrites(): Query[] {
  return queries.filter((query) => query.text.includes("insert into watch_beats"));
}

function assertNothingWritten() {
  assert.equal(beatWrites().length, 0);
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = env[key];
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  delete env.MC_OAUTH_SECRET;
  delete env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
  env.NODE_ENV = "test";
  env.MC_COOKIE_SECRET = "watch-test-cookie";
  resetCredentialsForTests();
  queries = [];
  readRows = [];
  setSqlForTests(async (strings, ...values) => {
    const text = strings.join(" ");
    queries.push({ text, values });
    if (text.includes("from watch_beats")) return readRows;
    return [];
  });
});

afterEach(() => {
  setSqlForTests(null);
  resetCredentialsForTests();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

async function issue(scopes: string[]) {
  const made = await createCredential({ label: "watch lane", scopes });
  if (!made.ok) throw new Error(made.error);
  return made;
}

function bind(map: Record<string, string[]>) {
  env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = JSON.stringify(map);
}

function post(token: string | null, body: unknown, extra: Record<string, string> = {}, raw?: BodyInit) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return POST(new Request("http://localhost/api/watch/beat", {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
  }));
}

function get(token: string | null, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return GET(new Request("http://localhost/api/watch/beats", { headers }));
}

describe("watch routes", () => {
  it("maps the two routes onto watch:write and watch:read", () => {
    assert.equal(scopeForRoute("POST", "/api/watch/beat"), "watch:write");
    assert.equal(scopeForRoute("GET", "/api/watch/beats"), "watch:read");
    assert.equal(scopeForRoute("GET", "/api/watch/beat"), null);
    assert.equal(scopeForRoute("POST", "/api/watch/beats"), null);
    assert.equal(scopeForRoute("POST", "/api/watch/beat/extra"), null);
    assert.ok(SCOPES.includes("watch:read"));
    assert.ok(SCOPES.includes("watch:write"));
  });

  it("F1 dev-open is 401 on both routes while fleet stays open", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "test";
    assert.equal(await enforceApi(new Request("http://localhost/api/fleet")), null);
    assert.equal((await post(null, BEAT)).status, 401);
    assert.equal((await get(null)).status, 401);
    assertNothingWritten();
  });

  it("F1 MC_TOKEN is 401 on both routes and still opens fleet", async () => {
    env.MC_TOKEN = "legacy-token";
    const headers = { authorization: "Bearer legacy-token" };
    assert.equal(await enforceApi(new Request("http://localhost/api/fleet", { headers })), null);
    assert.equal((await post(null, BEAT, headers)).status, 401);
    assert.equal((await get(null, headers)).status, 401);
    assertNothingWritten();
  });

  it("F1 dashboard session is 401 on both routes and still opens fleet", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    const cookie = await authCookieValue("pw");
    const headers = { cookie: `mc_auth=${cookie}` };
    assert.equal(await enforceApi(new Request("http://localhost/api/fleet", { headers })), null);
    assert.equal((await post(null, BEAT, headers)).status, 401);
    assert.equal((await get(null, headers)).status, 401);
    assertNothingWritten();
  });

  it("F1 OAuth JWT is 401 on both routes and is dev-open on fleet", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "test";
    env.MC_OAUTH_SECRET = "oauth-test-secret";
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
    assert.ok(jwt.startsWith("eyJ"));
    const headers = { authorization: `Bearer ${jwt}` };
    assert.equal(await enforceApi(new Request("http://localhost/api/fleet", { headers })), null);
    assert.equal((await post(null, BEAT, headers)).status, 401);
    assert.equal((await get(null, headers)).status, 401);
    assertNothingWritten();
  });

  it("F2 watch:read cannot POST and watch:write cannot GET", async () => {
    const reader = await issue(["watch:read"]);
    const writer = await issue(["watch:write"]);
    bind({ mini: [reader.credential.id, writer.credential.id] });
    const deniedPost = await post(reader.token, BEAT);
    assert.equal(deniedPost.status, 403);
    const postBody = await deniedPost.json();
    assert.equal(postBody.code, "insufficient_scope");
    assert.match(postBody.fix, /watch:write/);
    const deniedGet = await get(writer.token);
    assert.equal(deniedGet.status, 403);
    const getBody = await deniedGet.json();
    assert.equal(getBody.code, "insufficient_scope");
    assert.match(getBody.fix, /watch:read/);
    assertNothingWritten();
  });

  it("F3 expired and revoked credentials are 401 on both routes", async () => {
    plantCredentialForTests({
      token: "akc_expired_watch_token_value_xxxx",
      scopes: ["watch:write", "watch:read"],
      expires_at: "2000-01-01T00:00:00.000Z",
    });
    plantCredentialForTests({
      token: "akc_revoked_watch_token_value_xxxx",
      scopes: ["watch:write", "watch:read"],
      revoked_at: "2020-01-01T00:00:00.000Z",
    });
    for (const token of ["akc_expired_watch_token_value_xxxx", "akc_revoked_watch_token_value_xxxx"]) {
      assert.equal((await post(token, BEAT)).status, 401);
      assert.equal((await get(token)).status, 401);
    }
    assertNothingWritten();
  });

  it("F4 credential store unavailable is 503 and does not insert", async () => {
    env.DATABASE_URL = "postgres://localhost/watch-unavailable";
    let inserts = 0;
    setSqlForTests(async (strings) => {
      if (strings.join(" ").includes("insert into watch_beats")) inserts += 1;
      throw new Error("db down");
    });
    const res = await post("akc_not_a_stored_credential_value", BEAT);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "credential_store_unavailable" });
    assert.equal(inserts, 0);
  });

  it("F5 a Mini credential cannot write macbook or watcher, including with a dashboard cookie", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    const cookie = await authCookieValue("pw");
    const mini = await issue(["watch:write", "watch:read"]);
    const mac = await issue(["watch:write"]);
    const watcher = await issue(["watch:write"]);
    bind({
      mini: [mini.credential.id],
      macbook: [mac.credential.id],
      watcher: [watcher.credential.id],
    });
    const headers = { cookie: `mc_auth=${cookie}` };
    for (const source of ["macbook", "watcher"]) {
      const res = await post(mini.token, { ...BEAT, source }, headers);
      assert.equal(res.status, 403, source);
      const body = await res.json();
      assert.match(body.error, /not bound/);
      assertNothingWritten();
    }
    const allowed = await post(mini.token, BEAT, headers);
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { ok: true });
    assert.equal(beatWrites().length, 1);
    assert.equal(beatWrites()[0].values[0], "mini");
  });

  it("F6 missing or invalid source binding is 503 and writes nothing", async () => {
    const mini = await issue(["watch:write"]);
    const id = "00000000-0000-4000-8000-000000000001";
    const other = "00000000-0000-4000-8000-000000000002";
    const cases: Array<string | undefined> = [
      undefined,
      "",
      "   ",
      "{",
      "null",
      "[]",
      `"${id}"`,
      JSON.stringify({ laptop: [id] }),
      "{}",
      JSON.stringify({ mini: [] }),
      JSON.stringify({ mini: [], macbook: [] }),
      JSON.stringify({ mini: "not-an-array" }),
      JSON.stringify({ mini: ["not-a-uuid"] }),
      JSON.stringify({ mini: [id, id] }),
      JSON.stringify({ mini: [id], macbook: [id] }),
      JSON.stringify({ mini: [id], macbook: [id.toUpperCase()] }),
      JSON.stringify({ mini: [123] }),
      JSON.stringify({ "": [id] }),
    ];
    for (const raw of cases) {
      queries = [];
      if (typeof raw === "string") {
        assert.equal(loadWatchSourceBindings(raw).ok, false, JSON.stringify(raw));
      }
      if (raw === undefined) delete env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
      else env.WATCH_SOURCE_CREDENTIAL_IDS_JSON = raw;
      const res = await post(mini.token, BEAT);
      assert.equal(res.status, 503, JSON.stringify(raw));
      const body = await res.json();
      assert.match(body.error, /not configured/);
      assertNothingWritten();
    }
    bind({ mini: [mini.credential.id], macbook: [other] });
    const ok = await post(mini.token, BEAT);
    assert.equal(ok.status, 200);
  });

  it("F7 rejects the body before any write", async () => {
    const mini = await issue(["watch:write"]);
    bind({ mini: [mini.credential.id] });

    assert.equal(isJsonContentType(null), false);
    assert.equal(isJsonContentType(""), false);
    assert.equal(isJsonContentType("   "), false);
    assert.equal(isJsonContentType("application/json, text/plain"), false);
    assert.equal(isJsonContentType("application/json+x"), false);
    assert.equal(isJsonContentType("application/jsonx"), false);
    assert.equal(isJsonContentType("text/json"), false);
    assert.equal(isJsonContentType("application/json"), true);
    assert.equal(isJsonContentType("Application/JSON; charset=UTF-8"), true);
    assert.equal(isJsonContentType(" application/json ; charset=utf-8 "), true);

    const wrongType = await post(mini.token, BEAT, { "content-type": "text/plain" });
    assert.equal(wrongType.status, 415);
    assertNothingWritten();
    queries = [];
    const missingType = await POST(new Request("http://localhost/api/watch/beat", {
      method: "POST",
      headers: { authorization: `Bearer ${mini.token}` },
      body: JSON.stringify(BEAT),
    }));
    assert.equal(missingType.status, 415);
    assertNothingWritten();
    for (const contentType of [
      "application/json, text/plain",
      "application/json+x",
      "application/jsonx",
      "text/json",
      "",
      "   ",
    ]) {
      queries = [];
      const rejected = await post(mini.token, BEAT, { "content-type": contentType });
      assert.equal(rejected.status, 415, JSON.stringify(contentType));
      assertNothingWritten();
    }

    const nineKib = Buffer.alloc(9 * 1024, 0x78);
    assert.equal((await post(mini.token, null, {}, nineKib)).status, 413);
    assert.equal((await post(mini.token, null, {}, Buffer.alloc(8193, 0x78))).status, 413);
    const atLimit = await post(mini.token, null, {}, Buffer.alloc(8192, 0x78));
    assert.notEqual(atLimit.status, 413);
    assert.equal(atLimit.status, 400);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(9 * 1024)));
        controller.close();
      },
    });
    const lied = await POST(new Request("http://localhost/api/watch/beat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mini.token}`,
        "content-type": "application/json",
        "content-length": "1",
      },
      body: stream,
      duplex: "half",
    } as RequestInit));
    assert.equal(lied.status, 413);
    assert.notEqual(lied.headers.get("content-length"), "1");

    const malformed: unknown[] = [
      null,
      [],
      "mini",
      1,
      { ...BEAT, source: "Mini" },
      { ...BEAT, source: "" },
      { ...BEAT, source: 1 },
      { status: "ok", detail: "x", beat_at: BEAT.beat_at },
      { ...BEAT, status: "OK" },
      { ...BEAT, status: "fine" },
      { source: "mini", status: "ok", beat_at: BEAT.beat_at },
      { ...BEAT, detail: null },
      { ...BEAT, detail: "😀".repeat(501) },
      { ...BEAT, beat_at: "2026-10-27T12:00:00" },
      { ...BEAT, beat_at: "2026-02-31T00:00:00Z" },
      { ...BEAT, beat_at: "2026-10-27T12:00:00+0000" },
      { ...BEAT, beat_at: 0 },
      { ...BEAT, beat_at: null },
      { source: "mini", status: "ok", detail: "x" },
      { ...BEAT, received_at: "2026-10-27T12:34:56Z" },
      { ...BEAT, age_s: 0 },
      { ...BEAT, age_s: null },
      { ...BEAT, note: "extra" },
    ];
    for (const payload of malformed) {
      queries = [];
      const res = await post(mini.token, payload);
      assert.equal(res.status, 400, JSON.stringify(payload));
      assertNothingWritten();
    }
    const junk = await post(mini.token, null, {}, "{");
    assert.equal(junk.status, 400);
    assertNothingWritten();

    const typed = await post(mini.token, BEAT, { "content-type": "application/json; charset=utf-8" });
    assert.equal(typed.status, 200);
    const mixedCase = await post(mini.token, BEAT, { "content-type": "Application/JSON; charset=UTF-8" });
    assert.equal(mixedCase.status, 200);
    const wide = await post(mini.token, { ...BEAT, detail: "😀".repeat(500) });
    assert.equal(wide.status, 200);
  });

  it("F8 old and future beat_at are stored and age_s still comes from the read", async () => {
    const mini = await issue(["watch:write", "watch:read"]);
    bind({ mini: [mini.credential.id] });
    const oldBeat = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const futureBeat = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    for (const beatAt of [oldBeat, futureBeat]) {
      queries = [];
      const res = await post(mini.token, { ...BEAT, beat_at: beatAt });
      assert.equal(res.status, 200, beatAt);
      assert.ok(beatWrites().some((query) => query.values.includes(beatAt)));
    }
    readRows = [{
      source: "mini",
      status: "ok",
      detail: "scheduler healthy",
      beat_at: oldBeat,
      received_at: new Date().toISOString(),
      age_s: 4,
    }];
    const listed = await get(mini.token);
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    const body = await listed.json();
    assert.equal(body.beats.length, 1);
    assert.equal(body.beats[0].age_s, 4);
    assert.equal(body.beats[0].beat_at, new Date(oldBeat).toISOString());
    assert.equal("demo" in body, false);
  });

  it("F9 GET is 503 when the database is absent or the query fails, and 200 when the table is empty", async () => {
    const reader = await issue(["watch:read"]);
    setSqlForTests(null);
    delete env.DATABASE_URL;
    const absent = await get(reader.token);
    assert.equal(absent.status, 503);
    const absentBody = await absent.json();
    assert.equal(absentBody.beats, undefined);
    assert.equal(absentBody.demo, undefined);
    assert.equal(absent.headers.get("cache-control"), "no-store");

    setSqlForTests(async () => {
      throw new Error("db down");
    });
    const down = await get(reader.token);
    assert.equal(down.status, 503);
    assert.equal((await down.json()).beats, undefined);

    setSqlForTests(async () => []);
    delete env.WATCH_SOURCE_CREDENTIAL_IDS_JSON;
    const empty = await get(reader.token);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { beats: [] });
    assert.equal(empty.headers.get("cache-control"), "no-store");
  });

  it("F11 the OpenAPI document lists both watch routes and not the other method", () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, unknown>> };
    assert.ok(doc.paths["/api/watch/beat"].post);
    assert.equal(doc.paths["/api/watch/beat"].get, undefined);
    assert.ok(doc.paths["/api/watch/beats"].get);
    assert.equal(doc.paths["/api/watch/beats"].post, undefined);
  });
});
