import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkQueueObservation } from "../../src/lib/sweep-evidence";
import { GET } from "../../src/app/api/sweep/queues/route";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row, type SqlTag } from "../../src/lib/db";
import { openApiDocument } from "../../src/lib/openapi";
import { scopeForRoute } from "../../src/lib/scopes";

/**
 * The pr_review ready queue (#176): the sweep.queue validator's ready_items
 * rules. Every pr_review observation carries the ready PRs' heads; a reader
 * never derives a head from a PR number.
 */

const H = (c: string) => c.repeat(40);

function prReview(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "collector",
    queue: "reviews:acme/widgets",
    classification: "pr_review",
    repo: "acme/widgets",
    seq: 1,
    observed_at: "2026-11-23T12:00:00Z",
    complete: true,
    ready: { count: 2, refs: ["#7", "#12"] },
    raw: { count: 3, refs: ["#7", "#9", "#12"] },
    ready_items: [{ number: 7, head_sha: H("a") }, { number: 12, head_sha: H("b") }],
    stale_after_minutes: 30,
    ...over,
  };
}

describe("sweep.queue ready_items (#176)", () => {
  it("accepts a complete pr_review observation and keeps the heads", () => {
    const checked = checkQueueObservation(prReview());
    assert.equal(checked.ok, true, JSON.stringify(checked));
    if (!checked.ok) return;
    assert.deepEqual(checked.value.ready_items, [{ number: 7, head_sha: H("a") }, { number: 12, head_sha: H("b") }]);
    assert.deepEqual(checked.value.ready_refs, ["#7", "#12"]);
  });

  it("accepts a 64-hex head and an empty ready set", () => {
    assert.equal(checkQueueObservation(prReview({ ready: { count: 1, refs: ["#7"] }, ready_items: [{ number: 7, head_sha: "c".repeat(64) }] })).ok, true);
    const empty = checkQueueObservation(prReview({ ready: { count: 0, refs: [] }, ready_items: [] }));
    assert.equal(empty.ok, true);
    if (empty.ok) assert.deepEqual(empty.value.ready_items, []);
  });

  it("requires ready_items on every new pr_review observation, [] when incomplete", () => {
    const missing = checkQueueObservation(prReview({ ready_items: undefined }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.fields["observation.ready_items"] ?? "", /required/);
    assert.equal(checkQueueObservation(prReview({ ready_items: null })).ok, false);

    const incomplete = { complete: false, error: "GitHub rate limited", ready: undefined, raw: undefined };
    const noItems = checkQueueObservation(prReview({ ...incomplete, ready_items: undefined }));
    assert.equal(noItems.ok, false, "an incomplete pr_review observation still states ready_items");
    const withEmpty = checkQueueObservation(prReview({ ...incomplete, ready_items: [] }));
    assert.equal(withEmpty.ok, true);
    if (withEmpty.ok) {
      assert.equal(withEmpty.value.ready_count, null, "incomplete is unknown, never zero");
      assert.deepEqual(withEmpty.value.ready_items, []);
    }
    const withHeads = checkQueueObservation(prReview({ ...incomplete }));
    assert.equal(withHeads.ok, false, "an incomplete observation cannot carry ready heads");
  });

  it("rejects ready_items on issue_dispatch, and issue_dispatch stays valid without it", () => {
    const issue = { classification: "issue_dispatch", queue: "issues:acme/widgets", ready: { count: 1, refs: ["#1"] }, raw: { count: 0, refs: [] } };
    const legacy = checkQueueObservation(prReview({ ...issue, ready_items: undefined }));
    assert.equal(legacy.ok, true);
    if (legacy.ok) assert.equal(legacy.value.ready_items, null);
    for (const items of [[], [{ number: 1, head_sha: H("a") }], null]) {
      const bad = checkQueueObservation(prReview({ ...issue, ready_items: items }));
      assert.equal(bad.ok, false, JSON.stringify(items));
      if (!bad.ok) assert.match(bad.fields["observation.ready_items"] ?? "", /only valid on a pr_review/);
    }
  });

  it("rejects items that do not match ready.refs exactly", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["fewer items than refs", { ready_items: [{ number: 7, head_sha: H("a") }] }],
      ["more items than refs", { ready_items: [{ number: 7, head_sha: H("a") }, { number: 12, head_sha: H("b") }, { number: 13, head_sha: H("c") }] }],
      ["wrong order", { ready_items: [{ number: 12, head_sha: H("b") }, { number: 7, head_sha: H("a") }] }],
      ["different number", { ready_items: [{ number: 7, head_sha: H("a") }, { number: 11, head_sha: H("b") }] }],
      ["refs not numeric order", { ready: { count: 2, refs: ["#12", "#7"] }, ready_items: [{ number: 12, head_sha: H("b") }, { number: 7, head_sha: H("a") }] }],
      ["duplicate ref", { ready: { count: 2, refs: ["#7", "#7"] }, ready_items: [{ number: 7, head_sha: H("a") }, { number: 7, head_sha: H("a") }] }],
      ["ref not #<n>", { ready: { count: 1, refs: ["owner/name#7"] }, ready_items: [{ number: 7, head_sha: H("a") }] }],
      ["leading zero ref", { ready: { count: 1, refs: ["#07"] }, ready_items: [{ number: 7, head_sha: H("a") }] }],
      ["uppercase head", { ready_items: [{ number: 7, head_sha: "A".repeat(40) }, { number: 12, head_sha: H("b") }] }],
      ["short head", { ready_items: [{ number: 7, head_sha: "a".repeat(39) }, { number: 12, head_sha: H("b") }] }],
      ["missing head", { ready_items: [{ number: 7 }, { number: 12, head_sha: H("b") }] }],
      ["unknown item field", { ready_items: [{ number: 7, head_sha: H("a"), green_since: null }, { number: 12, head_sha: H("b") }] }],
      ["string number", { ready_items: [{ number: "7", head_sha: H("a") }, { number: 12, head_sha: H("b") }] }],
      ["zero number", { ready: { count: 1, refs: ["#0"] }, ready_items: [{ number: 0, head_sha: H("a") }] }],
      ["not an array", { ready_items: { number: 7, head_sha: H("a") } }],
      ["item not an object", { ready_items: ["#7", "#12"] }],
      ["over 50", { ready: { count: 51, refs: Array.from({ length: 50 }, (_, i) => `#${i + 1}`) }, ready_items: Array.from({ length: 51 }, (_, i) => ({ number: i + 1, head_sha: H("a") })) }],
    ];
    for (const [label, over] of cases) {
      const checked = checkQueueObservation(prReview(over));
      assert.equal(checked.ok, false, label);
    }
  });
});

