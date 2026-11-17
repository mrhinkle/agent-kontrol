import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setSqlForTests } from "../../src/lib/db";
import { signAccessToken } from "../../src/lib/authcrypto";

/**
 * Issue #52 Q6 OAuth teaching. Real register and token routes, synthetic
 * SQL only. No credential is minted against a live provider.
 */

const env = process.env as Record<string, string | undefined>;
const KEYS = ["DATABASE_URL", "NODE_ENV", "MC_OAUTH_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
const SECRET = "password=oauth-probe-secret";

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_OAUTH_SECRET;
  env.NODE_ENV = "test";
  setSqlForTests(null);
});

afterEach(() => {
  setSqlForTests(null);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

function formRequest(path: string, fields: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function assertTeaching(body: Record<string, unknown>, expected: { error: string; description: string; retryable: boolean }) {
  assert.equal(body.error, expected.error);
  assert.equal(body.error_description, expected.description);
  assert.equal(body.code, expected.error);
  assert.equal(body.cause, expected.description);
  assert.equal(body.retryable, expected.retryable);
  assert.equal(typeof body.fix, "string");
  assert.equal(JSON.stringify(body).includes(SECRET), false);
}

describe("OAuth register and token teaching", { concurrency: false }, () => {
  it("treats unconfigured storage as operator setup, not a transient retry", async () => {
    const { POST: register } = await import("../../src/app/oauth/register/route");
    const { POST: token } = await import("../../src/app/oauth/token/route");
    const { GET: authorize } = await import("../../src/app/oauth/authorize/route");
    for (const res of [
      await register(new Request("http://localhost/oauth/register", { method: "POST", body: "{}" })),
      await token(formRequest("/oauth/token", { grant_type: "authorization_code" })),
    ]) {
      assert.equal(res.status, 503);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const body = await res.json() as Record<string, unknown>;
      assertTeaching(body, { error: "server_error", description: "OAuth storage is not configured", retryable: false });
      assert.match(String(body.fix), /not a transient/);
    }
    const page = await authorize(new Request("http://localhost/oauth/authorize"));
    assert.equal(page.status, 503);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /OAuth storage is not configured/);
    assert.equal(html.includes("\"retryable\""), false);
  });

  it("teaches malformed registration, a bad redirect, and a transient register failure", async () => {
    env.DATABASE_URL = "postgresql://oauth-test.invalid/none";
    const { POST } = await import("../../src/app/oauth/register/route");
    const malformed = await POST(new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));
    assert.equal(malformed.status, 400);
    assertTeaching(await malformed.json(), {
      error: "invalid_client_metadata",
      description: "Request body must be JSON",
      retryable: false,
    });

    let sqlCalls = 0;
    setSqlForTests(async () => {
      sqlCalls += 1;
      throw new Error("register SQL must not run");
    });
    for (const body of ["null", "[]", "\"client\"", "1", "true"]) {
      const rejected = await POST(new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }));
      assert.equal(rejected.status, 400, body);
      const rejectedBody = await rejected.json() as Record<string, unknown>;
      assertTeaching(rejectedBody, {
        error: "invalid_client_metadata",
        description: "Request body must be a JSON object",
        retryable: false,
      });
      assert.equal(rejectedBody.error_description, "Request body must be a JSON object");
      assert.match(String(rejectedBody.fix), /client metadata/);
    }
    assert.equal(sqlCalls, 0);
    setSqlForTests(null);

    const empty = await POST(new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(empty.status, 400);
    const emptyBody = await empty.json() as Record<string, unknown>;
    assert.equal(emptyBody.error, "invalid_redirect_uri");
    assert.equal(emptyBody.error_description, "redirect_uris is required and must be a non-empty array");

    const redirect = await POST(new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    }));
    assert.equal(redirect.status, 400);
    const redirectBody = await redirect.json() as Record<string, unknown>;
    assert.equal(redirectBody.error, "invalid_redirect_uri");
    assert.equal(redirectBody.retryable, false);
    assert.match(String(redirectBody.fix), /https/);

    setSqlForTests(async () => { throw new Error(SECRET); });
    const failed = await POST(new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" }),
    }));
    assert.equal(failed.status, 500);
    const failedBody = await failed.json() as Record<string, unknown>;
    assertTeaching(failedBody, { error: "server_error", description: "Failed to register client", retryable: true });
    assert.match(String(failedBody.fix), /bounded number of times/);
  });

  it("registers a public client without adding error fields to the success body", async () => {
    env.DATABASE_URL = "postgresql://oauth-test.invalid/none";
    let inserts = 0;
    setSqlForTests(async (strings) => {
      assert.match(strings.join("?"), /insert into oauth_clients/);
      inserts += 1;
      return [];
    });
    const { POST } = await import("../../src/app/oauth/register/route");
    const res = await POST(new Request("http://localhost/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/cb"],
        client_name: "synthetic",
        token_endpoint_auth_method: "none",
      }),
    }));
    assert.equal(res.status, 201);
    assert.equal(inserts, 1);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(typeof body.client_id, "string");
    assert.equal(body.client_secret, undefined);
    assert.equal(body.error, undefined);
    assert.equal(body.fix, undefined);
    assert.deepEqual(body.redirect_uris, ["https://client.example/cb"]);
  });

  it("keeps token failures on their RFC status and distinguishes expiry from a store outage", async () => {
    env.DATABASE_URL = "postgresql://oauth-test.invalid/none";
    env.MC_OAUTH_SECRET = "oauth-test-secret";
    const { POST } = await import("../../src/app/oauth/token/route");

    const missing = await POST(formRequest("/oauth/token", { grant_type: "authorization_code" }));
    assert.equal(missing.status, 400);
    assertTeaching(await missing.json(), { error: "invalid_request", description: "client_id is required", retryable: false });

    setSqlForTests(async () => []);
    const unknown = await POST(formRequest("/oauth/token", { grant_type: "authorization_code", client_id: "missing" }));
    assert.equal(unknown.status, 401);
    assertTeaching(await unknown.json(), { error: "invalid_client", description: "Unknown client_id", retryable: false });

    const client = {
      client_id: "public-client",
      client_secret: null,
      token_endpoint_auth_method: "none",
    };
    const confidential = {
      client_id: "secret-client",
      client_secret: "stored-secret",
      token_endpoint_auth_method: "client_secret_post",
    };
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join("?");
      if (/from oauth_clients/.test(text)) {
        if (values[0] === "secret-client") return [confidential];
        if (values[0] === "public-client") return [client];
        return [];
      }
      return [];
    });
    const badSecret = await POST(formRequest("/oauth/token", {
      grant_type: "authorization_code",
      client_id: "secret-client",
      client_secret: "nope",
    }));
    assert.equal(badSecret.status, 401);
    assertTeaching(await badSecret.json(), { error: "invalid_client", description: "Invalid client credentials", retryable: false });

    const unsupported = await POST(formRequest("/oauth/token", { grant_type: "password", client_id: "public-client" }));
    assert.equal(unsupported.status, 400);
    const unsupportedBody = await unsupported.json() as Record<string, unknown>;
    assert.equal(unsupportedBody.error, "unsupported_grant_type");
    assert.equal(unsupportedBody.retryable, false);
    assert.match(String(unsupportedBody.fix), /authorization_code/);

    const verifier = "synthetic-verifier-value";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join("?");
      if (/from oauth_clients/.test(text)) return [client];
      if (/from oauth_codes/.test(text)) {
        if (values[0] === "expired-code") {
          return [{
            code: "expired-code",
            client_id: "public-client",
            redirect_uri: "https://client.example/cb",
            code_challenge: challenge,
            code_challenge_method: "S256",
            scope: "mcp",
            resource: null,
            expires_at: "2000-01-01T00:00:00.000Z",
            used: false,
          }];
        }
        if (values[0] === "outage-code") throw new Error(SECRET);
        return [];
      }
      return [];
    });
    const expired = await POST(formRequest("/oauth/token", {
      grant_type: "authorization_code",
      client_id: "public-client",
      code: "expired-code",
      redirect_uri: "https://client.example/cb",
      code_verifier: verifier,
    }));
    assert.equal(expired.status, 400);
    const expiredBody = await expired.json() as Record<string, unknown>;
    assertTeaching(expiredBody, { error: "invalid_grant", description: "Authorization code has expired", retryable: false });
    assert.match(String(expiredBody.fix), /Start authorization again/);

    const outage = await POST(formRequest("/oauth/token", {
      grant_type: "authorization_code",
      client_id: "public-client",
      code: "outage-code",
      redirect_uri: "https://client.example/cb",
      code_verifier: verifier,
    }));
    assert.equal(outage.status, 500);
    const outageBody = await outage.json() as Record<string, unknown>;
    assertTeaching(outageBody, { error: "server_error", description: "Failed to look up authorization code", retryable: true });

    const refresh = await signAccessToken({
      iss: "http://localhost",
      aud: "http://localhost/api/mcp",
      sub: "public-client",
      client_id: "public-client",
      scope: "mcp",
      typ: "refresh",
    }, -10);
    const staleRefresh = await POST(formRequest("/oauth/token", {
      grant_type: "refresh_token",
      client_id: "public-client",
      refresh_token: refresh,
    }));
    assert.equal(staleRefresh.status, 400);
    const refreshBody = await staleRefresh.json() as Record<string, unknown>;
    assert.equal(refreshBody.error, "invalid_grant");
    assert.equal(refreshBody.error_description, "Invalid or expired refresh token");
    assert.equal(refreshBody.retryable, false);
    assert.match(String(refreshBody.fix), /Do not retry this refresh token/);
  });

  it("answers a client-lookup database failure as retryable server_error", async () => {
    env.DATABASE_URL = "postgresql://oauth-test.invalid/none";
    env.MC_OAUTH_SECRET = "oauth-test-secret";
    const { POST } = await import("../../src/app/oauth/token/route");
    let queries = 0;
    setSqlForTests(async () => {
      queries += 1;
      throw new Error(`store down ${SECRET}`);
    });
    const res = await POST(formRequest("/oauth/token", {
      grant_type: "authorization_code",
      client_id: "known-client",
      client_secret: "secret",
    }));
    assert.equal(queries, 1);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json() as Record<string, unknown>;
    assertTeaching(body, {
      error: "server_error",
      description: "OAuth storage did not complete the client lookup.",
      retryable: true,
    });
    assert.equal(body.fix, "Retry a bounded number of times. OAuth storage did not complete the request.");
    assert.equal(body.access_token, undefined);
    assert.equal("principal" in body, false);
  });

  it("returns the token response unchanged after a valid code redemption", async () => {
    env.DATABASE_URL = "postgresql://oauth-test.invalid/none";
    env.MC_OAUTH_SECRET = "oauth-test-secret";
    const verifier = "synthetic-verifier-value";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let updates = 0;
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join("?");
      if (/from oauth_clients/.test(text)) {
        return [{ client_id: "public-client", client_secret: null, token_endpoint_auth_method: "none" }];
      }
      if (/from oauth_codes/.test(text)) {
        return [{
          code: values[0],
          client_id: "public-client",
          redirect_uri: "https://client.example/cb",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "mcp",
          resource: "http://localhost/api/mcp",
          expires_at: "2999-01-01T00:00:00.000Z",
          used: false,
        }];
      }
      if (/update oauth_codes/.test(text)) {
        updates += 1;
        return [{ code: values[0] }];
      }
      return [];
    });
    const { POST } = await import("../../src/app/oauth/token/route");
    const res = await POST(formRequest("/oauth/token", {
      grant_type: "authorization_code",
      client_id: "public-client",
      code: "live-code",
      redirect_uri: "https://client.example/cb",
      code_verifier: verifier,
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(updates, 1);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.token_type, "Bearer");
    assert.equal(typeof body.access_token, "string");
    assert.equal(typeof body.refresh_token, "string");
    assert.equal(body.scope, "mcp");
    assert.equal(body.error, undefined);
    assert.equal(body.fix, undefined);
    assert.equal(body.code, undefined);
  });
});
