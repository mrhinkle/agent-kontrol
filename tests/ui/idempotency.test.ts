import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toolResultFromCaught } from "../../src/lib/api-error";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import {
  hashPayload,
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_TTL_MS,
  IdempotencyConflict,
  IdempotencyKeyInvalid,
  IdempotencyUnknownOutcome,
  idempotencyScope,
  runIdempotent,
  setBeforeIdempotentWriteForTests,
  setIdempotencyClockForTests,
} from "../../src/lib/idempotency";
import { createTask, enqueueMessage, replyFromAgent } from "../../src/lib/store";
import { asUnknownWriteOutcome, UnknownWriteOutcome } from "../../src/lib/write-outcome";

/**
 * Same idempotency key and same arguments return the original row.
 * Same key and different arguments conflict. Keys expire after 24 hours.
 * The key comes from the caller. The actor comes from the credential.
 */

const env = process.env as Record<string, string | undefined>;
const TOKEN = "idem-test-token";
const PASSWORD = "idem-dashboard";
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_idem";

const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};

type Route = (req: Request) => Promise<Response>;
type Handle = { unref?: () => void };
type IdemRow = {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  response: unknown;
  expires_at: string;
  started_at?: string | null;
  claim_token?: string | null;
};

let postTasks: Route;
let postMessages: Route;
let postReply: Route;
let mcpPost: Route;

const creds: Row[] = [];
const inserts: { table: string; row: Row }[] = [];
const idem = new Map<string, IdemRow>();
let seq = 1;
/** The next resource insert is recorded, then the client loses RETURNING. */
let commitThenFail = false;
/** The next claim insert is recorded, then the client loses RETURNING. */
let claimInsertThenFail = false;
/** Definite failure of a follow-up thread_id write. Not a connection loss. */
let threadUpdateFault: Error | null = null;
let threadUpdates = 0;
/** Reads of the claim that should fail after a committed write. */
let failReads = 0;
/** Atomic inserts that saw a claim token they no longer own. */
let refusedAtomic = 0;

function columnsOf(text: string): string[] {
  const match = text.match(/insert into [a-z_]+ \(([^)]+)\)/i);
  if (!match) return [];
  return match[1].split(",").map((part) => part.trim()).filter(Boolean);
}

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

function idemId(scope: string, key: string): string {
  return `${scope}\0${key}`;
}