// ------------------------------------------------------------- the route

const env = process.env as Record<string, string | undefined>;
const saved = { db: env.DATABASE_URL, token: env.MC_TOKEN, node: env.NODE_ENV, password: env.MC_DASHBOARD_PASSWORD };
const TOKEN = "sweep-queues-test-token";
const PASSWORD = "sweep-queues-test-password";
const URL_OK = "http://localhost/api/sweep/queues?classification=pr_review";
export const FIXTURE = path.join(__dirname, "fixtures", "sweep-queues-pr_review.json");

/** The four kinds of projection row the route can see, as node-postgres returns them. */
const DB_NOW = "2026-11-23T12:00:00.000000Z";
const ROWS: Row[] = [
  {
    queue: "reviews:acme/gadgets", repo: "acme/gadgets", complete: false, error: "GitHub rate limited",
    observed_at: new Date("2026-11-23T11:50:00Z"), received_at: new Date("2026-11-23T11:50:02.123456Z"), stale_after_minutes: 30,
    ready_count: null, raw_count: null, ready_refs: [], age_minutes: 9, stale: false, ready_items: [],
  },
  {
    queue: "reviews:acme/legacy", repo: "acme/legacy", complete: true, error: null,
    observed_at: new Date("2026-11-23T11:55:00Z"), received_at: new Date("2026-11-23T11:55:01Z"), stale_after_minutes: 30,
    ready_count: 1, raw_count: 2, ready_refs: ["#4"], age_minutes: 4, stale: false, ready_items: null,
  },
  {
    queue: "reviews:acme/stale", repo: "acme/stale", complete: true, error: null,
    observed_at: new Date("2026-11-23T11:00:00Z"), received_at: new Date("2026-11-23T11:00:05Z"), stale_after_minutes: 30,
    ready_count: 1, raw_count: 1, ready_refs: ["#2"], age_minutes: 59, stale: true,
    ready_items: [{ number: 2, head_sha: "b".repeat(40), green_since: null }],
  },
  {
    queue: "reviews:acme/widgets", repo: "Acme/Widgets", complete: true, error: null,
    observed_at: new Date("2026-11-23T11:58:00Z"), received_at: new Date("2026-11-23T11:58:01.5Z"), stale_after_minutes: 30,
    ready_count: 2, raw_count: 5, ready_refs: ["#7", "#12"], age_minutes: 1, stale: false,
    ready_items: [
      { number: 7, head_sha: "a".repeat(40), green_since: "2026-11-23T10:00:00.000000Z" },
      { number: 12, head_sha: "c".repeat(64), green_since: null },
    ],
  },
];

