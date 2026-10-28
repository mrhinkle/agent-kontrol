import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWaterfall, dedupeSpans, formatDuration, mergeStatus, nanoToIso, parseOtlp, redactText, sanitizeAttributes, type SpanRow } from "../../src/lib/traces";

const TRACE = "0123456789abcdef0123456789abcdef";
const ns = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);

function otlp(spans: unknown[], resourceAttrs: unknown[] = [{ key: "agent.id", value: { stringValue: "cc-1" } }]) {
  return { resourceSpans: [{ resource: { attributes: resourceAttrs }, scopeSpans: [{ spans }] }] };
}
const span = (over: Record<string, unknown> = {}) => ({
  traceId: TRACE,
  spanId: "00000000000000a1",
  name: "Read",
  startTimeUnixNano: ns("2026-10-09T12:00:00.000Z"),
  endTimeUnixNano: ns("2026-10-09T12:00:01.500Z"),
  ...over,
});

describe("parseOtlp", () => {
  it("parses a valid span with timing, status, tokens and model", () => {
    const r = parseOtlp(
      otlp([
        span({
          status: { code: 2, message: "boom" },
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "claude-sonnet-5-5" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "120" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: 30 } },
            { key: "agentkontrol.cost_usd", value: { doubleValue: 0.0123 } },
          ],
        }),
      ]),
    );
    assert.equal(r.rejected, 0);
    const s = r.spans[0];
    assert.equal(s.agent_id, "cc-1");
    assert.equal(s.started_at, "2026-10-09T12:00:00.000Z");
    assert.equal(s.ended_at, "2026-10-09T12:00:01.500Z");
    assert.equal(s.status, "error");
    assert.equal(s.status_message, "boom");
    assert.equal(s.kind, "model");
    assert.equal(s.model, "claude-sonnet-5-5");
    assert.equal(s.input_tokens, 120);
    assert.equal(s.output_tokens, 30);
    assert.equal(s.cost_usd, 0.0123);
  });

  it("falls back to service.name and rejects spans with no agent", () => {
    const ok = parseOtlp(otlp([span()], [{ key: "service.name", value: { stringValue: "svc" } }]));
    assert.equal(ok.spans[0].agent_id, "svc");
    const none = parseOtlp(otlp([span()], []));
    assert.equal(none.spans.length, 0);
    assert.equal(none.rejected, 1);
    assert.match(none.errors[0], /agent id/);
  });

  it("uses defaultAgent when the resource names none", () => {
    assert.equal(parseOtlp(otlp([span()], []), { defaultAgent: "fallback" }).spans[0].agent_id, "fallback");
  });

  it("rejects bad ids and missing start times but keeps the good spans", () => {
    const r = parseOtlp(
      otlp([
        span({ traceId: "short" }),
        span({ spanId: "0000000000000000" }),
        span({ startTimeUnixNano: undefined }),
        span({ spanId: "00000000000000b2" }),
      ]),
    );
    assert.equal(r.spans.length, 1);
    assert.equal(r.rejected, 3);
  });

  it("returns an error for a body that is not OTLP", () => {
    assert.match(parseOtlp({ nope: 1 }).errors[0], /resourceSpans/);
    assert.match(parseOtlp(null).errors[0], /resourceSpans/);
  });

  it("treats parentless spans as sessions and tool.name spans as tools", () => {
    const r = parseOtlp(
      otlp([
        span({ spanId: "00000000000000c1" }),
        span({ spanId: "00000000000000c2", parentSpanId: "00000000000000c1", attributes: [{ key: "tool.name", value: { stringValue: "Bash" } }] }),
      ]),
    );
    assert.equal(r.spans[0].kind, "session");
    assert.equal(r.spans[1].kind, "tool");
    assert.equal(r.spans[1].parent_span_id, "00000000000000c1");
  });

  it("caps a request at 500 spans", () => {
    const many = Array.from({ length: 520 }, (_, i) => span({ spanId: i.toString(16).padStart(16, "0").replace(/^0{16}$/, "0000000000000fff") }));
    const r = parseOtlp(otlp(many));
    assert.ok(r.spans.length <= 500);
    assert.ok(r.errors.some((e) => /500/.test(e)));
  });
});

