import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { demoSpans, demoSummary } from "@/lib/demo-traces";
import { ListParamError, TRACE_LIST, listBody, listParamError, parseSearchList } from "@/lib/list-params";
import { loadTracePage } from "@/lib/list-read";

export const dynamic = "force-dynamic";

/**
 * GET /api/traces?agent=<id>&errors=1&before=<iso>&limit=<1-200>&cursor=&fields=
 * Trace summaries, newest first. Auth is enforced by middleware.
 * With no limit, cursor, or fields, demo mode still returns the sample and
 * ignores before, including a before value that is not a timestamp.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const url = new URL(req.url);
  let parsed;
  try {
    parsed = parseSearchList(TRACE_LIST, url.searchParams);
  } catch (e) {
    if (e instanceof ListParamError) return listParamError(e);
    throw e;
  }
  if (!isConfigured() && !parsed.active) {
    return NextResponse.json({ demo: true, traces: [demoSummary(demoSpans())] });
  }
  const before = url.searchParams.get("before");
  if (before && Number.isNaN(Date.parse(before))) {
    return apiError("validation_failed", {
      message: "before must be an ISO timestamp",
      fields: { before: "before must be an ISO timestamp" },
    });
  }
  try {
    const page = await loadTracePage(isConfigured() ? "database" : "demo-sample", {
      agent: url.searchParams.get("agent"),
      errorsOnly: url.searchParams.get("errors") === "1",
      before,
      parsed,
    });
    return NextResponse.json(listBody("traces", page.rows, page.paging, page.next_cursor, !isConfigured()));
  } catch (e) {
    return publicError("[traces] list failed", e, "could not read traces");
  }
}
