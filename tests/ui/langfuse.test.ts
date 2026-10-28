import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { langfuseConfig, langfuseStatus } from "../../src/lib/langfuse-config";
import { exportLangfuseEvent, langfusePayload, type LangfuseEvent } from "../../src/lib/langfuse";
import { queueLangfuseEvent } from "../../src/lib/langfuse-report";
import { types } from "@neondatabase/serverless";

const env = {
  LANGFUSE_ENABLED: "true",
  LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
  LANGFUSE_PUBLIC_KEY: "pk-test-fixture",
  LANGFUSE_SECRET_KEY: "sk-test-fixture",
  LANGFUSE_PROJECT_URL: "https://us.cloud.langfuse.com/project/fleet-fixture",
  VERCEL_ENV: "production",
};
const config = langfuseConfig(env)!;
const event: LangfuseEvent = {
  id: 42, created_at: "2026-10-16T12:00:00Z", agent_id: "codex-macbook",
  session_id: "session-fixture", platform: "codex", kind: "session_end",
};

describe("Langfuse configuration", () => {
  it("requires an explicit enable flag, keys, and a deliberate region", () => {
    assert.equal(langfuseConfig({}), null);
    assert.equal(langfuseConfig({ ...env, LANGFUSE_ENABLED: undefined }), null);
    assert.equal(langfuseConfig({ ...env, LANGFUSE_SECRET_KEY: " " }), null);
    assert.equal(langfuseConfig({ ...env, LANGFUSE_BASE_URL: undefined }), null);
    assert.equal(langfuseStatus({ ...env, LANGFUSE_SECRET_KEY: "" }).state, "incomplete");
    assert.equal(config.endpoint, "https://us.cloud.langfuse.com/api/public/otel/v1/traces");
  });

  it("rejects unsafe destinations and project links containing credentials or query strings", () => {
    for (const url of ["http://cloud.langfuse.com", "https://user:pass@cloud.langfuse.com", "https://cloud.langfuse.com?key=secret", "https://cloud.langfuse.com/api/public/otel", "javascript:alert(1)"]) {
      assert.equal(langfuseConfig({ ...env, LANGFUSE_BASE_URL: url }), null, url);
    }
    for (const url of ["https://elsewhere.example/project/id", "https://us.cloud.langfuse.com/project/id?key=secret", "https://user:pass@us.cloud.langfuse.com/project/id", "javascript:alert(1)"]) {
      assert.equal(langfuseStatus({ ...env, LANGFUSE_PROJECT_URL: url }).projectUrl, null, url);
    }
    assert.equal(langfuseConfig({ ...env, LANGFUSE_BASE_URL: "http://localhost:3000" })?.endpoint, "http://localhost:3000/api/public/otel/v1/traces");
  });

  it("exposes configuration readiness without exposing keys", () => {
    const status = langfuseStatus(env);
    assert.equal(status.state, "ready");
    assert.equal(status.projectUrl, env.LANGFUSE_PROJECT_URL);
    assert.ok(!JSON.stringify(status).includes("test-fixture"));
  });
});

