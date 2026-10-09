import { authCookieValue, randomToken, secretsMatch } from "@/lib/authcrypto";
import { escapeHtml, isAllowedRedirectUri, resource as mcpResource } from "@/lib/oauth";
import { isConfigured, sql } from "@/lib/db";

/**
 * Authorization endpoint (OAuth 2.1 authorization_code + PKCE S256).
 * Consent is gated by MC_DASHBOARD_PASSWORD (same as the dashboard).
 * Auth codes are single-use, ≤5 min, bound to client_id + redirect_uri + challenge.
 */

type OAuthClient = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
};

type AuthParams = {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
  resource: string;
};

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function parseParams(source: URLSearchParams): Partial<AuthParams> {
  return {
    response_type: source.get("response_type") ?? undefined,
    client_id: source.get("client_id") ?? undefined,
    redirect_uri: source.get("redirect_uri") ?? undefined,
    code_challenge: source.get("code_challenge") ?? undefined,
    code_challenge_method: source.get("code_challenge_method") ?? undefined,
    scope: source.get("scope") ?? undefined,
    state: source.get("state") ?? undefined,
    resource: source.get("resource") ?? undefined,
  };
}

function errorPage(message: string, status = 400): Response {
  return htmlResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorization error</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#111}
.err{background:#fef2f2;border:1px solid #fecaca;padding:1rem;border-radius:8px}</style>
</head><body><div class="err"><strong>Authorization error</strong><p>${escapeHtml(message)}</p></div></body></html>`,
    status
  );
}

function consentPage(
  params: AuthParams,
  clientName: string,
  opts: { authenticated: boolean; error?: string }
): Response {
  const { authenticated, error } = opts;
  const hidden = (name: keyof AuthParams, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;

  return htmlResponse(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize MCP client</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; color: #111; background: #fafafa; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #444; line-height: 1.45; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.35rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem; border: 1px solid #ccc; border-radius: 8px; font-size: 1rem; }
    button { margin-top: 1rem; width: 100%; padding: 0.7rem; border: 0; border-radius: 8px; background: #111; color: #fff; font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #333; }
    .err { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 0.6rem 0.75rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.9rem; }
    .meta { font-size: 0.8rem; color: #666; margin-top: 0.75rem; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize MCP client</h1>
    <p><strong>${escapeHtml(clientName)}</strong> wants access to Mission Control MCP
    with scope <code>${escapeHtml(params.scope || "mcp")}</code>.</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden("response_type", params.response_type)}
      ${hidden("client_id", params.client_id)}
      ${hidden("redirect_uri", params.redirect_uri)}
      ${hidden("code_challenge", params.code_challenge)}
      ${hidden("code_challenge_method", params.code_challenge_method)}
      ${hidden("scope", params.scope)}
      ${hidden("state", params.state)}
      ${hidden("resource", params.resource)}
      ${
        authenticated
          ? `<p class="meta">You're signed in to the dashboard. Click Approve to grant this client access.</p>`
          : `<label for="password">Dashboard password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />`
      }
      <button type="submit">Approve</button>
    </form>
    <p class="meta">Redirect: ${escapeHtml(params.redirect_uri)}</p>
  </div>
</body>
</html>`);
}

async function loadClient(clientId: string): Promise<OAuthClient | null> {
  try {
    const rows = await sql()`
      select client_id, client_name, redirect_uris
      from oauth_clients
      where client_id = ${clientId}
      limit 1
    `;
    const data = rows[0] as
      | { client_id: string; client_name: string | null; redirect_uris: unknown }
      | undefined;
    if (!data) return null;
    // neon returns jsonb already parsed — do not JSON.parse again.
    const uris = Array.isArray(data.redirect_uris) ? (data.redirect_uris as string[]) : [];
    return {
      client_id: data.client_id,
      client_name: data.client_name ?? null,
      redirect_uris: uris,
    };
  } catch {
    return null;
  }
}

async function validateParams(
  partial: Partial<AuthParams>
): Promise<{ ok: true; params: AuthParams; client: OAuthClient } | { ok: false; response: Response }> {
  if (!isConfigured()) {
    return { ok: false, response: errorPage("OAuth storage is not configured", 503) };
  }

  const {
    response_type,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    scope = "mcp",
    state = "",
    resource = "",
  } = partial;

  if (response_type !== "code") {
    return { ok: false, response: errorPage("response_type must be 'code'") };
  }
  if (!client_id) {
    return { ok: false, response: errorPage("client_id is required") };
  }
  if (!redirect_uri) {
    return { ok: false, response: errorPage("redirect_uri is required") };
  }
  if (!isAllowedRedirectUri(redirect_uri)) {
    return {
      ok: false,
      response: errorPage(
        "redirect_uri must be absolute https (or http for localhost/127.0.0.1)"
      ),
    };
  }
  if (!code_challenge) {
    return { ok: false, response: errorPage("code_challenge is required (PKCE S256)") };
  }
  if (code_challenge_method !== "S256") {
    return {
      ok: false,
      response: errorPage("code_challenge_method must be S256 (plain is not allowed)"),
    };
  }

  const client = await loadClient(client_id);
  if (!client) {
    return { ok: false, response: errorPage("Unknown client_id", 400) };
  }

  // EXACT string match — no prefix/substring matching (open-redirect defense).
  if (!client.redirect_uris.includes(redirect_uri)) {
    return { ok: false, response: errorPage("redirect_uri is not registered for this client") };
  }

  return {
    ok: true,
    params: {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
      resource,
    },
    client,
  };
}

async function hasValidDashboardSession(req: Request): Promise<boolean> {
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (!password) return true; // no password configured → treat as authenticated (dev/demo)

  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)mc_auth=([^;]+)/);
  const cookie = match?.[1] ? decodeURIComponent(match[1]) : "";
  if (!cookie) return false;
  return secretsMatch(cookie, await authCookieValue(password));
}

async function mintCodeAndRedirect(params: AuthParams, req: Request): Promise<Response> {
  const code = randomToken(32);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const resourceValue = params.resource || mcpResource(req);

  try {
    await sql()`
      insert into oauth_codes (
        code, client_id, redirect_uri, code_challenge, code_challenge_method,
        scope, resource, expires_at, used
      )
      values (
        ${code},
        ${params.client_id},
        ${params.redirect_uri},
        ${params.code_challenge},
        ${"S256"},
        ${params.scope || "mcp"},
        ${resourceValue},
        ${expiresAt},
        ${false}
      )
    `;
  } catch {
    return errorPage("Failed to issue authorization code", 500);
  }

  // Build redirect only from the exact validated redirect_uri (no open redirect).
  const target = new URL(params.redirect_uri);
  target.searchParams.set("code", code);
  if (params.state) target.searchParams.set("state", params.state);

  return Response.redirect(target.toString(), 302);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const validated = await validateParams(parseParams(url.searchParams));
  if (!validated.ok) return validated.response;

  const { params, client } = validated;
  // Always require an explicit approval click — never silently mint a code on
  // GET, even with a valid session (defends against authorization-code phishing
  // of a logged-in owner combined with open client registration).
  const authenticated = await hasValidDashboardSession(req);
  return consentPage(params, client.client_name || client.client_id, { authenticated });
}

export async function POST(req: Request) {
  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch {
    return errorPage("Invalid form body");
  }

  const validated = await validateParams(parseParams(form));
  if (!validated.ok) return validated.response;

  const { params, client } = validated;
  const password = process.env.MC_DASHBOARD_PASSWORD;

  // Dev/demo: no password configured → approve immediately.
  if (!password) {
    return mintCodeAndRedirect(params, req);
  }

  // Accept either an existing dashboard session or a correct password on this
  // POST. Either way, approval is an explicit user action (the Approve click).
  const hasSession = await hasValidDashboardSession(req);
  const submitted = form.get("password") ?? "";
  const passwordOk = submitted.length > 0 && (await secretsMatch(submitted, password));

  if (!hasSession && !passwordOk) {
    return consentPage(params, client.client_name || client.client_id, {
      authenticated: false,
      error: submitted ? "Wrong password" : "Password required",
    });
  }

  const res = await mintCodeAndRedirect(params, req);
  if (!passwordOk) {
    // Approved via an existing session — no new cookie needed.
    return res;
  }
  // Password approval — (re)establish the dashboard session cookie.
  const headers = new Headers(res.headers);
  const cookieVal = await authCookieValue(password);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  headers.append(
    "Set-Cookie",
    `mc_auth=${cookieVal}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`
  );
  return new Response(res.body, { status: res.status, headers });
}