describe("sanitizeAttributes", () => {
  it("drops credential-looking keys always, and content keys unless opted in", () => {
    const input = {
      "http.authorization": "Bearer x",
      api_key: "k",
      "my.secret.value": "s",
      "gen_ai.prompt": "hello",
      "tool.input": "{}",
      "tool.name": "Bash",
      count: 3,
      ok: true,
      nested: { a: 1 },
    };
    assert.deepEqual(sanitizeAttributes(input), { "tool.name": "Bash", count: 3, ok: true });
    const withContent = sanitizeAttributes(input, { captureContent: true });
    assert.equal(withContent["gen_ai.prompt"], "hello");
    assert.equal(withContent["tool.input"], "{}");
    assert.equal(withContent.api_key, undefined, "credentials are never kept, even with content capture");
  });

  it("caps value length and attribute count", () => {
    const long = sanitizeAttributes({ k: "x".repeat(2000) });
    assert.equal(long.k.toString().length, 500);
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    assert.equal(Object.keys(sanitizeAttributes(many)).length, 40);
  });
});

describe("dedupeSpans", () => {
  it("merges an open span with its later close", () => {
    const base = parseOtlp(otlp([span({ endTimeUnixNano: undefined })])).spans[0];
    const closed = parseOtlp(otlp([span({ status: { code: 1 } })])).spans[0];
    const merged = dedupeSpans([base, closed]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].ended_at, "2026-10-09T12:00:01.500Z");
    assert.equal(merged[0].status, "ok");
  });
});

describe("nanoToIso", () => {
  it("handles strings, zero and garbage", () => {
    assert.equal(nanoToIso(ns("2026-01-02T03:04:05.000Z")), "2026-01-02T03:04:05.000Z");
    assert.equal(nanoToIso("0"), null);
    assert.equal(nanoToIso("abc"), null);
    assert.equal(nanoToIso(undefined), null);
  });
});

function row(id: string, parent: string | null, startOff: number, endOff: number | null, extra: Partial<SpanRow> = {}): SpanRow {
  const t0 = Date.parse("2026-10-09T12:00:00.000Z");
  return {
    trace_id: TRACE, span_id: id, parent_span_id: parent, agent_id: "a", session_id: null, name: id, kind: "tool",
    status: "ok", status_message: null, started_at: new Date(t0 + startOff).toISOString(),
    ended_at: endOff === null ? null : new Date(t0 + endOff).toISOString(),
    attributes: {}, model: null, input_tokens: null, output_tokens: null, cost_usd: null, ...extra,
  };
}

describe("buildWaterfall", () => {
  it("orders children under parents with depth and proportional bars", () => {
    const wf = buildWaterfall([row("c", "a", 6000, 8000), row("b", "a", 1000, 4000), row("a", null, 0, 10000), row("d", "b", 2000, 3000)]);
    assert.deepEqual(wf.rows.map((r) => [r.span.span_id, r.depth]), [["a", 0], ["b", 1], ["d", 2], ["c", 1]]);
    assert.equal(wf.totalMs, 10000);
    const b = wf.rows[1];
    assert.equal(b.offsetPct, 10);
    assert.equal(b.widthPct, 30);
    assert.equal(b.durationMs, 3000);
  });

  it("treats a span with a missing parent as a root and survives cycles", () => {
    const wf = buildWaterfall([row("x", "ghost", 0, 100), row("p", "q", 0, 50), row("q", "p", 10, 60)]);
    assert.ok(wf.rows.some((r) => r.span.span_id === "x" && r.depth === 0));
    assert.deepEqual(wf.rows.map((r) => r.span.span_id).sort(), ["p", "q", "x"], "every span is shown exactly once, cycle members included");
  });

  it("extends open spans to now and flags them", () => {
    const now = Date.parse("2026-10-09T12:00:30.000Z");
    const wf = buildWaterfall([row("a", null, 0, null)], now);
    assert.equal(wf.totalMs, 30000);
    assert.equal(wf.rows[0].open, true);
    assert.equal(wf.rows[0].durationMs, null);
  });

  it("returns an empty waterfall for no spans", () => {
    assert.deepEqual(buildWaterfall([]).rows, []);
  });
});

