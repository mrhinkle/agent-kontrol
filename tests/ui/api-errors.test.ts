import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  API_ERRORS,
  apiError,
  mcpToolError,
  memoryKeyError,
  publicError,
  toolResultFromCaught,
} from "../../src/lib/api-error";
import { loadTraceResponse } from "../../src/lib/trace-response";

// Prior art: tests/ui/traces-route.test.ts (call the route handler with no database)
// and tests/ui/mcp-tools.test.ts (static source guard).

const REQUIRED = [
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "invalid_json",
  "missing_field",
  "rate_limited",
  "conflict",
  "task_not_found",
  "task_not_claimable",
  "memory_key_invalid",
  "repo_list_invalid",
  "payload_too_large",
  "internal_error",
] as const;

const TRACE = "0123456789abcdef0123456789abcdef";
const saved = {
  token: process.env.MC_TOKEN,
  db: process.env.DATABASE_URL,
  password: process.env.MC_DASHBOARD_PASSWORD,
};

let putRepos: (req: Request) => Promise<Response>;
let postTraces: (req: Request) => Promise<Response>;
let postLogin: (req: Request) => Promise<Response>;

before(async () => {
  process.env.MC_TOKEN = "route-test-token";
  process.env.MC_DASHBOARD_PASSWORD = "test-dashboard-password";
  delete process.env.DATABASE_URL;
  ({ PUT: putRepos } = await import("../../src/app/api/settings/repos/route"));
  ({ POST: postTraces } = await import("../../src/app/api/v1/traces/route"));
  ({ POST: postLogin } = await import("../../src/app/api/login/route"));
});

