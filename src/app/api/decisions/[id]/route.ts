import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { parseDecisionId, parsePatch, patchDecision } from "@/lib/decisions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PATCH /api/decisions/:id { status?, decision?, decided_by?, defer_until? }
 *
 * Dashboard session, MC_TOKEN, or an agent credential with decisions:write.
 * Records the answer on the row. Writing it back to GitHub is a later step.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await enforceApi(req);
  if (denied) return denied;
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
  const parsed = parsePatch(body);
  if (!parsed.ok) return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
  if (!isConfigured()) return NextResponse.json({ ok: true, demo: true });
  try {
    const decision = await patchDecision(id, parsed.value);
    if (!decision) {
      return apiError("not_found", {
        message: "Decision not found",
        fields: { id: "No decision with that id." },
      });
    }
    return NextResponse.json({ ok: true, decision });
  } catch (e) {
    return publicError("[decisions] patch failed", e);
  }
}