function installFake() {
  creds.length = 0;
  inserts.length = 0;
  idem.clear();
  seq = 1;
  commitThenFail = false;
  claimInsertThenFail = false;
  threadUpdateFault = null;
  threadUpdates = 0;
  failReads = 0;
  refusedAtomic = 0;
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
    if (lower.includes("delete from idempotency_keys") && lower.includes("expires_at")) {
      const [scope, key, now] = values as string[];
      const row = idem.get(idemId(scope, key));
      if (row && row.expires_at <= now) idem.delete(idemId(scope, key));
      return [];
    }
    if (lower.includes("delete from idempotency_keys") && lower.includes("response is null")) {
      const [scope, key, token] = values as string[];
      const row = idem.get(idemId(scope, key));
      if (row && row.response == null && row.claim_token === token) idem.delete(idemId(scope, key));
      return [];
    }
    if (lower.includes("insert into idempotency_keys")) {
      // values follow the SQL: scope, key, hash, expires_at, started_at, claim_token.
      // response is the SQL null literal and is not a parameter.
      const [scope, key, requestHash, expiresAt, startedAt, claimToken] = values as string[];
      const id = idemId(scope, key);
      if (idem.has(id)) return [];
      const row: IdemRow = {
        scope,
        idempotency_key: key,
        request_hash: requestHash,
        response: null,
        expires_at: expiresAt,
        started_at: startedAt,
        claim_token: claimToken,
      };
      idem.set(id, row);
      if (claimInsertThenFail) {
        claimInsertThenFail = false;
        throw new UnknownWriteOutcome(new Error("connection terminated after COMMIT before RETURNING"));
      }
      return [row];
    }
    if (lower.includes("update idempotency_keys") && lower.includes("set started_at")) {
      // values: started_at, claim_token, request_hash, scope, key, request_hash, lease cutoff.
      const [startedAt, claimToken, requestHash, scope, key, hashAgain, leaseCutoff] = values as string[];
      const row = idem.get(idemId(scope, key));
      if (!row || row.response != null) return [];
      if (row.request_hash !== requestHash || row.request_hash !== hashAgain) return [];
      if (row.started_at != null && row.started_at > leaseCutoff) return [];
      row.started_at = startedAt;
      row.claim_token = claimToken;
      row.request_hash = requestHash;
      return [row];
    }
    if (
      (lower.includes("insert into tasks") || lower.includes("insert into messages"))
      && lower.includes("update idempotency_keys")
      && lower.includes("claim_token")
    ) {
      const [scope, key, token] = values as string[];
      const claim = idem.get(idemId(scope, key));
      if (!claim || claim.claim_token !== token || claim.response != null) {
        refusedAtomic += 1;
        return [];
      }
      const rootMessage = lower.includes("insert into messages") && lower.includes("overriding system value");
      const replyMessage = lower.includes("insert into messages") && !rootMessage;
      const resource: Row = rootMessage
        ? {
            id: seq++,
            agent_id: values[3],
            body: values[4],
            created_by: values[5],
            direction: values[6],
            in_reply_to: values[7] ?? null,
            actor_type: values[8],
            actor_id: values[9],
            created_at: "2026-10-25T00:00:00.000Z",
          }
        : replyMessage
          ? {
              id: seq++,
              agent_id: values[3],
              body: values[4],
              created_by: values[5],
              direction: values[6],
              in_reply_to: values[7] ?? null,
              thread_id: values[8],
              actor_type: values[9],
              actor_id: values[10],
              created_at: "2026-10-25T00:00:00.000Z",
            }
          : {
              id: seq++,
              title: values[3],
              description: values[4] ?? null,
              project: values[5] ?? null,
              platform: values[6] ?? "any",
              machine: values[7] ?? null,
              priority: values[8] ?? 2,
              reviewer_platform: values[9] ?? null,
              created_by: values[10],
              actor_type: values[11],
              actor_id: values[12],
              status: "queued",
              created_at: "2026-10-25T00:00:00.000Z",
            };
      if (rootMessage) resource.thread_id = String(resource.id);
      claim.response = JSON.parse(JSON.stringify(resource)) as Row;
      inserts.push({ table: tableOf(text), row: resource });
      if (commitThenFail) {
        commitThenFail = false;
        failReads += 1;
        throw new UnknownWriteOutcome(new Error("connection terminated after COMMIT before RETURNING"));
      }
      return [{ response: claim.response }];
    }
    if (lower.includes("update idempotency_keys")) {
      const [body, scope, key, token] = values as string[];
      const row = idem.get(idemId(scope, key));
      if (!row || (token != null && row.claim_token !== token)) return [];
      if (lower.includes("response is null") && row.response != null) return [];
      row.response = JSON.parse(body);
      return [];
    }
    if (lower.includes("from idempotency_keys")) {
      if (failReads > 0) {
        failReads -= 1;
        throw new UnknownWriteOutcome(new Error("connection terminated before the stored response could be read"));
      }
      const [scope, key] = values as string[];
      const row = idem.get(idemId(scope, key));
      return row ? [row] : [];
    }
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
      if (lower.includes("insert into tasks") && row.platform == null) row.platform = "any";
      inserts.push({ table: tableOf(text), row });
      if (commitThenFail) {
        commitThenFail = false;
        throw new UnknownWriteOutcome(new Error("connection terminated after COMMIT before RETURNING"));
      }
      return [row];
    }
    if (lower.includes("update messages") && lower.includes("thread_id")) {
      threadUpdates += 1;
      if (threadUpdateFault) {
        const fault = threadUpdateFault;
        threadUpdateFault = null;
        throw fault;
      }
      const id = values[values.length - 1];
      const found = inserts.find((item) => item.table === "messages" && item.row.id === id);
      if (!found) return [];
      found.row.thread_id = values[0];
      return [found.row];
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
  setIdempotencyClockForTests(null);
  installFake();
});

afterEach(() => {
  setSqlForTests(null);
  setIdempotencyClockForTests(null);
  setBeforeIdempotentWriteForTests(null);
  resetCredentialsForTests();
  restoreEnv();
});

after(() => {
  for (const handle of handles()) handle.unref?.();
});

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const actorA = { actor_type: "agent" as const, actor_id: "cred-a" };

