import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { NextResponse } from "next/server";
import {
  LANGFUSE_DEFAULT_BASE_URL,
  getLangfuseStatus,
  ingestEventMeta,
  isLangfuseEnabled,
  langfuseStatusLabel,
  mcpToolMeta,
  parseLangfuseBaseUrl,
  readLangfuseConfig,
  sanitizeLangfuseMeta,
} from "../../src/lib/langfuse-config";
import { setLangfuseEmitterForTests, traceAgentEvent, type LangfuseTraceRecord } from "../../src/lib/langfuse";

const KEYS = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASEURL", "LANGFUSE_HOST", "LANGFUSE_BASE_URL"] as const;

const saved: Record<string, string | undefined> = {};
for (const key of KEYS) saved[key] = process.env[key];

function clearEnv() {
  for (const key of KEYS) delete process.env[key];
}

after(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setLangfuseEmitterForTests(null);
});

describe("Langfuse config", () => {
  it("stays off with no variables and uses the cloud default host", () => {
    const cfg = readLangfuseConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.baseUrl, LANGFUSE_DEFAULT_BASE_URL);
    assert.equal(cfg.baseUrlSource, "default");
    assert.equal(isLangfuseEnabled({}), false);
  });

  it("stays off when only one key is set", () => {
    assert.equal(readLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk-lf-test" }).enabled, false);
    assert.equal(readLangfuseConfig({ LANGFUSE_SECRET_KEY: "sk-lf-test" }).enabled, false);
    assert.equal(readLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "  ", LANGFUSE_SECRET_KEY: "sk-lf-test" }).enabled, false);
  });

  it("turns on when both keys are set", () => {
    const cfg = readLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test" });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.baseUrl, "https://cloud.langfuse.com");
    assert.equal(cfg.publicKey, "pk-lf-test");
  });

  it("prefers LANGFUSE_BASEURL, then LANGFUSE_HOST, then LANGFUSE_BASE_URL", () => {
    const all = readLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASEURL: "https://from-baseurl.example/langfuse/",
      LANGFUSE_HOST: "https://from-host.example",
      LANGFUSE_BASE_URL: "https://from-official.example",
    });
    assert.equal(all.baseUrl, "https://from-baseurl.example/langfuse");
    assert.equal(all.baseUrlSource, "LANGFUSE_BASEURL");

    const host = readLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_HOST: "https://us.cloud.langfuse.com",
    });
    assert.equal(host.baseUrl, "https://us.cloud.langfuse.com");
    assert.equal(host.baseUrlSource, "LANGFUSE_HOST");

    const official = readLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "http://localhost:3001",
    });
    assert.equal(official.enabled, true);
    assert.equal(official.baseUrl, "http://localhost:3001");
    assert.equal(official.baseUrlSource, "LANGFUSE_BASE_URL");
  });

  it("rejects credential, query, and non-http hosts and stays off", () => {
    assert.equal(parseLangfuseBaseUrl("not a url"), null);
    assert.equal(parseLangfuseBaseUrl("ftp://files.example"), null);
    assert.equal(parseLangfuseBaseUrl("https://user:secret@cloud.langfuse.com"), null);
    assert.equal(parseLangfuseBaseUrl("https://cloud.langfuse.com/path?token=abc"), null);
    const cfg = readLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASEURL: "https://user:pw@evil.example",
    });
    assert.equal(cfg.enabled, false);
    assert.match(cfg.baseUrlError ?? "", /LANGFUSE_BASEURL/);
  });
});

