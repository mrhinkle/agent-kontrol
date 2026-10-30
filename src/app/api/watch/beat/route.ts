import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { WatchBeatError, upsertBeat } from "@/lib/watch";
import {
  WATCH_BODY_MAX_BYTES,
  credentialBoundTo,
  loadWatchSourceBindings,
  parseWatchBeat,
} from "@/lib/watch-sources";
import {
  NO_STORE,
  databaseUnavailable,
  isJsonContentType,
  readCappedBody,
  requireWatchAgent,
  watchError,
} from "../access";

export const dynamic = "force-dynamic";

/** POST /api/watch/beat — one host observation. Only an akc_ credential with watch:write. */
export async function POST(req: Request) {
  // enforceApi allows a session, MC_TOKEN, OAuth, and dev-open. An akc_
  // bearer skips that decision so a dashboard cookie cannot hide it.
  // requireWatchAgent then rejects every principal that is not a verified agent.
  if (!/^Bearer\s+akc_/i.test(req.headers.get("authorization") ?? "")) {
    const gate = await enforceApi(req);
    if (gate) return gate;
  }

  const access = await requireWatchAgent(req, "watch:write");
  if (!access.ok) return access.response;

  if (!isJsonContentType(req.headers.get("content-type"))) {
    return watchError("unsupported_media_type");
  }

  const read = await readCappedBody(req, WATCH_BODY_MAX_BYTES);
  if (!read.ok) {
    if (read.reason === "too_large") {
      return watchError("payload_too_large", { fix: "Send a JSON object of at most 8 KiB." });
    }
    return watchError("invalid_json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
  } catch {
    return watchError("invalid_json");
  }

  const beat = parseWatchBeat(parsed);
  if (!beat.ok) {
    return watchError("validation_failed", { fields: { [beat.field]: beat.message } });
  }

  const bindings = loadWatchSourceBindings();
  if (!bindings.ok) {
    console.error("[watch] source binding", bindings.reason);
    return watchError("setup_required", {
      message: "Watch source binding is not configured.",
      fix: "Set WATCH_SOURCE_CREDENTIAL_IDS_JSON to a JSON object mapping mini, macbook, and watcher to arrays of credential ids.",
    });
  }
  if (!credentialBoundTo(bindings.bindings, beat.beat.source, access.principal.id)) {
    return watchError("forbidden", {
      message: "This credential is not bound to that source.",
      fix: "Use the source this credential is allowed to write.",
    });
  }

  try {
    await upsertBeat(beat.beat.source, beat.beat.status, beat.beat.detail, beat.beat.beat_at);
  } catch (err) {
    if (err instanceof WatchBeatError) {
      return watchError("validation_failed", {
        fields: { beat_at: "beat_at must be a finite RFC 3339 timestamp with an explicit offset." },
      });
    }
    console.error("[watch] beat write failed", err instanceof Error ? err.name : "error");
    return databaseUnavailable();
  }

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
