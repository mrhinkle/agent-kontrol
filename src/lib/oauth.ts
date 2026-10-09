/**
 * OAuth 2.1 authorization-server helpers for the self-hosted MCP AS.
 */

export const SCOPES = ["mcp"] as const;

/**
 * Deployment origin used as the OAuth issuer.
 * Honors MC_PUBLIC_URL, then x-forwarded-proto/host, then the request URL.
 */
export function issuer(req: Request): string {
  const override = process.env.MC_PUBLIC_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }

  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.headers.get("host");
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}`;
  }

  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

/** Protected resource identifier for this MCP server. */
export function resource(req: Request): string {
  return `${issuer(req)}/api/mcp`;
}

/** Escape user-controlled strings before embedding in consent HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * redirect_uri must be absolute https, or http only for localhost/127.0.0.1.
 * No open redirects — callers must also EXACT-match registered URIs.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (
      u.protocol === "http:" &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

export function oauthError(
  error: string,
  description: string,
  status = 400
): Response {
  return jsonResponse({ error, error_description: description }, status);
}
