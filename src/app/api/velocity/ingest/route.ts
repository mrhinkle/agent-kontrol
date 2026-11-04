import { requireTrustedWriter } from "@/lib/auth";
import { apiError } from "@/lib/api-error";
import { actorFromPrincipal } from "@/lib/actor";
import { isConfigured } from "@/lib/db";
import { parseVelocity } from "@/lib/velocity";
import { insertVelocity } from "@/lib/velocity-store";
import { privateResponse, readVelocityJSON, velocityJSON, VelocityBodyError } from "@/lib/velocity-http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const access = await requireTrustedWriter(req, { allowSession: true });
  if (!access.ok) return privateResponse(access.response);
  const origin = req.headers.get("origin");
  if ((access.principal.kind === "session" || origin !== null) && origin !== new URL(req.url).origin) {
    return velocityJSON({ error: "Import must come from this dashboard." }, 403);
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
  if (!isConfigured()) return velocityJSON({ error: "Benchmark history storage is not configured. This capture was not saved." }, 503);
  const actor = actorFromPrincipal(access.principal);
  if (!actor) return velocityJSON({ error: "Authenticated operator or collector required." }, 403);
  try { return velocityJSON({ ok: true, ...await insertVelocity(snapshot, actor) }); }
  catch { return velocityJSON({ error: "The capture could not be saved. Retry the same file after history storage is available; identical imports are safe to repeat." }, 503); }
}
