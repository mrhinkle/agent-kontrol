import { NextResponse } from "next/server";
import { requireDashboardSession } from "@/lib/auth";
import {
  createCredential,
  listCredentials,
  revokeCredential,
  updateCredentialLimits,
  validateLimitsInput,
} from "@/lib/credentials";

export const dynamic = "force-dynamic";

/**
 * GET/POST/PATCH/DELETE /api/settings/credentials
 *
 * Dashboard session only. MC_TOKEN and agent credentials are rejected.
 * The list never includes the token or its hash. POST returns the token
 * once, in that response only.
 *
 * POST takes optional rate_limit_per_minute and rate_limit_per_day (defaults
 * 60 and 10,000). PATCH changes only those two limits on an existing
 * credential and keeps the requests already counted in the current windows.
 *
 * Stored: label, 8-character prefix, SHA-256 of the token, scopes, timestamps,
 * request limits and the request counts for the current minute and UTC day.
 * Not stored: the token, prompts, or tool input.
 */

function failure(what: string, e: unknown) {
  console.error(`[settings/credentials] ${what}`, e instanceof Error ? e.name : "error");
  return NextResponse.json({ error: `Could not ${what}.` }, { status: 500 });
}

export async function GET(req: Request) {
  const denied = await requireDashboardSession(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ credentials: await listCredentials() });
  } catch (e) {
    return failure("list credentials", e);
  }
}

export async function POST(req: Request) {
  const denied = await requireDashboardSession(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const record = (body ?? {}) as {
    label?: unknown;
    scopes?: unknown;
    expires_at?: unknown;
    rate_limit_per_minute?: unknown;
    rate_limit_per_day?: unknown;
  };
  try {
    const created = await createCredential({
      label: record.label,
      scopes: record.scopes,
      expires_at: record.expires_at,
      rate_limit_per_minute: record.rate_limit_per_minute,
      rate_limit_per_day: record.rate_limit_per_day,
    });
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: 400 });
    return NextResponse.json({ credential: { ...created.credential, token: created.token } });
  } catch (e) {
    return failure("create the credential", e);
  }
}

export async function PATCH(req: Request) {
  const denied = await requireDashboardSession(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const checked = validateLimitsInput(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  try {
    const credential = await updateCredentialLimits(checked);
    if (!credential) return NextResponse.json({ error: "credential not found" }, { status: 404 });
    return NextResponse.json({ credential });
  } catch (e) {
    return failure("update the limits", e);
  }
}

export async function DELETE(req: Request) {
  const denied = await requireDashboardSession(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  try {
    const credential = await revokeCredential(id);
    if (!credential) return NextResponse.json({ error: "credential not found" }, { status: 404 });
    return NextResponse.json({ credential });
  } catch (e) {
    return failure("revoke the credential", e);
  }
}
