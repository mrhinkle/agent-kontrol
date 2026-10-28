import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { parseDriftBody, recordDrift } from "@/lib/skills/drift-report";

export const dynamic = "force-dynamic";

/**
 * POST /api/skills/drift
 * Operator route. A machine reports the skills it sees on disk. Agent Kontrol
 * does not read the machine. An agent credential cannot call this route.
 * An empty skills array means the directory was read and was empty. A collector
 * that failed to read the directory must not post an empty list.
 */

export async function POST(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  const parsed = parseDriftBody(body);
  if (!parsed.ok) return apiError("validation_failed", { message: parsed.message, fields: parsed.fields });
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; drift report not stored." });
  }
  try {
    const result = await recordDrift(parsed);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return publicError("[skills] drift failed", err);
  }
}
