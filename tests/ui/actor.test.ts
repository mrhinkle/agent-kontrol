import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actorFromPrincipal, currentActor, DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID, runWithActor } from "../../src/lib/actor";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { principalFromMcpAuth } from "../../src/lib/scopes";
import { claimNextTask, listTasks } from "../../src/lib/store";

/**
 * Actor is taken from the authenticated credential. created_by in the body
 * is a label and must not become actor_id.
 */

const env = process.env as Record<string, string | undefined>;
const TOKEN = "actor-test-token";
const PASSWORD = "actor-dashboard";
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_actor";

const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};

type Route = (req: Request) => Promise<Response>;
type Handle = { unref?: () => void };

let postTasks: Route;
let postMessages: Route;
let postReply: Route;
let mcpPost: Route;

const creds: Row[] = [];
const inserts: { table: string; row: Row }[] = [];
let seq = 1;

function columnsOf(text: string): string[] {
  const match = text.match(/insert into [a-z_]+ \(([^)]+)\)/i);
  if (!match) return [];
  return match[1].split(",").map((part) => part.trim()).filter(Boolean);
}

/** Map insert columns onto bound parameters, leaving SQL literals in place. */
function rowFrom(strings: TemplateStringsArray, values: unknown[]): Row {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
  const flat = text.replace(/\s+/g, " ");
  const cols = columnsOf(flat);
  const slots = (flat.match(/values \(([^)]*)\)/i)?.[1] ?? "").split(",").map((part) => part.trim());
  const row: Row = {};
  cols.forEach((col, i) => {
    const slot = slots[i] ?? "";
    const ref = /^\$(\d+)$/.exec(slot);
    if (ref) row[col] = values[Number(ref[1]) - 1];
    else if (slot.startsWith("'") && slot.endsWith("'")) row[col] = slot.slice(1, -1);
    else row[col] = null;
  });
  return row;
}

function tableOf(text: string): string {
  return text.match(/insert into ([a-z_]+)/i)?.[1] ?? "";
}

function installFake() {
  creds.length = 0;
  inserts.length = 0;
  seq = 1;
  setSqlForTests(async (strings, ...values) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    if (lower.includes("insert into agent_credentials")) {
      creds.push(rowFrom(strings, values));
      return [];
    }
    if (lower.includes("from agent_credentials")) {
      return creds.filter((row) => row.token_hash === values[0]);
    }
    if (lower.includes("update agent_credentials")) return [];
    if (lower.includes("insert into ")) {
      const rootMessage = lower.includes("insert into messages") && lower.includes("overriding system value");
      const row: Row = rootMessage
        ? {
            id: seq++,
            agent_id: values[0],
            body: values[1],
            created_by: values[2],
            direction: values[3],
            in_reply_to: values[4] ?? null,
            actor_type: values[5],
            actor_id: values[6],
            created_at: "2026-10-25T00:00:00.000Z",
          }
        : rowFrom(strings, values);
      if (!rootMessage) row.id = seq++;
      if (lower.includes("insert into messages") && (row.thread_id == null || row.thread_id === "")) {
        row.thread_id = String(row.id);
      }
      if (row.created_at == null) row.created_at = "2026-10-25T00:00:00.000Z";
      if (lower.includes("insert into tasks") && row.status == null) row.status = "queued";
      if (lower.includes("insert into tasks") && row.priority == null) row.priority = 2;
      inserts.push({ table: tableOf(text), row });
      return [row];
    }
    if (lower.includes("update messages") && lower.includes("thread_id")) {
      const id = values[values.length - 1];
      const found = inserts.find((item) => item.table === "messages" && item.row.id === id);
      if (!found) return [];
      found.row.thread_id = values[0];
      return [found.row];
    }
    if (lower.includes("from tasks")) {
      return inserts
        .filter((item) => item.table === "tasks")
        .map((item) => ({ ...item.row }));
    }
    if (lower.includes("update tasks")) {
      const id = values[values.length - 1];
      const found = inserts.find((item) => item.table === "tasks" && item.row.id === id);
      if (!found || found.row.status !== "queued") return [];
      found.row.status = "claimed";
      found.row.assigned_agent = values[0];
      found.row.claimed_at = values[1];
      found.row.updated_at = values[2];
      return [{ ...found.row }];
    }
    return [];
  });
}

