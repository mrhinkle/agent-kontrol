import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { setSqlForTests, type Row, type SqlTag } from "../../src/lib/db";
import {
  GH_ACCEPTED_EVENTS,
  GH_WEBHOOK_BODY_MAX_BYTES,
  GhEventInputError,
  insertGhEvent,
  parseSignatureHeader,
  signBody,
  verifySignature,
} from "../../src/lib/gh-events";
import { POST } from "../../src/app/api/webhooks/github/route";
import { middleware } from "../../src/middleware";
import { EVENT_FIXTURES, PING_PAYLOAD, REPO, SHA_A } from "./gh-event-fixtures";

const SECRET = "test-webhook-secret";
const URL_PATH = "http://localhost/api/webhooks/github";
const env = process.env as Record<string, string | undefined>;
const KEYS = ["MC_GITHUB_WEBHOOK_SECRET", "DATABASE_URL", "MC_DASHBOARD_PASSWORD", "MC_TOKEN", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

interface Captured {
  text: string;
  values: unknown[];
}
let calls: Captured[] = [];
let respond: (call: Captured) => Row[] | Promise<Row[]> = () => [{ id: "1" }];

const stub: SqlTag = async (strings, ...values) => {
  const call = { text: strings.join("$?"), values };
  calls.push(call);
  return respond(call);
};

beforeEach(() => {
  for (const k of KEYS) saved[k] = env[k];
  env.MC_GITHUB_WEBHOOK_SECRET = SECRET;
  calls = [];
  respond = () => [{ id: "1" }];
  setSqlForTests(stub);
});
afterEach(() => {
  setSqlForTests(null);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

function signedRequest(
  body: string | Uint8Array,
  opts: { event?: string | null; delivery?: string | null; signature?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  const event = opts.event === undefined ? "pull_request" : opts.event;
  const delivery = opts.delivery === undefined ? randomUUID() : opts.delivery;
  const signature = opts.signature === undefined ? signBody(SECRET, body) : opts.signature;
  if (event !== null) headers["x-github-event"] = event;
  if (delivery !== null) headers["x-github-delivery"] = delivery;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return new Request(URL_PATH, { method: "POST", headers, body });
}

function streamRequest(chunks: Uint8Array[], headers: Record<string, string>, onCancel?: () => unknown): Request {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
    cancel() {
      return onCancel?.() as Promise<void> | undefined;
    },
  });
  return new Request(URL_PATH, { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
}

async function json(res: Response): Promise<Record<string, any>> {
  return res.json() as Promise<Record<string, any>>;
}

const fixture = EVENT_FIXTURES[0];
const fixtureBody = JSON.stringify(fixture.payload);

/** A JSON object of exactly `size` bytes. */
function bodyOfSize(size: number): string {
  const shell = '{"pad":""}';
  return `{"pad":"${"x".repeat(size - shell.length)}"}`;
}

describe("signature helpers", () => {
  it("match GitHub's published test vector", () => {
    const vector = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    assert.equal(signBody("It's a Secret to Everybody", "Hello, World!"), vector);
    const digest = parseSignatureHeader(vector);
    assert.ok(digest);
    assert.equal(verifySignature("It's a Secret to Everybody", new TextEncoder().encode("Hello, World!"), digest), true);
    assert.equal(verifySignature("It's a Secret to Everybody", new TextEncoder().encode("Hello, World?"), digest), false);
  });

  it("accept only sha256= and 64 lowercase hex", () => {
    const hex = "a".repeat(64);
    assert.ok(parseSignatureHeader(`sha256=${hex}`));
    for (const bad of [
      null,
      "",
      hex,
      `sha1=${"a".repeat(40)}`,
      `SHA256=${hex}`,
      `sha256=${"A".repeat(64)}`,
      `sha256=${hex.slice(1)}`,
      `sha256=${hex}0`,
      ` sha256=${hex}`,
      `sha256=${hex} `,
      `sha256=${hex}, sha256=${hex}`,
      `sha256=${"g".repeat(64)}`,
    ]) {
      assert.equal(parseSignatureHeader(bad), null, String(bad));
    }
  });
});

describe("POST /api/webhooks/github rejections run no SQL", () => {
  it("is 503 not_configured without a secret, even for a signed ping", async () => {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete env.MC_GITHUB_WEBHOOK_SECRET;
      else env.MC_GITHUB_WEBHOOK_SECRET = value;
      const res = await POST(signedRequest(JSON.stringify(PING_PAYLOAD), { event: "ping" }));
      assert.equal(res.status, 503);
      const body = await json(res);
      assert.equal(body.code, "not_configured");
      assert.equal(typeof body.fix, "string");
    }
    assert.equal(calls.length, 0);
  });

  it("is 401 for a missing, malformed, wrong, or other-body signature", async () => {
    const cases: Request[] = [
      signedRequest(fixtureBody, { signature: null }),
      signedRequest(fixtureBody, { signature: "sha256=zz" }),
      signedRequest(fixtureBody, { signature: signBody(SECRET, fixtureBody).toUpperCase() }),
      signedRequest(fixtureBody, { signature: signBody("other-secret", fixtureBody) }),
      signedRequest(fixtureBody, { signature: signBody(SECRET, `${fixtureBody} `) }),
      signedRequest(fixtureBody, { signature: signBody(SECRET, JSON.stringify({ ...fixture.payload, action: "closed" })) }),
      signedRequest(JSON.stringify(PING_PAYLOAD), { event: "ping", signature: signBody("other", JSON.stringify(PING_PAYLOAD)) }),
      signedRequest("{}", { event: "star", signature: null }),
    ];
    for (const req of cases) {
      const res = await POST(req);
      assert.equal(res.status, 401);
      assert.equal((await json(res)).code, "unauthorized");
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal(calls.length, 0);
  });

  it("does not accept a session cookie, MC_TOKEN, or agent bearer instead of a signature", async () => {
    env.MC_TOKEN = "operator-token";
    const res = await POST(signedRequest(fixtureBody, {
      signature: null,
      headers: { authorization: "Bearer operator-token", cookie: "mc_auth=anything" },
    }));
    assert.equal(res.status, 401);
    const agent = await POST(signedRequest(fixtureBody, { signature: null, headers: { authorization: "Bearer akc_x" } }));
    assert.equal(agent.status, 401);
    assert.equal(calls.length, 0);
  });

  it("accepts exactly 1 MiB and answers 413 one byte over", async () => {
    const exact = bodyOfSize(GH_WEBHOOK_BODY_MAX_BYTES);
    assert.equal(Buffer.byteLength(exact), GH_WEBHOOK_BODY_MAX_BYTES);
    const ok = await POST(signedRequest(exact, { event: "star" }));
    assert.equal(ok.status, 202);

    const over = bodyOfSize(GH_WEBHOOK_BODY_MAX_BYTES + 1);
    const res = await POST(signedRequest(over));
    assert.equal(res.status, 413);
    assert.equal((await json(res)).code, "payload_too_large");
    assert.equal(calls.length, 0);
  });

  it("counts streamed chunks and ignores a Content-Length that lies", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    const chunks = [chunk, chunk, chunk, chunk, new Uint8Array([0x20])];
    const sig = signBody(SECRET, Buffer.concat(chunks));
    const headers = {
      "x-hub-signature-256": sig,
      "x-github-event": "push",
      "x-github-delivery": randomUUID(),
      "content-length": "10",
    };
    const res = await POST(streamRequest(chunks, headers));
    assert.equal(res.status, 413);

    // A small body under a huge Content-Length is read and judged by its bytes.
    const small = new TextEncoder().encode(JSON.stringify(PING_PAYLOAD));
    const ping = await POST(streamRequest([small.slice(0, 5), small.slice(5)], {
      "x-hub-signature-256": signBody(SECRET, small),
      "x-github-event": "ping",
      "x-github-delivery": randomUUID(),
      "content-length": String(50 * 1024 * 1024),
    }));
    assert.equal(ping.status, 200);
    assert.equal(calls.length, 0);
  });

  it("is still 413 when cancelling the stream rejects or throws", async () => {
    const big = new Uint8Array(GH_WEBHOOK_BODY_MAX_BYTES + 1);
    const headers = { "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "x-github-event": "push", "x-github-delivery": randomUUID() };
    const rejected = await POST(streamRequest([big], headers, () => Promise.reject(new Error("cancel failed"))));
    assert.equal(rejected.status, 413);
    const thrown = await POST(streamRequest([big], headers, () => {
      throw new Error("cancel threw");
    }));
    assert.equal(thrown.status, 413);
    assert.equal(calls.length, 0);
  });

  it("is 400 invalid_json for a signed body that is not UTF-8 JSON", async () => {
    for (const body of ["", "not json", "{", "payload=%7B%7D", new Uint8Array([0x7b, 0xff, 0x7d])]) {
      const res = await POST(signedRequest(body));
      assert.equal(res.status, 400, String(body));
      assert.equal((await json(res)).code, "invalid_json");
    }
    assert.equal(calls.length, 0);
  });

  it("is 400 validation_failed when an accepted event's payload is not an object", async () => {
    for (const body of ["[]", "[1,2]", "null", "1", '"text"', "true"]) {
      const res = await POST(signedRequest(body));
      assert.equal(res.status, 400, body);
      const out = await json(res);
      assert.equal(out.code, "validation_failed");
      assert.ok(out.fields.payload);
    }
    assert.equal(calls.length, 0);
  });

  it("is 400 for a bad event or delivery header, including the sweep: namespace", async () => {
    const cases: [Request, string][] = [
      [signedRequest(fixtureBody, { event: null }), "X-GitHub-Event"],
      [signedRequest(fixtureBody, { event: "" }), "X-GitHub-Event"],
      [signedRequest(fixtureBody, { event: "Pull_Request" }), "X-GitHub-Event"],
      [signedRequest(fixtureBody, { event: "pull-request" }), "X-GitHub-Event"],
      [signedRequest(fixtureBody, { event: "a".repeat(65) }), "X-GitHub-Event"],
      [signedRequest(fixtureBody, { delivery: null }), "X-GitHub-Delivery"],
      [signedRequest(fixtureBody, { delivery: "" }), "X-GitHub-Delivery"],
      [signedRequest(fixtureBody, { delivery: "sweep:abc" }), "X-GitHub-Delivery"],
      [signedRequest(fixtureBody, { delivery: "a".repeat(129) }), "X-GitHub-Delivery"],
      [signedRequest(fixtureBody, { delivery: "id with space" }), "X-GitHub-Delivery"],
      [signedRequest(fixtureBody, { delivery: "x'; drop table gh_events;--" }), "X-GitHub-Delivery"],
    ];
    for (const [req, field] of cases) {
      const res = await POST(req);
      assert.equal(res.status, 400);
      const out = await json(res);
      assert.equal(out.code, "validation_failed");
      assert.ok(out.fields[field], field);
    }
    assert.equal(calls.length, 0);
  });

  it("is 400 when an accepted event lacks its required fields", async () => {
    const pr = fixture.payload as Record<string, any>;
    const cases: [string, Record<string, unknown>, string][] = [
      ["pull_request", { ...pr, repository: undefined }, "repository.full_name"],
      ["pull_request", { ...pr, repository: { full_name: "" } }, "repository.full_name"],
      ["pull_request", { ...pr, repository: { full_name: "no-slash" } }, "repository.full_name"],
      ["pull_request", { ...pr, action: undefined }, "action"],
      ["pull_request", { ...pr, action: 5 }, "action"],
      ["pull_request", { ...pr, pull_request: { ...pr.pull_request, number: "7" } }, "pull_request.number"],
      ["pull_request", { ...pr, pull_request: { ...pr.pull_request, number: 0 } }, "pull_request.number"],
      ["pull_request", { ...pr, pull_request: { ...pr.pull_request, head: { sha: "nothex" } } }, "pull_request.head.sha"],
      ["issues", { action: "opened", repository: pr.repository, issue: {} }, "issue.number"],
      ["check_suite", { action: "completed", repository: pr.repository, check_suite: [] }, "check_suite"],
      ["workflow_run", { action: "completed", repository: pr.repository, workflow_run: { head_sha: 1 } }, "workflow_run.head_sha"],
      ["status", { repository: pr.repository, sha: null }, "sha"],
      ["push", { repository: pr.repository }, "after"],
    ];
    for (const [event, payload, field] of cases) {
      const res = await POST(signedRequest(JSON.stringify(payload), { event }));
      assert.equal(res.status, 400, `${event} ${field}`);
      const out = await json(res);
      assert.equal(out.code, "validation_failed");
      assert.ok(out.fields[field], `${event} ${field}: ${JSON.stringify(out.fields)}`);
    }
    assert.equal(calls.length, 0);
  });

  it("is 400 for a payload jsonb cannot store", async () => {
    let deep: unknown = {};
    for (let i = 0; i < 150; i++) deep = { d: deep };
    const bodies = [
      JSON.stringify({ ...fixture.payload, extra: "a\u0000b" }),
      JSON.stringify({ ...fixture.payload, ["k\u0000"]: 1 }),
      `{"action":"opened","x":"\\ud800"}`,
      JSON.stringify({ ...fixture.payload, deep }),
    ];
    for (const body of bodies) {
      const res = await POST(signedRequest(body));
      assert.equal(res.status, 400);
      assert.ok((await json(res)).fields.payload);
    }
    assert.equal(calls.length, 0);
  });
});

describe("POST /api/webhooks/github accepted deliveries", () => {
  it("answers a signed ping 200 and an unlisted event 202 without SQL", async () => {
    const ping = await POST(signedRequest(JSON.stringify(PING_PAYLOAD), { event: "ping", delivery: "d-ping" }));
    assert.equal(ping.status, 200);
    assert.deepEqual(await json(ping), { ok: true, event: "ping", delivery_id: "d-ping" });
    for (const event of ["star", "release", "installation", "check_run", "deployment"]) {
      const delivery = randomUUID();
      const res = await POST(signedRequest(JSON.stringify({ action: "created" }), { event, delivery }));
      assert.equal(res.status, 202);
      assert.deepEqual(await json(res), { ok: true, ignored: true, event, delivery_id: delivery });
    }
    assert.equal(calls.length, 0);
  });

  it("stores each of the eight events with its metadata as bound parameters", async () => {
    assert.deepEqual(EVENT_FIXTURES.map((f) => f.event).sort(), [...GH_ACCEPTED_EVENTS].sort());
    let id = 100;
    respond = () => [{ id: String(++id) }];
    for (const f of EVENT_FIXTURES) {
      calls = [];
      const delivery = randomUUID();
      const raw = JSON.stringify(f.payload, null, 2);
      const res = await POST(signedRequest(raw, { event: f.event, delivery }));
      assert.equal(res.status, 200, f.event);
      const out = await json(res);
      assert.deepEqual(out, { ok: true, stored: true, duplicate: false, id: String(id), delivery_id: delivery });
      assert.equal(calls.length, 1, f.event);
      const [call] = calls;
      assert.match(call.text, /insert into gh_events/);
      assert.match(call.text, /on conflict \(delivery_id\) do nothing/);
      assert.match(call.text, /returning id::text as id/);
      assert.doesNotMatch(call.text, /update|begin|commit/i);
      assert.deepEqual(call.values, [
        delivery,
        f.event,
        f.expect.action,
        f.expect.repo,
        f.expect.number,
        f.expect.head_sha,
        JSON.stringify(f.payload),
      ], f.event);
    }
  });

  it("keeps a PR number only when the check or workflow list names one PR", async () => {
    const run = EVENT_FIXTURES.find((f) => f.event === "workflow_run")!.payload as Record<string, any>;
    const pr = (n: number) => ({ number: n, head: { sha: SHA_A } });
    const cases: [unknown, number | null][] = [
      [[pr(9)], 9],
      [[pr(9), pr(9)], 9],
      [[pr(9), pr(10)], null],
      [[], null],
      [undefined, null],
      [[{ number: "9" }], null],
    ];
    for (const [list, expected] of cases) {
      calls = [];
      const payload = { ...run, workflow_run: { ...run.workflow_run, pull_requests: list } };
      const res = await POST(signedRequest(JSON.stringify(payload), { event: "workflow_run" }));
      assert.equal(res.status, 200);
      assert.equal(calls[0].values[4], expected, JSON.stringify(list));
    }
  });

  it("signs the bytes as sent: whitespace, Unicode, and newlines are not reserialized", async () => {
    const raw = `{\r\n  "action" : "opened",\n\t"number":7,"title":"caf\u00e9 \ud83d\ude80 \\u00e9",\n  "pull_request":{"number":7,"head":{"sha":"${SHA_A}"}},\n  "repository":{"full_name":"${REPO}"}   }\n\n`;
    const res = await POST(signedRequest(raw));
    assert.equal(res.status, 200);
    assert.equal(calls[0].values[6], JSON.stringify(JSON.parse(raw)));
    const reserialized = JSON.stringify(JSON.parse(raw));
    const mismatched = await POST(signedRequest(raw, { signature: signBody(SECRET, reserialized) }));
    assert.equal(mismatched.status, 401);
  });

  it("stores repositories named like .github and owners with underscores", async () => {
    for (const fullName of ["acme/.github", "octo_acme/widgets", "a/b", "Acme-Co/Widgets.js"]) {
      calls = [];
      const payload = { ...fixture.payload, repository: { full_name: fullName } };
      const res = await POST(signedRequest(JSON.stringify(payload)));
      assert.equal(res.status, 200, fullName);
      assert.equal(calls[0].values[3], fullName);
    }
    for (const fullName of ["acme", "acme/", "/widgets", "acme/wid gets", "acme/a/b", "acme/w\nx"]) {
      const res = await POST(signedRequest(JSON.stringify({ ...fixture.payload, repository: { full_name: fullName } })));
      assert.equal(res.status, 400, fullName);
    }
  });

  it("answers a duplicate delivery 200 duplicate:true", async () => {
    respond = () => [];
    const delivery = randomUUID();
    const res = await POST(signedRequest(fixtureBody, { delivery }));
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ok: true, duplicate: true, delivery_id: delivery });
  });

  it("is a retryable 503, never a stored receipt, without a database or when the insert fails", async () => {
    setSqlForTests(null);
    delete env.DATABASE_URL;
    const none = await POST(signedRequest(fixtureBody));
    assert.equal(none.status, 503);
    const noneBody = await json(none);
    assert.equal(noneBody.code, "setup_required");
    assert.equal(noneBody.retryable, true);
    assert.equal(noneBody.stored, undefined);

    setSqlForTests(stub);
    const original = console.error;
    console.error = () => {};
    try {
      respond = () => {
        throw Object.assign(new Error(`secret detail ${fixtureBody}`), { code: "57P01" });
      };
      const failed = await POST(signedRequest(fixtureBody));
      assert.equal(failed.status, 503);
      const text = await failed.text();
      const body = JSON.parse(text);
      assert.equal(body.code, "internal_error");
      assert.equal(body.retryable, true);
      assert.equal(body.stored, undefined);
      assert.doesNotMatch(text, /secret detail|Add widget/);
    } finally {
      console.error = original;
    }
  });
});

describe("insertGhEvent", () => {
  it("runs one statement on the caller's tag and never begins or commits", async () => {
    const seen: string[] = [];
    const tx: SqlTag = async (strings) => {
      seen.push(strings.join("?"));
      return [{ id: "55" }];
    };
    setSqlForTests(null);
    const out = await insertGhEvent({ delivery_id: "sweep:repo:1", event: "sweep_condition", payload: { a: 1 } }, tx);
    assert.deepEqual(out, { stored: true, duplicate: false, id: "55" });
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0], /\bbegin\b|\bcommit\b/i);
  });

  it("rejects bad input before any SQL", async () => {
    const bad = [
      { delivery_id: "", event: "x", payload: {} },
      { delivery_id: "a".repeat(201), event: "x", payload: {} },
      { delivery_id: "a\nb", event: "x", payload: {} },
      { delivery_id: "a", event: "", payload: {} },
      { delivery_id: "a", event: "e".repeat(65), payload: {} },
      { delivery_id: "a", event: "x", payload: [] as unknown as Record<string, unknown> },
      { delivery_id: "a", event: "x", payload: {}, number: -1 },
    ];
    for (const input of bad) {
      await assert.rejects(() => insertGhEvent(input), GhEventInputError);
    }
    assert.equal(calls.length, 0);
  });
});

describe("middleware for the webhook path", () => {
  const req = (path: string) => new NextRequest(`http://localhost${path}`, { method: "POST" });

  it("lets the exact path through the password gate and keeps neighbors protected", async () => {
    env.MC_DASHBOARD_PASSWORD = "pw";
    env.NODE_ENV = "production";
    delete env.MC_TOKEN;
    assert.notEqual((await middleware(req("/api/webhooks/github"))).status, 401);
    for (const path of ["/api/webhooks", "/api/webhooks/github/x", "/api/webhooks/githubx", "/api/webhooks/github2", "/api/webhooks/GitHub", "/api/webhook/github"]) {
      assert.equal((await middleware(req(path))).status, 401, path);
    }
  });

  it("stays reachable in production with a database and no password; neighbors are 503", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "production";
    env.DATABASE_URL = "postgres://x";
    assert.notEqual((await middleware(req("/api/webhooks/github"))).status, 503);
    assert.equal((await middleware(req("/api/webhooks/github/x"))).status, 503);
    assert.equal((await middleware(req("/api/webhooks"))).status, 503);
  });
});
