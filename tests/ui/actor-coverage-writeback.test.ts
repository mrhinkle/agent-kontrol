/**
 * Decision write-back retry stores one receipt for the authenticated principal.
 * The resolve path does not add a second receipt. A missed stamp writes nothing.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST as postWriteback } from "../../src/app/api/decisions/[id]/writeback/route";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID, runWithActor } from "../../src/lib/actor";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { setDecisionStoreForTests, setDecisionWriteback } from "../../src/lib/decisions";
import { clearGitHubWriteClientForTests, setGitHubWriteClientForTests, writeDecisionBack } from "../../src/lib/decision-writeback";
import { demoListActivity, resetDemoStoreForTests } from "../../src/lib/demo-store";
import { createMemoryDecisionStore } from "./decision-memory";

const env = process.env as Record<string, string | undefined>;
const TOKEN = "actor-writeback-token";
const PASSWORD = "actor-writeback-dashboard";
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_actor_coverage";
const SECRET = "ship the secret comment body";

const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  gh: env.GH_TOKEN,
  github: env.GITHUB_TOKEN,
  node: env.NODE_ENV,
};

function restoreEnv() {
  for (const [key, value] of [
    ["DATABASE_URL", saved.db],
    ["MC_DB_DRIVER", saved.driver],
    ["MC_TOKEN", saved.token],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["GH_TOKEN", saved.gh],
    ["GITHUB_TOKEN", saved.github],
    ["NODE_ENV", saved.node],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function seed(store: ReturnType<typeof createMemoryDecisionStore>, over: Record<string, unknown> = {}) {
  const row = {
    id: 4,
    key: "github:acme/widgets#9",
    source: "github-label",
    repo: "acme/widgets",
    number: 9,
    title: "Ship the widget",
    status: "decided",
    decision: SECRET,
    revision: 2,
    writeback: null,
    writeback_lock: null,
    writeback_lock_at: null,
    actor_id: "original-creator",
    decided_at: "2026-11-01T00:00:00.000Z",
    first_seen_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    ...over,
  };
  store.rows.push(row);
  return row;
}

function post(id: string, body: unknown, headers: Record<string, string> = {}) {
  return postWriteback(new Request(`http://x/api/decisions/${id}/writeback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}

async function receipts() {
  return demoListActivity({ actor: null, kind: "decision_writeback", since: null, until: null });
}

async function oneReceipt() {
  const events = await receipts();
  assert.equal(events.length, 1);
  const detail = events[0].detail;
  assert.ok(detail);
  return detail;
}

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  env.MC_DB_DRIVER = "pg";
  env.MC_TOKEN = TOKEN;
  env.MC_DASHBOARD_PASSWORD = PASSWORD;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  resetDemoStoreForTests();
  setDecisionStoreForTests(null);
  setGitHubWriteClientForTests(null);
});

afterEach(() => {
  setDecisionStoreForTests(null);
  setSqlForTests(null);
  clearGitHubWriteClientForTests();
  resetCredentialsForTests();
  resetDemoStoreForTests();
  restoreEnv();
});

describe("actor coverage for decision write-back retry", { concurrency: false }, () => {
  it("stores the dashboard operator and ignores a forged actor", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    seed(store);
    const res = await post("4", {
      expected_revision: 2,
      actor_id: "forged-root",
      actor_type: "agent",
      actor: { actor_type: "agent", actor_id: "forged-root" },
      decided_by: "forged-root",
      decision: "forged comment",
    }, { cookie: `mc_auth=${await authCookieValue(PASSWORD)}` });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { decision: { writeback: string; decision: string; actor_id: string } };
    assert.equal(body.decision.writeback, "not_written");
    assert.equal(body.decision.decision, SECRET);
    assert.equal(body.decision.actor_id, "original-creator");
    const detail = await oneReceipt();
    assert.equal(detail.actor_type, "human");
    assert.equal(detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(detail.tool, "decision_writeback");
    assert.equal(detail.writeback, "not_written");
    assert.equal(detail.decision_id, 4);
    assert.equal(JSON.stringify(detail).includes("forged"), false);
    assert.equal(JSON.stringify(detail).includes(SECRET), false);
  });

  it("stores legacy, dev-open, and a scoped agent, and skips no-op retries", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    seed(store);
    const legacy = await post("4", {}, { authorization: `Bearer ${TOKEN}` });
    assert.equal(legacy.status, 200, await legacy.clone().text());
    let detail = await oneReceipt();
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);

    resetDemoStoreForTests();
    store.rows[0].writeback = null;
    store.rows[0].revision = 2;
    delete env.MC_DASHBOARD_PASSWORD;
    const open = await post("4", { actor_id: DASHBOARD_ACTOR_ID });
    assert.equal(open.status, 200, await open.clone().text());
    detail = await oneReceipt();
    assert.equal(detail.actor_type, null);
    assert.equal(detail.actor_id, null);
    assert.equal(JSON.stringify(detail).includes(DASHBOARD_ACTOR_ID), false);

    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    resetDemoStoreForTests();
    store.rows[0].writeback = null;
    store.rows[0].revision = 2;
    const issued = await createCredential({ label: "writeback-agent", scopes: ["decisions:write"] });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const agent = await post("4", {}, { authorization: `Bearer ${issued.token}` });
    assert.equal(agent.status, 200, await agent.clone().text());
    detail = await oneReceipt();
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, issued.credential.id);

    resetDemoStoreForTests();
    const narrow = await createCredential({ label: "writeback-narrow", scopes: ["memory:write"] });
    assert.equal(narrow.ok, true);
    if (!narrow.ok) return;
    resetDemoStoreForTests();
    const denied = await post("4", {}, { authorization: `Bearer ${narrow.token}` });
    assert.equal(denied.status, 403);
    const anon = await post("4", {});
    assert.equal(anon.status, 401);
    store.rows.push({ ...store.rows[0], id: 8, key: "github:acme/widgets#8", status: "open", revision: 1, writeback: null });
    const notDecided = await post("8", {}, { authorization: `Bearer ${TOKEN}` });
    assert.equal(notDecided.status, 409);
    const stale = await post("4", { expected_revision: 0 }, { authorization: `Bearer ${TOKEN}` });
    assert.equal(stale.status, 409);
    store.rows.push({ ...store.rows[0], id: 9, key: "agent:someone:slug", status: "decided", revision: 1, writeback: null });
    const noTarget = await post("9", {}, { authorization: `Bearer ${TOKEN}` });
    assert.equal(noTarget.status, 200, await noTarget.clone().text());
    assert.equal((await receipts()).length, 0);
  });

  it("does not receipt a resolve-path write-back or a missed stamp", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const row = seed(store);
    const plain = await writeDecisionBack({
      id: row.id as number,
      key: String(row.key),
      actor_id: "original-creator",
      decided_at: "2026-11-01T00:00:00.000Z",
      decision: SECRET,
      revision: 2,
    });
    assert.equal(plain.status, "not_written");
    assert.equal((await receipts()).length, 0);
    assert.equal(store.rows[0].writeback, "not_written");

    store.rows[0].writeback = null;
    store.rows[0].revision = 2;
    const missed = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      setDecisionWriteback(4, "written", 99, null, true));
    assert.equal(missed, null);
    assert.equal((await receipts()).length, 0);
    assert.equal(store.rows[0].writeback, null);
  });

  it("rolls the stamp back when the receipt insert throws", async () => {
    env.DATABASE_URL = FIXTURE_URL;
    const calls: { text: string }[] = [];
    setDecisionStoreForTests(null);
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
      calls.push({ text });
      if (text === "begin" || text === "commit" || text === "rollback") return [];
      if (text.includes("insert into events")) throw new Error("receipt insert failed");
      if (text.includes("update decisions")) {
        return [{
          id: 4,
          key: "github:acme/widgets#9",
          status: "decided",
          decision: SECRET,
          writeback: values[0],
          revision: 3,
        }] as Row[];
      }
      return [];
    });
    await assert.rejects(
      () => runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
        setDecisionWriteback(4, "not_written", 2, "fence", true)),
      /receipt insert failed/,
    );
    assert.equal(calls.filter((call) => call.text === "commit").length, 0);
    assert.equal(calls.filter((call) => call.text === "rollback").length, 1);
    assert.equal(calls.filter((call) => call.text.includes("update decisions")).length, 1);
  });
});

