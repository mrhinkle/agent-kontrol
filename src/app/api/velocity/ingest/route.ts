import { requireTrustedWriter } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import { actorFromPrincipal } from "@/lib/actor";
import { describeDbError } from "@/lib/db-error";
import { isConfigured } from "@/lib/db";
import { parseVelocity } from "@/lib/velocity";
import { insertVelocity } from "@/lib/velocity-store";
import { privateResponse, readVelocityJSON, velocityError, velocityJSON, VelocityBodyError } from "@/lib/velocity-http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const access = await requireTrustedWriter(req, { allowSession: true });
  if (!access.ok) return privateResponse(access.response);
  const origin = req.headers.get("origin");
  if ((access.principal.kind === "session" || origin !== null) && origin !== new URL(req.url).origin) {
    return velocityError("forbidden", "Import must come from this dashboard.", {
      fix: "Open this dashboard and import from that page.",
    });
  }
  let snapshot;
  try { snapshot = parseVelocity(await readVelocityJSON(req)); }
  catch (e) {
    if (e instanceof VelocityBodyError) {
      const code = e.status === 413 ? "payload_too_large" : e.status === 415 ? "unsupported_media_type" : "invalid_json";
      return privateResponse(apiError(code, { fix: "Send a valid UTF-8 JSON capture of at most 2 MB." }));
    }
    return privateResponse(apiError("validation_failed", { message: "Capture does not match the supported benchmark contract. Preview the file to inspect validation details." }));
  }
  if (!isConfigured()) {
    return velocityError("setup_required", "Benchmark history storage is not configured. This capture was not saved.", {
      fix: "Set DATABASE_URL and install the velocity history storage, then send the same capture again.",
    });
  }
  const actor = actorFromPrincipal(access.principal);
  if (!actor) {
    return velocityError("forbidden", "Authenticated operator or collector required.", {
      fix: "Sign in to the dashboard or send Authorization: Bearer with MC_TOKEN.",
    });
  }
  try { return velocityJSON({ ok: true, ...await insertVelocity(snapshot, actor) }); }
  catch (e) {
    console.error("[velocity] insert failed", describeDbError(e));
    return velocityError("internal_error", "The capture could not be saved. Retry the same file after history storage is available; identical imports are safe to repeat.", {
      status: 503,
      retryable: true,
      fix: "Retry the same file after history storage is available. An identical import does not create a second row.",
    });
  }
}
