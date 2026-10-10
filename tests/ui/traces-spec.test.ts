import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWaterfall, dedupeSpans, formatDuration, nanoToIso, parseOtlp, sanitizeAttributes, type SpanRow } from "../../src/lib/traces";

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


describe("hidden: sanitizer", () => {
  it("drops indexed prompt and tool-content keys by default", () => {
    const out = sanitizeAttributes({
      "gen_ai.prompt.0.content": "Use sk-abcdefghijklmnopqrstuv",
      "gen_ai.completion.0.content": "x",
      "gen_ai.input.messages": "[]",
      "gen_ai.system_instructions": "be nice",
      "tool.input.command": "cat ~/.ssh/id_rsa",
      "tool.name": "Bash",
    });
    assert.deepEqual(out, { "tool.name": "Bash" });
  });
  it("keeps content keys when captureContent is on, but never credentials", () => {
    const out = sanitizeAttributes({ "gen_ai.prompt": "hi", "tool.input": "{}", api_key: "k", "http.authorization": "x" }, { captureContent: true });
    assert.deepEqual(out, { "gen_ai.prompt": "hi", "tool.input": "{}" });
  });
  it("classifies a long key before truncating it", () => {
    assert.deepEqual(sanitizeAttributes({ ["a".repeat(70) + ".password"]: "hunter2" }), {});
  });
  it("recognizes every api-key and private-key spelling", () => {
    for (const k of ["api_key", "api-key", "api.key", "apikey", "API_KEY", "private_key", "private-key", "privatekey", "x.cookie", "Credential"]) {
      assert.deepEqual(sanitizeAttributes({ [k]: "v" }), {}, k);
    }
  });
  it("caps lengths and counts, and skips non-primitives and NaN", () => {
    assert.equal(String(sanitizeAttributes({ k: "x".repeat(2000) }).k).length, 500);
    assert.equal(Object.keys(sanitizeAttributes(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])))).length, 40);
    assert.deepEqual(sanitizeAttributes({ a: NaN, b: Infinity, c: null, d: [1], e: { x: 1 }, f: undefined, g: 1 }), { g: 1 });
    assert.ok(Object.keys(sanitizeAttributes({ ["k".repeat(100)]: 1 }))[0].length <= 64);
  });
});

