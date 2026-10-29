import { NextResponse } from "next/server";
import { actorFromPrincipal } from "@/lib/actor";
import { publicError } from "@/lib/api-error";
import { deny, resolveBearerAccess } from "@/lib/auth";
import { evaluateAlerts } from "@/lib/brief-alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/brief/alerts/evaluate
 *
 * Computes the threshold conditions and, when brief.alerts.enabled is true,
 * inserts one operator message per newly claimed alert. Auth matches
 * POST /api/progress/ingest: MC_TOKEN, not an agent credential.
 * The body is ignored. A scheduler can POST with an empty body.
 */
export async function POST(req: Request) {
  const access = await resolveBearerAccess(req);
  if (!access.ok) return deny(access);
  try {
    const actor = actorFromPrincipal(access.principal);
    const report = await evaluateAlerts({ actor });
    return NextResponse.json(report, {
      headers: { "Cache-Control": "private, max-age=0" },
    });
  } catch (e) {
    return publicError("[brief-alerts] evaluate failed", e, "Could not evaluate threshold alerts.");
  }
}
