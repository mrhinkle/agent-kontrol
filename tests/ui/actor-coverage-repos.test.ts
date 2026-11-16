/**
 * REST repo replace and pin/hide store an events receipt for the
 * authenticated principal. Dry-run, stale, missing, denied, and a thrown
 * receipt do not leave a successful receipt behind.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PATCH as patchRepos, PUT as putRepos } from "../../src/app/api/settings/repos/route";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID } from "../../src/lib/actor";
import { authCookieValue } from "../../src/lib/authcrypto";
import { CREDENTIAL_ADMIN_KINDS, createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { listVersion, toWatchedRepo, trackedFromRow } from "../../src/lib/watched-repos";
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

const STORED = {
  repo: "acme/app",
  label: "App",
  short: "app",
  color: "#112233",
  blocked_label: null as string | null,
  position: 0,
  origin: "manual",
  pinned: false,
  hidden: false,
  gone: false,
  is_fork: false,
  is_archived: false,
  last_activity_at: null as string | null,
  fields_overridden: false,
};

const REPO = {
  repo: "acme/app",
  label: "App",
  short: "app",
  color: "#112233",
  blockedLabel: "blocked",
};

const creds: Row[] = [];
const calls: { text: string; values: unknown[] }[] = [];
let repoReads = 0;
let divergeLockedRead = false;
let throwOnReceipt = false;

function textOf(strings: TemplateStringsArray, values: unknown[]): string {
  let text = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
  return text.replace(/\s+/g, " ").trim();
}

function installFake() {
  creds.length = 0;
  calls.length = 0;
  repoReads = 0;
  divergeLockedRead = false;
  throwOnReceipt = false;
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
    if (lower.includes("insert into events")) {
      if (throwOnReceipt) throw new Error("receipt insert failed");
      return [{ id: 9, kind: values[0], created_at: "2026-11-15T00:00:00.000Z" }];
    }
    if (lower.includes("update watched_repos")) return [{ repo: STORED.repo }];
    const writing = /insert|update|delete/.test(lower);
    if (lower.includes("from watched_repos") && !writing) {
      repoReads += 1;
      if (divergeLockedRead && repoReads >= 3) return [{ ...STORED, label: "Other" }];
      return [{ ...STORED }];
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
  installFake();
});

afterEach(() => {
  setSqlForTests(null);
  resetCredentialsForTests();
  restoreEnv();
});

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}, method = "PUT") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function cookie() {
  return authCookieValue(PASSWORD);
}

function events() {
  return calls.filter((call) => call.text.toLowerCase().includes("insert into events"));
}

function detailOf(call: { values: unknown[] }) {
  const raw = call.values.find((value) => typeof value === "string" && value.includes("actor_type"));
  assert.equal(typeof raw, "string");
  return JSON.parse(String(raw)) as { actor_type: string | null; actor_id: string | null; tool: string; version?: string };
}

const storedVersion = listVersion([toWatchedRepo(trackedFromRow(STORED, 0), [], new Date(0))]);

describe("actor coverage for repo replace and pin", { concurrency: false }, () => {
  it("stores the dashboard operator on a repo replace and ignores a forged actor", async () => {
    const res = await putRepos(jsonReq("http://x/api/settings/repos", {
      repos: [REPO],
      actor_id: "forged-root",
      actor_type: "agent",
      actor: { actor_type: "agent", actor_id: "forged-root" },
    }, { cookie: `mc_auth=${await cookie()}` }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(events().length, 1);
    assert.equal(events()[0].values[0], "set_watched_repos");
    const detail = detailOf(events()[0]);
    assert.equal(detail.actor_type, "human");
    assert.equal(detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(detail.tool, "set_watched_repos");
    assert.equal(typeof detail.version, "string");
    assert.equal(JSON.stringify(events()[0].values).includes("forged-root"), false);
  });

  it("stores the legacy token on a pin and a null actor when the dashboard is open", async () => {
    const pinned = await patchRepos(jsonReq("http://x/api/settings/repos", {
      repo: "acme/app",
      pinned: true,
      actor_id: "forged-root",
      actor_type: "human",
    }, { authorization: `Bearer ${TOKEN}` }, "PATCH"));
    assert.equal(pinned.status, 200, await pinned.clone().text());
    assert.equal(events().length, 1);
    assert.equal(events()[0].values[0], "set_repo_override");
    const detail = detailOf(events()[0]);
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);
    assert.equal(detail.tool, "set_repo_override");
    assert.equal(JSON.stringify(events()[0].values).includes("forged-root"), false);
    assert.equal(detail.actor_id, LEGACY_ACTOR_ID);

    calls.length = 0;
    delete env.MC_DASHBOARD_PASSWORD;
    const open = await putRepos(jsonReq("http://x/api/settings/repos", {
      repos: [REPO],
      actor_id: DASHBOARD_ACTOR_ID,
      actor_type: "human",
    }));
    assert.equal(open.status, 200, await open.clone().text());
    assert.equal(events().length, 1);
    const openDetail = detailOf(events()[0]);
    assert.equal(openDetail.actor_type, null);
    assert.equal(openDetail.actor_id, null);
    assert.equal(JSON.stringify(events()[0].values).includes(DASHBOARD_ACTOR_ID), false);
  });

  it("does not receipt a dry run, a stale list, a missing pin, a denial, or a thrown receipt", async () => {
    const dry = await putRepos(jsonReq("http://x/api/settings/repos", {
      repos: [REPO],
      dry_run: true,
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(dry.status, 200, await dry.clone().text());
    assert.equal(events().length, 0);
    assert.equal(calls.some((call) => /insert into watched_repos|update watched_repos|delete from watched_repos/.test(call.text.toLowerCase())), false);

    calls.length = 0;
    const stale = await putRepos(jsonReq("http://x/api/settings/repos", {
      repos: [REPO],
      version: "not-the-list",
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(stale.status, 409, await stale.clone().text());
    assert.equal(events().length, 0);

    calls.length = 0;
    divergeLockedRead = true;
    const raced = await putRepos(jsonReq("http://x/api/settings/repos", {
      repos: [REPO],
      version: storedVersion,
    }, { authorization: `Bearer ${TOKEN}` }));
    assert.equal(raced.status, 409, await raced.clone().text());
    assert.equal(events().length, 0);
    assert.equal(calls.some((call) => /insert into watched_repos|delete from watched_repos/.test(call.text.toLowerCase())), false);

    calls.length = 0;
    divergeLockedRead = false;
    const missing = await patchRepos(jsonReq("http://x/api/settings/repos", {
      repo: "missing/repo",
      hidden: true,
    }, { authorization: `Bearer ${TOKEN}` }, "PATCH"));
    assert.equal(missing.status, 404, await missing.clone().text());
    assert.equal(events().length, 0);

    calls.length = 0;
    delete env.DATABASE_URL;
    const offline = await patchRepos(jsonReq("http://x/api/settings/repos", {
      repo: "acme/app",
      pinned: true,
    }, { authorization: `Bearer ${TOKEN}` }, "PATCH"));
    assert.equal(offline.status, 409, await offline.clone().text());
    assert.equal(events().length, 0);

    env.DATABASE_URL = FIXTURE_URL;
    calls.length = 0;
    const credential = await createCredential({ label: "coverage", scopes: ["memory:write"] });
    assert.equal(credential.ok, true);
    if (!credential.ok) throw new Error("credential was not issued");
    assert.match(credential.token, /^akc_/);
    const setup = events();
    assert.equal(setup.length, 1);
    assert.ok(setup[0].values.includes(CREDENTIAL_ADMIN_KINDS.create));
    assert.equal(calls.some((call) => /watched_repos/.test(call.text.toLowerCase())), false);
    calls.length = 0;
    const denied = await putRepos(jsonReq("http://x/api/settings/repos", {
      repos: [REPO],
    }, { authorization: `Bearer ${credential.token}` }));
    assert.equal(denied.status, 403, await denied.clone().text());
    assert.equal(events().length, 0);
    assert.equal(calls.some((call) => /insert into watched_repos|update watched_repos|delete from watched_repos/.test(call.text.toLowerCase())), false);

    calls.length = 0;
    throwOnReceipt = true;
    const failed = await putRepos(jsonReq("http://x/api/settings/repos", {
      repos: [REPO],
    }, { cookie: `mc_auth=${await cookie()}` }));
    assert.equal(failed.status, 500, await failed.clone().text());
    const failedBody = await failed.json() as { code: string };
    assert.equal(failedBody.code, "internal_error");
    assert.equal(events().length, 1);
    assert.equal(calls.filter((call) => call.text.toLowerCase() === "commit").length, 0);
    assert.ok(calls.some((call) => call.text.toLowerCase() === "rollback"));
  });
});
