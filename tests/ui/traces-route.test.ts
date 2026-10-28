import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

// No DATABASE_URL: the route authenticates and validates, then answers without storing.
let POST: (req: Request) => Promise<Response>;
const saved = { token: process.env.MC_TOKEN, db: process.env.DATABASE_URL };

before(async () => {
  process.env.MC_TOKEN = "route-test-token";
  delete process.env.DATABASE_URL;
  ({ POST } = await import("../../src/app/api/v1/traces/route"));
});
after(() => {
  if (saved.token === undefined) delete process.env.MC_TOKEN;
  else process.env.MC_TOKEN = saved.token;
  if (saved.db !== undefined) process.env.DATABASE_URL = saved.db;
});

const body = JSON.stringify({
  resourceSpans: [{ resource: { attributes: [{ key: "agent.id", value: { stringValue: "a" } }] }, scopeSpans: [{ spans: [
    { traceId: "0123456789abcdef0123456789abcdef", spanId: "00000000000000a1", name: "s", startTimeUnixNano: "1790000000000000000" },
    { traceId: "bad", spanId: "1", name: "junk", startTimeUnixNano: "1790000000000000000" },
  ] }] }],
});
const req = (init: { body?: BodyInit; headers?: Record<string, string> }) =>
  new Request("http://x/api/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer route-test-token", ...init.headers },
    body: init.body,
  });

describe("POST /api/v1/traces", () => {
  it("requires the bearer token", async () => {
    const res = await POST(req({ body, headers: { authorization: "Bearer wrong" } }));
    assert.equal(res.status, 401);
  });

  it("accepts OTLP JSON and reports rejected spans", async () => {
    const res = await POST(req({ body }));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.partialSuccess.rejectedSpans, 1);
  });

  it("accepts gzip bodies", async () => {
    const res = await POST(req({ body: gzipSync(Buffer.from(body)), headers: { "content-encoding": "gzip" } }));
    assert.equal(res.status, 200);
  });

  it("rejects protobuf, non-OTLP and invalid JSON", async () => {
    assert.equal((await POST(req({ body: "x", headers: { "content-type": "application/x-protobuf" } }))).status, 415);
    assert.equal((await POST(req({ body: "{\"a\":1}" }))).status, 400);
    assert.equal((await POST(req({ body: "{not json" }))).status, 400);
  });

  it("rejects an oversized body without buffering it all, plain or gzip", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    assert.equal((await POST(req({ body: big }))).status, 413);
    assert.equal((await POST(req({ body: big, headers: { "content-length": String(big.length) } }))).status, 413);
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20));
    assert.equal((await POST(req({ body: bomb, headers: { "content-encoding": "gzip" } }))).status, 400, "a gzip bomb is refused");
  });
});