function restoreEnv() {
  for (const [key, value] of [
    ["DATABASE_URL", saved.db],
    ["MC_DB_DRIVER", saved.driver],
    ["MC_TOKEN", saved.token],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["NODE_ENV", saved.node],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function handles(): Handle[] {
  const get = (process as unknown as { _getActiveHandles?: () => Handle[] })._getActiveHandles;
  return get ? get() : [];
}

before(async () => {
  const origInterval = global.setInterval;
  global.setInterval = ((fn: TimerHandler, ms?: number) => {
    const timer = origInterval(fn, ms);
    (timer as Handle).unref?.();
    return timer;
  }) as typeof setInterval;
  try {
    ({ POST: postTasks } = await import("../../src/app/api/tasks/route"));
    ({ POST: postMessages } = await import("../../src/app/api/messages/route"));
    ({ POST: postReply } = await import("../../src/app/api/messages/reply/route"));
    ({ POST: mcpPost } = await import(pathToFileURL(path.join(process.cwd(), "src/app/api/[transport]/route.ts")).href));
  } finally {
    global.setInterval = origInterval;
  }
});

beforeEach(() => {
  env.DATABASE_URL = FIXTURE_URL;
  env.MC_DB_DRIVER = "pg";
  env.MC_TOKEN = TOKEN;
  env.MC_DASHBOARD_PASSWORD = PASSWORD;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  installFake();
});

afterEach(() => {
  setSqlForTests(null);
  resetCredentialsForTests();
  restoreEnv();
});

after(() => {
  for (const handle of handles()) handle.unref?.();
});

async function issue(scopes: string[]) {
  const created = await createCredential({ label: "actor test", scopes });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("credential was not issued");
  return created;
}

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("actor attribution", { concurrency: false }, () => {
  it("maps an authenticated principal to a human or an agent, and dev-open to null", () => {
    assert.deepEqual(actorFromPrincipal({ kind: "agent", id: "cred-a", scopes: [] }), {
      actor_type: "agent",
      actor_id: "cred-a",
    });
    assert.deepEqual(actorFromPrincipal({ kind: "legacy" }), {
      actor_type: "agent",
      actor_id: LEGACY_ACTOR_ID,
    });
    assert.deepEqual(actorFromPrincipal({ kind: "session" }), {
      actor_type: "human",
      actor_id: DASHBOARD_ACTOR_ID,
    });
    assert.equal(actorFromPrincipal({ kind: "dev-open" }), null);
    const oauth = principalFromMcpAuth({
      clientId: "oauth-client-a",
      scopes: ["mcp"],
      extra: { sub: "person-1" },
    });
    assert.ok(oauth);
    assert.equal(oauth.kind, "oauth");
    if (oauth.kind !== "oauth") return;
    assert.deepEqual(actorFromPrincipal(oauth), { actor_type: "agent", actor_id: "oauth-client-a" });
    assert.equal(currentActor(), null);
    runWithActor({ actor_type: "agent", actor_id: "cred-a" }, () => {
      assert.deepEqual(currentActor(), { actor_type: "agent", actor_id: "cred-a" });
    });
    assert.equal(currentActor(), null);
  });

  it("keeps actor columns nullable in the schema", () => {
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    const migration = fs.readFileSync("supabase/migrations/20261025_actor.sql", "utf8");
    for (const source of [schema, migration]) {
      assert.match(source, /alter table messages add column if not exists actor_type text;/);
      assert.match(source, /alter table messages add column if not exists actor_id text;/);
      assert.match(source, /alter table tasks add column if not exists actor_type text;/);
      assert.match(source, /alter table tasks add column if not exists actor_id text;/);
    }
    assert.doesNotMatch(schema, /actor_type text not null/);
    assert.doesNotMatch(schema, /actor_id text not null/);
  });

  it("records credential A on a task even when the body claims another created_by", async () => {
    const credential = await issue(["tasks:write"]);
    const res = await postTasks(jsonReq("http://x/api/tasks", {
      title: "ship the fix",
      created_by: "someone-else",
      actor_type: "human",
      actor_id: "root",
    }, { authorization: `Bearer ${credential.token}` }));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { task: Row };
    assert.equal(body.task.actor_type, "agent");
    assert.equal(body.task.actor_id, credential.credential.id);
    assert.notEqual(body.task.actor_id, "someone-else");
    assert.notEqual(body.task.actor_id, "root");
    assert.equal(body.task.created_by, "someone-else");
    const stored = inserts.filter((item) => item.table === "tasks");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].row.actor_id, credential.credential.id);
  });

  it("records credential A on a reply even when created_by names another agent", async () => {
    const credential = await issue(["messages:write"]);
    const res = await postReply(jsonReq("http://x/api/messages/reply", {
      agent_id: "worker-one",
      body: "done",
      created_by: "worker-two",
    }, { authorization: `Bearer ${credential.token}` }));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { message: Row };
    assert.equal(body.message.actor_type, "agent");
    assert.equal(body.message.actor_id, credential.credential.id);
    assert.equal(body.message.created_by, "worker-two");
    assert.equal(inserts.filter((item) => item.table === "messages").length, 1);
  });

  it("records the signed-in operator on a dashboard message, not the body's created_by", async () => {
    const cookie = await authCookieValue(PASSWORD);
    const res = await postMessages(jsonReq("http://x/api/messages", {
      agent_id: "worker-one",
      body: "please look",
      created_by: "not-the-operator",
      actor_id: "root",
    }, { cookie: `mc_auth=${cookie}` }));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { message: Row };
    assert.equal(body.message.actor_type, "human");
    assert.equal(body.message.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(body.message.created_by, "not-the-operator");
  });

  it("records null actor fields for dev-open, never human/operator", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    const task = await postTasks(jsonReq("http://x/api/tasks", {
      title: "local open dashboard",
      created_by: "operator",
      actor_type: "human",
      actor_id: "operator",
    }));
    assert.equal(task.status, 200, await task.clone().text());
    const taskBody = await task.json() as { task: Row };
    assert.equal(taskBody.task.actor_type, null);
    assert.equal(taskBody.task.actor_id, null);
    assert.notEqual(taskBody.task.actor_id, DASHBOARD_ACTOR_ID);

    const message = await postMessages(jsonReq("http://x/api/messages", {
      agent_id: "worker-one",
      body: "unauthenticated",
      created_by: "operator",
      actor_type: "human",
      actor_id: "operator",
    }));
    assert.equal(message.status, 200, await message.clone().text());
    const messageBody = await message.json() as { message: Row };
    assert.equal(messageBody.message.actor_type, null);
    assert.equal(messageBody.message.actor_id, null);
    const stored = inserts.filter((item) => item.table === "tasks" || item.table === "messages");
    assert.equal(stored.length, 2);
    for (const item of stored) {
      assert.equal(item.row.actor_type, null);
      assert.equal(item.row.actor_id, null);
    }
  });

  it("records the legacy token as an agent, not as the created_by label", async () => {
    const res = await postTasks(jsonReq("http://x/api/tasks", {
      title: "from the shared token",
      created_by: "dashboard",
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { task: Row };
    assert.equal(body.task.actor_type, "agent");
    assert.equal(body.task.actor_id, LEGACY_ACTOR_ID);
    assert.equal(body.task.created_by, "dashboard");
  });

  it("records credential A when create_task is called over MCP with a spoofed created_by", async () => {
    const credential = await issue(["tasks:write"]);
    const before = new Set(handles());
    let text = "";
    let status = 0;
    try {
      const res = await mcpPost(new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_task",
            arguments: { title: "mcp task", created_by: "someone-else", actor_id: "root" },
          },
        }),
      }));
      status = res.status;
      text = await res.text();
    } finally {
      for (const handle of handles()) {
        if (!before.has(handle)) handle.unref?.();
      }
    }
    assert.equal(status, 200, text.slice(0, 500));
    const stored = inserts.filter((item) => item.table === "tasks");
    assert.equal(stored.length, 1, text.slice(0, 500));
    assert.equal(stored[0].row.actor_type, "agent");
    assert.equal(stored[0].row.actor_id, credential.credential.id);
    assert.equal(stored[0].row.created_by, "someone-else");
    assert.match(text, /Task #\d+ queued/);
  });

  it("returns actor fields from list and claim, normalizing blank columns to null", async () => {
    inserts.push(
      {
        table: "tasks",
        row: {
          id: 7,
          title: "with actor",
          status: "queued",
          platform: "any",
          priority: 2,
          machine: null,
          actor_type: "agent",
          actor_id: "cred-a",
          created_at: "2026-10-25T00:00:00.000Z",
        },
      },
      {
        table: "tasks",
        row: {
          id: 8,
          title: "legacy blank actor",
          status: "queued",
          platform: "grok",
          priority: 3,
          machine: null,
          actor_type: "",
          actor_id: "",
          created_at: "2026-10-25T00:00:01.000Z",
        },
      },
    );

    const listed = await listTasks({ status: "all" });
    const withActor = listed.find((task) => task.id === 7);
    const blank = listed.find((task) => task.id === 8);
    assert.ok(withActor);
    assert.equal(withActor.actor_type, "agent");
    assert.equal(withActor.actor_id, "cred-a");
    assert.ok(blank);
    assert.equal(blank.actor_type, null);
    assert.equal(blank.actor_id, null);

    const claimed = await claimNextTask({ platform: "any", agent_id: "worker-1" });
    assert.ok(claimed);
    assert.equal(claimed.id, 7);
    assert.equal(claimed.actor_type, "agent");
    assert.equal(claimed.actor_id, "cred-a");

    const claimedBlank = await claimNextTask({ platform: "grok", agent_id: "worker-1" });
    assert.ok(claimedBlank);
    assert.equal(claimedBlank.id, 8);
    assert.equal(claimedBlank.actor_type, null);
    assert.equal(claimedBlank.actor_id, null);
  });

  it("records credential A when reply_to_operator is called over MCP", async () => {
    const credential = await issue(["messages:write"]);
    const before = new Set(handles());
    let text = "";
    let status = 0;
    try {
      const res = await mcpPost(new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "reply_to_operator",
            arguments: {
              agent_id: "worker-one",
              body: "finished the queue",
              created_by: "someone-else",
              actor_id: "root",
            },
          },
        }),
      }));
      status = res.status;
      text = await res.text();
    } finally {
      for (const handle of handles()) {
        if (!before.has(handle)) handle.unref?.();
      }
    }
    assert.equal(status, 200, text.slice(0, 500));
    const stored = inserts.filter((item) => item.table === "messages");
    assert.equal(stored.length, 1, text.slice(0, 500));
    assert.equal(stored[0].row.actor_type, "agent");
    assert.equal(stored[0].row.actor_id, credential.credential.id);
    assert.notEqual(stored[0].row.actor_id, "root");
    assert.match(text, /Reply #\d+ delivered/);
  });
});
