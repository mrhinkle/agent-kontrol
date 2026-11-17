import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRunTelemetry, safeModel, summarizeRuns, type RunTelemetry, type RunView } from "../../src/lib/run-telemetry";
import { langfuseRunPayload } from "../../src/lib/langfuse-run";
import { execFileSync } from "node:child_process";

const run: RunTelemetry = {
  schema: "mc.run.v2", run_id: "11111111-1111-4111-8111-111111111111", role: "worker",
  started_at: "2026-10-16T12:00:00Z", ended_at: "2026-10-16T12:00:10Z", duration_ms: 10000,
  outcome: "completed", error_class: null, usage_scope: "run", usage_complete: true,
  model_usage: [{ model: "gpt-6.1-sol", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 400 }],
};
const row: RunView = { event_id: 1, agent_id: "codex-macbook", platform: "codex", run };

describe("completed run contract", () => {
  it("keeps only safe metadata and numeric usage", () => {
    const result = parseRunTelemetry({ ...run, prompt: "SECRET_PROMPT", result: "SECRET_RESULT", cost_usd: 100, env: "SECRET_ENV", error_class: "SECRET_ERROR", model_usage: [{ ...run.model_usage[0], raw: "SECRET_MESSAGE" }] });
    assert.ok(result);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    assert.ok(!JSON.stringify(result).includes("cost"));
    assert.equal(result.error_class, null);
  });

  it("rejects impossible durations, malformed usage, and repeated cumulative usage", () => {
    for (const change of [{ ended_at: "2026-10-15T00:00:00Z" }, { duration_ms: 1 }, { duration_ms: Infinity }, { run_id: "secret-key" }, { usage_scope: "session_cumulative" }, { model_usage: [{ model: "grok-4", input_tokens: -1 }] }, { model_usage: [{ model: "grok-4", output_tokens: "200" }] }]) {
      assert.equal(parseRunTelemetry({ ...run, ...change }), null, JSON.stringify(change));
    }
    assert.ok(parseRunTelemetry({ ...run, usage_scope: "session_cumulative", model_usage: [] }));
  });

  it("does not send credential-like or free-text model labels", () => {
    for (const name of ["sk-secret-token", "gpt-secret-key", "A model response", "someone@example.com", "__proto__", "constructor"]) assert.equal(safeModel(name), "unknown");
    assert.equal(safeModel("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
  });

  it("accepts the actual Python producer contract without sharing its validator", () => {
    const fixture = execFileSync("python3", ["-c", `
import sys,json
from datetime import datetime,timezone,timedelta
sys.path.insert(0,'agents/dispatcher')
from run_telemetry import parse_cli_output,build_detail
parsed=parse_cli_output('grok',json.dumps({'text':'PRIVATE_RESULT','modelUsage':{'grok-test':{'inputTokens':10,'cacheReadInputTokens':5,'outputTokens':3}}}))
start=datetime(2026,10,16,12,0,0,tzinfo=timezone.utc)
print(json.dumps(build_detail(review=False,started_at=start,ended_at=start+timedelta(seconds=2),duration_ms=2000,outcome='completed',error_class=None,parsed=parsed,cumulative=False,task_id=1)))
`], { encoding: "utf8" });
    const result = parseRunTelemetry(JSON.parse(fixture));
    assert.ok(result);
    assert.equal(result.model_usage[0].input_tokens, 15);
    assert.equal(result.duration_ms, 2000);
    assert.ok(!fixture.includes("PRIVATE_RESULT"));
  });
});

describe("run metrics", () => {
  const since = Date.parse("2026-10-16T00:00:00Z"), until = since + 86400000;
  it("counts stable run IDs once and never adds cached input twice", () => {
    const metrics = summarizeRuns([row, { ...row, event_id: 2 }], since, until);
    assert.equal(metrics.totals.completed_runs, 1);
    assert.equal(metrics.models[0].input_tokens, 1000);
    assert.equal(metrics.totals.p50_duration_ms, 10000);
  });

  it("leaves unknown tokens unknown and excludes resumed counters", () => {
    const metrics = summarizeRuns([{ ...row, run: { ...run, model_usage: [{ model: "unknown", output_tokens: 1 }], usage_complete: false } }], since, until);
    assert.equal(metrics.models[0].input_tokens, null);
    assert.equal(metrics.totals.complete_usage_runs, 0);
    const resumed = summarizeRuns([{ ...row, run: { ...run, usage_scope: "session_cumulative", model_usage: [] } }], since, until);
    assert.deepEqual(resumed.models, []);
    assert.equal(resumed.totals.runs_with_usage, 0);
  });

  it("includes failures but excludes out-of-window runs", () => {
    const metrics = summarizeRuns([{ ...row, run: { ...run, outcome: "timeout", error_class: "timeout" } }], since, until);
    assert.equal(metrics.totals.failed_runs, 1);
    assert.equal(summarizeRuns([row], until, until + 86400000).totals.completed_runs, 0);
  });
});

describe("completed run OTLP", () => {
  it("creates one timed run and parented model totals without fabricating model latency", () => {
    const payload = langfuseRunPayload(run, "PRIVATE_AGENT", "codex", "production")!;
    const [root, model] = payload.resourceSpans[0].scopeSpans[0].spans;
    assert.notEqual(root.startTimeUnixNano, root.endTimeUnixNano);
    assert.equal(model.parentSpanId, root.spanId);
    assert.equal(model.startTimeUnixNano, model.endTimeUnixNano);
    assert.ok(JSON.stringify(root).includes("cli_process_wall_time"));
    assert.ok(JSON.stringify(model).includes("not_measured"));
    assert.ok(!JSON.stringify(payload).includes("generation"));
    assert.ok(!JSON.stringify(payload).includes("PRIVATE_AGENT"));
    assert.ok(!JSON.stringify(payload).includes("usage_details"));
  });

  it("marks timeout and process errors while dropping raw error messages", () => {
    const payload = langfuseRunPayload({ ...run, outcome: "timeout", error_class: "timeout" }, "agent", "codex", "production")!;
    assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].status.code, 2);
    assert.ok(JSON.stringify(payload).includes('"stringValue":"timeout"'));
  });
});
