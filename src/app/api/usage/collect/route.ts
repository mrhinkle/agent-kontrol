import { NextResponse } from "next/server";
import { actorFromPrincipal, runWithActor } from "@/lib/actor";
import { publicError } from "@/lib/api-error";
import { requireTrustedWriter } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { cronAuthorized, runScheduledCollection } from "@/lib/providers/scheduled";
import type { Principal } from "@/lib/scopes";
import { ingestUsageBatch } from "@/lib/usage-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET or POST /api/usage/collect
 * Collects provider billing (OpenRouter, xAI, Claude API) for the last 30
 * complete UTC days and stores it, for every provider whose management
 * credentials are set on the deployment. `vercel.json` schedules it daily.
 *
 * Callers: Vercel Cron with `Authorization: Bearer $CRON_SECRET`, MC_TOKEN, or
 * the signed-in dashboard. An agent credential cannot call it. The response
 * names each provider and how many facts were written, never a cost or a key.
 */
async function collect(req: Request) {
  let principal: Principal;
  if (await cronAuthorized(req)) {
    principal = { kind: "legacy" };
  } else {
    const access = await requireTrustedWriter(req, { allowSession: true });
    if (!access.ok) return access.response;
    principal = access.principal;
  }
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; nothing collected." });
  }
  try {
    const outcome = await runWithActor(actorFromPrincipal(principal), () => runScheduledCollection({ ingest: ingestUsageBatch }));
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 });
  } catch (err) {
    return publicError("[usage] scheduled collection failed", err);
  }
}

export const GET = collect;
export const POST = collect;