describe("Langfuse metadata", () => {
  it("drops secret keys and redacts credential-shaped text", () => {
    const meta = sanitizeLangfuseMeta({
      agent_id: "claude-code-box",
      kind: "status",
      api_key: "should-drop",
      authorization: "Bearer abcdefghijklmnop",
      password: "hunter2",
      title: "using sk-abcdefghijklmnopqrstuvwxyz now",
      project: "repo sk-abcdefghijklmnopqrstuvwxyz",
      content: "full prompt",
      nested: { token: "nope" },
    });
    assert.equal(meta.agent_id, "claude-code-box");
    assert.equal(meta.kind, "status");
    assert.equal(String(meta.project).includes("sk-"), false);
    assert.match(String(meta.project), /\[redacted\]/);
    assert.equal("api_key" in meta, false);
    assert.equal("authorization" in meta, false);
    assert.equal("password" in meta, false);
    assert.equal("content" in meta, false);
    assert.equal("nested" in meta, false);
    assert.equal("title" in meta, false);
  });

  it("keeps MCP ids and sizes and leaves bodies out", () => {
    const meta = sanitizeLangfuseMeta(
      mcpToolMeta({
        agent_id: "hermes-box",
        platform: "hermes",
        content: "the note the operator must not see in Langfuse",
        body: "reply text",
        description: "worker prompt",
        title: "Ship the queue",
        query: "where is the bug",
        key: "project-x/status",
        tags: ["a", "b"],
        api_key: "sk-lf-should-not-pass",
      }),
    );
    assert.equal(meta.agent_id, "hermes-box");
    assert.equal(meta.platform, "hermes");
    assert.equal(meta.content_chars, "the note the operator must not see in Langfuse".length);
    assert.equal(meta.body_chars, "reply text".length);
    assert.equal(meta.description_chars, "worker prompt".length);
    assert.equal(meta.title_chars, "Ship the queue".length);
    assert.equal(meta.has_query, true);
    assert.equal(meta.has_key, true);
    assert.equal(meta.tag_count, 2);
    assert.equal("content" in meta, false);
    assert.equal("body" in meta, false);
    assert.equal("description" in meta, false);
    assert.equal("api_key" in meta, false);
    assert.equal("query" in meta, false);
    assert.equal("key" in meta, false);
  });

  it("ingest metadata keeps the event shape and the title length", () => {
    const meta = ingestEventMeta({
      agent_id: "codex-box",
      kind: "session_start",
      platform: "codex",
      title: "hello",
    });
    assert.equal(meta.agent_id, "codex-box");
    assert.equal(meta.kind, "session_start");
    assert.equal(meta.title_chars, 5);
    assert.equal("title" in meta, false);
  });
});

