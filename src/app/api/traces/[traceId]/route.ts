import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { demoSpans } from "@/lib/demo-traces";
import { getTrace } from "@/lib/trace-store";
import { loadTraceResponse } from "@/lib/trace-response";

export const dynamic = "force-dynamic";

/** GET /api/traces/<traceId> -> { demo, spans: [...] } ordered by start time. */
export async function GET(_req: Request, ctx: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await ctx.params;
  if (!isConfigured()) {
    const spans = demoSpans();
    return NextResponse.json({ demo: true, spans: traceId === spans[0].trace_id ? spans : [] });
  }
  return loadTraceResponse(traceId, () => getTrace(traceId));
}
