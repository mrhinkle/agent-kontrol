import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventStreamError, eventStreamResponse } from "../../src/lib/events-stream";
import { streamControlBody, streamFailure } from "../../src/lib/events-http";

const transport = (opts: Parameters<typeof eventStreamResponse>[0]) =>
  eventStreamResponse({ ...opts, enqueue: async (push) => { push(); } });

function frameData(text: string, event: string): Record<string, unknown> {
  const match = text.match(new RegExp(`event: ${event}\\ndata: (\\{.*\\})`));
  assert.ok(match, text);
  return JSON.parse(match[1]);
}

describe("SSE control teaching", () => {
  it("explains an expired cursor without an error token or invented id", async () => {
    const res = transport({
      consumer: "expired-meta",
      position: "1",
      generation: "1",
      credential: "c",
      signal: new AbortController().signal,
      first: { expired: true, events: [] },
    });
    const text = await res.text();
    assert.match(text, /event: cursor_expired/);
    assert.doesNotMatch(text, /^id:/m);
    const data = frameData(text, "cursor_expired");
    assert.equal(data.reconcile, true);
    assert.equal("error" in data, false);
    assert.equal(data.code, "cursor_expired");
    assert.equal(data.retryable, false);
    const teaching = streamControlBody("cursor_expired");
    assert.equal(data.cause, teaching.cause);
    assert.equal(data.fix, teaching.fix);
    assert.match(String(data.fix), /same cursor will expire again/);
  });

  it("keeps a store failure private and tells the client to retry a bounded number of times", async () => {
    const res = transport({
      consumer: "failure-meta",
      position: "4",
      generation: "1",
      credential: "c",
      signal: new AbortController().signal,
      first: { expired: false, events: [] },
      read: async () => { throw new Error("password=private-cause"); },
      pollMs: 1,
      lifetimeMs: 2000,
    });
    const text = await res.text();
    assert.match(text, /event: stream_error/);
    assert.doesNotMatch(text, /private-cause|^id:/m);
    const data = frameData(text, "stream_error");
    assert.equal(data.error, "stream_unavailable");
    assert.equal(data.reconcile, true);
    assert.equal(data.code, "internal_error");
    assert.equal(data.retryable, true);
    assert.match(String(data.cause), /did not answer/);
    assert.match(String(data.fix), /bounded number of times/);
  });

  it("tells a superseded consumer to reconnect only after the newer owner is gone", async () => {
    const options = {
      consumer: "duplicate-meta",
      position: "0",
      generation: "1",
      credential: "c",
      signal: new AbortController().signal,
      first: { expired: false, events: [] },
      read: async () => ({ expired: false, events: [] }),
      pollMs: 1,
      lifetimeMs: 2000,
    };
    const older = transport(options);
    const newer = transport({ ...options, generation: "2" });
    const text = await older.text();
    assert.match(text, /event: superseded/);
    const data = frameData(text, "superseded");
    assert.equal(data.reconcile, true);
    assert.equal("error" in data, false);
    assert.equal(data.code, "conflict");
    assert.equal(data.retryable, true);
    assert.match(String(data.cause), /newer stream/);
    assert.match(String(data.fix), /only after the newer stream is gone/);
    assert.match(String(data.fix), /Reconnecting immediately/);
    await newer.body!.cancel();
  });

  it("classifies an oversized event without using the exception text", async () => {
    const res = transport({
      consumer: "large-meta",
      position: "0",
      generation: "1",
      credential: "c",
      signal: new AbortController().signal,
      first: { expired: false, events: [] },
      read: async () => { throw new EventStreamError("event_too_large", 413); },
      pollMs: 1,
      lifetimeMs: 2000,
    });
    const text = await res.text();
    const data = frameData(text, "stream_error");
    assert.equal(data.error, "event_too_large");
    assert.equal(data.reconcile, true);
    assert.equal(data.code, "payload_too_large");
    assert.equal(data.retryable, false);
    assert.match(String(data.fix), /outside this stream/);
    assert.doesNotMatch(text, /EventStreamError/);
  });
});

describe("HTTP stream failures share the control mapper", () => {
  it("keeps superseded and stream_unavailable catalogue codes and adds cause", async () => {
    const replaced = await streamFailure("superseded", 409).json() as Record<string, unknown>;
    assert.equal(replaced.error, "superseded");
    assert.equal(replaced.code, "conflict");
    assert.equal(replaced.retryable, true);
    assert.equal(replaced.cause, streamControlBody("superseded").cause);
    assert.equal(replaced.fix, streamControlBody("superseded").fix);

    const down = await streamFailure("stream_unavailable", 503).json() as Record<string, unknown>;
    assert.equal(down.error, "stream_unavailable");
    assert.equal(down.code, "internal_error");
    assert.equal(down.retryable, true);
    assert.equal(down.cause, "The event store did not answer.");

    const auth = await streamFailure("unauthorized", 401).json() as Record<string, unknown>;
    assert.equal(auth.error, "unauthorized");
    assert.equal(auth.code, "unauthorized");
    assert.equal(auth.retryable, false);
    assert.equal(typeof auth.cause, "string");
    assert.equal(typeof auth.fix, "string");
  });
});
