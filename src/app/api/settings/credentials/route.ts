import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { requireDashboardSession } from "@/lib/auth";
import { describeDbError } from "@/lib/db-error";
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

function fieldFor(message: string): string {
  if (message.startsWith("rate_limit_per_minute") || message.startsWith("send rate_limit")) return "rate_limit_per_minute";
  if (message.startsWith("rate_limit_per_day")) return "rate_limit_per_day";
  if (message.startsWith("label")) return "label";
  if (message.startsWith("scopes") || message === "unknown scope" || message === "too many scopes") return "scopes";
  if (message.startsWith("expires_at")) return "expires_at";
  if (message.startsWith("id")) return "id";
  return "body";
}

function rejected(message: string) {
  const code = message === "label is required" || message === "id is required" ? "missing_field" as const : "validation_failed" as const;
  return apiError(code, { message, fields: { [fieldFor(message)]: message } });
}

function badJson() {
  return apiError("invalid_json", { message: "Request body must be JSON." });
}

function failure(what: string, e: unknown) {
  console.error(`[settings/credentials] ${what}`, describeDbError(e));
  return apiError("internal_error", { message: `Could not ${what}.` });
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
    return badJson();
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
    if (!created.ok) return rejected(created.error);
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
    return badJson();
  }
  const checked = validateLimitsInput(body);
  if (!checked.ok) return rejected(checked.error);
  try {
    const credential = await updateCredentialLimits(checked);
    if (!credential) return apiError("not_found", { message: "credential not found" });
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
    return badJson();
  }
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) {
    return rejected("id is required");
  }
  try {
    const credential = await revokeCredential(id);
    if (!credential) return apiError("not_found", { message: "credential not found" });
    return NextResponse.json({ credential });
  } catch (e) {
    return failure("revoke the credential", e);
  }
}
