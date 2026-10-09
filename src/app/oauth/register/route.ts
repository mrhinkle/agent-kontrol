import { randomToken } from "@/lib/authcrypto";
import {
  corsHeaders,
  isAllowedRedirectUri,
  jsonResponse,
  oauthError,
} from "@/lib/oauth";
import { isConfigured, sql } from "@/lib/db";

/**
 * Dynamic Client Registration (RFC 7591).
 * Public PKCE clients (token_endpoint_auth_method: "none") get no secret.
 */

type RegisterBody = {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
};

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}

export async function POST(req: Request) {
  if (!isConfigured()) {
    return oauthError("server_error", "OAuth storage is not configured", 503);
  }

  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return oauthError("invalid_client_metadata", "Request body must be JSON");
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return oauthError(
      "invalid_redirect_uri",
      "redirect_uris is required and must be a non-empty array"
    );
  }

  const redirectUris: string[] = [];
  for (const uri of body.redirect_uris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      return oauthError(
        "invalid_redirect_uri",
        "Each redirect_uri must be absolute https (or http for localhost/127.0.0.1)"
      );
    }
    redirectUris.push(uri);
  }

  const authMethod =
    typeof body.token_endpoint_auth_method === "string"
      ? body.token_endpoint_auth_method
      : "none";

  if (authMethod !== "none" && authMethod !== "client_secret_post") {
    return oauthError(
      "invalid_client_metadata",
      "token_endpoint_auth_method must be 'none' or 'client_secret_post'"
    );
  }

  const grantTypes =
    Array.isArray(body.grant_types) && body.grant_types.every((g) => typeof g === "string")
      ? (body.grant_types as string[])
      : ["authorization_code", "refresh_token"];

  const clientName =
    typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;

  const clientId = randomToken(16);
  const clientSecret = authMethod === "none" ? null : randomToken(32);
  const issuedAt = Math.floor(Date.now() / 1000);

  try {
    await sql()`
      insert into oauth_clients (
        client_id, client_secret, redirect_uris, client_name,
        token_endpoint_auth_method, grant_types
      )
      values (
        ${clientId},
        ${clientSecret},
        ${JSON.stringify(redirectUris)}::jsonb,
        ${clientName},
        ${authMethod},
        ${JSON.stringify(grantTypes)}::jsonb
      )
    `;
  } catch {
    return oauthError("server_error", "Failed to register client", 500);
  }

  const response: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes,
    response_types: ["code"],
  };
  if (clientName) response.client_name = clientName;
  if (clientSecret) response.client_secret = clientSecret;

  return jsonResponse(response, 201);
}
