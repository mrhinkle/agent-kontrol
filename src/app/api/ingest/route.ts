import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { isAuthorized } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { report, type ReportInput } from "@/lib/store";

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
 */
export async function POST(req: Request) {
  if (!(await isAuthorized(req))) {
    return apiError("unauthorized");
  }
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; event dropped" });
  }

  let body: ReportInput;
  try {
    body = (await req.json()) as ReportInput;
  } catch {
    return apiError("invalid_json");
  }
  if (!body.agent_id || !body.kind) {
    const fields: Record<string, string> = {};
    if (!body.agent_id) fields.agent_id = "agent_id is required";
    if (!body.kind) fields.kind = "kind is required";
    return apiError("missing_field", { message: "agent_id and kind are required", fields });
  }

  try {
    await report(body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return publicError("[ingest]", e);
  }
}
