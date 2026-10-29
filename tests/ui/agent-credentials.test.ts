import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { authCookieValue } from "../../src/lib/authcrypto";
import {
  createCredential,
  listCredentials,
  plantCredentialForTests,
  readCredentialHashForTests,
  resetCredentialsForTests,
  resolveAgentCredential,
  revokeCredential,
  setCredentialClockForTests,
  setLastUsedWriterForTests,
} from "../../src/lib/credentials";
import {
  SCOPES,
  TOOL_SCOPES,
  authorizeRoute,
  authorizeTool,
  evaluateMcpMessages,
  principalFromMcpAuth,
  type Principal,
} from "../../src/lib/scopes";

/**
 * Prior art: tests/ui/auth.test.ts (bearer decisions), tests/ui/mcp-tools.test.ts
 * (tool names are read from the route source), tests/ui/traces-route.test.ts
 * (call the route handler with a Request).
 */

const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
};

// A successful tools/call goes through mcp-handler, which leaves a session
// and a cleanup timer referenced. The suite has already reported by the time
// this hook runs; exit so `npm run test:ui` is not stuck on that handle.
after(() => {
  const code = process.exitCode ?? 0;
  setImmediate(() => process.exit(code));
});

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["NODE_ENV", saved.node],
    ["MC_DASHBOARD_PASSWORD", saved.password],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
});

afterEach(() => {
  resetCredentialsForTests();
  restoreEnv();
});

function agent(scopes: string[]): Principal {
  return { kind: "agent", id: "cred-test", scopes };
}

async function issue(scopes: string[], expires_at?: string) {
  const created = await createCredential({ label: "lane test", scopes, expires_at });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("unreachable");
  assert.match(created.token, /^akc_[A-Za-z0-9_-]{20,}$/);
  return created;
}

