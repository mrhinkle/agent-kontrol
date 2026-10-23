import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { API_ERRORS, type ErrorCode } from "../../src/lib/api-error";
import { middleware } from "../../src/middleware";
import { MAX_BODY_BYTES } from "../../src/lib/traces";
import { MESSAGES_SETUP_MESSAGE } from "../../src/lib/message-errors";
import { USAGE_SETUP_MESSAGE } from "../../src/lib/usage-errors";

// Prior art: tests/ui/api-errors.test.ts (call the route handler) and
// tests/ui/traces-route.test.ts (no real database). The SQL tag reuses
// globalThis.__mcPgPool, which src/lib/db.ts already reads, so these calls
// hit the handlers without a Postgres server.
// The MCP route starts a timer; it is unref'd so the test process can exit.

const env = process.env as Record<string, string | undefined>;
const TOKEN = "route-test-token";
const DASHBOARD = "fixture-dashboard";
const NOT_THE_DASHBOARD = "not-the-secret";
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_fixture";
const TRACE = "abcdef0123456789abcdef0123456789";
const REPO = {
  repo: "example-org/app-server",
  label: "App Server",
  short: "app",
  color: "#335bb2",
  blockedLabel: null,
};

type SqlMode = "empty" | "throw" | "missing-relation" | "foreign-message" | "usage-missing";
type Handle = { unref?: () => void };
type Route = (req: Request) => Promise<Response>;
type TaskRoute = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type TraceRoute = (req: Request, ctx: { params: Promise<{ traceId: string }> }) => Promise<Response>;

let mode: SqlMode = "empty";

const saved = {
  db: process.env.DATABASE_URL,
  driver: process.env.MC_DB_DRIVER,
  token: process.env.MC_TOKEN,
  password: process.env.MC_DASHBOARD_PASSWORD,
  node: process.env.NODE_ENV,
};

process.env.DATABASE_URL = FIXTURE_URL;
process.env.MC_DB_DRIVER = "pg";
process.env.MC_TOKEN = TOKEN;
process.env.MC_DASHBOARD_PASSWORD = DASHBOARD;


// Route handlers now enforce auth themselves (#40). These tests exercise error
// shapes, not auth, so requests carry the test token unless they set their own.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization") && !String(input).includes("/api/mcp")) headers.set("authorization", `Bearer ${process.env.MC_TOKEN}`);
    super(input, { ...init, headers });
  }
} as typeof Request;

(globalThis as unknown as { __mcPgPool?: { query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>; on: () => void } }).__mcPgPool = {
  on() {},
  async query(text: string) {
    if (mode === "throw") throw new Error("db down SECRET-DETAIL");
    if (mode === "missing-relation") {
      throw Object.assign(new Error('relation "messages" does not exist'), { code: "42P01" });
    }
    if (mode === "usage-missing" && text.includes("usage_facts")) {
      throw Object.assign(new Error('relation "usage_facts" does not exist'), { code: "42P01" });
    }
    if (mode === "foreign-message" && text.includes("from messages")) {
      return { rows: [{ id: 7, thread_id: "7", agent_id: "other-agent" }] };
    }
    return { rows: [] };
  },
};

let patchTask: TaskRoute;
let postTasks: Route;
let postClaim: Route;
let getTraceById: TraceRoute;
let getTraces: Route;
let postReply: Route;
let postLogin: Route;
let putRepos: Route;
let postTraceExport: Route;
let getUsage: Route;
let postUsage: Route;
let postProgress: Route;
let getDigest: Route;
let mcpPost: Route;

function routeUrl(...parts: string[]): string {
  return pathToFileURL(path.join(process.cwd(), "src/app/api", ...parts)).href;
}