describe("Langfuse status", () => {
  it("labels the three states", () => {
    assert.equal(langfuseStatusLabel("connected"), "Connected");
    assert.equal(langfuseStatusLabel("not_configured"), "Not configured");
    assert.equal(langfuseStatusLabel("unreachable"), "Not connected");
  });

  it("reports not configured and does not call the network", async () => {
    let called = false;
    const status = await getLangfuseStatus({ LANGFUSE_PUBLIC_KEY: "pk-only" }, async () => {
      called = true;
      return new Response("nope");
    });
    assert.equal(called, false);
    assert.equal(status.state, "not_configured");
    assert.equal(status.configured, false);
    assert.equal(status.projectUrl, null);
    assert.match(status.message ?? "", /both/i);
  });

  it("reports connected and links to the project without exposing the secret", async () => {
    let authorization = "";
    const status = await getLangfuseStatus(
      {
        LANGFUSE_PUBLIC_KEY: "pk-lf-public",
        LANGFUSE_SECRET_KEY: "sk-lf-secret",
        LANGFUSE_HOST: "https://us.cloud.langfuse.com",
      },
      async (input, init) => {
        assert.equal(String(input), "https://us.cloud.langfuse.com/api/public/projects");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ data: [{ id: "proj_abc", name: "Fleet" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    assert.equal(status.state, "connected");
    assert.equal(status.configured, true);
    assert.equal(status.projectName, "Fleet");
    assert.equal(status.projectUrl, "https://us.cloud.langfuse.com/project/proj_abc");
    assert.equal(authorization.startsWith("Basic "), true);
    assert.equal(authorization.includes("sk-lf-secret"), false);
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    assert.equal(decoded, "pk-lf-public:sk-lf-secret");
    assert.equal(JSON.stringify(status).includes("sk-lf-secret"), false);
  });

  it("ignores a project id that is not a safe path segment", async () => {
    const status = await getLangfuseStatus(
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASEURL: "https://langfuse.example" },
      async () => new Response(JSON.stringify({ data: [{ id: "../evil", name: "Nope" }] }), { status: 200 }),
    );
    assert.equal(status.state, "connected");
    assert.equal(status.projectUrl, "https://langfuse.example");
  });

  it("reports not connected when Langfuse rejects the keys", async () => {
    const status = await getLangfuseStatus({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }, async () => new Response("no", { status: 401 }));
    assert.equal(status.state, "unreachable");
    assert.equal(status.configured, true);
    assert.equal(status.projectUrl, LANGFUSE_DEFAULT_BASE_URL);
    assert.match(status.message ?? "", /401/);
    assert.equal(langfuseStatusLabel(status.state), "Not connected");
  });

  it("reports not connected when the host cannot be reached", async () => {
    const status = await getLangfuseStatus({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    assert.equal(status.state, "unreachable");
    assert.match(status.message ?? "", /Could not reach/);
    assert.equal((status.message ?? "").includes("ECONNREFUSED"), false);
  });
});

describe("traceAgentEvent", () => {
  it("runs the work and records nothing when Langfuse is off", async () => {
    clearEnv();
    let recorded = false;
    setLangfuseEmitterForTests(() => {
      recorded = true;
    });
    const value = await traceAgentEvent("ingest.event", { api_key: "secret", agent_id: "a" }, async () => 7);
    assert.equal(value, 7);
    assert.equal(recorded, false);
  });

  it("records a scrubbed span and still returns the result", async () => {
    clearEnv();
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    const seen: LangfuseTraceRecord[] = [];
    setLangfuseEmitterForTests(async (event) => {
      seen.push(event);
    });
    const res = await traceAgentEvent(
      "task.create",
      { platform: "codex", description: "full worker prompt", token: "abc", title_chars: 4 },
      async () => NextResponse.json({ ok: true }),
    );
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, "task.create");
    assert.equal(seen[0].level, "DEFAULT");
    assert.equal(seen[0].metadata.platform, "codex");
    assert.equal(seen[0].metadata.title_chars, 4);
    assert.equal(seen[0].metadata.http_status, 200);
    assert.equal("description" in seen[0].metadata, false);
    assert.equal("token" in seen[0].metadata, false);
    assert.equal(JSON.stringify(seen[0]).includes("sk-lf-test"), false);
  });

  it("marks server errors and redacts secrets inside thrown messages", async () => {
    clearEnv();
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    const seen: LangfuseTraceRecord[] = [];
    setLangfuseEmitterForTests((event) => {
      seen.push(event);
    });
    const failed = await traceAgentEvent("ingest.usage", { fact_count: 2 }, async () => NextResponse.json({ error: "x" }, { status: 500 }));
    assert.equal(failed.status, 500);
    assert.equal(seen[0].level, "ERROR");
    assert.equal(seen[0].metadata.http_status, 500);

    await assert.rejects(
      () => traceAgentEvent("task.claim", { agent_id: "dispatcher" }, async () => {
        throw new Error("db down sk-abcdefghijklmnopqrstuvwxyz");
      }),
      /db down/,
    );
    assert.equal(seen[1].level, "ERROR");
    assert.equal(String(seen[1].metadata.error).includes("sk-"), false);
    assert.match(String(seen[1].metadata.error), /\[redacted\]/);
  });
});

describe("Langfuse wiring", () => {
  it("registers tracing only after the keys are present", () => {
    const src = fs.readFileSync("src/instrumentation.ts", "utf8");
    assert.match(src, /NEXT_RUNTIME/);
    assert.match(src, /isLangfuseEnabled/);
    assert.doesNotMatch(src, /@langfuse\/otel/);
    assert.match(fs.readFileSync("next.config.ts", "utf8"), /@langfuse\/otel/);
  });

  it("traces task queue actions, MCP tools, and ingest endpoints", () => {
    const expectSpan = (file: string, span: string) => {
      const src = fs.readFileSync(file, "utf8");
      assert.ok(src.includes(`"${span}"`), `${file} missing ${span}`);
    };
    expectSpan("src/app/api/tasks/route.ts", "task.create");
    expectSpan("src/app/api/tasks/claim/route.ts", "task.claim");
    expectSpan("src/app/api/tasks/[id]/route.ts", "task.update");
    expectSpan("src/app/api/ingest/route.ts", "ingest.event");
    expectSpan("src/app/api/usage/ingest/route.ts", "ingest.usage");
    expectSpan("src/app/api/progress/ingest/route.ts", "ingest.progress");
    expectSpan("src/app/api/v1/traces/route.ts", "ingest.traces");
    const mcp = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    assert.match(mcp, /mcp\.\$\{name\}/);
    assert.match(mcp, /mcpToolMeta/);
    for (const name of ["report_status", "claim_task", "create_task", "update_task"]) {
      assert.ok(mcp.includes(`"${name}"`), `missing tool ${name}`);
    }
  });

  it("shows Langfuse on the settings page and documents the variables", () => {
    const page = fs.readFileSync("src/app/settings/page.tsx", "utf8");
    const card = fs.readFileSync("src/components/LangfuseSettings.tsx", "utf8");
    assert.match(page, /Integrations/);
    assert.match(page, /LangfuseSettings/);
    assert.match(page, /force-dynamic/);
    assert.match(card, /Connected|langfuseStatusLabel/);
    assert.match(card, /LANGFUSE_PUBLIC_KEY/);
    assert.match(card, /LANGFUSE_BASEURL/);
    assert.match(card, /Open Langfuse project/);
    const env = fs.readFileSync(".env.example", "utf8");
    assert.match(env, /LANGFUSE_PUBLIC_KEY/);
    assert.match(env, /LANGFUSE_SECRET_KEY/);
    assert.match(env, /LANGFUSE_BASEURL/);
    assert.match(env, /LANGFUSE_HOST/);
    const readme = fs.readFileSync("README.md", "utf8");
    assert.match(readme, /## Langfuse/);
    assert.match(readme, /ingest\.event/);
    assert.match(fs.readFileSync("docs/DEPLOY.md", "utf8"), /LANGFUSE_SECRET_KEY/);
  });
});
