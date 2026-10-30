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
 * Does not decide again. A comment that already contains the canonical
 * decision text skips a second comment. The marker alone does not.
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
  let expectedUpdatedAt: string | null = null;
  let expectedRevision: number | null = null;
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
    const raw = body as { expected_updated_at?: unknown; expected_revision?: unknown };
    if (raw.expected_updated_at != null && raw.expected_updated_at !== "") {
      if (typeof raw.expected_updated_at !== "string" || Number.isNaN(Date.parse(raw.expected_updated_at))) {
        return apiError("validation_failed", {
          message: "expected_updated_at must be an ISO 8601 timestamp.",
          fields: { expected_updated_at: "expected_updated_at must be an ISO 8601 timestamp." },
        });
      }
      expectedUpdatedAt = new Date(raw.expected_updated_at).toISOString();
    }
    if (raw.expected_revision != null && raw.expected_revision !== "") {
      const value = raw.expected_revision;
      const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return apiError("validation_failed", {
          message: "expected_revision must be a non-negative integer.",
          fields: { expected_revision: "expected_revision must be a non-negative integer." },
        });
      }
      expectedRevision = parsed;
    }
  }
  if (!decisionPersistenceOn()) return NextResponse.json({ ok: true, demo: true });
  try {
    const outcome = await retryDecisionWriteback(id, { updatedAt: expectedUpdatedAt, revision: expectedRevision });
    if (!outcome.ok) {
      return apiError(outcome.code, { message: outcome.message, fields: outcome.fields });
    }
    return NextResponse.json({ ok: true, decision: outcome.decision });
  } catch (err) {
    return publicError("[decisions] writeback failed", err);
  }
}