function handles(): Handle[] {
  const get = (process as unknown as { _getActiveHandles?: () => Handle[] })._getActiveHandles;
  return get ? get() : [];
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

async function assertFlat(res: Response, code: ErrorCode, error?: string, extra: string[] = []) {
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, API_ERRORS[code].status, JSON.stringify(body));
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  if (error !== undefined) assert.equal(body.error, error);
  assert.equal(typeof body.fix, "string");
  assert.ok((body.fix as string).length > 0);
  assert.equal(body.retryable, API_ERRORS[code].retryable);
  const allowed = new Set(["error", "code", "fix", "retryable", "fields", ...extra]);
  for (const key of Object.keys(body)) assert.ok(allowed.has(key), `unexpected ${key}`);
  return body;
}

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function auth(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function callTool(name: string, args: Record<string, unknown>, withAuth = true) {
  const before = new Set(handles());
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (withAuth) headers.authorization = `Bearer ${TOKEN}`;
    const res = await mcpPost(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }));
    const text = await res.text();
    return { res, text };
  } finally {
    for (const handle of handles()) {
      if (!before.has(handle)) handle.unref?.();
    }
  }
}

function toolBody(text: string): { isError?: boolean; content?: { text: string }[] } {
  const line = text.split("\n").find((item) => item.startsWith("data: "));
  assert.ok(line, text.slice(0, 400));
  const msg = JSON.parse(line.slice("data: ".length)) as {
    result?: { isError?: boolean; content?: { text: string }[] };
  };
  assert.ok(msg.result, text.slice(0, 400));
  return msg.result;
}

function assertTool(result: { isError?: boolean; content?: { text: string }[] }, code: ErrorCode, error?: string) {
  assert.equal(result.isError, true);
  assert.equal(result.content?.length, 1);
  const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  if (error !== undefined) assert.equal(body.error, error);
  assert.equal(typeof body.fix, "string");
  assert.ok((body.fix as string).length > 0);
  assert.equal(body.retryable, API_ERRORS[code].retryable);
  const allowed = new Set(["error", "code", "fix", "retryable", "fields"]);
  for (const key of Object.keys(body)) assert.ok(allowed.has(key), `unexpected ${key}`);
  return body;
}

