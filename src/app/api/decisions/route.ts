import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import {
  listDecisions,
  parseListQuery,
  parseReconcile,
  parseUpsert,
  reconcileDecisions,
  upsertDecision,
} from "@/lib/decisions";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Decision queue.
 * Auth: dashboard session or MC_TOKEN. An agent credential cannot call this
 * route; resolving a row is PATCH, and that requires decisions:write.
 *
 * GET  /api/decisions?status=open&repo=&source=&limit=
 *      Oldest first by first_seen_at. Each row includes age_days.
 *      status=open also returns deferred rows whose defer_until has passed.
 * POST /api/decisions
 *      Upsert one row by key, or { reconcile: { repo, source, seen_keys } }
 *      to withdraw label-sourced rows the collector did not see.
 */

const DEMO_NOTE = "DATABASE_URL not set; decision dropped";

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, response: apiError("invalid_json") };
  }
}

export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const parsed = parseListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
  if (!isConfigured()) {
    return NextResponse.json({ demo: true, decisions: [] });
  }
  try {
    const decisions = await listDecisions(parsed);
    return NextResponse.json({ demo: false, decisions });
  } catch (e) {
    return publicError("[decisions] list failed", e);
  }
}

export async function POST(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  const read = await readJson(req);
  if (!read.ok) return read.response;
  const body = read.body;
  const hasReconcile =
    !!body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "reconcile");
  const hasKey =
    !!body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "key");
  if (hasReconcile && hasKey) {
    return apiError("validation_failed", {
      message: "Send either a decision or a reconcile, not both.",
      fields: { body: "Send either a decision or a reconcile, not both." },
    });
  }

  if (hasReconcile) {
    const parsed = parseReconcile(body);
    if (!parsed.ok) return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
    if (!isConfigured()) return NextResponse.json({ ok: true, demo: true, note: DEMO_NOTE });
    try {
      const result = await reconcileDecisions(parsed.value);
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return publicError("[decisions] reconcile failed", e);
    }
  }

  const parsed = parseUpsert(body);
  if (!parsed.ok) return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
  if (!isConfigured()) return NextResponse.json({ ok: true, demo: true, note: DEMO_NOTE });
  try {
    const result = await upsertDecision(parsed.value);
    return NextResponse.json({ ok: true, decision: result.decision, status_held: result.status_held });
  } catch (e) {
    return publicError("[decisions] upsert failed", e);
  }
}
