import { NextResponse } from "next/server";
import { deny, resolveBearerAccess, trustedWriterRequired } from "@/lib/auth";
import { provenanceFromPrincipal } from "@/lib/actor";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { report, type ReportInput } from "@/lib/store";
import { SweepClockError } from "@/lib/sweep-clock";
import { SweepEvidenceConflict, isReservedIngestKind, isSweepObservationKind, writeObservation } from "@/lib/sweep-evidence";

export const maxDuration = 30;

/**
 * POST /api/ingest
 * The deterministic telemetry endpoint. Claude Code hooks, the Codex
 * watcher, and any daemon POST here.
 *
 * Body: {
 *   agent_id: string,            // required, e.g. "claude-code-macbook-pro"
 *   platform?: string,           // claude-code | cowork-cloud | chatgpt-work | codex | hermes | other
 *   machine?: string,
 *   display_name?: string,
 *   session_id?: string,
 *   kind: string,                // session_start | turn_start | waiting | notification | session_end | milestone | status | error | heartbeat
 *   title?: string,
 *   detail?: object,
 *   project?: string,
 *   summary?: string,
 *   status?: string              // explicit session status override
 * }
 *
 * The event stores the verified caller as principal_kind/principal_id. Any
 * such field in the body is ignored.
 *
 * Sweeper observations (#79) use the reserved kinds sweep.scheduler_job,
 * sweep.queue, and sweep.pr_snapshot with an `observation` object. Only the
 * legacy MC_TOKEN may send them: an agent credential, OAuth, and dev-open are
 * 403 and nothing is written. Any other kind starting with `sweep.` or named
 * after a synthetic sweeper event is refused for every caller, so it can never
 * be stored as ordinary telemetry.
 */
export async function POST(req: Request) {
  const access = await resolveBearerAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; event dropped" });
  }

  let body: ReportInput & { observation?: unknown };
  try {
    body = (await req.json()) as ReportInput & { observation?: unknown };
  } catch {
    return apiError("invalid_json");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return apiError("invalid_json");
  if (!body.agent_id || !body.kind) {
    const fields: Record<string, string> = {};
    if (!body.agent_id) fields.agent_id = "agent_id is required";
    if (!body.kind) fields.kind = "kind is required";
    return apiError("missing_field", { message: "agent_id and kind are required", fields });
  }

  if (isReservedIngestKind(body.kind)) {
    if (access.principal.kind !== "legacy") return trustedWriterRequired();
    if (!isSweepObservationKind(body.kind)) {
      return apiError("validation_failed", {
        message: "That kind is reserved for the sweeper.",
        fields: { kind: "Use sweep.scheduler_job, sweep.queue, or sweep.pr_snapshot." },
      });
    }
    const provenance = provenanceFromPrincipal(access.principal);
    if (!provenance) return trustedWriterRequired();
    try {
      const written = await writeObservation(body.kind, body.observation, provenance);
      if (!written.ok) {
        return apiError("validation_failed", { message: "The observation is not valid. Nothing was written.", fields: written.fields });
      }
      return NextResponse.json({ ok: true, kind: body.kind, ...written.value });
    } catch (e) {
      if (e instanceof SweepEvidenceConflict) return apiError("conflict", { message: e.detail });
      if (e instanceof SweepClockError) return apiError("internal_error", { status: 503, message: "The database clock could not be read. Nothing was written.", retryable: true });
      return publicError("[ingest] observation", e);
    }
  }

  try {
    await report(body, { principal: access.principal });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return publicError("[ingest]", e);
  }
}
