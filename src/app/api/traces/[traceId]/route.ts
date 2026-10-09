import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { demoSpans } from "@/lib/demo-traces";
import { getTrace } from "@/lib/trace-store";
import { isTraceId } from "@/lib/traces";

export const dynamic = "force-dynamic";

/** GET /api/traces/<traceId> -> { demo, spans: [...] } ordered by start time. */
export async function GET(_req: Request, ctx: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await ctx.params;
  if (!isConfigured()) {
    const spans = demoSpans();
    return NextResponse.json({ demo: true, spans: traceId === spans[0].trace_id ? spans : [] });
  }
  if (!isTraceId(traceId)) return NextResponse.json({ error: "invalid trace id" }, { status: 400 });
  try {
    const spans = await getTrace(traceId);
    if (spans.length === 0) return NextResponse.json({ error: "trace not found" }, { status: 404 });
    return NextResponse.json({ demo: false, spans });
  } catch (e) {
    console.error("[traces] read failed", e);
    return NextResponse.json({ error: "could not read trace" }, { status: 500 });
  }
}
