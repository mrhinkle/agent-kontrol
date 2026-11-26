import { NextResponse } from "next/server";
import { deny, resolveApiAccess } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { parseHiddenCardsWrite } from "@/lib/usage-hidden-cards";
import { listHiddenCards, setCardsHidden } from "@/lib/usage-hidden-store";

export const dynamic = "force-dynamic";

/**
 * Usage and Costs cards the operator hid because no tracking or feed is connected.
 *
 * GET /api/usage/hidden-cards                     -> { hidden: string[], demo }
 * PUT /api/usage/hidden-cards { cards, hidden }   -> { hidden: string[], demo }
 *
 * Display only. A stored key applies only while that card has no data; the page
 * shows a card with data even when its key is stored. Totals never read this.
 * Without a database the set is kept in memory (demo).
 *
 * Auth: dashboard session or MC_TOKEN. An agent credential is 403: no agent
 * scope grants this route.
 */
export async function GET(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  try {
    return NextResponse.json({ hidden: await listHiddenCards(), demo: !isConfigured() });
  } catch (e) {
    return publicError("[usage/hidden-cards] load", e, "Could not load hidden cards.");
  }
}

export async function PUT(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json", { message: "Request body must be JSON.", fields: { cards: "Request body must be JSON." } });
  }
  const parsed = parseHiddenCardsWrite(body);
  if (!parsed.ok) {
    return apiError("validation_failed", { message: parsed.message, fields: { [parsed.field]: parsed.message } });
  }
  try {
    return NextResponse.json({ hidden: await setCardsHidden(parsed.cards, parsed.hidden), demo: !isConfigured() });
  } catch (e) {
    return publicError("[usage/hidden-cards] save", e, "Could not save hidden cards.");
  }
}
