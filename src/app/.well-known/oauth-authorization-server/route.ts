import { corsHeaders, issuer, jsonResponse, SCOPES } from "@/lib/oauth";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * MCP clients discover endpoints, PKCE requirement, and supported grants here.
 */
export async function GET(req: Request) {
  const iss = issuer(req);
  return jsonResponse({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [...SCOPES],
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: corsHeaders });
}