describe("hidden: parseOtlp", () => {
  it("drops token and cost values that do not fit, keeping the span", () => {
    const a = (k: string, v: object) => ({ key: k, value: v });
    const r = parseOtlp(otlp([
      span({ attributes: [a("gen_ai.usage.input_tokens", { doubleValue: 1e21 }), a("gen_ai.usage.output_tokens", { doubleValue: 2.5 }), a("agentkontrol.cost_usd", { doubleValue: 1e15 })] }),
      span({ spanId: "00000000000000b2", attributes: [a("gen_ai.usage.input_tokens", { intValue: "9007199254740991" }), a("agentkontrol.cost_usd", { doubleValue: 1e-7 }), a("gen_ai.usage.completion_tokens", { intValue: 7 })] }),
      span({ spanId: "00000000000000b3", attributes: [a("gen_ai.usage.input_tokens", { intValue: -4 })] }),
    ]));
    assert.equal(r.spans.length, 3);
    assert.deepEqual([r.spans[0].input_tokens, r.spans[0].output_tokens, r.spans[0].cost_usd], [null, null, null]);
    assert.deepEqual([r.spans[1].input_tokens, r.spans[1].cost_usd, r.spans[1].output_tokens], [9007199254740991, 1e-7, 7]);
    assert.equal(r.spans[2].input_tokens, null);
  });
  it("lowercases ids, treats a bad parent as a root, and reads string status codes", () => {
    const r = parseOtlp(otlp([span({ traceId: TRACE.toUpperCase(), spanId: "00000000000000AB", parentSpanId: "nope", status: { code: "STATUS_CODE_ERROR" } })]));
    assert.equal(r.spans[0].trace_id, TRACE);
    assert.equal(r.spans[0].span_id, "00000000000000ab");
    assert.equal(r.spans[0].parent_span_id, null);
    assert.equal(r.spans[0].status, "error");
  });
  it("applies the kind rules in order", () => {
    const k = (attrs: object[], extra: object = {}) => parseOtlp(otlp([span({ attributes: attrs, ...extra })])).spans[0].kind;
    const s = (key: string, value: string) => ({ key, value: { stringValue: value } });
    assert.equal(k([s("agentkontrol.span.kind", "turn"), s("tool.name", "x")]), "turn");
    assert.equal(k([s("gen_ai.operation.name", "execute_tool")]), "tool");
    assert.equal(k([s("gen_ai.operation.name", "chat")]), "model");
    assert.equal(k([s("gen_ai.system", "x")]), "model");
    assert.equal(k([s("tool.name", "Bash")], { parentSpanId: "00000000000000f1" }), "tool");
    assert.equal(k([], { parentSpanId: "00000000000000f1" }), "other");
    assert.equal(k([]), "session");
    assert.equal(k([s("agentkontrol.span.kind", "bogus")]), "session");
  });
  it("limits free-text fields", () => {
    const r = parseOtlp(otlp([span({ name: "n".repeat(500), status: { code: 2, message: "m".repeat(900) } })]));
    assert.equal(r.spans[0].name.length, 200);
    assert.equal(r.spans[0].status_message?.length, 500);
    assert.equal(parseOtlp(otlp([span({ name: undefined })])).spans[0].name, "span");
  });
  it("reads session ids from the span, then the resource", () => {
    const r1 = parseOtlp(otlp([span({ attributes: [{ key: "session.id", value: { stringValue: "from-span" } }] })], [{ key: "agent.id", value: { stringValue: "a" } }, { key: "session.id", value: { stringValue: "from-res" } }]));
    assert.equal(r1.spans[0].session_id, "from-span");
    const r2 = parseOtlp(otlp([span()], [{ key: "agent.id", value: { stringValue: "a" } }, { key: "session.id", value: { stringValue: "from-res" } }]));
    assert.equal(r2.spans[0].session_id, "from-res");
  });
  it("never throws on garbage", () => {
    for (const bad of [undefined, 5, "x", [], { resourceSpans: "no" }, { resourceSpans: [null, 3, {}] }, { resourceSpans: [{ scopeSpans: [{ spans: [null, "x", { traceId: 1 }] }] }] }]) {
      assert.doesNotThrow(() => parseOtlp(bad));
    }
  });
  it("accepts exactly 500 spans and reports the limit beyond that", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => span({ spanId: (i + 1).toString(16).padStart(16, "0") }));
    const ok = parseOtlp(otlp(mk(500)));
    assert.equal(ok.spans.length, 500);
    assert.equal(ok.errors.length, 0);
    const over = parseOtlp(otlp(mk(501)));
    assert.equal(over.spans.length, 500);
    assert.ok(over.errors.some((e) => /500/.test(e)));
  });
});

describe("hidden: nanoToIso", () => {
  it("is exact on 19-digit nanosecond strings and accepts numbers and bigints", () => {
    assert.equal(nanoToIso("1790000000123456789"), "2026-09-21T14:13:20.123Z");
    assert.equal(nanoToIso(1790000000123n * 1_000_000n), "2026-09-21T14:13:20.123Z");
    assert.equal(nanoToIso(1.79e18), "2026-09-21T14:13:20.000Z");
    for (const bad of ["", "0", 0, "1e999999", "99999999999999999999999999", {}, [], null, NaN]) assert.equal(nanoToIso(bad), null, String(bad));
  });
});

