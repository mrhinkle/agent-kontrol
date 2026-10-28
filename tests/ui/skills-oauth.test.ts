import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { enforceApi } from "../../src/lib/auth";
import { authCookieValue, signAccessToken, verifyAccessToken } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { authorizeRoute, authorizeTool, scopeForRoute } from "../../src/lib/scopes";

/**
 * OAuth on the skills surface.
 *
 * An OAuth principal is unrestricted on mapped tools, and on routes left off
 * the scope table, the same way a legacy principal is on decisions.
 * A signed OAuth access token presented to REST does not become that
 * principal. resolveApiAccess has no JWT path.
 *
 * The dashboard password is set so the routes are closed. With it unset,
 * decideBearer("dashboard-open") allows any non-akc_ bearer, including this
 * JWT, as dev-open. That allow is the open dashboard, not an OAuth grant.
 */

const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  password: env.MC_DASHBOARD_PASSWORD,
  oauth: env.MC_OAUTH_SECRET,
  cookie: env.MC_COOKIE_SECRET,
  node: env.NODE_ENV,
};

let dashboardPassword = "";
let legacyToken = "";

const OPERATOR = [
  {
    label: "PATCH /api/skills/some-id",
    method: "PATCH" as const,
    path: "/api/skills/some-id",
    body: { trigger: "on_request" },
  },
  {
    label: "POST /api/skills/sync",
    method: "POST" as const,
    path: "/api/skills/sync",
    body: { trigger: "scheduled" },
  },
  {
    label: "POST /api/skills/drift",
    method: "POST" as const,
    path: "/api/skills/drift",
    body: { host: "lane-host", dir: "~/.codex/skills", skills: [] },
  },
];

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["MC_OAUTH_SECRET", saved.oauth],
    ["MC_COOKIE_SECRET", saved.cookie],
    ["NODE_ENV", saved.node],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function operatorRequest(call: (typeof OPERATOR)[number], headers: Record<string, string>): Request {
  return new Request(`http://localhost${call.path}`, {
    method: call.method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(call.body),
  });
}

async function callRoute(call: (typeof OPERATOR)[number], headers: Record<string, string>): Promise<Response> {
  const req = operatorRequest(call, headers);
  if (call.method === "PATCH") {
    const { PATCH } = await import("../../src/app/api/skills/[id]/route");
    return PATCH(req, { params: Promise.resolve({ id: "some-id" }) });
  }
  if (call.path.endsWith("/sync")) {
    const { POST } = await import("../../src/app/api/skills/sync/route");
    return POST(req);
  }
  const { POST } = await import("../../src/app/api/skills/drift/route");
  return POST(req);
}

async function issue(scopes: string[]) {
  const created = await createCredential({ label: "skills oauth", scopes });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("credential");
  return created.token;
}

