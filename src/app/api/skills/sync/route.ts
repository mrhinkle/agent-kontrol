import { NextResponse } from "next/server";
import { actorFromPrincipal, runWithActor } from "@/lib/actor";
import { apiError, publicError } from "@/lib/api-error";
import { deny, resolveApiAccess } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { parseSyncBody } from "@/lib/skills/settings";
import { syncSkills } from "@/lib/skills/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/skills/sync
 * Operator route. An agent credential cannot call it. There is no agent scope
 * for it. A scheduler calls the same route with MC_TOKEN and {"trigger":"scheduled"}.
 * This route does not register a Vercel cron.
 */

export async function POST(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  const text = await req.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return apiError("invalid_json");
    }
  }
  const parsed = parseSyncBody(body);
  if (!parsed.ok) return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; sync not run." });
  }
  try {
    const result = await runWithActor(actorFromPrincipal(access.principal), () =>
      syncSkills({ trigger: parsed.trigger }),
    );
    return NextResponse.json(result);
  } catch (err) {
    return publicError("[skills] sync failed", err);
  }
}
