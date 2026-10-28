import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { deny, resolveApiAccess } from "@/lib/auth";
import { decisionPersistenceOn, parseDecisionId } from "@/lib/decisions";
import { retryDecisionWriteback } from "@/lib/decision-resolve";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/decisions/:id/writeback
 *
 * Retry the GitHub comment and label removal for a decided row.
 * Does not decide again. The same marker skips a second comment.
 * Dashboard session, MC_TOKEN, or decisions:write.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  const { id: rawId } = await ctx.params;
  const id = parseDecisionId(rawId);
  if (id == null) {
    return apiError("validation_failed", {
      message: "invalid decision id",
      fields: { id: "invalid decision id" },
    });
  }
  let expected: string | null = null;
  const text = await req.text();
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return apiError("invalid_json");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiError("validation_failed", { message: "Send a JSON object.", fields: { body: "Send a JSON object." } });
    }
    const raw = (body as { expected_updated_at?: unknown }).expected_updated_at;
    if (raw != null && raw !== "") {
      if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
        return apiError("validation_failed", {
          message: "expected_updated_at must be an ISO 8601 timestamp.",
          fields: { expected_updated_at: "expected_updated_at must be an ISO 8601 timestamp." },
        });
      }
      expected = new Date(raw).toISOString();
    }
  }
  if (!decisionPersistenceOn()) return NextResponse.json({ ok: true, demo: true });
  try {
    const outcome = await retryDecisionWriteback(id, expected);
    if (!outcome.ok) {
      return apiError(outcome.code, { message: outcome.message, fields: outcome.fields });
    }
    return NextResponse.json({ ok: true, decision: outcome.decision });
  } catch (err) {
    return publicError("[decisions] writeback failed", err);
  }
}
