import {
  pkceS256Matches,
  secretsMatch,
  signAccessToken,
  verifyAccessToken,
} from "@/lib/authcrypto";
import { corsHeaders, issuer, oauthError, resource as defaultResource } from "@/lib/oauth";
import { isConfigured, sql } from "@/lib/db";

/**
 * Token endpoint (OAuth 2.1).
 * Supports authorization_code (+ PKCE S256) and refresh_token grants.
 */

const ACCESS_TTL = 3600;
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30 days

type OAuthClientRow = {
  client_id: string;
  client_secret: string | null;
  token_endpoint_auth_method: string | null;
};

type OAuthCodeRow = {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
  used: boolean;
};

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

async function loadClient(clientId: string): Promise<OAuthClientRow | null> {
  try {
    const rows = await sql()`
      select client_id, client_secret, token_endpoint_auth_method
      from oauth_clients
      where client_id = ${clientId}
      limit 1
    `;
    if (!rows[0]) return null;
    return rows[0] as OAuthClientRow;
  } catch {
    return null;
  }
}

async function authenticateClient(
  form: URLSearchParams
): Promise<{ client: OAuthClientRow } | Response> {
  const clientId = form.get("client_id") ?? "";
  if (!clientId) {
    return oauthError("invalid_request", "client_id is required");
  }

  const client = await loadClient(clientId);
  if (!client) {
    return oauthError("invalid_client", "Unknown client_id", 401);
  }

  const method = client.token_endpoint_auth_method || "none";
  if (method === "none") {
    // Public client — no secret required.
    return { client };
  }

  const secret = form.get("client_secret") ?? "";
  if (!client.client_secret || !(await secretsMatch(secret, client.client_secret))) {
    return oauthError("invalid_client", "Invalid client credentials", 401);
  }
  return { client };
}

async function handleAuthorizationCode(
  req: Request,
  form: URLSearchParams,
  client: OAuthClientRow
): Promise<Response> {
  const code = form.get("code") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const codeVerifier = form.get("code_verifier") ?? "";

  if (!code || !redirectUri || !codeVerifier) {
    return oauthError(
      "invalid_request",
      "code, redirect_uri, and code_verifier are required"
    );
  }

  let lookedUp: OAuthCodeRow | null = null;
  try {
    const rows = await sql()`
      select code, client_id, redirect_uri, code_challenge, code_challenge_method,
             scope, resource, expires_at, used
      from oauth_codes
      where code = ${code}
      limit 1
    `;
    lookedUp = (rows[0] as OAuthCodeRow | undefined) ?? null;
  } catch {
    return oauthError("server_error", "Failed to look up authorization code", 500);
  }

  if (!lookedUp) {
    return oauthError("invalid_grant", "Authorization code is invalid or already used");
  }

  const row = lookedUp;

  if (row.used) {
    return oauthError("invalid_grant", "Authorization code is invalid or already used");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return oauthError("invalid_grant", "Authorization code has expired");
  }

  // EXACT match on client_id and redirect_uri.
  if (row.client_id !== client.client_id) {
    return oauthError("invalid_grant", "Authorization code was not issued to this client");
  }
  if (row.redirect_uri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match");
  }

  if (row.code_challenge_method !== "S256") {
    return oauthError("invalid_grant", "Only S256 PKCE is supported");
  }

  if (!(await pkceS256Matches(codeVerifier, row.code_challenge))) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  // Atomic single-use: mark used only if still unused (race-safe).
  let claimed: { code: string } | null = null;
  try {
    const rows = await sql()`
      update oauth_codes
      set used = true
      where code = ${code} and used = false
      returning code
    `;
    claimed = (rows[0] as { code: string } | undefined) ?? null;
  } catch {
    return oauthError("server_error", "Failed to redeem authorization code", 500);
  }
  if (!claimed) {
    return oauthError("invalid_grant", "Authorization code is invalid or already used");
  }

  const iss = issuer(req);
  const aud = row.resource || defaultResource(req);
  const scope = row.scope || "mcp";
  const sub = client.client_id;

  const accessToken = await signAccessToken(
    {
      iss,
      aud,
      sub,
      client_id: client.client_id,
      scope,
      typ: "access",
    },
    ACCESS_TTL
  );

  const refreshToken = await signAccessToken(
    {
      iss,
      aud,
      sub,
      client_id: client.client_id,
      scope,
      typ: "refresh",
    },
    REFRESH_TTL
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: refreshToken,
      scope,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        ...corsHeaders,
      },
    }
  );
}

async function handleRefreshToken(
  req: Request,
  form: URLSearchParams,
  client: OAuthClientRow
): Promise<Response> {
  const refreshToken = form.get("refresh_token") ?? "";
  if (!refreshToken) {
    return oauthError("invalid_request", "refresh_token is required");
  }

  const payload = await verifyAccessToken(refreshToken);
  if (!payload || payload.typ !== "refresh") {
    return oauthError("invalid_grant", "Invalid or expired refresh token");
  }

  if (payload.client_id !== client.client_id) {
    return oauthError("invalid_grant", "Refresh token was not issued to this client");
  }

  const iss = issuer(req);
  const aud = payload.aud || defaultResource(req);
  const scope = payload.scope || "mcp";

  const accessToken = await signAccessToken(
    {
      iss,
      aud,
      sub: payload.sub || client.client_id,
      client_id: client.client_id,
      scope,
      typ: "access",
    },
    ACCESS_TTL
  );

  // Rotate refresh token.
  const newRefresh = await signAccessToken(
    {
      iss,
      aud,
      sub: payload.sub || client.client_id,
      client_id: client.client_id,
      scope,
      typ: "refresh",
    },
    REFRESH_TTL
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: newRefresh,
      scope,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        ...corsHeaders,
      },
    }
  );
}

export async function POST(req: Request) {
  if (!isConfigured()) {
    return oauthError("server_error", "OAuth storage is not configured", 503);
  }

  let form: URLSearchParams;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const json = (await req.json()) as Record<string, string>;
      form = new URLSearchParams();
      for (const [k, v] of Object.entries(json)) {
        if (v != null) form.set(k, String(v));
      }
    } else {
      form = new URLSearchParams(await req.text());
    }
  } catch {
    return oauthError("invalid_request", "Invalid request body");
  }

  const auth = await authenticateClient(form);
  if (auth instanceof Response) return auth;
  const { client } = auth;

  const grantType = form.get("grant_type") ?? "";
  if (grantType === "authorization_code") {
    return handleAuthorizationCode(req, form, client);
  }
  if (grantType === "refresh_token") {
    return handleRefreshToken(req, form, client);
  }
  return oauthError("unsupported_grant_type", "Supported: authorization_code, refresh_token");
}
