import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { readBeats } from "@/lib/watch";
import { NO_STORE, databaseUnavailable, requireWatchAgent } from "../access";

export const dynamic = "force-dynamic";

/**
 * GET /api/watch/beats — every host row, with age_s from the database clock.
 * Only an akc_ credential with watch:read. No source binding. No demo payload.
 */
export async function GET(req: Request) {
  // Same split as POST /api/watch/beat. A non-akc_ denial from enforceApi
  // stands; an akc_ bearer is decided only by requireWatchAgent.
  if (!/^Bearer\s+akc_/i.test(req.headers.get("authorization") ?? "")) {
    const gate = await enforceApi(req);
    if (gate) return gate;
  }

  const access = await requireWatchAgent(req, "watch:read");
  if (!access.ok) return access.response;

  try {
    const beats = await readBeats();
    return NextResponse.json({ beats }, { headers: NO_STORE });
  } catch (err) {
    console.error("[watch] beat read failed", err instanceof Error ? err.name : "error");
    return databaseUnavailable();
  }
}
