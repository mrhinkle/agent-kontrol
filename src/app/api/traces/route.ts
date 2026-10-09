import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { demoSpans, demoSummary } from "@/lib/demo-traces";
import { listTraces } from "@/lib/trace-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/traces?agent=<id>&errors=1&before=<iso>&limit=<1-100>
 * Trace summaries, newest first. Auth is enforced by middleware.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!isConfigured()) {
    return NextResponse.json({ demo: true, traces: [demoSummary(demoSpans())] });
  }
  const before = url.searchParams.get("before");
  if (before && Number.isNaN(Date.parse(before))) {
    return NextResponse.json({ error: "before must be an ISO timestamp" }, { status: 400 });
  }
  const limit = Number(url.searchParams.get("limit") ?? 50);
  try {
    const traces = await listTraces({
      agent: url.searchParams.get("agent"),
      errorsOnly: url.searchParams.get("errors") === "1",
      before,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return NextResponse.json({ demo: false, traces });
  } catch (e) {
    console.error("[traces] list failed", e);
    return NextResponse.json({ error: "could not read traces" }, { status: 500 });
  }
}
