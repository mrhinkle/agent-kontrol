import { deny, resolveBearerAccess } from "@/lib/auth";
import { describeDbError } from "@/lib/db-error";
import { isConfigured } from "@/lib/db";
import { streamFailure } from "@/lib/events-http";
import { acquireStream, cursorPosition, EventStreamError, eventStreamResponse, readStreamBatch } from "@/lib/events-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  // No legacy, query-string or open-demo credential can read an inbox stream.
  if (!/^Bearer\s+akc_\S+$/i.test(req.headers.get("authorization") ?? "")) {
    return streamFailure("unauthorized", 401);
  }
  const access = await resolveBearerAccess(req);
  if (!access.ok) return deny(access);
  if (access.principal.kind !== "agent") return streamFailure("consumer_forbidden", 403);
  if (!isConfigured()) return streamFailure("stream_not_configured", 503);
  try {
    const url = new URL(req.url);
    if (url.searchParams.getAll("consumer").length !== 1 || url.searchParams.getAll("since").length > 1) {
      throw new EventStreamError("invalid_consumer", 400);
    }
    const consumer = url.searchParams.get("consumer") ?? "";
    const queryCursor = url.searchParams.get("since");
    const headerCursor = req.headers.get("last-event-id");
    if (queryCursor && headerCursor && queryCursor !== headerCursor) throw new EventStreamError("cursor_conflict", 400);
    const position = cursorPosition(consumer, queryCursor ?? headerCursor);
    const generation = await acquireStream(consumer, access.principal.id);
    const first = await readStreamBatch(consumer, access.principal.id, generation, position);
    return eventStreamResponse({ consumer, position, generation, credential: access.principal.id, signal: req.signal, first });
  } catch (e) {
    const known = e instanceof EventStreamError;
    if (!known) console.error("[events/stream] failed", describeDbError(e));
    return streamFailure(known ? e.code : "stream_unavailable", known ? e.status : 503);
  }
}
