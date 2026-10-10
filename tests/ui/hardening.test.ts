import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWaterfall, dedupeSpans, formatDuration, parseWholeDays, retentionDays, sanitizeAttributes, type SpanInput, type SpanRow } from "../../src/lib/traces";
import { buildSessionNote, writebackDays, type SessionFacts } from "../../src/lib/session-note";

const TRACE = "0123456789abcdef0123456789abcdef";
const T0 = Date.parse("2026-10-09T12:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const id = (n: number) => n.toString(16).padStart(16, "0");

function row(span_id: string, parent: string | null, start: number, end: number | null, extra: Partial<SpanRow> = {}): SpanRow {
  return {
    trace_id: TRACE, span_id, parent_span_id: parent, agent_id: "a", session_id: null, name: span_id, kind: "tool", status: "ok",
    status_message: null, started_at: iso(start), ended_at: end === null ? null : iso(end), attributes: {}, model: null,
    input_tokens: null, output_tokens: null, cost_usd: null, ...extra,
  };
}

describe("pure functions tolerate hostile input", () => {
  it("sanitizeAttributes returns {} for anything that is not a plain object", () => {
    for (const bad of [null, undefined, 5, "x", true, [1, 2]]) assert.deepEqual(sanitizeAttributes(bad as never), {});
  });
  it("buildWaterfall returns an empty waterfall for anything that is not an array", () => {
    for (const bad of [null, undefined, 5, "x", {}]) assert.deepEqual(buildWaterfall(bad as never), { rows: [], startMs: 0, endMs: 0, totalMs: 0 });
  });
});

describe("buildWaterfall layout", () => {
  it("ignores array elements that are not spans", () => {
    const wf = buildWaterfall([null, 5, "x", {}, row(id(1), null, 0, 10)] as never);
    assert.deepEqual(wf.rows.map((r) => r.span.span_id), [id(1)]);
  });
  it("handles a 30,000-deep parent chain without overflowing the stack", () => {
    const spans = Array.from({ length: 30_000 }, (_, i) => row(id(i + 1), i === 0 ? null : id(i), i, i + 1));
    const wf = buildWaterfall(spans);
    assert.equal(wf.rows.length, 30_000);
    assert.equal(wf.rows[0].depth, 0);
    assert.equal(wf.rows[29_999].depth, 29_999);
    assert.equal(new Set(wf.rows.map((r) => r.span.span_id)).size, 30_000, "every span exactly once");
  });
  it("keeps a child under its parent even when the child's clock says it started first", () => {
    const wf = buildWaterfall([row(id(1), null, 1000, 5000), row(id(2), id(1), 500, 900)]);
    assert.deepEqual(wf.rows.map((r) => [r.span.span_id, r.depth]), [[id(1), 0], [id(2), 1]]);
  });
  it("shows every span of a cycle once, with the rest of the trace intact", () => {
    const wf = buildWaterfall([row(id(1), id(2), 10, 20), row(id(2), id(1), 0, 30), row(id(3), null, 5, 6), row(id(4), id(3), 5, 6)]);
    assert.deepEqual(wf.rows.map((r) => r.span.span_id).sort(), [id(1), id(2), id(3), id(4)]);
    assert.equal(wf.rows.find((r) => r.span.span_id === id(4))!.depth, 1);
  });
  it("skips a span with an unparseable start and clamps an end that precedes the start", () => {
    const wf = buildWaterfall([row(id(1), null, 0, 100), row(id(2), id(1), 0, 0, { started_at: "not a date" }), row(id(3), id(1), 50, 10)]);
    assert.deepEqual(wf.rows.map((r) => r.span.span_id), [id(1), id(3)]);
    const clamped = wf.rows[1];
    assert.equal(clamped.durationMs, 0);
    assert.ok(clamped.widthPct >= 0.4 && clamped.offsetPct >= 0 && clamped.offsetPct <= 100);
  });
  it("orders siblings by start time, then by id, for a stable layout", () => {
    const wf = buildWaterfall([row(id(9), id(1), 10, 11), row(id(3), id(1), 10, 11), row(id(2), id(1), 5, 6), row(id(1), null, 0, 20)]);
    assert.deepEqual(wf.rows.map((r) => r.span.span_id), [id(1), id(2), id(3), id(9)]);
  });
});

describe("formatDuration", () => {
  it("treats a non-finite value like an unknown duration", () => {
    for (const v of [NaN, Infinity, -Infinity]) assert.equal(formatDuration(v), "running");
  });
});

describe("dedupeSpans compares times chronologically", () => {
  it("keeps the earlier instant even when its string sorts later (different UTC offsets)", () => {
    const base: SpanInput = { ...row(id(1), null, 0, null), ended_at: null };
    const laterString = { ...base, started_at: "2026-10-09T13:00:00.000+01:00" }; // 12:00Z, sorts after the other string
    const earlierString = { ...base, started_at: "2026-10-09T12:30:00.000Z" }; // 12:30Z, sorts before
    const merged = dedupeSpans([earlierString, laterString]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].started_at, "2026-10-09T13:00:00.000+01:00", "12:00Z is earlier than 12:30Z");
  });
});

