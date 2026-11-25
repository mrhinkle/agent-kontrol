import { isConfigured, sql } from "./db";
import { parseRunTelemetry, platformLabel, summarizeRuns, type RunView } from "./run-telemetry";
import { wrapperRunView } from "./wrapper-runs";

export async function runMetrics(now = new Date()) {
  const until = now.getTime(), since = until - 86400_000;
  if (!isConfigured()) {
    const demo: RunView[] = [
      { event_id: 1, agent_id: "claude-demo", platform: "claude-code", run: { schema: "mc.run.v2", run_id: "11111111-1111-4111-8111-111111111111", role: "worker", started_at: new Date(until - 120_000).toISOString(), ended_at: new Date(until - 60_000).toISOString(), duration_ms: 60_000, outcome: "completed", error_class: null, usage_scope: "run", usage_complete: true, model_usage: [{ model: "claude-sonnet-demo", input_tokens: 12000, output_tokens: 900 }], task_id: 1 } },
      { event_id: 2, agent_id: "grok-demo", platform: "grok", run: { schema: "mc.run.v2", run_id: "22222222-2222-4222-8222-222222222222", role: "review", started_at: new Date(until - 300_000).toISOString(), ended_at: new Date(until - 270_000).toISOString(), duration_ms: 30_000, outcome: "failed", error_class: "process_error", usage_scope: "unavailable", usage_complete: false, model_usage: [] } },
    ];
    return { ...summarizeRuns(demo, since, until), demo: true, truncated: false, window: "24h" };
  }
  const db = sql();
  const rows = await db`
    select e.id, e.agent_id, a.platform, e.detail from events e
    left join agents a on a.id = e.agent_id
    where e.kind = 'run_complete' and e.created_at >= ${new Date(since).toISOString()}::timestamptz
    order by e.created_at desc, e.id desc limit 1001
  `;
  const runs: RunView[] = [];
  for (const row of rows.slice(0, 1000)) {
    const run = parseRunTelemetry(row.detail);
    if (run) runs.push({ event_id: Number(row.id), agent_id: String(row.agent_id), platform: platformLabel(row.platform), run });
  }
  // The two sources are separate launch paths, so one run is never in both: the dispatcher starts
  // CLIs itself and never calls a fleet wrapper, and the wrappers never emit run_complete. Each
  // source is capped at 1,000 rows, so the sample can hold up to 2,000; `truncated` is set when
  // either source hit its cap, and the page says the cap is per source.
  // Fleet wrapper records (fleet-dispatch.sh, codex-review.sh, spec-review.sh) are stored as
  // ordinary milestone or error events. They are read here and shown as runs; nothing is copied.
  const wrapperRows = await db`
    select e.id, e.agent_id, a.platform, e.detail, e.created_at from events e
    left join agents a on a.id = e.agent_id
    where e.kind in ('milestone', 'error') and e.agent_id like 'fleet-%' and e.created_at >= ${new Date(since).toISOString()}::timestamptz
    order by e.created_at desc, e.id desc limit 1001
  `;
  for (const row of wrapperRows.slice(0, 1000)) {
    const view = wrapperRunView({ id: row.id, agent_id: String(row.agent_id), platform: row.platform, created_at: row.created_at, detail: row.detail });
    if (view) runs.push(view);
  }
  return { ...summarizeRuns(runs, since, until), demo: false, truncated: rows.length > 1000 || wrapperRows.length > 1000, window: "24h" };
}

export type RunMetrics = Awaited<ReturnType<typeof runMetrics>>;
