import { NextResponse } from "next/server";
import { runWithPrincipal } from "@/lib/actor";
import { publicError } from "@/lib/api-error";
import { requireTrustedWriter } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { runProgressCollection } from "@/lib/progress-collect/run";
import { defaultDeps, withCollectorLock } from "@/lib/progress-collect/store";
import { cronAuthorized } from "@/lib/providers/scheduled";
import type { Principal } from "@/lib/scopes";
import { githubToken } from "@/lib/skills/source";

export const dynamic = "force-dynamic";
// Limits (see progress-collect/run.ts): no repo starts after 240 s, no GitHub request runs past
// 260 s, writes stop starting at 275 s, and one repo gets at most 90 s.
export const maxDuration = 300;

/**
 * GET or POST /api/progress/collect
 * One hosted tick of the progress collector (what scripts/collect-progress.sh
 * did on a workstation): the owner activity scan when its last run is over
 * 15 minutes old, then a detailed sweep of as many repos as fit, oldest first.
 * `vercel.json` schedules it every 5 minutes. GitHub is read with the
 * deployment's GH_TOKEN (or GITHUB_TOKEN).
 *
 * Callers: Vercel Cron with `Authorization: Bearer $CRON_SECRET`, MC_TOKEN, or
 * the signed-in dashboard. An agent credential cannot call it.
 *
 * Response: { ok, activity: { ran, repos, status }, sweep: { collected, skipped,
 * remaining, rate_limited }, elapsed_ms }. 502 `github_auth` when GitHub refuses the token,
 * 503 `github_token_missing` when none is set, `skipped: "busy"` when another
 * run holds the lock. Never a token.
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
  const token = githubToken();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "github_token_missing", note: "Set GH_TOKEN (or GITHUB_TOKEN) on the deployment." },
      { status: 503 },
    );
  }
  try {
    const locked = await withCollectorLock(() =>
      runWithPrincipal(principal, () => runProgressCollection(defaultDeps(token))),
    );
    if (locked.busy) return NextResponse.json({ ok: true, skipped: "busy" });
    return NextResponse.json(locked.value.body, { status: locked.value.status });
  } catch (err) {
    return publicError("[progress] collection failed", err);
  }
}

export const GET = collect;
export const POST = collect;
