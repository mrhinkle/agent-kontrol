import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkStreamRegistration, cursorPosition, eventFrame, EventStreamError, eventStreamResponse, STREAM_FRAME_MAX, streamCursor } from "../../src/lib/events-stream";
import { authorizeRoute } from "../../src/lib/scopes";
import { GET } from "../../src/app/api/events/stream/route";

const registration = { id: "reviewer", credential_id: "credential-1", repos: ["The-AIE/the-gibson"], event_types: ["status"] };

// Transport-only cases inject the authorization boundary; real PostgreSQL tests
// drive the default enqueue path across committed registration/revocation races.
const transportResponse = (opts: Parameters<typeof eventStreamResponse>[0]) =>
  eventStreamResponse({ ...opts, enqueue: async push => { push(); } });

describe("consumer registration and cursor authority", () => {
  it("requires explicit bounded filters and rejects unknown fields", () => {
    assert.deepEqual(checkStreamRegistration(registration), { ...registration, enabled: true });
    for (const bad of [null, [], {}, { ...registration, id: "../reviewer" }, { ...registration, credential_id: "a\nb" },
      { ...registration, repos: [] }, { ...registration, repos: ["https://evil.test/x"] },
      { ...registration, event_types: ["status\ndata:"] }, { ...registration, enabled: "yes" },
      { ...registration, scopes: ["*"] }, { ...registration, repos: Array(51).fill("a/b") }]) {
      assert.throws(() => checkStreamRegistration(bad), EventStreamError);
    }
  });

  it("binds cursors to a consumer and parses PostgreSQL bigint losslessly", () => {
    assert.equal(cursorPosition("reviewer", null), "0");
    assert.equal(cursorPosition("reviewer", streamCursor("reviewer", "9007199254740993")), "9007199254740993");
    assert.throws(() => cursorPosition("reviewer", "other:42"), (e: EventStreamError) => e.status === 403);
    for (const cursor of ["reviewer:-1", "reviewer:01", "reviewer:1.1", "reviewer:1:2", "reviewer:9223372036854775808", "reviewer:1\n"]) {
      assert.throws(() => cursorPosition("reviewer", cursor), EventStreamError);
    }
  });

  it("does not grant stream access through an unrelated or missing scope", () => {
    assert.equal(authorizeRoute({ kind: "agent", id: "c", scopes: ["tasks:write"] }, "GET", "/api/events/stream").ok, false);
    assert.equal(authorizeRoute({ kind: "agent", id: "c", scopes: ["events:read"] }, "GET", "/api/events/stream").ok, true);
    assert.equal(authorizeRoute({ kind: "agent", id: "c", scopes: ["events:read"] }, "POST", "/api/events/consumers").ok, false);
    assert.equal(authorizeRoute({ kind: "agent", id: "c", scopes: ["events:read"] }, "GET", "/api/events/stream/extra").ok, false);
  });

  it("requires a scoped header even when a dashboard/demo could otherwise be open", async () => {
    for (const url of ["http://localhost/api/events/stream?consumer=reviewer", "http://localhost/api/events/stream?consumer=reviewer&key=demo"]) {
      const res = await GET(new Request(url));
      assert.equal(res.status, 401);
    }
  });
});

describe("bounded SSE transport", () => {
  it("preserves the controller envelope and rejects oversized frames", () => {
    const row = { id: "3", event: "status", payload: { state: "success", sha: "abc" } };
    const frame = eventFrame("reviewer", row);
    assert.match(frame, /^id: reviewer:3\nevent: github\ndata: /);
    assert.deepEqual(JSON.parse(frame.split("data: ")[1]), { id: "reviewer:3", event: "status", payload: row.payload });
    assert.throws(() => eventFrame("reviewer", { ...row, payload: { body: "x".repeat(STREAM_FRAME_MAX) } }), EventStreamError);
  });

  it("emits an explicit expired-cursor reconciliation without an invented event id", async () => {
    const res = transportResponse({ consumer: "expired", position: "1", generation: "1", credential: "c", signal: new AbortController().signal,
      first: { expired: true, events: [] } });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const text = await res.text();
    assert.match(text, /event: cursor_expired/);
    assert.doesNotMatch(text, /^id:/m);
  });

  it("sends heartbeat comments and closes on cancellation", async () => {
    const abort = new AbortController();
    const res = transportResponse({ consumer: "heartbeat", position: "0", generation: "1", credential: "c", signal: abort.signal,
      first: { expired: false, events: [] }, read: async () => ({ expired: false, events: [] }), pollMs: 1, heartbeatMs: 5, lifetimeMs: 2000 });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), ": ping\n\n");
    abort.abort();
    assert.equal((await reader.read()).done, true);
  });

  it("closes at the configured lifetime even without events", async () => {
    const res = transportResponse({ consumer: "duration", position: "0", generation: "1", credential: "c", signal: new AbortController().signal,
      first: { expired: false, events: [] }, read: async () => ({ expired: false, events: [] }), pollMs: 1, heartbeatMs: 10000, lifetimeMs: 20 });
    assert.equal(await res.text(), "");
  });

  it("bounds prefetch for a reader that does not drain, then cancels cleanly", async () => {
    let reads = 0;
    const res = transportResponse({ consumer: "slow", position: "0", generation: "1", credential: "c", signal: new AbortController().signal,
      first: { expired: false, events: [{ id: "1", event: "status", payload: {} }] },
      read: async () => { reads++; return { expired: false, events: [{ id: "2", event: "status", payload: {} }] }; }, pollMs: 1, lifetimeMs: 2000 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(reads <= 1, `read ${reads} batches without consumer demand`);
    await res.body!.cancel();
  });

  it("terminates an older same-consumer connection with superseded", async () => {
    const options = { consumer: "duplicate", position: "0", generation: "1", credential: "c", signal: new AbortController().signal,
      first: { expired: false, events: [] }, read: async () => ({ expired: false, events: [] }), pollMs: 1, lifetimeMs: 2000 };
    const older = transportResponse(options);
    const newer = transportResponse({ ...options, generation: "2" });
    assert.match(await older.text(), /event: superseded/);
    await newer.body!.cancel();
  });

  it("reports a store failure without leaking the exception or advancing a cursor", async () => {
    const res = transportResponse({ consumer: "failure", position: "0", generation: "1", credential: "c", signal: new AbortController().signal,
      first: { expired: false, events: [] }, read: async () => { throw new Error("password=private"); }, pollMs: 1, lifetimeMs: 2000 });
    const text = await res.text();
    assert.match(text, /stream_unavailable/);
    assert.doesNotMatch(text, /private|^id:/m);
  });

  it("fences a backpressured old connection with an explicit terminal frame", async () => {
    const options = { consumer: "buffered", position: "0", generation: "1", credential: "c", signal: new AbortController().signal,
      first: { expired: false, events: [{ id: "1", event: "status", payload: {} }] },
      read: async () => ({ expired: false, events: [] }), pollMs: 1000, lifetimeMs: 2000 };
    const older = transportResponse(options);
    const newer = transportResponse({ ...options, generation: "2", first: { expired: false, events: [] } });
    const text = await older.text();
    assert.match(text, /id: buffered:1/);
    assert.match(text, /event: superseded/);
    await newer.body!.cancel();
  });
});
