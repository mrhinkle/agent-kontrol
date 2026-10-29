import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { isTraceId, type SpanRow } from "@/lib/traces";

/** Read one trace. An empty result is not_found. A thrown loader is internal_error. */
export async function loadTraceResponse(traceId: string, load: () => Promise<SpanRow[]>): Promise<NextResponse> {
  if (!isTraceId(traceId)) {
    return apiError("validation_failed", {
      message: "invalid trace id",
      fields: { traceId: "Use a 32-character hex trace id." },
    });
  }
  try {
    const spans = await load();
    if (spans.length === 0) return apiError("not_found", { message: "trace not found" });
    return NextResponse.json({ demo: false, spans });
  } catch (e) {
    return publicError("[traces] read failed", e, "could not read trace");
  }
}
