import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRunTelemetry, summarizeRuns, type RunView } from "../../src/lib/run-telemetry";
import { wrapperRunView } from "../../src/lib/wrapper-runs";

// Shapes as stored by /api/ingest from the fleet wrappers (emit-event.sh): detail holds
// outcome, exit, at, event_id and file paths. There is no duration unless elapsed_s is sent.
const review = {
  id: 2505702, agent_id: "fleet-review-macbook-pro-4", platform: "codex", created_at: "2026-11-25T01:45:17.659Z",
  detail: { at: "2026-11-25T01:45:16Z", out: "/tmp/review.log", exit: 0, outcome: "VERDICT: REQUEST_CHANGES", event_id: "20261125T014515Z-review-cb8d715d" },
};
const dispatch = {
  id: 2505800, agent_id: "fleet-dispatch-mac-mini", platform: "grok", created_at: "2026-11-25T02:00:05.000Z",
  detail: { at: "2026-11-25T02:00:04Z", exit: 0, outcome: "finished", event_id: "20261125T020004Z-dispatch-aaaa1111", elapsed_s: "612" },
};
const since = Date.parse("2026-11-25T00:00:00Z"), until = since + 86400000;

describe("fleet wrapper records as runs", () => {
  it("maps a review record to a completed review run with an unknown duration", () => {
    const view = wrapperRunView(review);
    assert.ok(view);
    assert.equal(view.run.role, "review");
    assert.equal(view.run.outcome, "completed"); // the reviewer ran to a verdict; the verdict is not a failure
    assert.equal(view.run.ended_at, "2026-11-25T01:45:16.000Z");
    assert.equal(view.duration_known, false);
    assert.equal(view.run.usage_scope, "unavailable");
    assert.deepEqual(view.run.model_usage, []);
    assert.equal(view.platform, "codex");
    assert.ok(parseRunTelemetry(view.run), "must satisfy the existing run contract");
  });

  it("uses elapsed_s as the duration when the wrapper sends it", () => {
    const view = wrapperRunView(dispatch);
    assert.ok(view);
    assert.equal(view.run.role, "worker");
    assert.equal(view.run.duration_ms, 612000);
    assert.equal(view.duration_known, true);
    assert.equal(view.run.started_at, "2026-11-25T01:49:52.000Z");
    assert.ok(parseRunTelemetry(view.run));
  });

  it("gives the same record the same run id, and different records different ids", () => {
    const a = wrapperRunView(review)!, b = wrapperRunView({ ...review, id: 999 })!, c = wrapperRunView(dispatch)!;
    assert.equal(a.run.run_id, b.run.run_id);
    assert.notEqual(a.run.run_id, c.run.run_id);
  });

  it("classifies failures without copying wrapper text", () => {
    const outcome = (o: string, exit: number | string) => wrapperRunView({ ...dispatch, detail: { ...dispatch.detail, outcome: o, exit } })!.run;
    assert.deepEqual([outcome("wall-timeout", 124).outcome, outcome("wall-timeout", 124).error_class], ["timeout", "timeout"]);
    assert.deepEqual([outcome("stalled-after-commit", 125).outcome, outcome("stalled", 125).error_class], ["timeout", "timeout"]);
    assert.deepEqual([outcome("grok-exited-nonzero", 1).outcome, outcome("grok-exited-nonzero", 1).error_class], ["failed", "process_error"]);
    assert.deepEqual([outcome("launch-failed", 126).outcome, outcome("launch-failed", 126).error_class], ["unavailable", "unavailable"]);
    assert.equal(outcome("handed-off", 0).outcome, "completed");
    assert.equal(outcome("finished (orphans-killed)", 0).outcome, "completed");
    const noVerdict = wrapperRunView({ ...review, detail: { ...review.detail, outcome: "no-verdict", exit: 2 } })!.run;
    assert.deepEqual([noVerdict.outcome, noVerdict.error_class], ["failed", "protocol_error"]);
    const none = wrapperRunView({ ...review, detail: { ...review.detail, outcome: "VERDICT: NONE (codex run terminated by usage limit)", exit: 4 } })!.run;
    assert.equal(none.outcome, "failed");
    assert.ok(!JSON.stringify(none).includes("usage limit"));
  });

  it("ignores records that are not wrapper runs", () => {
    assert.equal(wrapperRunView({ ...review, agent_id: "claude-macbook" }), null);
    assert.equal(wrapperRunView({ ...review, agent_id: "fleet-other-macbook" }), null);
    assert.equal(wrapperRunView({ ...review, detail: null }), null);
    assert.equal(wrapperRunView({ ...review, detail: { exit: 0 } }), null);
    assert.equal(wrapperRunView({ ...review, created_at: "not a date", detail: { ...review.detail, at: "nope" } }), null);
  });

  it("ignores an absurd elapsed value instead of inventing a duration", () => {
    for (const elapsed_s of ["-5", "abc", "99999999", ""]) {
      const view = wrapperRunView({ ...dispatch, detail: { ...dispatch.detail, elapsed_s } })!;
      assert.equal(view.duration_known, false, elapsed_s);
      assert.equal(view.run.duration_ms, 0);
    }
  });
});

describe("run metrics with unknown durations", () => {
  it("counts every run but takes percentiles only from known durations", () => {
    const rows: RunView[] = [wrapperRunView(review)!, wrapperRunView(dispatch)!];
    const metrics = summarizeRuns(rows, since, until);
    assert.equal(metrics.totals.completed_runs, 2);
    assert.equal(metrics.totals.runs_with_duration, 1);
    assert.equal(metrics.totals.p50_duration_ms, 612000);
    assert.equal(metrics.totals.failed_runs, 0);
    assert.equal(metrics.runs.find((r) => r.run.role === "review")!.duration_known, false);
  });

  it("reports no percentile when no run has a known duration", () => {
    const metrics = summarizeRuns([wrapperRunView(review)!], since, until);
    assert.equal(metrics.totals.completed_runs, 1);
    assert.equal(metrics.totals.runs_with_duration, 0);
    assert.equal(metrics.totals.p50_duration_ms, null);
  });
});