describe("formatDuration", () => {
  it("formats ranges", () => {
    assert.equal(formatDuration(null), "running");
    assert.equal(formatDuration(0), "<1ms");
    assert.equal(formatDuration(250), "250ms");
    assert.equal(formatDuration(1500), "1.50s");
    assert.equal(formatDuration(75_000), "1m 15s");
  });
});

describe("sanitizer hardening", () => {
  it("drops indexed prompt and tool-content keys by default", () => {
    const out = sanitizeAttributes({
      "gen_ai.prompt.0.content": "Use sk-abcdefghijklmnopqrstuv",
      "gen_ai.completion.0.content": "x",
      "gen_ai.input.messages": "[]",
      "tool.input.command": "cat ~/.ssh/id_rsa",
      "gen_ai.usage.input_tokens": 5,
      "tool.name": "Bash",
    });
    // Token counts are filtered too (the name contains "token") but live in their own columns.
    assert.deepEqual(out, { "tool.name": "Bash" });
  });

  it("classifies a long key before truncating it", () => {
    const key = "a".repeat(70) + ".password";
    assert.deepEqual(sanitizeAttributes({ [key]: "hunter2" }), {});
  });

  it("scrubs obvious credentials inside values, names and status messages", () => {
    assert.equal(redactText("token sk-abcdefghijklmnopqrstuv end"), "token [redacted] end");
    assert.equal(redactText("Authorization: Bearer abcdefghijklmnop1234"), "Authorization: [redacted]");
    assert.equal(redactText("ghp_abcdefghijklmnopqrstuvwxyz0123"), "[redacted]");
    const r = parseOtlp(otlp([span({ name: "call sk-abcdefghijklmnopqrstuv", status: { code: 2, message: "failed with ghp_abcdefghijklmnopqrstuvwxyz0123" } })]));
    assert.equal(r.spans[0].name, "call [redacted]");
    assert.equal(r.spans[0].status_message, "failed with [redacted]");
  });
});

describe("numeric validation", () => {
  it("drops token and cost values that would not fit the database, keeping the span", () => {
    const attrs = (k: string, v: object) => ({ key: k, value: v });
    const r = parseOtlp(
      otlp([
        span({ attributes: [attrs("gen_ai.usage.input_tokens", { doubleValue: 1e21 }), attrs("gen_ai.usage.output_tokens", { doubleValue: 2.5 }), attrs("agentkontrol.cost_usd", { doubleValue: 1e15 })] }),
        span({ spanId: "00000000000000b2", attributes: [attrs("gen_ai.usage.input_tokens", { intValue: "9007199254740991" }), attrs("agentkontrol.cost_usd", { doubleValue: 1e-7 })] }),
      ]),
    );
    assert.equal(r.spans.length, 2);
    assert.deepEqual([r.spans[0].input_tokens, r.spans[0].output_tokens, r.spans[0].cost_usd], [null, null, null]);
    assert.deepEqual([r.spans[1].input_tokens, r.spans[1].cost_usd], [9007199254740991, 1e-7]);
  });
});

describe("monotonic merge", () => {
  it("an error is never overwritten by ok, in either arrival order", () => {
    assert.equal(mergeStatus("error", "ok"), "error");
    assert.equal(mergeStatus("ok", "error"), "error");
    assert.equal(mergeStatus("unset", "ok"), "ok");
    assert.equal(mergeStatus("ok", "unset"), "ok");
  });

  it("keeps the later end and the failure when updates arrive out of order", () => {
    const closed = parseOtlp(otlp([span({ status: { code: 2, message: "boom" }, endTimeUnixNano: ns("2026-10-09T12:00:05.000Z") })])).spans[0];
    const staleOk = parseOtlp(otlp([span({ status: { code: 1 }, endTimeUnixNano: ns("2026-10-09T12:00:01.000Z") })])).spans[0];
    const m = dedupeSpans([closed, staleOk]);
    assert.equal(m[0].status, "error");
    assert.equal(m[0].status_message, "boom");
    assert.equal(m[0].ended_at, "2026-10-09T12:00:05.000Z");
  });
});