describe("hidden: dedupeSpans", () => {
  it("is order independent: an error is never overwritten and the later end wins", () => {
    const closed = parseOtlp(otlp([span({ status: { code: 2, message: "boom" }, endTimeUnixNano: ns("2026-10-09T12:00:05.000Z") })])).spans[0];
    const staleOk = parseOtlp(otlp([span({ status: { code: 1 }, endTimeUnixNano: ns("2026-10-09T12:00:01.000Z") })])).spans[0];
    for (const order of [[closed, staleOk], [staleOk, closed]]) {
      const m = dedupeSpans(order);
      assert.equal(m.length, 1);
      assert.equal(m[0].status, "error");
      assert.equal(m[0].ended_at, "2026-10-09T12:00:05.000Z");
    }
  });
  it("keeps the earliest start, combines attributes, prefers non-null fields, and keeps first-seen order", () => {
    const a = { ...parseOtlp(otlp([span({ startTimeUnixNano: ns("2026-10-09T12:00:02.000Z"), endTimeUnixNano: undefined, attributes: [{ key: "a", value: { intValue: 1 } }] })])).spans[0], model: "m1", cost_usd: null };
    const b = { ...parseOtlp(otlp([span({ startTimeUnixNano: ns("2026-10-09T12:00:00.000Z"), attributes: [{ key: "b", value: { intValue: 2 } }] })])).spans[0], model: null, cost_usd: 0.5 };
    const other = parseOtlp(otlp([span({ spanId: "00000000000000c9" })])).spans[0];
    const m = dedupeSpans([a, other, b]);
    assert.deepEqual(m.map((s) => s.span_id), [a.span_id, other.span_id]);
    assert.equal(m[0].started_at, "2026-10-09T12:00:00.000Z");
    assert.deepEqual(m[0].attributes, { a: 1, b: 2 });
    assert.equal(m[0].model, "m1");
    assert.equal(m[0].cost_usd, 0.5);
  });
  it("does not mutate its input", () => {
    const a = parseOtlp(otlp([span({ endTimeUnixNano: undefined })])).spans[0];
    const b = parseOtlp(otlp([span()])).spans[0];
    const snapshot = JSON.stringify([a, b]);
    dedupeSpans([a, b]);
    assert.equal(JSON.stringify([a, b]), snapshot);
  });
});

function row(id: string, parent: string | null, startOff: number, endOff: number | null): SpanRow {
  const t0 = Date.parse("2026-10-09T12:00:00.000Z");
  return { trace_id: TRACE, span_id: id, parent_span_id: parent, agent_id: "a", session_id: null, name: id, kind: "tool", status: "ok", status_message: null,
    started_at: new Date(t0 + startOff).toISOString(), ended_at: endOff === null ? null : new Date(t0 + endOff).toISOString(),
    attributes: {}, model: null, input_tokens: null, output_tokens: null, cost_usd: null };
}

describe("hidden: buildWaterfall", () => {
  it("visits every span exactly once even with a self-parent or a cycle", () => {
    const wf = buildWaterfall([row("self", "self", 0, 10), row("p", "q", 0, 50), row("q", "p", 10, 60), row("ok", null, 5, 6)]);
    const ids = wf.rows.map((r) => r.span.span_id).sort();
    assert.deepEqual(ids, ["ok", "p", "q", "self"], "every span appears, none twice");
  });
  it("gives instant spans a visible bar and clamps bars inside the window", () => {
    const wf = buildWaterfall([row("a", null, 0, 10_000), row("b", "a", 5_000, 5_000)]);
    const b = wf.rows.find((r) => r.span.span_id === "b")!;
    assert.ok(b.widthPct >= 0.4);
    for (const r of wf.rows) assert.ok(r.offsetPct >= 0 && r.offsetPct + Math.min(r.widthPct, 100) <= 100.0001 + 0.4);
  });
  it("totalMs is at least 1 for a single instant span, and uses nowMs for open spans", () => {
    assert.equal(buildWaterfall([row("a", null, 0, 0)]).totalMs, 1);
    const now = Date.parse("2026-10-09T12:00:30.000Z");
    const wf = buildWaterfall([row("a", null, 0, null), row("b", "a", 1000, 2000)], now);
    assert.equal(wf.totalMs, 30000);
    assert.equal(wf.endMs, now);
  });
  it("orders siblings by start time regardless of input order", () => {
    const wf = buildWaterfall([row("late", "r", 9000, 9500), row("early", "r", 1000, 1500), row("r", null, 0, 10000)]);
    assert.deepEqual(wf.rows.map((r) => r.span.span_id), ["r", "early", "late"]);
  });
});

describe("hidden: formatDuration", () => {
  it("covers boundaries", () => {
    assert.equal(formatDuration(0.4), "<1ms");
    assert.equal(formatDuration(999), "999ms");
    assert.equal(formatDuration(1000), "1.00s");
    assert.equal(formatDuration(12_340), "12.3s");
    assert.equal(formatDuration(60_000), "1m 0s");
    assert.equal(formatDuration(75_000), "1m 15s");
  });
});
