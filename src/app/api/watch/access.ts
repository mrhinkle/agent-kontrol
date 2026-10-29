/**
 * Watch routes accept only a verified akc_ credential.
 * MC_TOKEN, the dashboard cookie, an OAuth JWT, and a dev-open caller are
 * 401 here. Other routes keep using enforceApi / enforceBearer.
 */

import { NextResponse } from "next/server";
import { apiError, errorBody, type ApiErrorOverrides, type ErrorCode } from "@/lib/api-error";
import { resolveAgentCredential } from "@/lib/credentials";
import { requireScope, type Principal, type Scope } from "@/lib/scopes";

export const NO_STORE = { "cache-control": "no-store" } as const;

export function watchError(code: ErrorCode, overrides?: ApiErrorOverrides): NextResponse {
  return apiError(code, { ...overrides, headers: { ...NO_STORE, ...overrides?.headers } });
}

function unauthorized(): NextResponse {
  return NextResponse.json(errorBody("unauthorized"), { status: 401, headers: NO_STORE });
}

export function storeUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "credential_store_unavailable" },
    { status: 503, headers: NO_STORE },
  );
}

export function databaseUnavailable(): NextResponse {
  return watchError("setup_required", {
    message: "The watch beat store is unavailable.",
    fix: "Set DATABASE_URL, apply the schema, and retry.",
    retryable: true,
  });
}

/**
 * Read at most `max` bytes. A longer stream is rejected without parsing.
 * Content-Length is not consulted.
 */
export async function readCappedBody(
  req: Request,
  max: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "unreadable" }> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const first = header.split(",")[0] ?? "";
  const media = first.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json";
}

export type WatchAccess =
  | { ok: true; principal: { kind: "agent"; id: string; scopes: readonly string[] } }
  | { ok: false; response: NextResponse };

/**
 * Verify the bearer as an agent credential and require `scope`.
 * Anything that is not a verified akc_ token is 401, including a bearer
 * that would be MC_TOKEN or an OAuth JWT on another route. A cookie is ignored.
 */
export async function requireWatchAgent(req: Request, scope: Scope): Promise<WatchAccess> {
  const header = req.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)/i.exec(header.trim()) : null;
  const token = match?.[1] ?? "";
  if (!token.startsWith("akc_")) return { ok: false, response: unauthorized() };

  const resolved = await resolveAgentCredential(token);
  if (resolved.status === "unavailable") return { ok: false, response: storeUnavailable() };
  if (resolved.status !== "ok") return { ok: false, response: unauthorized() };

  let pathname = "/";
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return { ok: false, response: unauthorized() };
  }
  const expected = scope === "watch:write"
    ? { method: "POST", pathname: "/api/watch/beat" }
    : scope === "watch:read"
      ? { method: "GET", pathname: "/api/watch/beats" }
      : null;
  if (!expected || req.method.toUpperCase() !== expected.method || pathname !== expected.pathname) {
    return { ok: false, response: unauthorized() };
  }

  const principal: Principal = {
    kind: "agent",
    id: resolved.credential.id,
    scopes: resolved.credential.scopes,
  };
  const decision = requireScope(principal, scope);
  if (!decision.ok) {
    return {
      ok: false,
      response: NextResponse.json(decision.body, { status: decision.status, headers: NO_STORE }),
    };
  }
  return { ok: true, principal };
}
