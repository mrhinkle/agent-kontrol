import { actorFromPrincipal, runWithActor } from "@/lib/actor";
import { requireTrustedWriter } from "@/lib/auth";
import { describeDbError } from "@/lib/db-error";
import { isConfigured } from "@/lib/db";
import { streamFailure } from "@/lib/events-http";
import { readBoundedBody } from "@/lib/gh-events";
import { checkStreamRegistration, EventStreamError, registerStreamConsumer } from "@/lib/events-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Explicit operator registration. A credential cannot choose its own binding or filters.
 * The receipt actor is this trusted writer. The body's credential_id is the target
 * binding, not the caller, and extra actor fields are not authority.
 */
export async function POST(req: Request): Promise<Response> {
  const trusted = await requireTrustedWriter(req, { allowSession: true });
  if (!trusted.ok) return trusted.response;
  const actor = actorFromPrincipal(trusted.principal);
  if (!isConfigured()) return streamFailure("stream_not_configured", 503);
  const body = await readBoundedBody(req, 16_384);
  if (!body.ok) return streamFailure(body.reason, body.reason === "too_large" ? 413 : 400);
  try {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)); }
    catch { return streamFailure("invalid_json", 400); }
    const consumer = checkStreamRegistration(value);
    await runWithActor(actor, () => registerStreamConsumer(consumer));
    return Response.json({ ok: true, consumer });
  } catch (e) {
    const known = e instanceof EventStreamError;
    if (!known) console.error("[events/consumers] failed", describeDbError(e));
    return streamFailure(known ? e.code : "stream_unavailable", known ? e.status : 503);
  }
}
