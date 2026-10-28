import { NextResponse } from "next/server";
import { publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { runScheduleTick } from "@/lib/skills/schedule";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/skills/schedule/tick
 * Operator route. The path is nested so GET /api/skills/schedule still reads a skill
 * whose id is "schedule". An agent credential cannot call it and there is no agent
 * scope for it. An external scheduler (cron, launchd, Hermes cron) calls it
 * every minute with MC_TOKEN. The body is ignored.
 *
 * For each skill whose trigger is scheduled and whose cron is due, it queues
 * one task. It never runs the skill. This route does not register a Vercel
 * cron; the repo deploys on Fly and its other scheduled work is external.
 */
export async function POST(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; no tasks queued." });
  }
  try {
    return NextResponse.json(await runScheduleTick());
  } catch (err) {
    return publicError("[skills] schedule tick failed", err);
  }
}
