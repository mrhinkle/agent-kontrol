import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runWithActor } from "../../src/lib/actor";
import { signAccessToken } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, sql, type Row, type SqlTag } from "../../src/lib/db";
import { fakeQuotaSql } from "./quota-fake";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { skillsDigest } from "../../src/lib/skills/digest";
import { runSkillTool } from "../../src/lib/skills/mcp";
import { callsOf, installSkillsSql, skillsMemory, type MemSkill } from "./skills-memory";

/**
 * run_skill records the authenticated principal.
 * A supplied agent_id is not an identity, except as the span label
 * reported_agent_id on the two shared-secret principals.
 */

const NOW = "2026-10-27T12:00:00.000Z";
const DB = "postgres://skills:skills@127.0.0.1:9/skills_test";
const LEGACY = "identity-mc-token";
const OAUTH_SECRET = "identity-oauth-secret";
const OAUTH_ID = "oauth-client-9";
const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  password: env.MC_DASHBOARD_PASSWORD,
  oauth: env.MC_OAUTH_SECRET,
  node: env.NODE_ENV,
  stall: env.AK_SKILL_STALL_MINUTES,
};

type CredRow = {
  id: string;
  label: string;
  token_prefix: string;
  token_hash: string;
  scopes: string[];
  created_at: string;
  expires_at: null;
  revoked_at: null;
  last_used_at: string | null;
};

type Issued = { id: string; token: string };

const credRows: CredRow[] = [];
let credA: Issued = { id: "", token: "" };
let credB: Issued = { id: "", token: "" };
let postMcp: (req: Request) => Promise<Response>;
let getSkill: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["MC_OAUTH_SECRET", saved.oauth],
    ["NODE_ENV", saved.node],
    ["AK_SKILL_STALL_MINUTES", saved.stall],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function skill(): MemSkill {
  return {
    id: "open",
    source_id: "master-skills",
    path: "skills/open/SKILL.md",
    name: "open",
    description: "Open to every lane",
    version: "1.2.0",
    sha: "ab".repeat(32),
    commit_sha: "c".repeat(40),
    body: "Follow these steps.",
    references: [],
    runtimes: { claude: true, codex: true, grok: true, hermes: true, mini: true },
    category: null,
    tags: [],
    frontmatter: {},
    removed_at: null,
    synced_at: NOW,
  };
}

function rememberCredential(token: string, id: string, label: string) {
  credRows.push({
    id,
    label,
    token_prefix: token.slice(0, 8),
    token_hash: createHash("sha256").update(token).digest("hex"),
    scopes: ["skills:write"],
    created_at: NOW,
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
  });
}

function credentialSql(text: string, values: unknown[]): Row[] {
  const quota = fakeQuotaSql(text, values);
  if (quota) return quota;
  if (text.includes("token_hash")) {
    const hash = String(values[0]);
    const row = credRows.find((item) => item.token_hash === hash);
    return row ? [{ ...row, scopes: [...row.scopes] }] : [];
  }
  if (text.includes("last_used_at")) {
    const id = String(values[1] ?? "");
    const row = credRows.find((item) => item.id === id);
    if (row) row.last_used_at = String(values[0]);
    return [];
  }
  return [];
}

async function issue(label: string): Promise<Issued> {
  const created = await createCredential({ label, scopes: ["skills:write"] });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("credential was not issued");
  rememberCredential(created.token, created.credential.id, label);
  return { id: created.credential.id, token: created.token };
}

function rpcBody(raw: string): { result?: Record<string, unknown> } {
  const line = raw.split("\n").find((item) => item.startsWith("data: "));
  if (!line) throw new Error(raw.slice(0, 800));
  return JSON.parse(line.slice("data: ".length)) as { result?: Record<string, unknown> };
}

