import { requireTrustedWriter } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { readBoundedBody } from "@/lib/gh-events";
import { checkStreamRegistration, EventStreamError, registerStreamConsumer } from "@/lib/events-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Explicit operator registration. A credential cannot choose its own binding or filters. */
export async function POST(req: Request): Promise<Response> {
  const trusted = await requireTrustedWriter(req, { allowSession: true });
  if (!trusted.ok) return trusted.response;
  if (!isConfigured()) return Response.json({ error: "stream_not_configured" }, { status: 503 });
  const body = await readBoundedBody(req, 16_384);
  if (!body.ok) return Response.json({ error: body.reason }, { status: body.reason === "too_large" ? 413 : 400 });
  try {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)); }
    catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
    const consumer = checkStreamRegistration(value);
    await registerStreamConsumer(consumer);
    return Response.json({ ok: true, consumer });
  } catch (e) {
    const known = e instanceof EventStreamError;
    return Response.json({ error: known ? e.code : "stream_unavailable" }, { status: known ? e.status : 503 });
  }
}
