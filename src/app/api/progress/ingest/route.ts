import { NextResponse } from "next/server";
import { enforceBearer } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { ingestSnapshots, type IngestInput } from "@/lib/progress-store";

export const maxDuration = 30;

/**
 * POST /api/progress/ingest
 * Where scripts/collect-progress.sh puts one collection tick. Bearer MC_TOKEN,
 * same as /api/ingest.
 *
 * Body: {
 *   collected_at?: ISO8601,      // defaults to now; set explicitly when backfilling
 *   kind?: "tick" | "daily" | "backfill",
 *   repos: [{
 *     repo: "example-org/app-server",
 *     label?: "App Server",
 *     open_issues?, open_prs?, blocked_issues?,
 *     merged_prs_24h?, issues_closed_24h?, issues_opened_24h?,
 *     total_issues_created?, total_issues_closed?, total_prs_merged?,
 *     review_rounds?, no_verdict_rate?,
 *     detail?: { lane_mix?, stalled_prs?, notes? }
 *   }]
 * }
 */
export async function POST(req: Request) {
  const denied = await enforceBearer(req);
  if (denied) return denied;
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; snapshot dropped" });
  }

  let body: IngestInput;
  try {
    body = (await req.json()) as IngestInput;
  } catch {
    return apiError("invalid_json");
  }
  if (!Array.isArray(body.repos) || body.repos.length === 0) {
    return apiError("missing_field", { message: "repos[] is required", fields: { repos: "repos[] is required" } });
  }
  if (body.collected_at && Number.isNaN(Date.parse(body.collected_at))) {
    return apiError("validation_failed", {
      message: "collected_at must be ISO 8601",
      fields: { collected_at: "collected_at must be ISO 8601" },
    });
  }

  try {
    const written = await ingestSnapshots(body);
    return NextResponse.json({ ok: true, written });
  } catch (e) {
    return publicError("[progress] ingest failed", e);
  }
}
