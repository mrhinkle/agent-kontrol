import { NextResponse } from "next/server";
import { actorFromPrincipal, provenanceFromPrincipal } from "@/lib/actor";
import { apiError, publicError } from "@/lib/api-error";
import { requireTrustedWriter, trustedWriterRequired } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { checkConsumerRegistration, upsertConsumer } from "@/lib/sweep-evidence";

export const dynamic = "force-dynamic";

/**
 * POST /api/sweep/consumers registers or updates one consumer (#79). Only
 * MC_TOKEN or the signed-in dashboard. There are no implicit registrations.
 * Send enabled false to retire one; rows are not deleted. registered_at is
 * set on the first registration and starts a never-seen consumer's grace.
 */
export async function POST(req: Request) {
  const trusted = await requireTrustedWriter(req, { allowSession: true });
  if (!trusted.ok) return trusted.response;
  if (!isConfigured()) {
    return apiError("setup_required", { message: "DATABASE_URL is not set. Registrations live in the database." });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  const checked = checkConsumerRegistration(body);
  if (!checked.ok) {
    return apiError("validation_failed", { message: "The registration is not valid. Nothing was written.", fields: checked.fields });
  }
  const provenance = provenanceFromPrincipal(trusted.principal);
  const actor = actorFromPrincipal(trusted.principal);
  if (!provenance || !actor) return trustedWriterRequired();
  try {
    const out = await upsertConsumer(checked.value, provenance, actor);
    return NextResponse.json({ ok: true, ...out, consumer: checked.value });
  } catch (e) {
    return publicError("[sweep] consumer registration failed", e);
  }
}