describe("scope table", { concurrency: false }, () => {
  it("maps every registered MCP tool, and denies a tool that is absent", () => {
    const src = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const names = new Set<string>([
      ...Array.from(src.matchAll(/registerTool\(\s*"([^"]+)"/g), (m) => m[1]),
      ...Array.from(src.matchAll(/name:\s*"([^"]+)"/g), (m) => m[1]),
    ]);
    for (const name of [
      "report_status",
      "get_fleet_status",
      "get_progress_digest",
      "get_morning_brief",
      "remember",
      "recall",
      "check_inbox",
      "reply_to_operator",
      "reply_to_mark",
      "create_task",
      "get_task_queue",
      "claim_task",
      "update_task",
      "list_skills",
      "get_skill",
      "run_skill",
      "send_message",
      "requeue_task",
      "delete_note",
    ]) {
      assert.ok(names.has(name), `route source is missing ${name}`);
      assert.ok(TOOL_SCOPES[name], `${name} is not in the scope table`);
    }
    const legacy = authorizeTool({ kind: "legacy" }, "not_a_real_tool");
    const oauth = authorizeTool({ kind: "oauth", id: "oauth-client" }, "not_a_real_tool");
    const full = authorizeTool(agent([...SCOPES]), "not_a_real_tool");
    assert.equal(legacy.ok, false);
    assert.equal(oauth.ok, false);
    assert.equal(full.ok, false);
    if (!full.ok) assert.equal(full.body.code, "insufficient_scope");
  });

  it("denies an agent credential on a route that is not in the table, and still allows the legacy token", () => {
    const principal = agent(["fleet:read"]);
    const missing = authorizeRoute(principal, "GET", "/api/usage");
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.status, 403);
      assert.equal(missing.body.code, "insufficient_scope");
      assert.equal(missing.body.retryable, false);
    }
    assert.equal(authorizeRoute({ kind: "legacy" }, "GET", "/api/usage").ok, true);
    assert.equal(authorizeRoute({ kind: "session" }, "POST", "/api/settings/credentials").ok, true);
  });

  it("requires tasks:write for create_task and status:write for report_status", () => {
    const fleetOnly = agent(["fleet:read"]);
    const create = authorizeTool(fleetOnly, "create_task");
    const report = authorizeTool(fleetOnly, "report_status");
    assert.equal(create.ok, false);
    assert.equal(report.ok, false);
    if (!create.ok) assert.equal(create.body.fix, "Use a credential that has the tasks:write scope");
    if (!report.ok) assert.equal(report.body.fix, "Use a credential that has the status:write scope");
    assert.equal(authorizeTool(agent(["tasks:write"]), "create_task").ok, true);
    assert.equal(authorizeTool({ kind: "legacy" }, "create_task").ok, true);
    assert.equal(authorizeTool({ kind: "oauth", id: "oauth-client" }, "report_status").ok, true);
  });

  it("treats an authenticated OAuth AuthInfo as all-access on mapped tools", () => {
    const principal = principalFromMcpAuth({
      clientId: "oauth-client",
      scopes: ["mcp"],
      extra: { sub: "oauth-client" },
    });
    assert.equal(principal?.kind, "oauth");
    assert.ok(principal);
    if (!principal) return;
    assert.equal(authorizeTool(principal, "create_task").ok, true);
    assert.equal(authorizeTool(principal, "not_a_real_tool").ok, false);
    assert.equal(principalFromMcpAuth({ clientId: "mystery", scopes: ["mcp"] }), null);
    const denied = evaluateMcpMessages(null, { method: "tools/call", params: { name: "create_task" } });
    assert.equal(denied.ok, false);
  });

  it("denies a tools/call it cannot read, and allows initialize", () => {
    const principal = agent(["tasks:write"]);
    assert.equal(evaluateMcpMessages(principal, { method: "initialize", params: {} }).ok, true);
    assert.equal(evaluateMcpMessages(principal, { method: "tools/call", params: {} }).ok, false);
    assert.equal(evaluateMcpMessages(principal, { not: "a message" }).ok, false);
    const call = evaluateMcpMessages(agent(["fleet:read"]), {
      method: "tools/call",
      params: { name: "create_task" },
    });
    assert.equal(call.ok, false);
    if (!call.ok) assert.equal(call.body.fix, "Use a credential that has the tasks:write scope");
  });

  it("keeps the schema idempotent and puts columns before the token index", () => {
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    const migration = fs.readFileSync("supabase/migrations/20261021_agent_credentials.sql", "utf8");
    for (const sql of [schema, migration]) {
      assert.match(sql, /create table if not exists agent_credentials/);
      assert.match(sql, /add column if not exists token_hash/);
      const tableAt = sql.indexOf("create table if not exists agent_credentials");
      const indexAt = sql.indexOf("agent_credentials_token_hash_idx");
      assert.ok(tableAt !== -1 && indexAt > tableAt);
      assert.ok(sql.indexOf("add column if not exists token_hash") < indexAt);
    }
    assert.doesNotMatch(schema, /drop table/);
  });

  it("requires every API route except login, the MCP transport, and the public OpenAPI document to enforce auth itself", () => {
    const root = "src/app/api";
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") files.push(full);
      }
    };
    walk(root);
    assert.ok(files.length >= 15);
    for (const file of files) {
      if (file.includes(`${path.sep}login${path.sep}`)) continue;
      if (file.includes("[transport]")) continue;
      // The OpenAPI document is the public contract, same as GET /docs/api.md.
      // It must not grow an auth check that would hide it, and it must not
      // become a pattern for other routes to skip enforcement.
      if (file.includes(`${path.sep}openapi.json${path.sep}`)) continue;
      const src = fs.readFileSync(file, "utf8");
      assert.match(
        src,
        /enforceApi|enforceBearer|requireDashboardSession|resolveApiAccess|resolveBearerAccess/,
        `${file} does not enforce credentials`,
      );
      if (/resolveApiAccess|resolveBearerAccess/.test(src)) {
        assert.match(src, /if \(!access\.ok\) return deny\(access\)/, `${file} resolves access but does not deny`);
      }
    }
  });
});