describe("idempotency keys", { concurrency: false }, () => {
  it("adds the idempotency_keys table in schema.sql and the changelog migration", () => {
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    const migration = fs.readFileSync("supabase/migrations/20261025_idempotency.sql", "utf8");
    for (const sql of [schema, migration]) {
      assert.match(sql, /create table if not exists idempotency_keys/i);
      assert.match(sql, /primary key \(scope, idempotency_key\)/i);
      assert.match(sql, /response jsonb/i);
      assert.match(sql, /expires_at timestamptz not null/i);
    }
    assert.match(schema, /started_at timestamptz/);
    assert.match(schema, /claim_token text/);
    assert.match(schema, /alter table idempotency_keys add column if not exists started_at timestamptz/i);
    assert.match(schema, /alter table idempotency_keys add column if not exists claim_token text/i);
    const lease = fs.readFileSync("supabase/migrations/20261026_idempotency_lease.sql", "utf8");
    assert.match(lease, /add column if not exists started_at timestamptz/i);
    assert.match(lease, /add column if not exists claim_token text/i);
    assert.equal(IDEMPOTENCY_LEASE_MS, 30_000);
  });

  it("hashes the same arguments once, whatever the key order", () => {
    assert.equal(hashPayload({ b: 1, a: "x" }), hashPayload({ a: "x", b: 1 }));
    assert.notEqual(hashPayload({ title: "a" }), hashPayload({ title: "a", created_by: "dashboard" }));
  });

  it("replays, conflicts, and expires a key", async () => {
    setIdempotencyClockForTests(() => new Date("2026-10-25T00:00:00.000Z"));
    let calls = 0;
    const run = (title: string) => runIdempotent({
      actor: actorA,
      route: "create_task",
      key: " same-key ",
      payload: { title },
      execute: async () => ({ id: ++calls, title }),
    });
    const first = await run("ship it");
    const replay = await run("ship it");
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
    await assert.rejects(() => run("other"), IdempotencyConflict);
    assert.equal(calls, 1);
    setIdempotencyClockForTests(() => new Date("2026-10-25T23:59:59.000Z"));
    const still = await run("ship it");
    assert.equal(still.id, first.id);
    assert.equal(calls, 1);
    setIdempotencyClockForTests(() => new Date("2026-10-26T00:00:00.000Z"));
    const after = await run("other");
    assert.equal(after.id, 2);
    assert.equal(calls, 2);
  });

  it("keeps one caller's key from satisfying a different actor", async () => {
    let calls = 0;
    const run = (actor_id: string) => runIdempotent({
      actor: { actor_type: "agent", actor_id },
      route: "create_task",
      key: "shared",
      payload: { title: "same" },
      execute: async () => ({ id: ++calls }),
    });
    assert.equal((await run("a")).id, 1);
    assert.equal((await run("b")).id, 2);
    assert.equal((await run("a")).id, 1);
  });

  it("treats a lost connection as an unknown write outcome and a definite error as not one", () => {
    const lost = asUnknownWriteOutcome(Object.assign(new Error("connection terminated unexpectedly"), { code: "08006" }));
    assert.ok(lost instanceof UnknownWriteOutcome);
    assert.equal(asUnknownWriteOutcome(new Error("boom")), null);
    assert.ok(asUnknownWriteOutcome(new TypeError("fetch failed")) instanceof UnknownWriteOutcome);
  });

  it("returns the stored row when the write commits and the caller dies before reading it", async () => {
    commitThenFail = true;
    const headers = { authorization: `Bearer ${TOKEN}`, "idempotency-key": "commit-then-die" };
    const first = await postTasks(jsonReq("http://x/api/tasks", { title: "once" }, headers));
    assert.equal(first.status, 409, await first.clone().text());
    const body = await first.json() as Record<string, unknown>;
    assert.equal(body.code, "idempotency_conflict");
    assert.equal(body.retryable, true);
    assert.match(String(body.error), /may already have been saved/);
    assert.match(String(body.error), /24 hours/);
    assert.match(String(body.error), /actor and this route/);
    assert.match(String(body.fix), /24 hours/);
    assert.match(String(body.fix), /actor and the route/);
    const tasks = () => inserts.filter((item) => item.table === "tasks");
    assert.equal(tasks().length, 1);
    const claim = [...idem.values()].find((row) => row.idempotency_key === "commit-then-die");
    assert.ok(claim);
    const stored = claim.response as { title?: string; __agent_kontrol_idempotency?: string };
    assert.equal(stored.title, "once");
    assert.notEqual(stored.__agent_kontrol_idempotency, "unknown_outcome");

    const retry = await postTasks(jsonReq("http://x/api/tasks", { title: "once" }, headers));
    assert.equal(retry.status, 200, await retry.clone().text());
    const saved = await retry.json() as { task: { id: number; title: string } };
    assert.equal(saved.task.title, "once");
    assert.equal(saved.task.id, tasks()[0].row.id);
    assert.equal(tasks().length, 1);

    commitThenFail = true;
    const queued = {
      agent_id: "worker-one",
      body: "hello",
      idempotency_key: "msg-die",
      actor: { actor_type: "human" as const, actor_id: "operator" },
    };
    await assert.rejects(() => enqueueMessage(queued), (err: unknown) => err instanceof IdempotencyUnknownOutcome);
    const messages = () => inserts.filter((item) => item.table === "messages");
    assert.equal(messages().length, 1);
    const again = await enqueueMessage(queued);
    assert.equal(again.id, messages()[0].row.id);
    assert.equal(again.thread_id, String(again.id));
    assert.equal(messages().length, 1);
  });

  it("refuses the old owner's insert after the lease is taken over", async () => {
    const start = new Date("2026-10-25T00:00:00.000Z");
    setIdempotencyClockForTests(() => start);
    const task = { title: "once", idempotency_key: "stall-task", actor: actorA };
    let secondTask: { id: number } | undefined;
    setBeforeIdempotentWriteForTests(async () => {
      setIdempotencyClockForTests(() => new Date(start.getTime() + IDEMPOTENCY_LEASE_MS + 1));
      secondTask = await createTask(task);
    });
    const lateTask = await createTask(task);
    assert.ok(secondTask);
    assert.equal(refusedAtomic, 1);
    assert.equal(inserts.filter((item) => item.table === "tasks").length, 1);
    assert.equal(lateTask.id, secondTask.id);
    assert.equal(lateTask.title, "once");

    refusedAtomic = 0;
    inserts.length = 0;
    const message = {
      agent_id: "worker-one",
      body: "hello",
      idempotency_key: "stall-msg",
      actor: { actor_type: "human" as const, actor_id: "operator" },
    };
    let secondMessage: { id: number } | undefined;
    setIdempotencyClockForTests(() => start);
    setBeforeIdempotentWriteForTests(async () => {
      setIdempotencyClockForTests(() => new Date(start.getTime() + IDEMPOTENCY_LEASE_MS + 1));
      secondMessage = await enqueueMessage(message);
    });
    const lateMessage = await enqueueMessage(message);
    assert.ok(secondMessage);
    assert.equal(refusedAtomic, 1);
    assert.equal(inserts.filter((item) => item.table === "messages").length, 1);
    assert.equal(lateMessage.id, secondMessage.id);
    assert.equal(lateMessage.thread_id, String(lateMessage.id));
  });

  it("executes the resource write once when the claim commits and the write never starts", async () => {
    claimInsertThenFail = true;
    const input = { title: "once", idempotency_key: "claim-lost", actor: actorA };
    const first = await createTask(input);
    const tasks = () => inserts.filter((item) => item.table === "tasks");
    assert.equal(tasks().length, 1);
    const retry = await createTask(input);
    assert.equal(retry.id, first.id);
    assert.equal(retry.title, "once");
    assert.equal(tasks().length, 1);
  });

  it("releases the claim when the write fails, and reports an in-progress key", async () => {
    let calls = 0;
    await assert.rejects(() => runIdempotent({
      actor: actorA,
      route: "create_task",
      key: "retry",
      payload: { title: "a" },
      execute: async () => {
        calls += 1;
        throw new Error("boom");
      },
    }));
    const nested = runIdempotent({
      actor: actorA,
      route: "create_task",
      key: "busy",
      payload: { title: "a" },
      execute: async () => {
        await assert.rejects(() => runIdempotent({
          actor: actorA,
          route: "create_task",
          key: "busy",
          payload: { title: "a" },
          execute: async () => ({ id: 9 }),
        }), (err: unknown) => {
          assert.ok(err instanceof IdempotencyConflict);
          assert.match(err.message, /in progress/);
          assert.equal(err.retryable, true);
          assert.equal(typeof err.retryAfterSec, "number");
          assert.ok((err.retryAfterSec ?? 0) >= 1);
          return true;
        });
        return { id: 3 };
      },
    });
    assert.deepEqual(await nested, { id: 3 });
    const recovered = await runIdempotent({
      actor: actorA,
      route: "create_task",
      key: "retry",
      payload: { title: "a" },
      execute: async () => ({ id: ++calls }),
    });
    assert.equal(recovered.id, 2);
    assert.equal(calls, 2);
  });

  it("executes once when the claim insert commits and the connection drops", async () => {
    claimInsertThenFail = true;
    let calls = 0;
    const run = () => runIdempotent({
      actor: actorA,
      route: "create_task",
      key: "lost-claim",
      payload: { title: "a" },
      execute: async () => ({ id: ++calls }),
    });
    const first = await run();
    assert.equal(first.id, 1);
    assert.equal(calls, 1);
    const retry = await run();
    assert.deepEqual(retry, first);
    assert.equal(calls, 1);
  });

  it("takes over a crashed claim after the lease and executes once", async () => {
    const start = new Date("2026-10-25T00:00:00.000Z");
    const scope = idempotencyScope(actorA, "create_task");
    const key = "crashed";
    const payload = { title: "a" };
    idem.set(idemId(scope, key), {
      scope,
      idempotency_key: key,
      request_hash: hashPayload(payload),
      response: null,
      expires_at: new Date(start.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      started_at: start.toISOString(),
      claim_token: "dead-process",
    });
    setIdempotencyClockForTests(() => new Date(start.getTime() + IDEMPOTENCY_LEASE_MS));
    let calls = 0;
    const run = () => runIdempotent({
      actor: actorA,
      route: "create_task",
      key,
      payload,
      execute: async () => ({ id: ++calls }),
    });
    const first = await run();
    assert.equal(first.id, 1);
    assert.equal(calls, 1);
    const replay = await run();
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
  });

  it("reports a live claim inside the lease as retryable and does not execute", async () => {
    const start = new Date("2026-10-25T00:00:00.000Z");
    const later = new Date(start.getTime() + 1000);
    setIdempotencyClockForTests(() => later);
    const scope = idempotencyScope(actorA, "create_task");
    const key = "live";
    const payload = { title: "a" };
    idem.set(idemId(scope, key), {
      scope,
      idempotency_key: key,
      request_hash: hashPayload(payload),
      response: null,
      expires_at: new Date(start.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      started_at: start.toISOString(),
      claim_token: "other-request",
    });
    let calls = 0;
    const run = (body: Record<string, unknown>) => runIdempotent({
      actor: actorA,
      route: "create_task",
      key,
      payload: body,
      execute: async () => ({ id: ++calls }),
    });
    let caught: unknown;
    await assert.rejects(() => run(payload), (err: unknown) => {
      caught = err;
      assert.ok(err instanceof IdempotencyConflict);
      assert.match(err.message, /in progress/);
      assert.equal(err.retryable, true);
      assert.equal(err.retryAfterSec, 29);
      return true;
    });
    assert.equal(calls, 0);
    const mcp = toolResultFromCaught("[idempotency] live claim", caught);
    const mcpBody = JSON.parse(mcp.content[0].text) as { retryable: boolean; retry_after: number };
    assert.equal(mcpBody.retryable, true);
    assert.equal(mcpBody.retry_after, 29);

    await assert.rejects(() => run({ title: "other" }), (err: unknown) => {
      assert.ok(err instanceof IdempotencyConflict);
      assert.equal(err.retryable, false);
      assert.equal(err.retryAfterSec, null);
      return true;
    });
    assert.equal(calls, 0);

    const httpKey = "http-live";
    const httpScope = "agent:mc-token:create_task";
    idem.set(idemId(httpScope, httpKey), {
      scope: httpScope,
      idempotency_key: httpKey,
      request_hash: hashPayload({ title: "once" }),
      response: null,
      expires_at: new Date(start.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      started_at: start.toISOString(),
      claim_token: "other-request",
    });
    const res = await postTasks(jsonReq("http://x/api/tasks", { title: "once" }, {
      authorization: `Bearer ${TOKEN}`,
      "idempotency-key": httpKey,
    }));
    assert.equal(res.status, 409, await res.clone().text());
    const body = await res.json() as { code: string; retryable: boolean; retry_after: number };
    assert.equal(body.code, "idempotency_conflict");
    assert.equal(body.retryable, true);
    assert.equal(body.retry_after, 29);
    assert.equal(res.headers.get("Retry-After"), "29");
    assert.equal(inserts.filter((item) => item.table === "tasks").length, 0);
  });

  it("rejects a key that is too long or contains a control character, and ignores a blank key", async () => {
    await assert.rejects(
      () => createTask({ title: "a", idempotency_key: "x".repeat(201) }),
      IdempotencyKeyInvalid,
    );
    await assert.rejects(
      () => createTask({ title: "a", idempotency_key: "bad\nkey" }),
      IdempotencyKeyInvalid,
    );
    await createTask({ title: "one", idempotency_key: "   " });
    await createTask({ title: "two", idempotency_key: "" });
    assert.equal(inserts.filter((item) => item.table === "tasks").length, 2);
  });

  it("records one task when POST /api/tasks repeats an Idempotency-Key", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, "idempotency-key": "task-1" };
    const body = { title: "queue the digest", created_by: "someone-else", actor_id: "root" };
    const first = await postTasks(jsonReq("http://x/api/tasks", body, headers));
    const second = await postTasks(jsonReq("http://x/api/tasks", body, headers));
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(second.status, 200);
    const a = await first.json() as { task: Row };
    const b = await second.json() as { task: Row };
    assert.deepEqual(b.task, a.task);
    assert.equal(a.task.actor_type, "agent");
    assert.equal(a.task.actor_id, "mc-token");
    assert.equal(a.task.created_by, "someone-else");
    assert.equal(inserts.filter((item) => item.table === "tasks").length, 1);
    assert.equal([...idem.values()][0]?.scope, "agent:mc-token:create_task");
  });

  it("returns idempotency_conflict when the same header carries a different task", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, "Idempotency-Key": "task-2" };
    const ok = await postTasks(jsonReq("http://x/api/tasks", { title: "first" }, headers));
    assert.equal(ok.status, 200, await ok.clone().text());
    const conflict = await postTasks(jsonReq("http://x/api/tasks", { title: "second" }, headers));
    assert.equal(conflict.status, 409);
    const body = await conflict.json() as Record<string, unknown>;
    assert.equal(body.code, "idempotency_conflict");
    assert.equal(body.retryable, false);
    assert.equal(typeof body.error, "string");
    assert.equal(typeof body.fix, "string");
    assert.match(String((body.fields as { idempotency_key: string }).idempotency_key), /different arguments/);
    assert.equal(inserts.filter((item) => item.table === "tasks").length, 1);
  });

  it("creates a new task after the key expires, and a body field is not a key", async () => {
    setIdempotencyClockForTests(() => new Date("2026-10-25T00:00:00.000Z"));
    const headers = { authorization: `Bearer ${TOKEN}`, "idempotency-key": "task-3" };
    await postTasks(jsonReq("http://x/api/tasks", { title: "first" }, headers));
    setIdempotencyClockForTests(() => new Date("2026-10-26T00:00:00.000Z"));
    const again = await postTasks(jsonReq("http://x/api/tasks", { title: "second" }, headers));
    assert.equal(again.status, 200, await again.clone().text());
    assert.equal(inserts.filter((item) => item.table === "tasks").length, 2);

    await postTasks(jsonReq("http://x/api/tasks", { title: "plain", idempotency_key: "not-a-header" }, {
      authorization: `Bearer ${TOKEN}`,
    }));
    await postTasks(jsonReq("http://x/api/tasks", { title: "plain", idempotency_key: "not-a-header" }, {
      authorization: `Bearer ${TOKEN}`,
    }));
    assert.equal(inserts.filter((item) => item.table === "tasks").length, 4);
  });

  it("replays an operator message and conflicts a reply from the header", async () => {
    const cookie = await authCookieValue(PASSWORD);
    const messageHeaders = { cookie: `mc_auth=${cookie}`, "idempotency-key": "msg-1" };
    const message = { agent_id: "worker-one", body: "please look", created_by: "not-the-operator" };
    const first = await postMessages(jsonReq("http://x/api/messages", message, messageHeaders));
    const second = await postMessages(jsonReq("http://x/api/messages", message, messageHeaders));
    assert.equal(first.status, 200, await first.clone().text());
    const a = await first.json() as { message: Row };
    const b = await second.json() as { message: Row };
    assert.deepEqual(b.message, a.message);
    assert.equal(a.message.actor_type, "human");
    assert.equal(a.message.actor_id, "operator");
    assert.equal([...idem.values()][0]?.scope, "human:operator:enqueue_message");
    assert.equal(inserts.filter((item) => item.table === "messages").length, 1);

    const replyHeaders = { authorization: `Bearer ${TOKEN}`, "idempotency-key": "reply-1" };
    const reply = await postReply(jsonReq("http://x/api/messages/reply", {
      agent_id: "worker-one",
      body: "done",
    }, replyHeaders));
    assert.equal(reply.status, 200, await reply.clone().text());
    const clash = await postReply(jsonReq("http://x/api/messages/reply", {
      agent_id: "worker-one",
      body: "done differently",
    }, replyHeaders));
    assert.equal(clash.status, 409);
    assert.equal((await clash.json() as { code: string }).code, "idempotency_conflict");
    assert.equal(inserts.filter((item) => item.table === "messages").length, 2);
    const replyScope = [...idem.values()].find((row) => row.idempotency_key === "reply-1");
    assert.equal(replyScope?.scope, "agent:mc-token:reply_to_operator");
  });

  it("stores one MCP create_task for a repeated key and conflicts a different title", async () => {
    const created = await createCredential({ label: "idempotency", scopes: ["tasks:write"] });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("credential was not issued");
    const before = new Set(handles());
    const call = async (title: string, id: number) => {
      const res = await mcpPost(new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "create_task",
            arguments: { title, idempotency_key: "mcp-1", created_by: "someone-else" },
          },
        }),
      }));
      const text = await res.text();
      return { status: res.status, text };
    };
    let results: { status: number; text: string }[] = [];
    try {
      results = [await call("mcp task", 1), await call("mcp task", 2), await call("other task", 3)];
    } finally {
      for (const handle of handles()) {
        if (!before.has(handle)) handle.unref?.();
      }
    }
    assert.equal(results[0].status, 200, results[0].text.slice(0, 400));
    const taskLine = (text: string) => text.match(/Task #\d+ queued[^"\\]*/)?.[0];
    assert.equal(taskLine(results[0].text), taskLine(results[1].text));
    assert.match(results[2].text, /idempotency_conflict/);
    const stored = inserts.filter((item) => item.table === "tasks");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].row.actor_id, created.credential.id);
    assert.equal(stored[0].row.created_by, "someone-else");
    assert.equal([...idem.values()][0]?.scope, `agent:${created.credential.id}:create_task`);
  });

  it("replays one MCP reply_to_operator and conflicts a different body", async () => {
    const created = await createCredential({ label: "idempotency-reply", scopes: ["messages:write"] });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("credential was not issued");
    const before = new Set(handles());
    const call = async (name: string, body: string, id: number) => {
      const res = await mcpPost(new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name,
            arguments: { agent_id: "worker-one", body, idempotency_key: "mcp-reply-1" },
          },
        }),
      }));
      const text = await res.text();
      return { status: res.status, text };
    };
    let results: { status: number; text: string }[] = [];
    try {
      results = [
        await call("reply_to_operator", "finished", 1),
        await call("reply_to_operator", "finished", 2),
        await call("reply_to_mark", "finished", 3),
        await call("reply_to_operator", "a different reply", 4),
      ];
    } finally {
      for (const handle of handles()) {
        if (!before.has(handle)) handle.unref?.();
      }
    }
    assert.equal(results[0].status, 200, results[0].text.slice(0, 400));
    const replyLine = (text: string) => text.match(/Reply #\d+ delivered[^"\\]*/)?.[0];
    assert.equal(replyLine(results[0].text), replyLine(results[1].text));
    assert.equal(replyLine(results[0].text), replyLine(results[2].text));
    assert.match(results[3].text, /idempotency_conflict/);
    assert.equal(inserts.filter((item) => item.table === "messages").length, 1);
    const claim = [...idem.values()].find((row) => row.idempotency_key === "mcp-reply-1");
    assert.equal(claim?.scope, `agent:${created.credential.id}:reply_to_operator`);
  });

  it("registers idempotency_key on create_task and both reply tools", () => {
    const src = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const matches = src.match(/idempotency_key: z/g) ?? [];
    assert.equal(matches.length, 2);
    assert.match(src, /idempotency_key: args\.idempotency_key/);
  });

  it("does not insert a second message when the thread_id write fails after the insert", async () => {
    const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const messages = () => inserts.filter((item) => item.table === "messages");

    threadUpdateFault = deadlock();
    const queued = {
      agent_id: "worker-one",
      body: "hello",
      idempotency_key: "thread-deadlock",
      actor: { actor_type: "human" as const, actor_id: "operator" },
    };
    let firstId: number | undefined;
    try {
      const first = await enqueueMessage(queued);
      firstId = first.id;
      assert.equal(first.thread_id, String(first.id));
      assert.equal(threadUpdates, 0);
    } catch (err) {
      assert.ok(err instanceof IdempotencyUnknownOutcome);
      assert.ok(threadUpdates >= 1);
    }
    assert.equal(messages().length, 1);
    if (firstId != null) {
      const again = await enqueueMessage(queued);
      assert.equal(again.id, firstId);
    } else {
      await assert.rejects(() => enqueueMessage(queued), IdempotencyUnknownOutcome);
    }
    assert.equal(messages().length, 1);

    threadUpdateFault = deadlock();
    threadUpdates = 0;
    const replied = {
      agent_id: "worker-one",
      body: "done",
      idempotency_key: "reply-deadlock",
      actor: actorA,
    };
    let replyId: number | undefined;
    try {
      const reply = await replyFromAgent(replied);
      replyId = reply.id;
      assert.equal(reply.thread_id, String(reply.id));
      assert.equal(threadUpdates, 0);
    } catch (err) {
      assert.ok(err instanceof IdempotencyUnknownOutcome);
      assert.ok(threadUpdates >= 1);
    }
    assert.equal(messages().length, 2);
    if (replyId != null) {
      const again = await replyFromAgent(replied);
      assert.equal(again.id, replyId);
    } else {
      await assert.rejects(() => replyFromAgent(replied), IdempotencyUnknownOutcome);
    }
    assert.equal(messages().length, 2);
  });

  it("writes a message thread in one statement, and a task in one insert", () => {
    const src = fs.readFileSync("src/lib/store.ts", "utf8");
    const messages = src.slice(
      src.indexOf("export async function enqueueMessage"),
      src.indexOf("export async function fetchMessages"),
    );
    const task = src.slice(
      src.indexOf("async function insertTask"),
      src.indexOf("const OPEN_STATUSES"),
    );
    assert.equal(/update\s+messages/i.test(messages), false);
    assert.match(messages, /overriding system value/);
    assert.match(messages, /nextval\(pg_get_serial_sequence\('messages', 'id'\)\)/);
    assert.match(messages, /update idempotency_keys/i);
    assert.match(messages, /claim_token/);
    assert.match(messages, /for update/i);
    assert.match(messages, /select response from stored/i);
    assert.match(task, /insert into tasks/i);
    assert.match(task, /update idempotency_keys/i);
    assert.match(task, /claim_token/);
    assert.match(task, /for update/i);
    assert.match(task, /select response from stored/i);
    assert.equal(/update\s+tasks/i.test(task), false);
  });

  it("documents the 24 hour retry window and actor-plus-route key scope", () => {
    const api = fs.readFileSync("docs/API.md", "utf8");
    const mcp = fs.readFileSync("docs/MCP.md", "utf8");
    for (const text of [api, mcp]) {
      assert.match(text, /24 hour window/);
      assert.match(text, /scoped by actor and route/);
      assert.match(text, /After 24 hours the same key starts a new write|After that window the same key starts a new write/);
      assert.match(text, /30 second lease/);
      assert.match(text, /Retry-After/);
    }
  });

  it("scopes a store reply to reply_to_operator", async () => {
    await replyFromAgent({
      agent_id: "worker-one",
      body: "ack",
      idempotency_key: "store-reply",
      actor: actorA,
    });
    await enqueueMessage({
      agent_id: "worker-one",
      body: "hello",
      idempotency_key: "store-msg",
      actor: { actor_type: "human", actor_id: "operator" },
    });
    const reply = [...idem.values()].find((row) => row.idempotency_key === "store-reply");
    const message = [...idem.values()].find((row) => row.idempotency_key === "store-msg");
    assert.equal(reply?.scope, "agent:cred-a:reply_to_operator");
    assert.equal(message?.scope, "human:operator:enqueue_message");
  });
});