describe("fleet export privacy and correlation", () => {
  it("cannot forward arbitrary nested event content or raw identifiers", () => {
    const sensitive = {
      ...event, title: "SECRET_PROMPT", summary: "SECRET_REPLY", project: "SECRET_PROJECT",
      machine: "SECRET_MACHINE", detail: { messages: ["SECRET_MESSAGE"], error: "SECRET_ERROR", api_key: "SECRET_KEY" },
    };
    const serialized = JSON.stringify(langfusePayload(sensitive, "SECRET_ENV"));
    for (const text of ["SECRET_", event.agent_id, event.session_id!]) assert.ok(!serialized.includes(text), text);
    assert.ok(serialized.includes('"stringValue":"default"'));
    assert.ok(!serialized.includes("generation"));
    assert.ok(!serialized.includes("cost_details"));
  });

  it("uses separate event traces while grouping events from the same agent session", () => {
    const first = langfusePayload(event, "production")!.resourceSpans[0].scopeSpans[0].spans[0];
    const next = langfusePayload({ ...event, id: 43 }, "production")!.resourceSpans[0].scopeSpans[0].spans[0];
    const otherAgent = langfusePayload({ ...event, agent_id: "grok-mini" }, "production")!.resourceSpans[0].scopeSpans[0].spans[0];
    const session = (span: typeof first) => { const value = span.attributes.find((a) => a.key === "langfuse.session.id")?.value; return value && "stringValue" in value ? value.stringValue : undefined; };
    assert.match(first.traceId, /^[0-9a-f]{32}$/);
    assert.match(first.spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(first.traceId, next.traceId);
    assert.notEqual(first.spanId, next.spanId);
    assert.equal(session(first), session(next));
    assert.notEqual(session(first), session(otherAgent));
    assert.equal(first.startTimeUnixNano, "1792152000000000000");
    assert.equal(first.endTimeUnixNano, first.startTimeUnixNano);
  });

  it("drops heartbeat noise, invalid dates and unknown event kinds", () => {
    for (const changed of [{ kind: "heartbeat" }, { kind: "SECRET_EVENT" }, { created_at: "invalid" }, { id: -1 }, { id: NaN }]) {
      assert.equal(langfusePayload({ ...event, ...changed }, "production"), null);
    }
    const span = langfusePayload({ ...event, kind: "error", platform: "SECRET_PLATFORM" }, "production")!.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.status.code, 2);
    assert.ok(!JSON.stringify(span).includes("SECRET_PLATFORM"));
  });

  it("preserves timestamp milliseconds with the installed Neon driver's parsed value", () => {
    const created_at = types.getTypeParser(1184)("2026-10-16 12:00:00.123+00") as Date | string;
    const span = langfusePayload({ ...event, created_at }, "production")!.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.startTimeUnixNano, "1792152000123000000");
    assert.equal(langfusePayload({ ...event, created_at: new Date(NaN) }, "production"), null);
  });

  it("marks failed MCP status reports as errors without exporting arbitrary status strings", () => {
    const span = langfusePayload({ ...event, kind: "status", status: "failed", platform: "cowork-local" }, "production")!.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.status.code, 2);
    assert.ok(span.attributes.some((a) => a.key === "langfuse.observation.level" && "stringValue" in a.value && a.value.stringValue === "ERROR"));
    assert.ok(JSON.stringify(span).includes("cowork-local"));
    assert.ok(!JSON.stringify(langfusePayload({ ...event, status: "SECRET_STATUS" }, "production")).includes("SECRET_STATUS"));
  });
});

describe("OTLP transport", () => {
  it("sends JSON with v4 ingestion and project auth, never following redirects", async () => {
    let calls = 0;
    const send: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, config.endpoint);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-langfuse-ingestion-version"), "4");
      assert.equal(headers.get("authorization"), `Basic ${Buffer.from("pk-test-fixture:sk-test-fixture").toString("base64")}`);
      assert.equal(headers.get("content-type"), "application/json");
      assert.ok(!String(init?.body).includes("sk-test-fixture"));
      return Response.json({});
    };
    assert.equal(await exportLangfuseEvent(event, config, send), "sent");
    assert.equal(calls, 1);
  });

  it("does not retry or throw on authentication failures, throttling, timeouts or partial rejection", async () => {
    for (const status of [401, 429, 500]) {
      let calls = 0;
      assert.equal(await exportLangfuseEvent(event, config, async () => { calls++; return new Response("SECRET_RESPONSE", { status }); }), "http_error");
      assert.equal(calls, 1);
    }
    assert.equal(await exportLangfuseEvent(event, config, async () => { throw new Error("SECRET_EXCEPTION"); }), "network_error");
    assert.equal(await exportLangfuseEvent(event, config, async () => Response.json({ partialSuccess: { rejectedSpans: "1", errorMessage: "SECRET_REJECTION" } })), "partial_rejection");
    assert.equal(await exportLangfuseEvent(event, config, async () => new Response("not json")), "invalid_response");
    assert.equal(await exportLangfuseEvent({ ...event, kind: "heartbeat" }, config, async () => { throw new Error("should not send"); }), "skipped");
  });
});

describe("serverless scheduling", () => {
  it("schedules one post-response export only when enabled and relevant", () => {
    let scheduled = 0;
    const schedule = () => { scheduled++; };
    queueLangfuseEvent(event, schedule, config);
    assert.equal(scheduled, 1);
    queueLangfuseEvent(event, schedule, null);
    queueLangfuseEvent({ ...event, kind: "heartbeat" }, schedule, config);
    assert.equal(scheduled, 1);
  });

  it("keeps scheduling failures from breaking successful ingestion and redacts logs", () => {
    const log = mock.method(console, "warn", () => {});
    try {
      assert.doesNotThrow(() => queueLangfuseEvent(event, () => { throw new Error("SECRET_CONTEXT"); }, config));
      assert.deepEqual(log.mock.calls[0].arguments, ["Langfuse event export: scheduling_failed"]);
    } finally { log.mock.restore(); }
  });
});
