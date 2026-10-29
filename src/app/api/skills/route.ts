import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { demoList, demoUpstream } from "@/lib/skills/demo";
import { listSkillViews } from "@/lib/skills/query";
import { isRuntime, runtimeMustBeMessage } from "@/lib/skills/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills?runtime=&q=&category=
 * Auth: enforceApi. Agent credentials need skills:read.
 * PATCH, sync, and drift are separate routes and are not in the agent scope table.
 * category is an exact case-insensitive match. The value uncategorized matches null.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const runtime = url.searchParams.get("runtime");
  const q = url.searchParams.get("q");
  const category = url.searchParams.get("category");
  if (runtime != null && !isRuntime(runtime)) {
    return apiError("validation_failed", {
      message: "invalid runtime",
      fields: { runtime: runtimeMustBeMessage() },
    });
  }
  if (!isConfigured()) {
    return NextResponse.json({ demo: true, upstream: demoUpstream(), skills: demoList({ runtime, q, category }) });
  }
  try {
    const listed = await listSkillViews({ runtime, q, category });
    return NextResponse.json({ demo: false, upstream: listed.upstream, skills: listed.skills });
  } catch (err) {
    return publicError("[skills] list failed", err);
  }
}