describe("skills OAuth principals", { concurrency: false }, () => {
  beforeEach(() => {
    delete env.DATABASE_URL;
    delete env.MC_COOKIE_SECRET;
    env.NODE_ENV = "test";
    dashboardPassword = randomUUID();
    legacyToken = randomUUID();
    env.MC_DASHBOARD_PASSWORD = dashboardPassword;
    env.MC_TOKEN = legacyToken;
    env.MC_OAUTH_SECRET = randomUUID();
    resetCredentialsForTests();
    setSqlForTests(null);
  });

  afterEach(() => {
    setSqlForTests(null);
    resetCredentialsForTests();
    restoreEnv();
  });

  it("treats an OAuth principal as unrestricted on the skills tools, same as decisions", () => {
    const oauth = { kind: "oauth" as const, id: "oauth-client" };
    for (const tool of ["list_skills", "get_skill", "run_skill"]) {
      assert.equal(authorizeTool(oauth, tool).ok, true, tool);
    }

    const reader = { kind: "agent" as const, id: "cred-read", scopes: ["skills:read"] };
    assert.equal(authorizeTool(reader, "list_skills").ok, true);
    assert.equal(authorizeTool(reader, "get_skill").ok, true);
    const run = authorizeTool(reader, "run_skill");
    assert.equal(run.ok, false);
    if (!run.ok) {
      assert.equal(run.status, 403);
      assert.equal(run.body.code, "insufficient_scope");
      assert.match(run.body.fix, /skills:write/);
    }

    const neither = { kind: "agent" as const, id: "cred-fleet", scopes: ["fleet:read"] };
    for (const [tool, scope] of [
      ["list_skills", "skills:read"],
      ["get_skill", "skills:read"],
      ["run_skill", "skills:write"],
    ] as const) {
      const decision = authorizeTool(neither, tool);
      assert.equal(decision.ok, false, tool);
      if (!decision.ok) {
        assert.equal(decision.status, 403);
        assert.equal(decision.body.code, "insufficient_scope");
        assert.match(decision.body.fix, new RegExp(scope));
      }
    }

    const legacy = { kind: "legacy" as const };
    for (const call of OPERATOR) {
      assert.equal(scopeForRoute(call.method, call.path), null, call.label);
      assert.equal(authorizeRoute(oauth, call.method, call.path).ok, true, call.label);
      assert.equal(authorizeRoute(legacy, call.method, call.path).ok, true, call.label);
    }
    assert.equal(scopeForRoute("POST", "/api/decisions"), null);
    assert.equal(scopeForRoute("GET", "/api/decisions"), null);
    assert.equal(authorizeRoute(oauth, "POST", "/api/decisions").ok, true);
    assert.equal(authorizeRoute(legacy, "GET", "/api/decisions").ok, true);
  });

  it("denies a signed OAuth access token on the operator routes", async () => {
    // Same helper and payload shape the token endpoint uses (src/app/oauth/token/route.ts).
    // oauthSigningKey() reads MC_OAUTH_SECRET first. beforeEach set that.
    const jwt = await signAccessToken(
      {
        iss: "http://localhost:3000",
        aud: "http://localhost:3000/api/mcp",
        sub: "oauth-client",
        client_id: "oauth-client",
        scope: "mcp",
        typ: "access",
      },
      3600,
    );
    const payload = await verifyAccessToken(jwt);
    assert.ok(payload);
    assert.equal(payload.client_id, "oauth-client");
    assert.equal(payload.sub, "oauth-client");
    assert.equal(payload.scope, "mcp");
    assert.equal(payload.typ, "access");
    assert.equal(jwt.split(".").length, 3);

    const headers = { authorization: `Bearer ${jwt}` };
    for (const call of OPERATOR) {
      const gated = await enforceApi(operatorRequest(call, headers));
      assert.ok(gated, `${call.label} enforceApi allowed the OAuth token`);
      assert.equal(gated.status, 401, `${call.label} enforceApi`);
      assert.equal((await gated.json()).code, "unauthorized");

      const routed = await callRoute(call, headers);
      assert.equal(routed.status, 401, `${call.label} route`);
      assert.equal((await routed.json()).code, "unauthorized");
    }
  });

  it("denies an agent credential on the operator routes even with both skills scopes", async () => {
    const token = await issue(["skills:read", "skills:write"]);
    const headers = { authorization: `Bearer ${token}` };
    const both = { kind: "agent" as const, id: "cred-both", scopes: ["skills:read", "skills:write"] };
    for (const call of OPERATOR) {
      assert.equal(authorizeRoute(both, call.method, call.path).ok, false, call.label);
      const gated = await enforceApi(operatorRequest(call, headers));
      assert.ok(gated, `${call.label} enforceApi allowed the agent credential`);
      assert.equal(gated.status, 403, `${call.label} enforceApi`);
      const gatedBody = await gated.json() as { code: string; fix: string };
      assert.equal(gatedBody.code, "insufficient_scope");
      assert.match(gatedBody.fix, /not granted by any agent scope/);

      const routed = await callRoute(call, headers);
      assert.equal(routed.status, 403, `${call.label} route`);
      const routedBody = await routed.json() as { code: string };
      assert.equal(routedBody.code, "insufficient_scope");
    }
  });

  it("allows the legacy MC_TOKEN and the dashboard session on the operator routes", async () => {
    const cookie = await authCookieValue(dashboardPassword);
    const callers: { name: string; headers: Record<string, string> }[] = [
      { name: "MC_TOKEN", headers: { authorization: `Bearer ${legacyToken}` } },
      { name: "dashboard session", headers: { cookie: `mc_auth=${cookie}` } },
    ];
    for (const caller of callers) {
      for (const call of OPERATOR) {
        const gated = await enforceApi(operatorRequest(call, caller.headers));
        assert.equal(gated, null, `${caller.name} ${call.label} enforceApi`);
        const routed = await callRoute(call, caller.headers);
        assert.equal(routed.status, 200, `${caller.name} ${call.label}`);
        const body = await routed.json() as { ok?: boolean; demo?: boolean };
        assert.equal(body.ok, true, `${caller.name} ${call.label}`);
        assert.equal(body.demo, true, `${caller.name} ${call.label}`);
      }
    }
  });
});
