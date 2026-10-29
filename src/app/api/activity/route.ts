import { NextResponse } from "next/server";
import { ActivityQueryError, activityQueryError, parseActivityFilters } from "@/lib/activity";
import { publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { loadActivityPage } from "@/lib/list-read";
import { ACTIVITY_LIST, ListParamError, listBody, listParamError, parseSearchList } from "@/lib/list-params";

export const dynamic = "force-dynamic";

/**
 * GET /api/activity?actor=&kind=&since=&until=&limit=&cursor=&fields=
 * Events newest first. With no database this reads the in-memory demo
 * event log, including when no paging params were passed. There is no
 * static sample. Filters still apply.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const url = new URL(req.url);
  let parsed;
  try {
    parsed = parseSearchList(ACTIVITY_LIST, url.searchParams);
  } catch (e) {
    if (e instanceof ListParamError) return listParamError(e);
    throw e;
  }
  let filters;
  try {
    filters = parseActivityFilters({
      actor: url.searchParams.get("actor"),
      kind: url.searchParams.get("kind"),
      since: url.searchParams.get("since"),
      until: url.searchParams.get("until"),
    });
  } catch (e) {
    if (e instanceof ActivityQueryError) return activityQueryError(e);
    throw e;
  }
  try {
    const page = await loadActivityPage(isConfigured() ? "database" : "demo-store", {
      ...filters,
      parsed,
    });
    return NextResponse.json(listBody("activity", page.rows, page.paging, page.next_cursor, !isConfigured()));
  } catch (e) {
    return publicError("[activity] list failed", e, "could not read activity");
  }
}
