import { NextResponse } from "next/server";
import { apiError, type ApiErrorOverrides, type ErrorCode } from "@/lib/api-error";
import { sql, type SqlTag } from "@/lib/db";
import {
  GH_WEBHOOK_BODY_MAX_BYTES,
  extractMetadata,
  insertGhEvent,
  isAcceptedEvent,
  isEventHeader,
  isPlainObject,
  isWebhookDeliveryId,
  parseSignatureHeader,
  readBoundedBody,
  unstorableReason,
  verifySignature,
  webhookSecret,
} from "@/lib/gh-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

function hookError(code: ErrorCode, overrides?: ApiErrorOverrides): NextResponse {
  return apiError(code, { ...overrides, headers: { ...NO_STORE, ...overrides?.headers } });
}

function badSignature(message: string): NextResponse {
  return hookError("unauthorized", {
    message,
    fix: "Sign the exact request body with HMAC SHA-256 under MC_GITHUB_WEBHOOK_SECRET and send it as X-Hub-Signature-256: sha256=<hex>.",
  });
}

/**
 * POST /api/webhooks/github — one GitHub delivery into gh_events.
 * The HMAC signature is the only credential. A session cookie, MC_TOKEN, an
 * agent credential, or an OAuth token does not stand in for it.
 */
export async function POST(req: Request) {
  const secret = webhookSecret();
  if (!secret) {
    return hookError("not_configured", { message: "The GitHub webhook secret is not configured." });
  }

  const digest = parseSignatureHeader(req.headers.get("x-hub-signature-256"));
  if (!digest) return badSignature("X-Hub-Signature-256 is missing or not sha256=<64 lowercase hex>.");

  const read = await readBoundedBody(req, GH_WEBHOOK_BODY_MAX_BYTES);
  if (!read.ok) {
    if (read.reason === "too_large") {
      return hookError("payload_too_large", { fix: "GitHub deliveries above 1 MiB are not accepted." });
    }
    return hookError("invalid_json", { message: "The request body could not be read." });
  }

  if (!verifySignature(secret, read.bytes, digest)) {
    return badSignature("X-Hub-Signature-256 does not match the body.");
  }

  const event = req.headers.get("x-github-event");
  if (!isEventHeader(event)) {
    return hookError("validation_failed", {
      fields: { "X-GitHub-Event": "Send 1 to 64 lowercase letters or underscores." },
    });
  }
  const deliveryId = req.headers.get("x-github-delivery");
  if (!isWebhookDeliveryId(deliveryId)) {
    return hookError("validation_failed", {
      fields: { "X-GitHub-Delivery": "Send 1 to 128 letters, digits, or hyphens (GitHub sends a GUID)." },
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
  } catch {
    return hookError("invalid_json", {
      fix: "Set the webhook content type to application/json so GitHub sends the payload as a JSON body.",
    });
  }

  if (event === "ping") {
    return NextResponse.json({ ok: true, event: "ping", delivery_id: deliveryId }, { headers: NO_STORE });
  }
  if (!isAcceptedEvent(event)) {
    return NextResponse.json(
      { ok: true, ignored: true, event, delivery_id: deliveryId },
      { status: 202, headers: NO_STORE },
    );
  }

  if (!isPlainObject(payload)) {
    return hookError("validation_failed", { fields: { payload: "The payload must be a JSON object." } });
  }
  const unstorable = unstorableReason(payload);
  if (unstorable) return hookError("validation_failed", { fields: { payload: unstorable } });
  const meta = extractMetadata(event, payload);
  if (!meta.ok) return hookError("validation_failed", { fields: { [meta.field]: meta.message } });

  let db: SqlTag;
  try {
    db = sql();
  } catch {
    return hookError("setup_required", {
      message: "The event store is not configured.",
      fix: "Set DATABASE_URL, apply the schema, then redeliver.",
      retryable: true,
    });
  }

  try {
    const result = await insertGhEvent({ delivery_id: deliveryId, event, ...meta.meta, payload }, db);
    if (result.duplicate) {
      return NextResponse.json({ ok: true, duplicate: true, delivery_id: deliveryId }, { headers: NO_STORE });
    }
    return NextResponse.json(
      { ok: true, stored: true, duplicate: false, id: result.id, delivery_id: deliveryId },
      { headers: NO_STORE },
    );
  } catch (err) {
    // Name and SQLSTATE only: a driver error can quote the payload.
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    console.error("[webhooks/github] insert failed", err instanceof Error ? err.name : "error", code);
    return hookError("internal_error", {
      status: 503,
      message: "The event was not stored.",
      fix: "Redeliver the same delivery from GitHub. A delivery that was already stored is not stored twice.",
    });
  }
}