async function mcpCall(token: string, method: string, params: Record<string, unknown>) {
  const res = await postMcp(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  const raw = await res.text();
  const msg = rpcBody(raw);
  return { status: res.status, result: msg.result ?? {}, raw };
}

async function callRun(token: string, args: Record<string, unknown>) {
  const called = await mcpCall(token, "tools/call", { name: "run_skill", arguments: args });
  assert.equal(called.status, 200, called.raw.slice(0, 500));
  const content = called.result.content as { text?: string }[] | undefined;
  return {
    isError: called.result.isError === true,
    text: content?.[0]?.text ?? "",
  };
}

function descriptionOf(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "";
  const record = schema as { description?: unknown; anyOf?: unknown[] };
  if (typeof record.description === "string") return record.description;
  for (const item of record.anyOf ?? []) {
    const found = descriptionOf(item);
    if (found) return found;
  }
  return "";
}

async function skillDetail(): Promise<{ triggers: { agent: string }[]; lastRun: { agent: string } | null }> {
  const res = await getSkill(new Request("http://localhost/api/skills/open", {
    headers: { authorization: `Bearer ${LEGACY}` },
  }), { params: Promise.resolve({ id: "open" }) });
  assert.equal(res.status, 200);
  return res.json() as Promise<{ triggers: { agent: string }[]; lastRun: { agent: string } | null }>;
}

describe("run_skill identity", { concurrency: false }, () => {
  before(async () => {
    const orig = global.setInterval;
    global.setInterval = ((fn: TimerHandler, ms?: number) => {
      const timer = orig(fn, ms);
      (timer as { unref?: () => void }).unref?.();
      return timer;
    }) as typeof setInterval;
    try {
      const route = await import(pathToFileURL(path.join(process.cwd(), "src/app/api/[transport]/route.ts")).href);
      postMcp = route.POST;
      const detail = await import("../../src/app/api/skills/[id]/route");
      getSkill = detail.GET;
    } finally {
      global.setInterval = orig;
    }
  });

  beforeEach(async () => {
    delete env.DATABASE_URL;
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "test";
    env.MC_TOKEN = LEGACY;
    env.MC_OAUTH_SECRET = OAUTH_SECRET;
    env.AK_SKILL_STALL_MINUTES = "60";
    resetCredentialsForTests();
    credRows.length = 0;
    installSkillsSql();
    const inner: SqlTag = sql();
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ");
      // The request-quota charge runs in a transaction on the credential row.
      if (/^\s*(begin|commit|rollback)\s*$/i.test(text)) return [];
      if (text.includes("agent_credentials")) return credentialSql(text, values);
      return inner(strings, ...values);
    });
    setSkillNowForTests(() => new Date(NOW));
    skillsMemory.skills.push(skill());
    skillsMemory.settings.push({
      skill_id: "open",
      trigger: "on_request",
      scope: { mode: "all", lanes: [] },
      schedule: null,
      updated_by: null,
      updated_at: NOW,
    });
    credA = await issue("lane-a");
    credB = await issue("lane-b");
    env.DATABASE_URL = DB;
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
    resetCredentialsForTests();
    credRows.length = 0;
    restoreEnv();
  });

  it("rejects an OAuth caller that supplies a different agent", async () => {
    const jwt = await signAccessToken(
      {
        iss: "http://localhost:3000",
        aud: "http://localhost:3000/api/mcp",
        sub: OAUTH_ID,
        client_id: OAUTH_ID,
        scope: "mcp",
        typ: "access",
      },
      3600,
    );
    const started = await callRun(jwt, { id: "open", agent_id: "grok-lane-3", runtime: "grok" });
    assert.equal(started.isError, true, started.text);
    const body = JSON.parse(started.text) as { code?: string; error?: string };
    assert.equal(body.code, "identity_mismatch");
    assert.match(body.error ?? "", new RegExp(OAUTH_ID));
    assert.match(body.error ?? "", /agent_id must match that id or be omitted/);
    assert.equal(skillsMemory.runs.length, 0);
    assert.equal(skillsMemory.spans.length, 0);
    assert.equal(callsOf("sk:insert-run"), 0);
  });

  it("records an agent credential id when agent_id matches or is omitted, and rejects a different one", async () => {
    const mismatch = await callRun(credA.token, { id: "open", agent_id: "grok-lane-3", runtime: "grok" });
    assert.equal(mismatch.isError, true, mismatch.text);
    assert.equal(JSON.parse(mismatch.text).code, "identity_mismatch");
    assert.match(mismatch.text, new RegExp(credA.id));
    assert.match(mismatch.text, /omitted/);
    assert.equal(skillsMemory.runs.length, 0);
    assert.equal(skillsMemory.spans.length, 0);

    const matched = await callRun(credA.token, { id: "open", agent_id: credA.id, runtime: "grok" });
    assert.equal(matched.isError, false, matched.text);
    assert.equal(skillsMemory.runs[0]?.agent_id, credA.id);
    assert.equal(skillsMemory.runs[0]?.actor_id, credA.id);
    assert.equal(skillsMemory.spans[0]?.agent_id, credA.id);
    assert.equal(skillsMemory.spans[0]?.attributes.reported_agent_id, undefined);

    const omitted = await callRun(credA.token, { id: "open", runtime: "grok" });
    assert.equal(omitted.isError, false, omitted.text);
    assert.equal(skillsMemory.runs[1]?.agent_id, credA.id);
    assert.equal(skillsMemory.spans[1]?.agent_id, credA.id);
    assert.equal(skillsMemory.spans[1]?.attributes.reported_agent_id, undefined);

    const detail = await skillDetail();
    assert.deepEqual(detail.triggers.map((row) => row.agent), [credA.id, credA.id]);
    assert.equal(detail.lastRun?.agent, credA.id);

    let nowMs = Date.parse(NOW);
    setSkillNowForTests(() => new Date(nowMs));
    nowMs += 61 * 60 * 1000;
    const digest = await skillsDigest("7d");
    assert.deepEqual(digest.stalled.map((row) => row.agent).sort(), [credA.id, credA.id].sort());
  });

  it("refuses completion by a different actor even when that actor passes the starter agent_id", async () => {
    const started = await callRun(credA.token, { id: "open", runtime: "grok" });
    assert.equal(started.isError, false, started.text);
    const runId = started.text.match(/run_id: ([0-9a-f-]{36})/)?.[1];
    assert.ok(runId);
    const stolen = await callRun(credB.token, {
      run_id: runId,
      complete: true,
      agent_id: credA.id,
      status: "done",
    });
    assert.equal(stolen.isError, true, stolen.text);
    assert.match(stolen.text, /"code":"forbidden"/);
    assert.equal(skillsMemory.runs[0]?.ended_at, null);
    assert.equal(skillsMemory.runs[0]?.agent_id, credA.id);
    assert.equal(skillsMemory.runs[0]?.actor_id, credA.id);
    assert.equal(skillsMemory.spans.length, 1);
  });

  it("stores a legacy token's supplied agent_id only as reported_agent_id", async () => {
    const started = await callRun(LEGACY, { id: "open", agent_id: "grok-lane-3", runtime: "grok" });
    assert.equal(started.isError, false, started.text);
    assert.equal(skillsMemory.runs[0]?.agent_id, "mc-token");
    assert.equal(skillsMemory.runs[0]?.actor_id, "mc-token");
    assert.equal(skillsMemory.spans[0]?.agent_id, "mc-token");
    assert.equal(skillsMemory.spans[0]?.attributes.reported_agent_id, "grok-lane-3");
    const detail = await skillDetail();
    assert.equal(detail.triggers[0]?.agent, "mc-token");
    assert.equal(detail.lastRun?.agent, "mc-token");
    assert.equal(JSON.stringify(detail).includes("grok-lane-3"), false);
  });

  it("stores a dashboard session's supplied agent_id only as reported_agent_id", async () => {
    const started = await runWithActor(
      { actor_type: "human", actor_id: "operator" },
      () => runSkillTool({ id: "open", agent_id: "grok-lane-3", runtime: "grok" }),
    );
    assert.equal(started.isError, undefined);
    assert.equal(skillsMemory.runs[0]?.agent_id, "operator");
    assert.equal(skillsMemory.runs[0]?.actor_id, "operator");
    assert.equal(skillsMemory.spans[0]?.agent_id, "operator");
    assert.equal(skillsMemory.spans[0]?.attributes.reported_agent_id, "grok-lane-3");
    const detail = await skillDetail();
    assert.equal(detail.triggers[0]?.agent, "operator");
    assert.equal(detail.lastRun?.agent, "operator");
  });

  it("marks agent_id optional on the registered run_skill schema", async () => {
    const listed = await mcpCall(LEGACY, "tools/list", {});
    assert.equal(listed.status, 200, listed.raw.slice(0, 500));
    const tools = listed.result.tools as {
      name: string;
      description?: string;
      inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
    }[] | undefined;
    assert.ok(tools, listed.raw.slice(0, 500));
    const run = tools.find((tool) => tool.name === "run_skill");
    assert.ok(run, tools.map((tool) => tool.name).join(","));
    const required = run.inputSchema?.required ?? [];
    assert.equal(required.includes("agent_id"), false);
    const described = descriptionOf(run.inputSchema?.properties?.agent_id);
    assert.match(described, /omit/i);
    assert.doesNotMatch(described, /required/i);
    assert.match(run.description ?? "", /authenticated caller/);
  });
});
