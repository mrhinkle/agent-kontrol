/**
 * Fleet wrapper records shown as completed runs.
 *
 * The fleet wrappers (fleet-dispatch.sh, codex-review.sh, spec-review.sh) post one
 * milestone or error event to /api/ingest when a lane or review ends, under an agent
 * id of `fleet-<kind>-<host>`. This maps a stored event of that shape onto the
 * existing run contract at read time, so the work the fleet does appears beside
 * dispatcher runs with no change on any machine and nothing written twice.
 *
 * A wrapper record has no token counts, and no duration unless the wrapper sends
 * `elapsed_s` in its detail. Neither is invented: usage stays "unavailable" and an
 * unknown duration is marked, kept out of percentiles and shown as unavailable.
 */
import { createHash } from "node:crypto";
import { platformLabel, type RunTelemetry, type RunView } from "./run-telemetry";

export interface WrapperEventRow {
  id: number | string;
  agent_id: string;
  platform?: unknown;
  created_at: string | Date;
  detail: unknown;
}

const ROLES: Record<string, RunTelemetry["role"]> = { dispatch: "worker", review: "review", "spec-review": "review" };
const WEEK_MS = 7 * 86400_000;

/** A stable UUID-shaped id from the wrapper's own event id, so the same record is one run. */
function runId(agentId: string, eventId: string): string {
  const hex = createHash("sha256").update(`fleet-wrapper:${agentId}:${eventId}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function classify(outcome: string, exit: unknown): Pick<RunTelemetry, "outcome" | "error_class"> {
  const code = typeof exit === "number" ? exit : typeof exit === "string" && /^-?\d+$/.test(exit) ? Number(exit) : NaN;
  const text = outcome.toLowerCase();
  if (text.includes("timeout") || text.startsWith("stalled")) return { outcome: "timeout", error_class: "timeout" };
  if (code === 126 || code === 127) return { outcome: "unavailable", error_class: "unavailable" };
  if (text === "no-verdict" || text.startsWith("verdict: none")) return { outcome: "failed", error_class: "protocol_error" };
  // A review that reached any verdict ran to completion; the verdict itself is not a failure.
  if (code === 0 && (text.startsWith("verdict:") || text.startsWith("finished") || text.startsWith("handed-off"))) return { outcome: "completed", error_class: null };
  return { outcome: "failed", error_class: "process_error" };
}

export function wrapperRunView(row: WrapperEventRow): RunView | null {
  const kind = /^fleet-(dispatch|spec-review|review)-/.exec(row.agent_id)?.[1];
  const detail = row.detail !== null && typeof row.detail === "object" && !Array.isArray(row.detail) ? row.detail as Record<string, unknown> : null;
  if (!kind || !detail || typeof detail.outcome !== "string") return null;

  const created = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
  const reported = typeof detail.at === "string" ? Date.parse(detail.at) : NaN;
  // Prefer the wrapper's own end time, unless it is missing or far from when the server stored the event.
  const end = Number.isFinite(reported) && (!Number.isFinite(created) || Math.abs(reported - created) <= 86400_000) ? reported : created;
  if (!Number.isFinite(end) || end < 0) return null;

  const elapsed = typeof detail.elapsed_s === "number" ? detail.elapsed_s : typeof detail.elapsed_s === "string" && /^\d+(\.\d+)?$/.test(detail.elapsed_s) ? Number(detail.elapsed_s) : NaN;
  const known = Number.isFinite(elapsed) && elapsed >= 0 && elapsed * 1000 <= WEEK_MS;
  const duration = known ? Math.round(elapsed * 1000) : 0;

  const eventId = typeof detail.event_id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(detail.event_id) ? detail.event_id : `event-${row.id}`;
  return {
    event_id: Number(row.id), agent_id: row.agent_id, platform: platformLabel(row.platform), duration_known: known,
    run: {
      schema: "mc.run.v2", run_id: runId(row.agent_id, eventId), role: ROLES[kind],
      started_at: new Date(end - duration).toISOString(), ended_at: new Date(end).toISOString(), duration_ms: duration,
      ...classify(detail.outcome, detail.exit),
      usage_scope: "unavailable", usage_complete: false, model_usage: [],
    },
  };
}
