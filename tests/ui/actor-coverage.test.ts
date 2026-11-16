/**
 * Authenticated actor on application writes.
 * The stored event or resource is the proof. AsyncLocalStorage alone is not.
 * Body actor_id, actor_type, and actor do not override the principal.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GET as getActivity } from "../../src/app/api/activity/route";
import { POST as postMemory } from "../../src/app/api/memory/route";
import { POST as postClaim } from "../../src/app/api/tasks/claim/route";
import { PATCH as patchTask } from "../../src/app/api/tasks/[id]/route";
import { runWithPrincipal } from "../../src/lib/actor";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID } from "../../src/lib/actor";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { demoCreateTask, resetDemoStoreForTests } from "../../src/lib/demo-store";
import { rememberForTool } from "../../src/lib/dry-run-actions";
import { taskRevision } from "../../src/lib/revision";
import { fakeQuotaSql } from "./quota-fake";

const env = process.env as Record<string, string | undefined>;
const TOKEN = "actor-coverage-token";
const PASSWORD = "actor-coverage-dashboard";
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_actor_coverage";

const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};

const creds: Row[] = [];
const calls: { text: string; values: unknown[] }[] = [];

function textOf(strings: TemplateStringsArray, values: unknown[]): string {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
  return text.replace(/\s+/g, " ").trim();
}

function installFake() {
  creds.length = 0;
  calls.length = 0;
  setSqlForTests(async (strings, ...values) => {
    const text = textOf(strings, values);
    const lower = text.toLowerCase();
    calls.push({ text, values: [...values] });
    const quota = fakeQuotaSql(text, values);
    if (quota) return quota;
    if (lower === "begin" || lower === "commit" || lower === "rollback") return [];
    if (lower.includes("insert into agent_credentials")) {
      creds.push({
        id: values[0],
        label: values[1],
        token_prefix: values[2],
        token_hash: values[3],
        scopes: values[4],
        created_at: values[5],
        expires_at: values[6],
        revoked_at: null,
        last_used_at: null,
        rate_limit_per_minute: values[7],
        rate_limit_per_day: values[8],
      });
      return [];
    }
    if (lower.includes("from agent_credentials")) {
      return creds.filter((row) => row.token_hash === values[0]);
    }
    if (lower.includes("update agent_credentials")) return [];
    if (lower.includes("insert into memory") && lower.includes("insert into events")) {
      return [{
        id: 11,
        key: values[0],
        content: values[1],
        tags: values[2] ?? [],
        agent_id: values[3],
        created_at: "2026-11-15T00:00:00.000Z",
        updated_at: "2026-11-15T00:00:00.000Z",
        receipt_id: 21,
        receipt_kind: "remember",
        receipt_at: "2026-11-15T00:00:00.000Z",
      }];
    }
    if (lower.includes("status = 'queued'") && lower.includes("from tasks")) {
      const platforms = values.find((value) => Array.isArray(value)) as unknown[] | undefined;
      if (platforms?.[0] === "empty") return [];
      return [{
        id: 7,
        title: "queued work",
        status: "queued",
        platform: "any",
        priority: 1,
        machine: null,
        created_at: "2026-11-15T00:00:00.000Z",
        actor_type: "agent",
        actor_id: "creator",
      }];
    }
    if (lower.includes("update tasks") && lower.includes("task_claimed")) {
      return [{
        id: 7,
        title: "queued work",
        status: "claimed",
        platform: "any",
        priority: 1,
        machine: null,
        actor_type: "agent",
        actor_id: "creator",
        receipt_id: 31,
        receipt_kind: "task_claimed",
        receipt_at: "2026-11-15T00:00:00.000Z",
      }];
    }
    if (lower.includes("update tasks") && lower.includes("insert into events")) {
      return [{
        id: 4,
        title: "patch me",
        status: values.includes("running") ? "running" : "queued",
        platform: "any",
        priority: 2,
        actor_type: "agent",
        actor_id: "creator",
        receipt_id: 41,
        receipt_kind: "task_updated",
        receipt_at: "2026-11-15T00:00:00.000Z",
      }];
    }
    if (lower.includes("insert into events") || lower.includes("insert into agents")) {
      return [{ id: 51, kind: "status", created_at: "2026-11-15T00:00:00.000Z" }];
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

beforeEach(() => {
  env.DATABASE_URL = FIXTURE_URL;
  env.MC_DB_DRIVER = "pg";
  env.MC_TOKEN = TOKEN;
  env.MC_DASHBOARD_PASSWORD = PASSWORD;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  resetDemoStoreForTests();
  installFake();
});

afterEach(() => {
  setSqlForTests(null);
  resetCredentialsForTests();
  resetDemoStoreForTests();
  restoreEnv();
});

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function issue(scopes: string[]) {
  const created = await createCredential({ label: "coverage", scopes });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("credential was not issued");
  return created;
}

async function cookie() {
  return authCookieValue(PASSWORD);
}

function writes(fragment: string) {
  return calls.filter((call) => call.text.toLowerCase().includes(fragment));
}

describe("actor coverage for memory, task patch, and claim", { concurrency: false }, () => {
  it("stores the agent credential on a memory write and ignores a forged actor", async () => {
    const credential = await issue(["memory:write"]);
    const res = await postMemory(jsonReq("http://x/api/memory", {
      content: "the note",
      key: "coverage-key",
      actor_type: "human",
      actor_id: "forged-root",
      actor: { actor_type: "human", actor_id: "forged-root" },
    }, { authorization: `Bearer ${credential.token}` }));
    assert.equal(res.status, 200, await res.clone().text());
    const memory = writes("insert into memory");
    assert.equal(memory.length, 1);
    assert.match(memory[0].text, /insert into events/);
    assert.equal(memory[0].values.at(-2), "agent");
    assert.equal(memory[0].values.at(-1), credential.credential.id);
    assert.equal(memory[0].values.includes("forged-root"), false);
  });

  it("stores the dashboard operator on a task patch and does not rewrite the creator from the body", async () => {
    const res = await patchTask(jsonReq("http://x/api/tasks/4", {
      status: "running",
      actor_type: "agent",
      actor_id: "forged-root",
      actor: { actor_type: "human", actor_id: "forged-root" },
      eventKind: "task_requeued",
      activityTool: "requeue_task",
    }, { cookie: `mc_auth=${await cookie()}` }, "PATCH"), {
      params: Promise.resolve({ id: "4" }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { task: { actor_id: string | null } };
    assert.equal(body.task.actor_id, "creator");
    const patched = writes("update tasks");
    assert.equal(patched.length, 1);
    assert.equal(patched[0].values.includes("task_updated"), true);
    assert.equal(patched[0].values.includes("update_task"), true);
    assert.equal(patched[0].values.includes("task_requeued"), false);
    assert.equal(patched[0].values.includes("requeue_task"), false);
    assert.equal(patched[0].values.at(-2), "human");
    assert.equal(patched[0].values.at(-1), DASHBOARD_ACTOR_ID);
    assert.equal(patched[0].values.includes("forged-root"), false);
  });

  it("stores the legacy token on a claim event and on the following status report", async () => {
    const res = await postClaim(jsonReq("http://x/api/tasks/claim", {
      platform: "any",
      agent_id: "worker-1",
      actor_id: "forged-root",
      actor_type: "human",
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { task: { id: number; actor_id: string | null } };
    assert.equal(body.task.id, 7);
    assert.equal(body.task.actor_id, "creator");
    const claimed = writes("task_claimed");
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].values.at(-2), "agent");
    assert.equal(claimed[0].values.at(-1), LEGACY_ACTOR_ID);
    assert.equal(claimed[0].values.includes("forged-root"), false);
    const reported = writes("insert into agents");
    assert.equal(reported.length, 1);
    assert.equal(reported[0].values.includes(LEGACY_ACTOR_ID), true);
    assert.equal(reported[0].values.includes("forged-root"), false);
  });

  it("stores a null actor for dev-open memory and for an OAuth principal on the tool path", async () => {
    delete env.MC_DASHBOARD_PASSWORD;
    const open = await postMemory(jsonReq("http://x/api/memory", {
      content: "local",
      key: "open-key",
      actor_type: "human",
      actor_id: DASHBOARD_ACTOR_ID,
    }));
    assert.equal(open.status, 200, await open.clone().text());
    const memory = writes("insert into memory");
    assert.equal(memory.length, 1);
    assert.equal(memory[0].values.at(-2), null);
    assert.equal(memory[0].values.at(-1), null);

    calls.length = 0;
    const tool = await runWithPrincipal({ kind: "oauth", id: "oauth-client-a" }, () => rememberForTool({
      content: "from oauth",
      key: "oauth-key",
      ...( { actor_id: "forged-root" } as Record<string, string> ),
    }));
    assert.equal(tool.isError, undefined);
    const oauth = writes("insert into memory");
    assert.equal(oauth.length, 1);
    assert.equal(oauth[0].values.at(-2), "agent");
    assert.equal(oauth[0].values.at(-1), "oauth-client-a");
    assert.equal(oauth[0].values.includes("forged-root"), false);
  });

  it("does not write a receipt for a dry run, a denial, an empty claim, or a thrown receipt", async () => {
    const dry = await postMemory(jsonReq("http://x/api/memory", {
      content: "preview",
      key: "dry-key",
      dry_run: true,
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(dry.status, 200, await dry.clone().text());
    assert.equal(writes("insert into memory").length, 0);
    assert.equal(writes("insert into events").length, 0);

    calls.length = 0;
    const denied = await postMemory(jsonReq("http://x/api/memory", {
      content: "nope",
      key: "denied-key",
    }));
    assert.equal(denied.status, 401);
    assert.equal(writes("insert into memory").length, 0);

    calls.length = 0;
    const empty = await postClaim(jsonReq("http://x/api/tasks/claim", {
      platform: "empty",
      agent_id: "worker-1",
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(empty.status, 200, await empty.clone().text());
    const emptyBody = await empty.json() as { task: null };
    assert.equal(emptyBody.task, null);
    assert.equal(writes("task_claimed").length, 0);
    assert.equal(writes("insert into agents").length, 0);

    calls.length = 0;
    setSqlForTests(async (strings, ...values) => {
      const text = textOf(strings, values);
      const lower = text.toLowerCase();
      calls.push({ text, values: [...values] });
      if (lower.includes("insert into memory")) throw new Error("receipt insert failed");
      return [];
    });
    const failed = await postMemory(jsonReq("http://x/api/memory", {
      content: "rollback",
      key: "rollback-key",
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(failed.status, 500);
    const failedBody = await failed.json() as { code: string };
    assert.equal(failedBody.code, "internal_error");
    const attempted = writes("insert into memory");
    assert.equal(attempted.length, 1);
    assert.match(attempted[0].text, /insert into events/);
    assert.equal(calls.filter((call) => call.text.toLowerCase() === "commit").length, 0);
  });

  it("stores the dashboard actor on a demo task patch and a null actor when the dashboard is open", async () => {
    delete env.DATABASE_URL;
    const seeded = await demoCreateTask({ title: "demo patch", actor: { actor_type: "agent", actor_id: "creator" } });
    const revision = taskRevision(seeded);
    const authed = await patchTask(jsonReq(`http://x/api/tasks/${seeded.id}`, {
      status: "running",
      expected_revision: revision,
      actor_id: "forged-root",
      actor: { actor_type: "human", actor_id: "forged-root" },
    }, { cookie: `mc_auth=${await cookie()}` }, "PATCH"), {
      params: Promise.resolve({ id: String(seeded.id) }),
    });
    assert.equal(authed.status, 200, await authed.clone().text());
    const authedBody = await authed.json() as { task: { actor_id: string | null } };
    assert.equal(authedBody.task.actor_id, "creator");
    const activity = await getActivity(new Request("http://x/api/activity", {
      headers: { cookie: `mc_auth=${await cookie()}` },
    }));
    assert.equal(activity.status, 200, await activity.clone().text());
    const listed = await activity.json() as { activity: { kind: string; actor_id: string | null; actor_type: string | null }[] };
    const updated = listed.activity.filter((row) => row.kind === "task_updated");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].actor_type, "human");
    assert.equal(updated[0].actor_id, DASHBOARD_ACTOR_ID);

    const before = listed.activity.length;
    const preview = await patchTask(jsonReq(`http://x/api/tasks/${seeded.id}`, {
      status: "done",
      dry_run: true,
    }, { cookie: `mc_auth=${await cookie()}` }, "PATCH"), {
      params: Promise.resolve({ id: String(seeded.id) }),
    });
    assert.equal(preview.status, 200, await preview.clone().text());
    const again = await getActivity(new Request("http://x/api/activity", {
      headers: { cookie: `mc_auth=${await cookie()}` },
    }));
    const againBody = await again.json() as { activity: unknown[] };
    assert.equal(againBody.activity.length, before);

    delete env.MC_DASHBOARD_PASSWORD;
    resetDemoStoreForTests();
    const openTask = await demoCreateTask({ title: "open patch" });
    const open = await patchTask(jsonReq(`http://x/api/tasks/${openTask.id}`, {
      status: "running",
      expected_revision: taskRevision(openTask),
      actor_id: DASHBOARD_ACTOR_ID,
    }, {}, "PATCH"), {
      params: Promise.resolve({ id: String(openTask.id) }),
    });
    assert.equal(open.status, 200, await open.clone().text());
    const openActivity = await getActivity(new Request("http://x/api/activity"));
    const openBody = await openActivity.json() as { activity: { kind: string; actor_id: string | null }[] };
    const openUpdated = openBody.activity.filter((row) => row.kind === "task_updated");
    assert.equal(openUpdated.length, 1);
    assert.equal(openUpdated[0].actor_id, null);
  });
});