describe("credential store", { concurrency: false }, () => {
  it("stores a hash, shows the token once, and lists neither the token nor the hash", async () => {
    const created = await issue(["fleet:read", "tasks:read"]);
    const hash = await readCredentialHashForTests(created.credential.id);
    assert.equal(hash, createHash("sha256").update(created.token).digest("hex"));
    assert.notEqual(hash, created.token);
    assert.equal(created.credential.token_prefix, created.token.slice(0, 8));
    const listed = await listCredentials();
    const blob = JSON.stringify(listed);
    assert.equal(blob.includes(created.token), false);
    assert.equal(blob.includes(String(hash)), false);
    assert.equal(listed[0]?.label, "lane test");
    assert.deepEqual(listed[0]?.scopes, ["fleet:read", "tasks:read"]);
    assert.equal("token" in (listed[0] ?? {}), false);
    assert.equal("token_hash" in (listed[0] ?? {}), false);
  });

  it("rejects revoked and expired credentials and a token that was never issued", async () => {
    const created = await issue(["fleet:read"], new Date(Date.now() + 60_000).toISOString());
    assert.equal((await resolveAgentCredential(created.token)).status, "ok");
    assert.equal((await resolveAgentCredential("akc_this-token-was-not-issued")).status, "reject");
    await revokeCredential(created.credential.id);
    assert.equal((await resolveAgentCredential(created.token)).status, "reject");

    const expiring = await issue(["tasks:read"], new Date(Date.now() + 60_000).toISOString());
    setCredentialClockForTests(() => Date.now() + 120_000);
    assert.equal((await resolveAgentCredential(expiring.token)).status, "reject");

    plantCredentialForTests({
      token: "akc_planted-expiry-not-a-secret",
      scopes: ["fleet:read"],
      expires_at: "not-a-date",
    });
    assert.equal((await resolveAgentCredential("akc_planted-expiry-not-a-secret")).status, "reject");
    plantCredentialForTests({
      token: "akc_planted-revoked-not-a-secret",
      scopes: ["fleet:read"],
      revoked_at: "not-a-date",
    });
    assert.equal((await resolveAgentCredential("akc_planted-revoked-not-a-secret")).status, "reject");
  });

  it("still resolves the credential when the last_used_at write throws", async () => {
    const created = await issue(["fleet:read"]);
    setLastUsedWriterForTests(async () => {
      throw new Error("timestamp store unavailable");
    });
    const resolved = await resolveAgentCredential(created.token);
    assert.equal(resolved.status, "ok");
  });

  it("records last_used_at on a successful resolve", async () => {
    const created = await issue(["fleet:read"]);
    assert.equal(created.credential.last_used_at, null);
    assert.equal((await resolveAgentCredential(created.token)).status, "ok");
    const listed = await listCredentials();
    assert.equal(typeof listed[0]?.last_used_at, "string");
  });

  it("rejects an unknown scope and an expiry in the past", async () => {
    const badScope = await createCredential({ label: "x", scopes: ["tasks:own"] });
    assert.equal(badScope.ok, false);
    const badExpiry = await createCredential({
      label: "x",
      scopes: ["fleet:read"],
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(badExpiry.ok, false);
  });
});

describe("REST enforcement", { concurrency: false }, () => {
  it("blocks create-task and ingest when the scope is missing, and allows them when it is present", async () => {
    const fleetOnly = await issue(["fleet:read"]);
    const writer = await issue(["tasks:write", "status:write"]);
    env.MC_TOKEN = "test-mc-token";

    const { POST: postTasks } = await import("../../src/app/api/tasks/route");
    const { POST: postIngest } = await import("../../src/app/api/ingest/route");
    const { GET: getFleet } = await import("../../src/app/api/fleet/route");

    const taskReq = (token: string) =>
      new Request("http://localhost/api/tasks", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "synthetic task" }),
      });
    const ingestReq = (token: string) =>
      new Request("http://localhost/api/ingest", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ agent_id: "lane-test", kind: "status", title: "synthetic" }),
      });

    const deniedTask = await postTasks(taskReq(fleetOnly.token));
    assert.equal(deniedTask.status, 403);
    const deniedBody = await deniedTask.json();
    assert.equal(deniedBody.code, "insufficient_scope");
    assert.equal(deniedBody.fix, "Use a credential that has the tasks:write scope");
    assert.equal(deniedBody.retryable, false);
    assert.equal(JSON.stringify(deniedBody).includes(fleetOnly.token), false);

    const deniedIngest = await postIngest(ingestReq(fleetOnly.token));
    assert.equal(deniedIngest.status, 403);
    assert.equal((await deniedIngest.json()).fix, "Use a credential that has the status:write scope");

    const allowedTask = await postTasks(taskReq(writer.token));
    assert.equal(allowedTask.status, 200);
    const allowedIngest = await postIngest(ingestReq(writer.token));
    assert.equal(allowedIngest.status, 200);

    const fleet = await getFleet(
      new Request("http://localhost/api/fleet", { headers: { authorization: `Bearer ${fleetOnly.token}` } }),
    );
    assert.equal(fleet.status, 200);

    const legacy = await postTasks(taskReq("test-mc-token"));
    assert.equal(legacy.status, 200);

    const unknown = await getFleet(
      new Request("http://localhost/api/fleet", { headers: { authorization: "Bearer akc_not-a-real-credential" } }),
    );
    assert.equal(unknown.status, 401);
    assert.equal((await unknown.json()).error, "unauthorized");
  });

  it("keeps the credential routes on the dashboard session", async () => {
    env.MC_TOKEN = "test-mc-token";
    const issued = await issue(["tasks:write", "fleet:read", "status:write"]);
    const { GET, POST, DELETE } = await import("../../src/app/api/settings/credentials/route");

    const authed = (token: string) =>
      new Request("http://localhost/api/settings/credentials", {
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await GET(authed("test-mc-token"))).status, 401);
    assert.equal((await GET(authed(issued.token))).status, 401);

    const open = await GET(new Request("http://localhost/api/settings/credentials"));
    assert.equal(open.status, 200);
    const openBody = await open.json();
    assert.equal(JSON.stringify(openBody).includes(issued.token), false);
    assert.equal(JSON.stringify(openBody).includes("token_hash"), false);

    const created = await POST(
      new Request("http://localhost/api/settings/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "from the route", scopes: ["fleet:read"] }),
      }),
    );
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.match(createdBody.credential.token, /^akc_/);
    const again = await GET(new Request("http://localhost/api/settings/credentials"));
    const againBody = await again.json();
    assert.equal(JSON.stringify(againBody).includes(createdBody.credential.token), false);

    const removed = await DELETE(
      new Request("http://localhost/api/settings/credentials", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: createdBody.credential.id }),
      }),
    );
    assert.equal(removed.status, 200);
    assert.equal((await resolveAgentCredential(createdBody.credential.token)).status, "reject");

    env.MC_DASHBOARD_PASSWORD = "test-dashboard-password";
    const locked = await GET(new Request("http://localhost/api/settings/credentials"));
    assert.equal(locked.status, 401);
    const cookie = await authCookieValue("test-dashboard-password");
    const session = await GET(
      new Request("http://localhost/api/settings/credentials", { headers: { cookie: `mc_auth=${cookie}` } }),
    );
    assert.equal(session.status, 200);
    const both = await GET(
      new Request("http://localhost/api/settings/credentials", {
        headers: { cookie: `mc_auth=${cookie}`, authorization: "Bearer test-mc-token" },
      }),
    );
    assert.equal(both.status, 401);
  });
});

