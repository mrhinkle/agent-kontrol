import { NextRequest, NextResponse } from "next/server";
import { authCookieValue, secretsMatch } from "@/lib/authcrypto";

/**
 * Password gate for the dashboard.
 *
 * - MC_DASHBOARD_PASSWORD unset -> no gate in local dev and database-less demo
 *   deploys; a production build with DATABASE_URL set refuses to serve (503).
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

/**
 * True when the dashboard has no password but would serve real data: a
 * production build with a database attached. Local dev and database-less demo
 * deploys stay open on purpose; a deploy holding real data does not.
 */
export function isUnprotectedWithRealData(): boolean {
  return (
    !process.env.MC_DASHBOARD_PASSWORD &&
    process.env.NODE_ENV === "production" &&
    !!process.env.DATABASE_URL
  );
}

export async function middleware(req: NextRequest) {
  const password = process.env.MC_DASHBOARD_PASSWORD;
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.some((r) => r.test(pathname));

  if (!password) {
    if (!isPublic && isUnprotectedWithRealData()) {
      const message = "MC_DASHBOARD_PASSWORD is not set. Set it to serve the dashboard.";
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: message }, { status: 503 })
        : new NextResponse(message, { status: 503, headers: { "content-type": "text/plain" } });
    }
    return NextResponse.next();
  }

  if (isPublic) return NextResponse.next();

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
