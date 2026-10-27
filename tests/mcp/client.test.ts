/**
 * Live MCP client checks against a demo-mode server started by
 * scripts/run-mcp-client-tests.ts. Prior art: tests/ui/mcp-tools.test.ts
 * (tool-name inventory) and tests/ui/auth.test.ts (401 must not mean allowed).
 *
 * Demo mode does not store writes. docs/ARCHITECTURE.md: no DATABASE_URL
 * means sample data and nothing stored. The route answers report_status,
 * get_fleet_status, create_task, claim_task, update_task, remember, and
 * recall with a fixed refusal. These tests lock that contract. They do not
 * claim a persistence round-trip.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = process.env.AK_MCP_BASE_URL;
const token = process.env.AK_MCP_TOKEN;
if (!baseUrl || !token) {
  throw new Error("AK_MCP_BASE_URL and AK_MCP_TOKEN are required; run npm run test:mcp");
}

/** The 14 tools in docs/MCP.md. Names are stable for the 1.x line. */
const DOCUMENTED_TOOLS = [
  "report_status",
  "get_fleet_status",
  "get_progress_digest",
  "remember",
  "recall",
  "check_inbox",
  "reply_to_operator",
  "create_task",
  "get_task_queue",
  "claim_task",
  "update_task",
  "list_skills",
  "get_skill",
  "run_skill",
] as const;

/**
 * The server still registers this deprecated alias (docs/MCP.md). The live
 * list is the 14 documented names plus this one alias, and nothing else.
 */
const DEPRECATED_ALIAS = "reply_to_mark";

/** Fixed demo-mode replies from src/app/api/[transport]/route.ts. */
const DEMO = {
  reportStatus: "Agent Kontrol is in demo mode (no database configured); status not stored.",
  fleetStatus: "Agent Kontrol is in demo mode (no database configured).",
  createTask: "Demo mode; task not queued.",
  claimTask: "Demo mode; no tasks.",
  updateTask: "Demo mode; task not updated.",
  remember: "Demo mode; note not stored.",
  recall: "Demo mode; no stored memory.",
} as const;

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "agent-kontrol-mcp-ci", version: "0" },
  },
});

const probe = `mcp-probe-${randomBytes(4).toString("hex")}`;
const agentId = `${probe}-agent`;
const taskTitle = `${probe}-task`;
const note = `${probe}-note`;

function toolText(result: unknown, tool: string): string {
  if (!result || typeof result !== "object") {
    throw new Error(`${tool}: result is not an object`);
  }
  const record = result as { isError?: unknown; content?: unknown };
  if (record.isError === true) {
    throw new Error(`${tool}: tool result isError is true: ${JSON.stringify(result)}`);
  }
  if (!Array.isArray(record.content) || record.content.length === 0) {
    throw new Error(`${tool}: tool result has no content: ${JSON.stringify(result)}`);
  }
  const texts: string[] = [];
  for (const part of record.content) {
    if (!part || typeof part !== "object") {
      throw new Error(`${tool}: content part is not an object`);
    }
    const item = part as { type?: unknown; text?: unknown };
    if (item.type !== "text") continue;
    if (typeof item.text !== "string" || item.text.length === 0) {
      throw new Error(`${tool}: text content is empty or not a string`);
    }
    texts.push(item.text);
  }
  if (texts.length === 0) {
    throw new Error(`${tool}: tool result has no text content: ${JSON.stringify(result)}`);
  }
  return texts.join("\n");
}

async function postInitialize(authorization?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (authorization) headers.authorization = authorization;
  return fetch(baseUrl as string, {
    method: "POST",
    redirect: "manual",
    headers,
    body: INITIALIZE_BODY,
  });
}

function assertRejected(response: Response): void {
  assert.equal(response.status, 401);
  const www = response.headers.get("www-authenticate");
  assert.ok(www, "401 response is missing WWW-Authenticate");
  assert.match(www, /resource_metadata=/);
  assert.match(www, /\/\.well-known\/oauth-protected-resource/);
}

