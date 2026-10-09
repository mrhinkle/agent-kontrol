import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth";
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
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; snapshot dropped" });
  }

  let body: IngestInput;
  try {
    body = (await req.json()) as IngestInput;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.repos) || body.repos.length === 0) {
    return NextResponse.json({ error: "repos[] is required" }, { status: 400 });
  }
  if (body.collected_at && Number.isNaN(Date.parse(body.collected_at))) {
    return NextResponse.json({ error: "collected_at must be ISO 8601" }, { status: 400 });
  }

  try {
    const written = await ingestSnapshots(body);
    return NextResponse.json({ ok: true, written });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
