import { NextResponse } from "next/server";
import { publicError, apiError } from "@/lib/api-error";
import { enforceApi, requireTrustedWriter } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { readSweepStatus, runSweep } from "@/lib/sweeper";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/sweep runs the absence sweeper once (#79). Only MC_TOKEN or the
 * signed-in dashboard. The body is ignored: there is no caller "now", and the
 * database clock decides every threshold. Each check reports firing, clear,
 * held, unknown, or not_configured on its own; one failed check does not
 * fail the others. The response is 200 whenever the run completed, including
 * when a check is unknown; read each check's state and error.
 *
 * GET /api/sweep is read-only status: registrations, active latches, and the
 * Paused section the brief prints. It never writes.
 */
export async function POST(req: Request) {
  const trusted = await requireTrustedWriter(req, { allowSession: true });
  if (!trusted.ok) return trusted.response;
  if (!isConfigured()) {
    return apiError("setup_required", { message: "DATABASE_URL is not set. The sweeper needs the database clock and its evidence." });
  }
  try {
    const run = await runSweep();
    return NextResponse.json({ ok: true, ...run }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return publicError("[sweep] run failed", e, "The sweep could not run.");
  }
}

export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  if (!isConfigured()) {
    return apiError("setup_required", { message: "DATABASE_URL is not set. Sweeper status lives in the database." });
  }
  try {
    return NextResponse.json(await readSweepStatus(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return publicError("[sweep] status failed", e, "Sweeper status is unavailable.");
  }
}