describe("MCP client against demo mode", { concurrency: 1 }, () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  before(async () => {
    transport = new StreamableHTTPClientTransport(new URL(baseUrl as string), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    client = new Client({ name: "agent-kontrol-mcp-ci", version: "0.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
  });

  it("rejects an initialize with no Authorization header", async () => {
    const response = await postInitialize();
    try {
      assertRejected(response);
    } finally {
      await response.arrayBuffer().catch(() => undefined);
    }
  });

  it("rejects an initialize with a bearer token that is not MC_TOKEN", async () => {
    const response = await postInitialize("Bearer ak-mcp-wrong-token-not-a-secret");
    try {
      assertRejected(response);
    } finally {
      await response.arrayBuffer().catch(() => undefined);
    }
  });

  it("lists exactly the 14 documented tools plus the reply_to_mark alias", async () => {
    const listed = await client.listTools();
    const nextCursor = (listed as { nextCursor?: unknown }).nextCursor;
    assert.equal(
      nextCursor,
      undefined,
      "tools/list returned a cursor; refusing to treat one page as the full set"
    );
    const names = listed.tools.map((tool) => tool.name);
    const expected = [...DOCUMENTED_TOOLS, DEPRECATED_ALIAS];
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    assert.deepEqual(
      [...counts.keys()].sort(),
      [...expected].sort(),
      `tools/list returned [${names.join(", ")}]`
    );
    for (const name of expected) {
      assert.equal(counts.get(name), 1, `${name} should appear once`);
    }
    assert.equal(names.length, 15);
  });

  it("report_status then get_fleet_status does not show the reported agent in demo mode", async () => {
    const reported = toolText(
      await client.callTool({
        name: "report_status",
        arguments: {
          agent_id: agentId,
          platform: "grok",
          title: `${probe} status`,
          status: "active",
        },
      }),
      "report_status"
    );
    const fleet = toolText(await client.callTool({ name: "get_fleet_status", arguments: {} }), "get_fleet_status");
    assert.equal(fleet.includes(agentId), false, "get_fleet_status echoed the agent id report_status just sent");
    assert.equal(reported, DEMO.reportStatus);
    assert.equal(fleet, DEMO.fleetStatus);
  });

  it("create_task then claim_task then update_task does not complete a lifecycle in demo mode", async () => {
    const created = toolText(
      await client.callTool({
        name: "create_task",
        arguments: { title: taskTitle, platform: "grok", created_by: agentId },
      }),
      "create_task"
    );
    const claimed = toolText(
      await client.callTool({
        name: "claim_task",
        arguments: { platform: "grok", agent_id: agentId },
      }),
      "claim_task"
    );
    const updated = toolText(
      await client.callTool({
        name: "update_task",
        arguments: { id: 1, status: "done", result: `${probe} result`, agent_id: agentId },
      }),
      "update_task"
    );
    assert.equal(claimed.includes(taskTitle), false, "claim_task returned the task title create_task just sent");
    assert.equal(claimed.includes("Claimed task"), false, "claim_task reported a claim in demo mode");
    assert.equal(created, DEMO.createTask);
    assert.equal(claimed, DEMO.claimTask);
    assert.equal(updated, DEMO.updateTask);
  });

  it("remember then recall does not round-trip a note in demo mode", async () => {
    const stored = toolText(
      await client.callTool({
        name: "remember",
        arguments: { content: note, key: `${probe}-key`, agent_id: agentId },
      }),
      "remember"
    );
    const recalled = toolText(
      await client.callTool({
        name: "recall",
        arguments: { query: note, key: `${probe}-key` },
      }),
      "recall"
    );
    assert.equal(recalled.includes(note), false, "recall returned the note remember just sent");
    assert.equal(stored, DEMO.remember);
    assert.equal(recalled, DEMO.recall);
  });

  it("list_skills in demo mode hides selected skills when no lane is passed", async () => {
    const listed = toolText(await client.callTool({ name: "list_skills", arguments: {} }), "list_skills");
    assert.match(listed, /runtime filter: none \(caller did not pass runtime\)\./);
    assert.match(listed, /verify-gibson/);
    assert.equal(listed.includes("spec-writer"), false);
    assert.equal(listed.includes(probe), false);
  });

  it("get_skill in demo mode returns the fixture body and the pinned sha", async () => {
    const body = toolText(
      await client.callTool({ name: "get_skill", arguments: { id: "verify-gibson", runtime: "grok" } }),
      "get_skill",
    );
    assert.match(body, /^# verify-gibson/);
    assert.match(body, /Pinned SHA: [0-9a-f]{64}/);
    assert.match(body, /Prove the change against the lane's checks/);
  });

  it("run_skill in demo mode does not store a run or echo the note", async () => {
    const started = toolText(
      await client.callTool({
        name: "run_skill",
        arguments: {
          id: "verify-gibson",
          agent_id: agentId,
          runtime: "grok",
          note: `${probe}-skill-note`,
        },
      }),
      "run_skill",
    );
    assert.equal(started, "DATABASE_URL not set; skill run not stored.");
    assert.equal(started.includes(probe), false);
    const wrong = await client.callTool({
      name: "run_skill",
      arguments: { id: "operator-voice", agent_id: agentId, runtime: "grok" },
    });
    assert.equal((wrong as { isError?: boolean }).isError, true);
    const wrongText = (wrong as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
    assert.match(wrongText, /not compatible/);
  });

  it("accepts run_skill completion without id through the registered schema", async () => {
    const result = await client.callTool({
      name: "run_skill",
      arguments: { run_id: "00000000-0000-4000-8000-000000000001", complete: true },
    });
    const record = result as { isError?: boolean; content?: { text?: string }[] };
    const text = record.content?.[0]?.text ?? "";
    assert.equal(record.isError, true, text);
    assert.match(text, /"code":"not_found"/);
    assert.equal(text.includes("Required"), false);
    assert.equal(/invalid_type/.test(text), false);
  });
});
