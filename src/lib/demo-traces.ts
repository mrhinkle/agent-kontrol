import type { SpanRow, TraceSummary } from "./traces";

/** Synthetic traces for demo mode (no database). Times are relative to now. */
export function demoSpans(nowMs: number = Date.now()): SpanRow[] {
  const trace = "d3m0d3m0d3m0d3m0d3m0d3m0d3m0d3m0".replace(/[^0-9a-f]/g, "a");
  const t0 = nowMs - 95_000;
  const at = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
  const base = {
    trace_id: trace,
    agent_id: "demo-claude-code",
    session_id: "demo-session",
    status_message: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
  } as const;
  return [
    { ...base, span_id: "00000000000000a1", parent_span_id: null, name: "session", kind: "session", status: "ok", started_at: at(0), ended_at: null, attributes: { project: "api-server" } },
    { ...base, span_id: "00000000000000a2", parent_span_id: "00000000000000a1", name: "turn 1", kind: "turn", status: "ok", started_at: at(500), ended_at: at(41_000), attributes: {} },
    { ...base, span_id: "00000000000000a3", parent_span_id: "00000000000000a2", name: "Read", kind: "tool", status: "ok", started_at: at(2_000), ended_at: at(2_400), attributes: { "tool.name": "Read" } },
    { ...base, span_id: "00000000000000a4", parent_span_id: "00000000000000a2", name: "Grep", kind: "tool", status: "ok", started_at: at(3_000), ended_at: at(3_900), attributes: { "tool.name": "Grep" } },
    { ...base, span_id: "00000000000000a5", parent_span_id: "00000000000000a2", name: "Edit", kind: "tool", status: "ok", started_at: at(9_000), ended_at: at(9_300), attributes: { "tool.name": "Edit" } },
    { ...base, span_id: "00000000000000a6", parent_span_id: "00000000000000a2", name: "Bash", kind: "tool", status: "error", status_message: "exit status 1", started_at: at(12_000), ended_at: at(31_000), attributes: { "tool.name": "Bash" } },
    { ...base, span_id: "00000000000000a7", parent_span_id: "00000000000000a2", name: "Bash", kind: "tool", status: "ok", started_at: at(33_000), ended_at: at(40_000), attributes: { "tool.name": "Bash" } },
    { ...base, span_id: "00000000000000a8", parent_span_id: "00000000000000a1", name: "turn 2", kind: "turn", status: "ok", started_at: at(55_000), ended_at: null, attributes: {} },
    { ...base, span_id: "00000000000000a9", parent_span_id: "00000000000000a8", name: "Read", kind: "tool", status: "ok", started_at: at(56_000), ended_at: at(56_300), attributes: { "tool.name": "Read" } },
  ];
}

export function demoSummary(spans: SpanRow[]): TraceSummary {
  return {
    trace_id: spans[0].trace_id,
    agent_id: spans[0].agent_id,
    root_name: "session",
    started_at: spans[0].started_at,
    ended_at: null,
    span_count: spans.length,
    error_count: spans.filter((s) => s.status === "error").length,
    open_count: spans.filter((s) => s.ended_at === null).length,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
}