let queries: string[] = [];
function mockDb(rows: Row[] = ROWS): void {
  queries = [];
  const tag: SqlTag = async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    if (text.includes("clock_timestamp()")) return [{ now: DB_NOW }];
    if (text.includes("from sweep_queues q")) return rows;
    throw new Error(`unexpected query: ${text.slice(0, 80)}`);
  };
  setSqlForTests(tag);
  env.DATABASE_URL = "postgres://mock.invalid/db";
}

async function call(url = URL_OK, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const res = await GET(new Request(url, { headers }));
  return { status: res.status, body: await res.json() as Record<string, any>, headers: res.headers };
}

describe("GET /api/sweep/queues (#176)", () => {
  beforeEach(() => {
    delete env.DATABASE_URL;
    delete env.MC_DASHBOARD_PASSWORD;
    env.MC_TOKEN = TOKEN;
    env.NODE_ENV = "test";
    resetCredentialsForTests();
    setSqlForTests(null);
  });
  afterEach(() => {
    setSqlForTests(null);
    for (const [key, value] of [["DATABASE_URL", saved.db], ["MC_TOKEN", saved.token], ["NODE_ENV", saved.node], ["MC_DASHBOARD_PASSWORD", saved.password]] as const) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });

  it("returns one row per projection row, sorted, nulls on unmeasured rows, and matches the recorded fixture", async () => {
    mockDb([...ROWS].reverse());
    const res = await call();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers.get("cache-control"), "no-store");
    const { queues } = res.body;
    assert.deepEqual(Object.keys(res.body), ["queues"]);
    // The SQL orders by queue; the mock returned rows reversed, and the route keeps the database order.
    assert.deepEqual(queues.map((q: Record<string, unknown>) => q.queue), [...ROWS].reverse().map((r) => r.queue));
    mockDb();
    const { body } = await call();
    const byQueue = new Map<string, Record<string, any>>(body.queues.map((q: Record<string, any>) => [q.queue, q]));

    const complete = byQueue.get("reviews:acme/widgets")!;
    assert.deepEqual(complete, {
      queue: "reviews:acme/widgets", repo: "Acme/Widgets", observed_at: "2026-11-23T11:58:00.000Z", received_at: "2026-11-23T11:58:01.500Z",
      stale: false, age_minutes: 1, stale_after_minutes: 30, complete: true, error: null,
      ready: { count: 2, refs: ["#7", "#12"] }, raw: { count: 5 },
      ready_items: [
        { number: 7, head_sha: "a".repeat(40), green_since: "2026-11-23T10:00:00.000Z" },
        { number: 12, head_sha: "c".repeat(64), green_since: null },
      ],
    });
    const incomplete = byQueue.get("reviews:acme/gadgets")!;
    assert.deepEqual([incomplete.complete, incomplete.error, incomplete.ready, incomplete.raw, incomplete.ready_items], [false, "GitHub rate limited", null, null, null],
      "incomplete is null, never ready.count 0");
    const stale = byQueue.get("reviews:acme/stale")!;
    assert.deepEqual([stale.complete, stale.stale, stale.error, stale.age_minutes, stale.ready, stale.raw, stale.ready_items], [true, true, "stale observation", 59, null, null, null]);
    const legacy = byQueue.get("reviews:acme/legacy")!;
    assert.deepEqual([legacy.complete, legacy.error, legacy.ready, legacy.raw, legacy.ready_items], [false, "missing ready_items", null, null, null]);

    // Read-only: only the clock and the projection select.
    assert.equal(queries.length, 2);
    for (const q of queries) assert.doesNotMatch(q, /\b(insert|update|delete)\b/i);
    const select = queries.find((q) => q.includes("from sweep_queues q"))!;
    assert.match(select, /where q\.classification = 'pr_review'/);
    assert.match(select, /order by q\.queue/);
    assert.doesNotMatch(select, /sweep_observations/, "historical observations are never selected");
    assert.match(select, /p\.head_sha = e\.item->>'head_sha'/, "green_since only from a row at the ready head");
    assert.match(select, /and p\.open/);

    // The recorded response shape Part 2 tests against (AC 74). Re-record with AK_RECORD_FIXTURES=1.
    if (env.AK_RECORD_FIXTURES === "1") {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, JSON.stringify(body, null, 2) + "\n");
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(FIXTURE, "utf8")), body, "the recorded fixture is the route's response");
  });

  it("treats malformed stored items as unmeasured", async () => {
    const base = ROWS[3];
    const cases: [string, Row][] = [
      ["items do not match refs", { ...base, ready_refs: ["#7", "#13"] }],
      ["bad head", { ...base, ready_items: [{ number: 7, head_sha: "XYZ", green_since: null }, base.ready_items[1]] }],
      ["string number", { ...base, ready_items: [{ number: "7", head_sha: "a".repeat(40), green_since: null }, base.ready_items[1]] }],
      ["null ready count", { ...base, ready_count: null }],
    ];
    for (const [label, row] of cases) {
      mockDb([row]);
      const { body } = await call();
      assert.deepEqual([body.queues[0].complete, body.queues[0].error, body.queues[0].ready, body.queues[0].ready_items], [false, "malformed ready_items", null, null], label);
    }
  });

  it("accepts only classification=pr_review, exact bytes", async () => {
    mockDb();
    for (const q of ["", "?", "?classification=", "?classification", "?classification=issue_dispatch", "?classification=PR_REVIEW",
      "?classification=pr_review&classification=pr_review", "?classification[]=pr_review", "?classification%5B%5D=pr_review",
      "?classification=%20pr_review", "?classification=pr_review%20", "?classification=pr_review+", "?classification=pr%5Freview",
      "?classification=pr_review&x=1", "?x=1&classification=pr_review", "?Classification=pr_review"]) {
      const res = await call(`http://localhost/api/sweep/queues${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.code, "validation_failed", q);
      assert.equal(res.body.fields.classification, "classification must be pr_review.", q);
      assert.equal("queues" in res.body, false);
    }
    assert.equal(queries.length, 0, "a bad query runs no SQL");
  });

  it("is 503 without a database, never an empty list", async () => {
    const res = await call();
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "setup_required");
    assert.equal("queues" in res.body, false);
  });

  it("allows MC_TOKEN, the session cookie, and progress:read; refuses everything else", async () => {
    // Credentials are created in memory, before DATABASE_URL points at the mock.
    const reader = await createCredential({ label: "queue reader", scopes: ["progress:read"] });
    const writer = await createCredential({ label: "status only", scopes: ["status:write", "tasks:read"] });
    assert.ok(reader.ok && writer.ok);
    if (!reader.ok || !writer.ok) return;
    env.MC_DASHBOARD_PASSWORD = PASSWORD;

    // An agent credential is checked before the query and the database: progress:read gets through
    // (503 here, because the credential store is in memory only while DATABASE_URL is unset).
    let res = await call(URL_OK, { authorization: `Bearer ${reader.token}` });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    res = await call("http://localhost/api/sweep/queues?classification=x", { authorization: `Bearer ${reader.token}` });
    assert.equal(res.status, 400, "past auth, the query is checked");
    res = await call(URL_OK, { authorization: `Bearer ${writer.token}` });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "insufficient_scope");
    assert.match(res.body.fix, /progress:read/);
    assert.equal(JSON.stringify(res.body).includes(writer.token), false);
    res = await call(URL_OK, { authorization: "Bearer akc_not-a-real-token" });
    assert.equal(res.status, 401, "unknown agent credential");

    mockDb();
    assert.equal((await call(URL_OK, { authorization: `Bearer ${TOKEN}` })).status, 200, "MC_TOKEN");
    const cookie = await authCookieValue(PASSWORD);
    const session = await call(URL_OK, { cookie: `mc_auth=${cookie}` });
    assert.equal(session.status, 200, "session cookie");
    assert.equal(session.body.queues.length, ROWS.length);
    for (const [label, headers] of [
      ["no credential", {}],
      ["wrong bearer", { authorization: "Bearer nope" }],
      ["wrong cookie", { cookie: "mc_auth=nope" }],
    ] as [string, Record<string, string>][]) {
      const denied = await call(URL_OK, headers);
      assert.equal(denied.status, 401, label);
      assert.equal("queues" in denied.body, false, label);
    }
    assert.equal(scopeForRoute("GET", "/api/sweep/queues"), "progress:read");
    assert.equal(scopeForRoute("POST", "/api/sweep/queues"), null);
    assert.equal(scopeForRoute("GET", "/api/sweep"), "progress:read");
  });

  it("is documented in OpenAPI and docs/API.md, and never reads producer config", () => {
    const doc = openApiDocument() as Record<string, any>;
    const op = doc.paths["/api/sweep/queues"]?.get;
    assert.ok(op, "OpenAPI has GET /api/sweep/queues");
    assert.deepEqual(Object.keys(doc.paths["/api/sweep/queues"]), ["get"]);
    assert.equal(op.operationId, "getSweepQueues");
    assert.deepEqual(op.parameters, [{ name: "classification", in: "query", required: true, schema: { type: "string", enum: ["pr_review"] } }]);
    for (const code of ["200", "400", "401", "403", "500", "503"]) assert.ok(op.responses[code], code);
    const rowSchema = doc.components.schemas.SweepPrReviewQueueRow;
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    for (const row of fixture.queues) assert.deepEqual(Object.keys(row).sort(), [...rowSchema.required].sort(), "the fixture rows have exactly the documented keys");
    assert.deepEqual(Object.keys(rowSchema.properties.ready_items.items.properties).sort(), ["green_since", "head_sha", "number"]);
    assert.ok(doc.components.schemas.SweepQueueObservation.properties.ready_items, "the observation schema names ready_items");
    const api = fs.readFileSync("docs/API.md", "utf8");
    assert.match(api, /`GET \/api\/sweep\/queues\?classification=pr_review`/);
    const src = fs.readFileSync("src/app/api/sweep/queues/route.ts", "utf8");
    assert.doesNotMatch(src, /sweep-producer|config\.json|readFile/, "the route never reads producer configuration");
  });
});
