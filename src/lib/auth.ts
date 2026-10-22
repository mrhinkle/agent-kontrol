import { authCookieValue, secretsMatch } from "./authcrypto";
import { resolveAgentCredential } from "./credentials";
import {
  authorizeRoute,
  type Principal,
  type ScopeErrorBody,
} from "./scopes";

/**
 * Shared-secret auth for agents reporting in, plus per-agent credentials.
 *
 * Accepts `Authorization: Bearer <MC_TOKEN>` always. That legacy token has
 * every scope.
 * The `?key=<MC_TOKEN>` query form is accepted ONLY when the caller
 * explicitly opts in via `{ allowQueryKey: true }`. Agent credentials are
 * never accepted from the query string.
 *
 * A bearer that starts with `akc_` is always checked, including when
 * MC_TOKEN is unset. Revoked, expired, unknown, and unreadable credentials
 * are rejected. A scope the credential does not have is 403.
 *
 * If MC_TOKEN is unset and the request is not an agent credential:
 *   - in development or test: ingest-style checks allow the request.
 *   - anywhere else, including an unset NODE_ENV: they deny (fail closed).
 *
 * Data routes (`enforceApi`) also accept the dashboard session cookie.
 * When the dashboard password is unset they stay open for ordinary
 * callers, and they still enforce an `akc_` bearer.
 */

export type Access =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401; body: { error: "unauthorized" } }
  | { ok: false; status: 403; body: ScopeErrorBody };

const UNAUTHORIZED: Access = { ok: false, status: 401, body: { error: "unauthorized" } };

function jsonDenied(decision: Access): Response | null {
  if (decision.ok) return null;
  return new Response(JSON.stringify(decision.body), {
    status: decision.status,
    headers: { "content-type": "application/json" },
  });
}

function bearerFrom(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function queryKey(req: Request): string | null {
  try {
    return new URL(req.url).searchParams.get("key");
  } catch {
    return null;
  }
}

type BearerMode = "bearer" | "strict" | "dashboard-open";

async function decideBearer(
  req: Request,
  mode: BearerMode,
  allowQueryKey: boolean,
): Promise<Access> {
  const headerToken = bearerFrom(req);
  const mc = process.env.MC_TOKEN;

  if (headerToken && mc && (await secretsMatch(headerToken, mc))) {
    return { ok: true, principal: { kind: "legacy" } };
  }

  if (headerToken?.startsWith("akc_")) {
    const resolved = await resolveAgentCredential(headerToken);
    if (resolved.status !== "ok") return UNAUTHORIZED;
    const principal: Principal = {
      kind: "agent",
      id: resolved.credential.id,
      scopes: resolved.credential.scopes,
    };
    let pathname = "/";
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return UNAUTHORIZED;
    }
    const decision = authorizeRoute(principal, req.method, pathname);
    if (!decision.ok) return decision;
    return { ok: true, principal };
  }

  if (allowQueryKey) {
    const key = queryKey(req);
    if (key && mc && (await secretsMatch(key, mc))) {
      return { ok: true, principal: { kind: "legacy" } };
    }
  }

  if (mode === "dashboard-open") {
    return { ok: true, principal: { kind: "dev-open" } };
  }

  if (
    mode === "bearer" &&
    !mc &&
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test")
  ) {
    return { ok: true, principal: { kind: "dev-open" } };
  }

  return UNAUTHORIZED;
}

export async function isAuthorized(
  req: Request,
  opts?: { allowQueryKey?: boolean },
): Promise<boolean> {
  const decision = await decideBearer(req, "bearer", opts?.allowQueryKey === true);
  return decision.ok;
}

/** Ingest-style routes. 401 for a bad credential, 403 for a missing scope. */
export async function enforceBearer(
  req: Request,
  opts?: { allowQueryKey?: boolean },
): Promise<Response | null> {
  return jsonDenied(await decideBearer(req, "bearer", opts?.allowQueryKey === true));
}

/**
 * Dashboard data routes. Session cookie, legacy token, or a scoped
 * agent credential. When the dashboard password is unset, ordinary
 * callers stay allowed and an agent credential is still checked.
 */
export async function enforceApi(req: Request): Promise<Response | null> {
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (password) {
    const cookie = readCookie(req, "mc_auth");
    if (cookie && (await secretsMatch(cookie, await authCookieValue(password)))) {
      return null;
    }
    return jsonDenied(await decideBearer(req, "strict", false));
  }
  return jsonDenied(await decideBearer(req, "dashboard-open", false));
}

/**
 * Settings that mint credentials. A bearer is never enough: not MC_TOKEN
 * and not an agent credential. The dashboard session cookie is required
 * when a password is set. With no password (local demo) a request that
 * presents no Authorization header is allowed, matching the open dashboard.
 */
export async function requireDashboardSession(req: Request): Promise<Response | null> {
  const header = req.headers.get("authorization");
  if (header && header.trim()) return jsonDenied(UNAUTHORIZED);
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
      return jsonDenied(UNAUTHORIZED);
    }
    return null;
  }
  const cookie = readCookie(req, "mc_auth");
  if (cookie && (await secretsMatch(cookie, await authCookieValue(password)))) return null;
  return jsonDenied(UNAUTHORIZED);
}
