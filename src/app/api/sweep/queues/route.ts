import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { readPrReviewQueues } from "@/lib/sweep-evidence";

export const dynamic = "force-dynamic";

const CLASSIFICATION_ERROR = "classification must be pr_review.";

/**
 * GET /api/sweep/queues?classification=pr_review (#176) is read-only: one
 * row per current pr_review sweep_queues projection row, sorted by queue.
 * Same access as GET /api/sweep: the dashboard session, MC_TOKEN, or an agent
 * credential with progress:read. The query string must be exactly
 * classification=pr_review; anything else is 400. No database is 503, never
 * an empty list. It never reads producer configuration and never writes.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  if (new URL(req.url).search !== "?classification=pr_review") {
    return apiError("validation_failed", { message: CLASSIFICATION_ERROR, fields: { classification: CLASSIFICATION_ERROR } });
  }
  if (!isConfigured()) {
    return apiError("setup_required", { message: "DATABASE_URL is not set. Queue observations live in the database." });
  }
  try {
    const queues = await readPrReviewQueues();
    return NextResponse.json({ queues }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return publicError("[sweep] queue read failed", e, "Queue status is unavailable.");
  }
}
