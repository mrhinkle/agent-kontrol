import { NextResponse } from "next/server";
import { publicError } from "@/lib/api-error";
import { requireTrustedWriter } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { cronAuthorized } from "@/lib/providers/scheduled";
import { runSweep } from "@/lib/sweeper";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/sweep/cron runs the absence sweeper once (#79) on a schedule.
 * `vercel.json` calls it every 5 minutes. It does what POST /api/sweep does;
 * it exists because Vercel Cron sends GET and GET /api/sweep is read-only status.
 *
 * Callers: Vercel Cron with `Authorization: Bearer $CRON_SECRET`, MC_TOKEN, or
 * the signed-in dashboard. An agent credential cannot call it.
 *
 * Overlapping runs are safe: each check takes a transaction advisory lock, so a
 * second run waits and then finds the latches the first one wrote (an event is
 * emitted once per condition). Response: { ok, checks, retention } as for
 * POST /api/sweep; 200 whenever the run completed, including a check that is
 * unknown. Without a database: { ok: true, demo: true } and nothing runs.
 */
export async function GET(req: Request) {
  if (!(await cronAuthorized(req))) {
    const access = await requireTrustedWriter(req, { allowSession: true });
    if (!access.ok) return access.response;
  }
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; the sweeper did not run." });
  }
  try {
    const run = await runSweep();
    return NextResponse.json({ ok: true, ...run }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return publicError("[sweep] scheduled run failed", e, "The sweep could not run.");
  }
}
