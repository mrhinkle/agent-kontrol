import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { pruneSpans, upsertSpans } from "@/lib/trace-store";
import { captureContentEnabled, dedupeSpans, MAX_BODY_BYTES, parseOtlp } from "@/lib/traces";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Read a request body, giving up (null) as soon as it passes `max` bytes. */
async function readCapped(req: Request, max: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * POST /api/v1/traces
 * OTLP/HTTP JSON trace export (the OpenTelemetry wire format), so any
 * OpenTelemetry exporter can send here. Set the exporter's endpoint to
 * <your-url>/api/v1/traces, protocol http/json, and an
 * `Authorization: Bearer <MC_TOKEN>` header. The agent id is the `agent.id`
 * resource attribute, falling back to `service.name`.
 *
 * Answers 200 { partialSuccess: { rejectedSpans, errorMessage? } } as OTLP
 * specifies. gzip request bodies are accepted. Protobuf is not (send JSON).
 * Prompt and tool content, and credential-looking attributes, are dropped
 * unless MC_TRACE_CAPTURE_CONTENT is set (credentials are never kept).
 */
export async function POST(req: Request) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    return NextResponse.json({ error: "send OTLP as JSON (Content-Type: application/json); protobuf is not supported" }, { status: 415 });
  }

  let text: string;
  try {
    // Refuse early on a declared size, then read the stream with a hard cap so an
    // oversized body is never fully buffered.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "request too large" }, { status: 413 });
    const raw = await readCapped(req, MAX_BODY_BYTES);
    if (raw === null) return NextResponse.json({ error: "request too large" }, { status: 413 });
    let buf = raw;
    if ((req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip") {
      buf = gunzipSync(buf, { maxOutputLength: MAX_BODY_BYTES });
    }
    text = buf.toString("utf8");
  } catch {
    return NextResponse.json({ error: "could not read body (too large or bad gzip)" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { spans, rejected, errors } = parseOtlp(body, { captureContent: captureContentEnabled() });
  if (spans.length === 0 && rejected === 0 && errors.length > 0) {
    return NextResponse.json({ error: errors[0] }, { status: 400 });
  }
  const partialSuccess = rejected > 0 ? { rejectedSpans: rejected, errorMessage: errors.join("; ") } : {};

  if (!isConfigured()) return NextResponse.json({ partialSuccess, demo: true });

  try {
    await upsertSpans(dedupeSpans(spans));
    // Housekeeping on roughly 1 in 50 writes, so no scheduler is needed.
    if (Math.random() < 0.02) pruneSpans().catch((e) => console.error("[traces] prune failed", e));
    return NextResponse.json({ partialSuccess });
  } catch (e) {
    console.error("[traces] write failed", e);
    return NextResponse.json({ error: "could not store spans" }, { status: 500 });
  }
}
