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

export interface OAuthErrorTeaching {
  code?: string;
  cause?: string;
  fix?: string;
  retryable?: boolean;
}

const OAUTH_TEACHING: Record<string, { fix: string; retryable: boolean }> = {
  invalid_request: {
    fix: "Correct the request body and send it again. Do not retry an unchanged body.",
    retryable: false,
  },
  invalid_client: {
    fix: "Send the registered client_id and, for a confidential client, its client_secret.",
    retryable: false,
  },
  invalid_grant: {
    fix: "Correct the grant and send it again. Do not retry an unchanged grant.",
    retryable: false,
  },
  invalid_client_metadata: {
    fix: "Correct the client metadata and send the registration again.",
    retryable: false,
  },
  invalid_redirect_uri: {
    fix: "Send absolute https redirect URIs, or http for localhost and 127.0.0.1.",
    retryable: false,
  },
  unsupported_grant_type: {
    fix: "Use grant_type authorization_code or refresh_token.",
    retryable: false,
  },
  server_error: {
    fix: "Retry a bounded number of times. OAuth storage did not complete the request.",
    retryable: true,
  },
};

const OAUTH_SETUP_FIX = "Configure OAuth storage, then retry. This is not a transient client error.";

/**
 * RFC 6749 error object plus additive teaching fields. `error` and
 * `error_description` stay the protocol values. Caught exception text is
 * never copied into the body; callers pass a static description.
 */
export function oauthError(
  error: string,
  description: string,
  status = 400,
  teaching?: OAuthErrorTeaching,
): Response {
  const fallback = OAUTH_TEACHING[error] ?? {
    fix: "Correct the OAuth request and send it again. Do not retry an unchanged request.",
    retryable: false,
  };
  const setup = error === "server_error" && status === 503;
  return jsonResponse({
    error,
    error_description: description,
    code: teaching?.code ?? error,
    cause: teaching?.cause ?? description,
    fix: teaching?.fix ?? (setup ? OAUTH_SETUP_FIX : fallback.fix),
    retryable: teaching?.retryable ?? (setup ? false : fallback.retryable),
  }, status);
}
