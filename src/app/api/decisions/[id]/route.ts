import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { actorFromPrincipal } from "@/lib/actor";
import { deny, resolveApiAccess } from "@/lib/auth";
import { decisionPersistenceOn, parseDecisionId } from "@/lib/decisions";
import { parseResolveBody, resolveDecision } from "@/lib/decision-resolve";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PATCH /api/decisions/:id
 *
 * Dashboard session, MC_TOKEN, or an agent credential with decisions:write.
 * The stored actor is the principal. Body decided_by is ignored.
 * status decided writes the row, then tries the GitHub comment. A failed
 * write-back still leaves the row decided and sets writeback to not_written.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  const parsed = parseResolveBody(body);
  if (!parsed.ok) return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
  if (!decisionPersistenceOn()) return NextResponse.json({ ok: true, demo: true });
  try {
    const outcome = await resolveDecision({
      ...parsed.value,
      id,
      actor: actorFromPrincipal(access.principal),
    });
    if (!outcome.ok) {
      return apiError(outcome.code, {
        message: outcome.message,
        fields: outcome.fields,
      });
    }
    return NextResponse.json({ ok: true, decision: outcome.decision });
  } catch (err) {
    return publicError("[decisions] patch failed", err);
  }
}
