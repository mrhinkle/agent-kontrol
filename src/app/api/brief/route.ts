import { NextResponse } from "next/server";
import { publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { briefQueryError, briefWantsJson, loadBrief, morningBriefText, parseBriefQuery } from "@/lib/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/brief?window=24h|72h
 *
 * Plain text by default, for a scheduler that curls the route. `Accept:
 * application/json` returns the same object as `scripts/morning-brief.sh --json`.
 * The script remains the fallback and still sweeps GitHub. This route does not.
 * A failure is the JSON error body, including when the client asked for text.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const parsed = parseBriefQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return briefQueryError(parsed);

  try {
    const headers = { "Cache-Control": "private, max-age=0, s-maxage=60" };
    if (briefWantsJson(req.headers.get("accept"))) {
      return NextResponse.json(await loadBrief(parsed.window), { headers });
    }
    return new NextResponse(await morningBriefText(parsed.window), {
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (e) {
    return publicError("[brief] failed", e, "Could not build the morning brief.");
  }
}