before(async () => {
  ({ PATCH: patchTask } = await import(routeUrl("tasks/[id]/route.ts")));
  ({ POST: postTasks } = await import(routeUrl("tasks/route.ts")));
  ({ POST: postClaim } = await import(routeUrl("tasks/claim/route.ts")));
  ({ GET: getTraceById } = await import(routeUrl("traces/[traceId]/route.ts")));
  ({ GET: getTraces } = await import(routeUrl("traces/route.ts")));
  ({ POST: postReply } = await import(routeUrl("messages/reply/route.ts")));
  ({ POST: postLogin } = await import(routeUrl("login/route.ts")));
  ({ PUT: putRepos } = await import(routeUrl("settings/repos/route.ts")));
  ({ POST: postTraceExport } = await import(routeUrl("v1/traces/route.ts")));
  ({ GET: getUsage } = await import(routeUrl("usage/route.ts")));
  ({ POST: postUsage } = await import(routeUrl("usage/ingest/route.ts")));
  ({ POST: postProgress } = await import(routeUrl("progress/ingest/route.ts")));
  ({ GET: getDigest } = await import(routeUrl("progress/digest/route.ts")));

  const origInterval = global.setInterval;
  global.setInterval = ((fn: TimerHandler, ms?: number) => {
    const timer = origInterval(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }) as typeof setInterval;
  try {
    ({ POST: mcpPost } = await import(routeUrl("[transport]/route.ts")));
  } finally {
    global.setInterval = origInterval;
  }
});

beforeEach(() => {
  mode = "empty";
});

after(() => {
  globalThis.Request = NativeRequest;
  if (saved.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = saved.db;
  if (saved.driver === undefined) delete process.env.MC_DB_DRIVER;
  else process.env.MC_DB_DRIVER = saved.driver;
  if (saved.token === undefined) delete process.env.MC_TOKEN;
  else process.env.MC_TOKEN = saved.token;
  if (saved.password === undefined) delete process.env.MC_DASHBOARD_PASSWORD;
  else process.env.MC_DASHBOARD_PASSWORD = saved.password;
  if (saved.node === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved.node;
});

describe("documented REST error triggers", () => {
  it("unauthorized: a bad ingest bearer, and a wrong dashboard password", async () => {
    const traces = await postTraceExport(new Request("http://x/api/v1/traces", {
      method: "POST",
      headers: auth({ "content-type": "application/json", authorization: "Bearer wrong-token" }),
      body: "{}",
    }));
    const denied = await assertFlat(traces, "unauthorized", "unauthorized");
    assert.equal(denied.fields, undefined);

    const login = await postLogin(jsonReq("http://x/api/login", { password: NOT_THE_DASHBOARD }, {
      "x-real-ip": "203.0.113.51",
    }));
    const wrong = await assertFlat(login, "unauthorized", "wrong password");
    assert.match(String(wrong.fix), /password/i);
  });

  it("forbidden: in_reply_to belongs to a different agent", async () => {
    mode = "foreign-message";
    const res = await quiet(() => postReply(jsonReq("http://x/api/messages/reply", {
      agent_id: "worker-one",
      body: "hello",
      in_reply_to: 7,
    }, auth())));
    const body = await assertFlat(res, "forbidden", "in_reply_to belongs to a different agent");
    assert.deepEqual(body.fields, { in_reply_to: "in_reply_to belongs to a different agent" });
  });

  it("not_found: an unknown trace id when a database is connected", async () => {
    const res = await quiet(() => getTraceById(
      new Request(`http://x/api/traces/${TRACE}`),
      { params: Promise.resolve({ traceId: TRACE }) },
    ));
    await assertFlat(res, "not_found", "trace not found");
  });

  it("not_found: demo mode returns 200 and an empty spans list", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = await getTraceById(
        new Request("http://x/api/traces/abcdef0123456789abcdef0123456780"),
        { params: Promise.resolve({ traceId: "abcdef0123456789abcdef0123456780" }) },
      );
      assert.equal(res.status, 200);
      const body = await res.json() as { spans: unknown[]; code?: string };
      assert.deepEqual(body.spans, []);
      assert.equal(body.code, undefined);
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });

  it("not_found: in_reply_to names a message that does not exist", async () => {
    const res = await quiet(() => postReply(jsonReq("http://x/api/messages/reply", {
      agent_id: "worker-one",
      body: "hello",
      in_reply_to: 7,
    }, auth())));
    const body = await assertFlat(res, "not_found", "in_reply_to 7 not found");
    assert.deepEqual(body.fields, { in_reply_to: "in_reply_to 7 not found" });
  });

  it("validation_failed: a bad task id and a bad trace id", async () => {
    const task = await patchTask(
      jsonReq("http://x/api/tasks/nope", { status: "done" }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    const taskBody = await assertFlat(task, "validation_failed", "invalid task id");
    assert.deepEqual(taskBody.fields, { id: "invalid task id" });

    const trace = await getTraceById(
      new Request("http://x/api/traces/nope"),
      { params: Promise.resolve({ traceId: "nope" }) },
    );
    const traceBody = await assertFlat(trace, "validation_failed", "invalid trace id");
    assert.equal((traceBody.fields as { traceId: string }).traceId.length > 0, true);
  });

  it("validation_failed: a bad timestamp", async () => {
    const usage = await getUsage(new Request("http://x/api/usage?since=not-a-date&until=also-not"));
    const usageBody = await assertFlat(usage, "validation_failed", "since/until must be ISO 8601");
    assert.equal((usageBody.fields as { since: string }).since.includes("ISO"), true);
    assert.equal((usageBody.fields as { until: string }).until.includes("ISO"), true);

    const ignored = await getUsage(new Request("http://x/api/usage?since=not-a-date"));
    assert.equal(ignored.status, 200);

    const traces = await getTraces(new Request("http://x/api/traces?before=not-a-date"));
    const traceBody = await assertFlat(traces, "validation_failed", "before must be an ISO timestamp");
    assert.equal(typeof (traceBody.fields as { before: string }).before, "string");

    const ingest = await postUsage(jsonReq("http://x/api/usage/ingest", {
      facts: [],
      collected_at: "not-a-date",
    }, auth()));
    const ingestBody = await assertFlat(ingest, "validation_failed", "collected_at must be ISO 8601");
    assert.equal((ingestBody.fields as { collected_at: string }).collected_at.includes("ISO"), true);

    const progress = await postProgress(jsonReq("http://x/api/progress/ingest", {
      repos: [{ repo: "example-org/app-server" }],
      collected_at: "not-a-date",
    }, auth()));
    const progressBody = await assertFlat(progress, "validation_failed", "collected_at must be ISO 8601");
    assert.equal((progressBody.fields as { collected_at: string }).collected_at.includes("ISO"), true);
  });

  it("validation_failed: a privacy refusal", async () => {
    const res = await quiet(() => postUsage(jsonReq("http://x/api/usage/ingest", {
      facts: [{
        model: "test-model",
        account_id: "acct-test",
        source: "hermes_state",
        last_seen_at: "2026-10-21T00:00:00.000Z",
        prompt: "do not store",
      }],
    }, auth())));
    const body = await assertFlat(res, "validation_failed", "privacy: refusing fact field prompt");
    assert.equal((body.fields as { detail: string }).detail, "privacy: refusing fact field prompt");
  });

  it("validation_failed: an OTLP body the parser rejected", async () => {
    const res = await postTraceExport(jsonReq("http://x/api/v1/traces", {}, auth()));
    const body = await assertFlat(res, "validation_failed");
    assert.match(String(body.error), /resourceSpans/);
  });

  it("invalid_json: login keeps its error string, and a task body that is not JSON", async () => {
    const login = await postLogin(jsonReq("http://x/api/login", "{", { "x-real-ip": "203.0.113.52" }));
    await assertFlat(login, "invalid_json", "invalid request");

    const task = await postTasks(jsonReq("http://x/api/tasks", "{"));
    await assertFlat(task, "invalid_json", "invalid JSON");
  });

  it("missing_field: a required field is absent and fields names it", async () => {
    const res = await postTasks(jsonReq("http://x/api/tasks", {}));
    const body = await assertFlat(res, "missing_field", "title is required");
    assert.deepEqual(body.fields, { title: "title is required" });
  });

  it("rate_limited: the sixth login attempt from one client IP", async () => {
    const headers = { "x-real-ip": "203.0.113.50" };
    for (let i = 0; i < 5; i++) {
      const res = await postLogin(jsonReq("http://x/api/login", { password: NOT_THE_DASHBOARD }, headers));
      assert.equal(res.status, 401);
    }
    const blocked = await postLogin(jsonReq("http://x/api/login", { password: NOT_THE_DASHBOARD }, headers));
    await assertFlat(blocked, "rate_limited");
    const retry = Number(blocked.headers.get("Retry-After"));
    assert.equal(Number.isInteger(retry) && retry > 0, true);
  });

  it("conflict: saving repos when no database is connected", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = await putRepos(new Request("http://x/api/settings/repos", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repos: [REPO] }),
      }));
      await assertFlat(res, "conflict", "Settings can only be saved when a database is connected.");
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });

  it("stale: a version that does not match the stored list", async () => {
    const res = await putRepos(new Request("http://x/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: [REPO], version: "not-a-real-version" }),
    }));
    await assertFlat(res, "stale", API_ERRORS.stale.message);
  });

  it("task_not_found: PATCH /api/tasks/:id when that id does not exist", async () => {
    const res = await quiet(() => patchTask(
      jsonReq("http://x/api/tasks/999999", { status: "done", result: "missing" }),
      { params: Promise.resolve({ id: "999999" }) },
    ));
    const body = await assertFlat(res, "task_not_found", "Task not found");
    assert.equal(body.fields, undefined);
  });

  it("task_not_found is not used in demo mode", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = await patchTask(
        jsonReq("http://x/api/tasks/999999", { status: "done" }),
        { params: Promise.resolve({ id: "999999" }) },
      );
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean; demo: boolean; code?: string };
      assert.equal(body.ok, true);
      assert.equal(body.demo, true);
      assert.equal(body.code, undefined);
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });

  it("task_not_claimable is not returned for an empty claim", async () => {
    const res = await postClaim(jsonReq("http://x/api/tasks/claim", {
      platform: "grok",
      agent_id: "worker-one",
    }));
    assert.equal(res.status, 200);
    const body = await res.json() as { task: unknown; code?: string };
    assert.equal(body.task, null);
    assert.equal(body.code, undefined);
    assert.equal(JSON.stringify(body).includes("task_not_claimable"), false);
  });

  it("repo_list_invalid: the settings list fails validation", async () => {
    const res = await putRepos(new Request("http://x/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: [] }),
    }));
    const body = await assertFlat(res, "repo_list_invalid", "Add at least one repo.", ["errors"]);
    assert.deepEqual(body.errors, [{ index: -1, field: "repos", message: "Add at least one repo." }]);
  });

  it("payload_too_large: a trace export over 2 MB", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1));
        controller.close();
      },
    });
    const res = await postTraceExport(new Request("http://x/api/v1/traces", {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: stream,
      duplex: "half",
    } as RequestInit));
    await assertFlat(res, "payload_too_large", "request too large");
  });

  it("unsupported_media_type: a trace export that is not JSON", async () => {
    const res = await postTraceExport(new Request("http://x/api/v1/traces", {
      method: "POST",
      headers: auth({ "content-type": "application/x-protobuf" }),
      body: "not-json",
    }));
    await assertFlat(res, "unsupported_media_type");
  });

  it("setup_required: messaging tables are missing", async () => {
    mode = "missing-relation";
    const res = await postReply(jsonReq("http://x/api/messages/reply", {
      agent_id: "worker-one",
      body: "hello",
    }, auth()));
    const body = await assertFlat(res, "setup_required", MESSAGES_SETUP_MESSAGE, ["setup_required", "message"]);
    assert.equal(body.setup_required, true);
    assert.equal(body.message, MESSAGES_SETUP_MESSAGE);
  });

  it("setup_required: usage ingest tables are missing", async () => {
    mode = "usage-missing";
    const res = await postUsage(jsonReq("http://x/api/usage/ingest", {
      facts: [{
        model: "test-model",
        account_id: "acct-test",
        source: "hermes_state",
        last_seen_at: "2026-10-21T00:00:00.000Z",
      }],
    }, auth()));
    const body = await assertFlat(res, "setup_required", USAGE_SETUP_MESSAGE, ["setup_required", "message"]);
    assert.equal(body.setup_required, true);
    assert.equal(body.message, USAGE_SETUP_MESSAGE);
  });

  it("setup_required: production API with a database and no dashboard password", async () => {
    const prevNode = env.NODE_ENV;
    const prevPassword = process.env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "production";
    delete process.env.MC_DASHBOARD_PASSWORD;
    try {
      const api = await middleware(new NextRequest("http://localhost/api/fleet"));
      const body = await assertFlat(api, "setup_required");
      assert.match(String(body.error), /MC_DASHBOARD_PASSWORD/);

      const page = await middleware(new NextRequest("http://localhost/tasks"));
      assert.equal(page.status, 503);
      assert.match(page.headers.get("content-type") ?? "", /text\/plain/);
      const text = await page.text();
      assert.equal(text.includes("task_not_found") , false);
      assert.equal(text.startsWith("{"), false);
    } finally {
      if (prevNode === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = prevNode;
      if (prevPassword === undefined) delete process.env.MC_DASHBOARD_PASSWORD;
      else process.env.MC_DASHBOARD_PASSWORD = prevPassword;
    }
  });

  it("GET /api/usage stays HTTP 200 when the usage table is missing", async () => {
    mode = "usage-missing";
    const res = await getUsage(new Request("http://x/api/usage"));
    assert.equal(res.status, 200);
    const body = await res.json() as { setup_required?: boolean; code?: string; message?: string };
    assert.equal(body.setup_required, true);
    assert.equal(body.message, USAGE_SETUP_MESSAGE);
    assert.equal(body.code, undefined);
  });

  it("internal_error: the digest hides the exception text", async () => {
    mode = "throw";
    const res = await quiet(() => getDigest(new Request("http://x/api/progress/digest")));
    const body = await assertFlat(res, "internal_error", "Could not build the digest.");
    assert.equal(JSON.stringify(body).includes("SECRET-DETAIL"), false);
  });

  it("internal_error: a successful digest stays text/plain", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const res = await getDigest(new Request("http://x/api/progress/digest"));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      const text = await res.text();
      assert.equal(text.startsWith("{"), false);
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });
});