describe("MCP enforcement", { concurrency: false }, () => {
  it("rejects a tools/call the credential cannot make, and accepts the legacy token", async () => {
    env.MC_TOKEN = "test-mc-token";
    const fleetOnly = await issue(["fleet:read"]);
    const writer = await issue(["tasks:write"]);
    const { POST } = await import("../../src/app/api/[transport]/route");

    const call = (token: string, name: string) =>
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { title: "synthetic task" } },
        }),
      });

    const denied = await POST(call(fleetOnly.token, "create_task"));
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json();
    assert.equal(deniedBody.code, "insufficient_scope");
    assert.equal(deniedBody.fix, "Use a credential that has the tasks:write scope");
    assert.equal(deniedBody.retryable, false);

    const statusDenied = await POST(call(fleetOnly.token, "report_status"));
    assert.equal(statusDenied.status, 403);
    assert.equal((await statusDenied.json()).fix, "Use a credential that has the status:write scope");

    const unmapped = await POST(call(writer.token, "not_a_real_tool"));
    assert.equal(unmapped.status, 403);

    const allowed = await POST(call(writer.token, "create_task"));
    assert.notEqual(allowed.status, 403);
    assert.notEqual(allowed.status, 401);

    const legacy = await POST(call("test-mc-token", "create_task"));
    assert.notEqual(legacy.status, 403);
    assert.notEqual(legacy.status, 401);

    await revokeCredential(writer.credential.id);
    const revoked = await POST(call(writer.token, "create_task"));
    assert.equal(revoked.status, 401);
    assert.match(revoked.headers.get("www-authenticate") ?? "", /resource_metadata/);
  });
});
