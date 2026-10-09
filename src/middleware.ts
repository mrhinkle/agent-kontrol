import { NextRequest, NextResponse } from "next/server";
import { authCookieValue, secretsMatch } from "@/lib/authcrypto";

/**
 * Password gate for the dashboard.
 *
 * - MC_DASHBOARD_PASSWORD unset -> no gate (local dev / demo).
 * - Agent endpoints (/api/ingest and the MCP transport routes) are excluded
 *   here; they enforce their own MC_TOKEN bearer auth.
 * - Data endpoints (/api/fleet, /api/memory) accept either the session
 *   cookie or the MC_TOKEN bearer header.
 */

const PUBLIC_PATHS: RegExp[] = [
  /^\/login$/,
  /^\/api\/login$/,
  /^\/api\/ingest$/,
  /^\/api\/messages\/reply$/, // agent replies (token-authed in route)
  /^\/api\/progress\/ingest$/, // collector cron (token-authed in route)
  /^\/api\/usage\/ingest$/, // usage collector (token-authed in route)
  /^\/api\/(mcp|sse|message)(\/.*)?$/, // MCP transports (token-authed in route)
  /^\/\.well-known\//, // OAuth AS + protected-resource metadata
  /^\/oauth\//, // OAuth authorize / token / register
];

export async function middleware(req: NextRequest) {
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((r) => r.test(pathname))) return NextResponse.next();

  const cookie = req.cookies.get("mc_auth")?.value;
  if (cookie && (await secretsMatch(cookie, await authCookieValue(password)))) {
    return NextResponse.next();
  }

  const bearer = req.headers.get("authorization");
  if (
    process.env.MC_TOKEN &&
    bearer?.startsWith("Bearer ") &&
    (await secretsMatch(bearer.slice(7), process.env.MC_TOKEN))
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
