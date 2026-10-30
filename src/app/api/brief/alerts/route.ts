import { NextResponse } from "next/server";
import { publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { readAlerts } from "@/lib/brief-alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/brief/alerts
 *
 * Current threshold conditions and whether each latch is still sent.
 * This route never inserts a message. Auth matches GET /api/brief.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  try {
    const report = await readAlerts();
    return NextResponse.json(report, {
      headers: { "Cache-Control": "private, max-age=0" },
    });
  } catch (e) {
    return publicError("[brief-alerts] read failed", e, "Could not read threshold alerts.");
  }
}