describe("documented MCP error triggers", () => {
  it("task_not_found: update_task when the id does not exist", async () => {
    const { res, text } = await quiet(() => callTool("update_task", { id: 999999, status: "done" }));
    assert.equal(res.status, 200);
    const body = assertTool(toolBody(text), "task_not_found", "Task not found");
    assert.equal(body.fields, undefined);
    assert.equal(text.includes("SECRET-DETAIL"), false);
  });

  it("update_task in demo mode is not an error", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { res, text } = await callTool("update_task", { id: 999999, status: "done" });
      assert.equal(res.status, 200);
      const result = toolBody(text);
      assert.equal(result.isError, undefined);
      assert.match(result.content?.[0].text ?? "", /Demo mode; task not updated\./);
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });

  it("forbidden: reply_to_operator when in_reply_to belongs to a different agent", async () => {
    mode = "foreign-message";
    const { res, text } = await quiet(() => callTool("reply_to_operator", {
      agent_id: "worker-one",
      body: "hello",
      in_reply_to: 7,
    }));
    assert.equal(res.status, 200);
    const body = assertTool(toolBody(text), "forbidden", "in_reply_to belongs to a different agent");
    assert.deepEqual(body.fields, { in_reply_to: "in_reply_to belongs to a different agent" });
  });

  it("not_found: reply_to_operator when in_reply_to does not exist", async () => {
    const { res, text } = await quiet(() => callTool("reply_to_operator", {
      agent_id: "worker-one",
      body: "hello",
      in_reply_to: 7,
    }));
    assert.equal(res.status, 200);
    assertTool(toolBody(text), "not_found", "in_reply_to 7 not found");
  });

  it("memory_key_invalid: recall with an empty key or a control character", async () => {
    const empty = await callTool("recall", { key: "" });
    assert.equal(empty.res.status, 200);
    const emptyBody = assertTool(toolBody(empty.text), "memory_key_invalid", "Memory key is invalid.");
    assert.equal(typeof (emptyBody.fields as { key: string }).key, "string");

    const newline = await callTool("recall", { key: "has\na newline" });
    assertTool(toolBody(newline.text), "memory_key_invalid");
  });

  it("internal_error: a thrown handler hides the exception text", async () => {
    mode = "throw";
    const { res, text } = await quiet(() => callTool("update_task", { id: 999999, status: "done" }));
    assert.equal(res.status, 200);
    assertTool(toolBody(text), "internal_error", "Internal error.");
    assert.equal(text.includes("SECRET-DETAIL"), false);
  });

  it("task_not_claimable is not returned when claim_task finds nothing queued", async () => {
    const { res, text } = await callTool("claim_task", { platform: "grok", agent_id: "worker-one" });
    assert.equal(res.status, 200);
    const result = toolBody(text);
    assert.notEqual(result.isError, true);
    assert.match(result.content?.[0].text ?? "", /No queued tasks/);
    assert.equal(text.includes("task_not_claimable"), false);
  });

  it("unauthorized is the HTTP 401, not a tool result", async () => {
    const before = new Set(handles());
    try {
      const res = await mcpPost(new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "recall", arguments: {} },
        }),
      }));
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.code, undefined);
      assert.equal(body.retryable, undefined);
    } finally {
      for (const handle of handles()) {
        if (!before.has(handle)) handle.unref?.();
      }
    }
  });

  it("missing_field is not returned when the tool schema rejects a missing argument", async () => {
    const { res, text } = await callTool("remember", {});
    assert.equal(res.status, 200);
    const result = toolBody(text);
    assert.equal(result.isError, true);
    assert.equal(text.includes('"code":"missing_field"'), false);
    assert.equal(text.includes('"retryable"'), false);
  });

});
