import { NextResponse } from "next/server";
import { actorFromPrincipal, runWithActor } from "@/lib/actor";
import { apiError, publicError } from "@/lib/api-error";
import { deny, resolveApiAccess } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { demoDetail } from "@/lib/skills/demo";
import { getSkillDetail, patchSkillSettings } from "@/lib/skills/query";
import { parseSettingsPatch } from "@/lib/skills/settings";
import { DEFAULT_SCOPE, DEFAULT_TRIGGER } from "@/lib/skills/types";

export const dynamic = "force-dynamic";

/**
 * GET  /api/skills/:id  — skills:read for an agent credential.
 * PATCH /api/skills/:id — operator route. Not in ROUTE_SCOPES.
 *   An agent credential is denied. The dashboard session and MC_TOKEN are not.
 *   dry_run is not accepted: the task dry-run helper does not apply to settings.
 */

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: apiError("invalid_json") };
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await resolveApiAccess(_req);
  if (!denied.ok) return deny(denied);
  const { id } = await ctx.params;
  if (!isConfigured()) {
    const detail = demoDetail(id);
    if (!detail) return apiError("not_found", { message: "Skill not found" });
    return NextResponse.json(detail);
  }
  try {
    const detail = await getSkillDetail(id);
    if (!detail) return apiError("not_found", { message: "Skill not found" });
    return NextResponse.json(detail);
  } catch (err) {
    return publicError("[skills] detail failed", err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  const { id } = await ctx.params;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  if (!isConfigured()) {
    const parsed = parseSettingsPatch(read.body, { trigger: DEFAULT_TRIGGER, scope: DEFAULT_SCOPE, schedule: null });
    if (!parsed.ok) return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; skill settings not stored." });
  }
  try {
    return await runWithActor(actorFromPrincipal(access.principal), async () => {
      const result = await patchSkillSettings(id, read.body);
      if (!result.ok) return apiError(result.code, { message: result.message, fields: result.fields });
      return NextResponse.json(result.detail);
    });
  } catch (err) {
    return publicError("[skills] settings failed", err);
  }
}