after(() => {
  if (saved.token === undefined) delete process.env.MC_TOKEN;
  else process.env.MC_TOKEN = saved.token;
  if (saved.db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = saved.db;
  if (saved.password === undefined) delete process.env.MC_DASHBOARD_PASSWORD;
  else process.env.MC_DASHBOARD_PASSWORD = saved.password;
});

function silence<T>(fn: () => T): T {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

async function jsonOf(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

describe("error catalogue", () => {
  it("has a status, message, fix, and retryable flag for every code", () => {
    const codes = Object.keys(API_ERRORS);
    assert.ok(codes.length >= 15);
    for (const code of REQUIRED) assert.ok(codes.includes(code), code);
    for (const spec of Object.values(API_ERRORS)) {
      assert.equal(typeof spec.status, "number");
      assert.equal(typeof spec.message, "string");
      assert.ok(spec.fix.length > 0);
      assert.equal(typeof spec.retryable, "boolean");
    }
    assert.equal(API_ERRORS.internal_error.retryable, true);
    assert.equal(API_ERRORS.internal_error.status, 500);
  });

  it("keeps the stale code the settings page already checks", async () => {
    const res = apiError("stale", { extra: { code: "conflict" } });
    assert.equal(res.status, 409);
    const body = await jsonOf(res);
    assert.equal(body.code, "stale");
    assert.equal(body.error, API_ERRORS.stale.message);
    assert.equal(body.retryable, false);
  });
});

describe("REST errors", () => {
  it("returns a validation error and keeps the per-field errors array", async () => {
    const res = await putRepos(new Request("http://x/api/settings/repos", {
      method: "PUT",
      body: JSON.stringify({ repos: [] }),
    }));
    assert.equal(res.status, 400);
    const body = await jsonOf(res);
    assert.equal(typeof body.error, "string");
    assert.equal(body.error, "Add at least one repo.");
    assert.equal(body.code, "repo_list_invalid");
    assert.equal(body.retryable, false);
    assert.equal(typeof body.fix, "string");
    assert.deepEqual(body.errors, [{ index: -1, field: "repos", message: "Add at least one repo." }]);
    assert.deepEqual(body.fields, { repos: "Add at least one repo." });
  });

  it("keeps the invalid-JSON errors array on the settings route", async () => {
    const res = await putRepos(new Request("http://x/api/settings/repos", {
      method: "PUT",
      body: "{",
    }));
    assert.equal(res.status, 400);
    const body = await jsonOf(res);
    assert.equal(body.code, "invalid_json");
    assert.equal(body.error, "Request body must be JSON.");
    assert.deepEqual(body.errors, [{ index: -1, field: "repos", message: "Request body must be JSON." }]);
  });

  it("returns an auth error whose error string is unchanged", async () => {
    const traces = await postTraces(new Request("http://x/api/v1/traces", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(traces.status, 401);
    const denied = await jsonOf(traces);
    assert.equal(denied.error, "unauthorized");
    assert.equal(denied.code, "unauthorized");
    assert.equal(denied.retryable, false);
    assert.equal(typeof denied.fix, "string");

    const login = await postLogin(new Request("http://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "not-the-password" }),
    }));
    assert.equal(login.status, 401);
    const wrong = await jsonOf(login);
    assert.equal(wrong.error, "wrong password");
    assert.equal(wrong.code, "unauthorized");
    assert.match(String(wrong.fix), /password/i);
  });

  it("returns not_found when a trace has no spans", async () => {
    const res = await loadTraceResponse(TRACE, async () => []);
    assert.equal(res.status, 404);
    const body = await jsonOf(res);
    assert.equal(body.error, "trace not found");
    assert.equal(body.code, "not_found");
    assert.equal(body.retryable, false);
    assert.equal(typeof body.fix, "string");
  });

  it("does not leak a thrown SECRET-DETAIL on a 500", async () => {
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const res = await loadTraceResponse(TRACE, async () => {
        throw new Error("boom SECRET-DETAIL");
      });
      assert.equal(res.status, 500);
      const body = await jsonOf(res);
      assert.equal(body.code, "internal_error");
      assert.equal(body.retryable, true);
      assert.equal(body.error, "could not read trace");
      assert.equal(JSON.stringify(body).includes("SECRET-DETAIL"), false);
      assert.ok(logged.some((args) => args.some((item) => item instanceof Error && item.message.includes("SECRET-DETAIL"))));
    } finally {
      console.error = orig;
    }
  });

  it("maps only an exact Task not found, and refuses a lookalike that carries extra text", () => {
    const found = silence(() => publicError("[tasks]", new Error("Task not found")));
    assert.equal(found.status, 404);
    return jsonOf(found).then((body) => {
      assert.equal(body.code, "task_not_found");
      assert.equal(body.error, "Task not found");
    }).then(() => {
      const leaked = silence(() => publicError("[tasks]", new Error("Task not found SECRET-DETAIL")));
      assert.equal(leaked.status, 500);
      return jsonOf(leaked).then((body) => {
        assert.equal(body.code, "internal_error");
        assert.equal(JSON.stringify(body).includes("SECRET-DETAIL"), false);
      });
    });
  });
});

describe("MCP tool errors", () => {
  it("returns isError with the same JSON keys", () => {
    const result = mcpToolError("missing_field", {
      message: "title is required",
      fields: { title: "title is required" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    assert.equal(body.error, "title is required");
    assert.equal(body.code, "missing_field");
    assert.equal(typeof body.fix, "string");
    assert.equal(body.retryable, false);
    assert.deepEqual(body.fields, { title: "title is required" });
  });

  it("hides a thrown SECRET-DETAIL inside a tool failure", () => {
    const result = silence(() => toolResultFromCaught("[mcp]", new Error("db down SECRET-DETAIL")));
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    assert.equal(body.code, "internal_error");
    assert.equal(body.retryable, true);
    assert.equal(result.content[0].text.includes("SECRET-DETAIL"), false);
  });

  it("rejects a bad memory key instead of treating it as an empty recall", () => {
    assert.equal(memoryKeyError(undefined), null);
    assert.equal(memoryKeyError("session/abc"), null);
    const bad = memoryKeyError("");
    assert.ok(bad);
    assert.equal(bad.isError, true);
    const body = JSON.parse(bad.content[0].text) as Record<string, unknown>;
    assert.equal(body.code, "memory_key_invalid");
    assert.equal(body.retryable, false);
    const newline = memoryKeyError("has\na newline");
    assert.equal(JSON.parse(newline!.content[0].text).code, "memory_key_invalid");
  });
});

describe("route source guard", () => {
  it("fails if a route under src/app/api returns a raw exception message", () => {
    const root = "src/app/api";
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(root);
    assert.ok(files.length >= 15, "the scan found too few route files to be a real guard");
    const leak = /\(e as Error\)\.message|\be\.message\b|\berr\.message\b|\berror\.message\b/;
    const hits = files.filter((file) => leak.test(fs.readFileSync(file, "utf8")));
    assert.deepEqual(hits, []);
  });

  it("wires the settings stale code and the MCP tool guard", () => {
    const repos = fs.readFileSync("src/app/api/settings/repos/route.ts", "utf8");
    assert.match(repos, /apiError\("stale"\)/);
    assert.match(repos, /errors: checked\.errors/);
    const mcp = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    assert.match(mcp, /guardTool\(/);
    assert.match(mcp, /memoryKeyError\(/);
    assert.match(mcp, /toolResultFromCaught\(/);
  });

  it("lists every catalogue code in the API and MCP docs", () => {
    const api = fs.readFileSync("docs/API.md", "utf8");
    const mcp = fs.readFileSync("docs/MCP.md", "utf8");
    for (const code of Object.keys(API_ERRORS)) {
      assert.ok(api.includes(code), `docs/API.md missing ${code}`);
      assert.ok(mcp.includes(code), `docs/MCP.md missing ${code}`);
    }
  });
});