describe("whole-number day settings", () => {
  it("parseWholeDays accepts only whole numbers from 1 to 999999", () => {
    const cases: [string | undefined, number][] = [["7", 7], [" 12 ", 12], ["999999", 999999], ["0", 30], ["-3", 30], ["1.5", 30], ["12days", 30], ["abc", 30], ["", 30], [undefined, 30], ["1234567", 30], ["1e3", 30], ["0x10", 30]];
    for (const [raw, want] of cases) assert.equal(parseWholeDays(raw, 30), want, JSON.stringify(raw));
    assert.equal(parseWholeDays("nope", 7), 7, "the fallback is a parameter");
  });
  it("retentionDays and writebackDays read their own variables strictly", () => {
    const saved = { ...process.env };
    try {
      for (const [raw, want] of [["14", 14], ["14.9", 30], ["14d", 30], ["0", 30]] as [string, number][]) {
        process.env.MC_TRACE_RETENTION_DAYS = raw;
        process.env.MC_MEMORY_WRITEBACK_DAYS = raw;
        assert.equal(retentionDays(), want, raw);
        assert.equal(writebackDays(), want, raw);
      }
    } finally {
      process.env = saved;
    }
  });
});

describe("session note counts", () => {
  const base: SessionFacts = {
    session_id: "s", agent_id: "a", display_name: null, platform: null, project: null, status: "done",
    started_at: "2026-10-09T12:00:00.000Z", ended_at: "2026-10-09T12:10:00.000Z",
    event_count: 5, error_count: 1, tools: [{ name: "Bash", count: 3, failed: 1 }], milestones: [], summary: null,
  };
  it("never prints negative, fractional or NaN counts", () => {
    const n = buildSessionNote({ ...base, event_count: -4, error_count: NaN, tools: [{ name: "Bash", count: 2.9, failed: -1 }, { name: "Edit", count: Infinity, failed: 0.7 }] })!;
    assert.match(n.content, /Events: 0, errors: 0\./);
    assert.match(n.content, /Tools: Bash×2, Edit×0\./);
    const countLines = n.content.split("\n").filter((l) => l.startsWith("Events:") || l.startsWith("Tools:")).join("\n");
    assert.doesNotMatch(countLines, /NaN|Infinity|-\d|\d\.\d/);
  });
  it("keeps the end timestamp line, as documented", () => {
    assert.match(buildSessionNote(base)!.content, /Outcome: done\. Ran 10m 0s\. Ended 2026-10-09T12:10:00\.000Z\./);
  });
  it("a session whose only tool count is fractional is still thin", () => {
    const thin = { ...base, ended_at: "2026-10-09T12:00:30.000Z", tools: [{ name: "Bash", count: 0.4, failed: 0 }] };
    assert.equal(buildSessionNote(thin), null);
  });
});
