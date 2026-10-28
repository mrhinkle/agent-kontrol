/**
 * Live MCP client checks against a demo-mode server started by
 * scripts/run-mcp-client-tests.ts. Prior art: tests/ui/mcp-tools.test.ts
 * (tool-name inventory) and tests/ui/auth.test.ts (401 must not mean allowed).
 *
 * Demo mode has no DATABASE_URL. The five write tools store in memory for
 * this process. get_fleet_status, recall, and get_task_queue read that
 * store back. Successful text is labeled demo. The store clears when the
 * process exits. These tests round-trip that lifecycle.
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

/** The 17 tools in docs/MCP.md. Names are stable for the 1.x line. */
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
  "request_decision",
  "list_decisions",
  "resolve_decision",
] as const;

/**
 * The server still registers this deprecated alias (docs/MCP.md). The live
 * list is the 17 documented names plus this one alias, and nothing else.
 */
const DEPRECATED_ALIAS = "reply_to_mark";

/** Same banner src/lib/demo-store.ts prefixes on a successful demo write. */
const DEMO_BANNER = "[demo — in-memory, cleared when this process restarts]";

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
const noteA = `${probe}-note-a`;
const noteB = `${probe}-note-b`;

function assertDemo(text: string, tool: string): void {
  assert.equal(text.startsWith(`${DEMO_BANNER}\n`), true, `${tool} was not labeled demo: ${text.slice(0, 160)}`);
  assert.equal(text.includes("not stored"), false, tool);
}

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

  it("lists exactly the 17 documented tools plus the reply_to_mark alias", async () => {
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
    assert.equal(names.length, 18);
  });

  it("report_status then get_fleet_status shows the reported agent, labeled demo", async () => {
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
    assertDemo(reported, "report_status");
    assertDemo(fleet, "get_fleet_status");
    assert.match(reported, /Status reported to Agent Kontrol/);
    assert.match(fleet, new RegExp(agentId));
    assert.match(fleet, /ACTIVE/);
    assert.equal(fleet.includes("cowork-cloud-1"), false);
  });

  it("create_task then claim_task then update_task completes in the demo store", async () => {
    const created = toolText(
      await client.callTool({
        name: "create_task",
        arguments: { title: taskTitle, platform: "hermes", created_by: agentId },
      }),
      "create_task"
    );
    assertDemo(created, "create_task");
    const id = Number(created.match(/Task #(\d+)/)?.[1]);
    assert.ok(id > 0, created);
    assert.match(created, new RegExp(`Task #${id} queued for hermes \\(priority 2\\)\\.`));

    const claimed = toolText(
      await client.callTool({
        name: "claim_task",
        arguments: { platform: "hermes", agent_id: agentId },
      }),
      "claim_task"
    );
    assertDemo(claimed, "claim_task");
    assert.match(claimed, new RegExp(`Claimed task #${id}: ${taskTitle}`));

    const updated = toolText(
      await client.callTool({
        name: "update_task",
        arguments: { id, status: "done", result: `${probe} result`, agent_id: agentId },
      }),
      "update_task"
    );
    assertDemo(updated, "update_task");
    assert.match(updated, new RegExp(`Task #${id} updated \\(done\\)\\.`));

    const queue = toolText(
      await client.callTool({ name: "get_task_queue", arguments: { status: "done" } }),
      "get_task_queue"
    );
    assertDemo(queue, "get_task_queue");
    assert.match(queue, new RegExp(`#${id} \\[DONE\\] \\(hermes, p2\\) ${taskTitle}`));

    const again = toolText(
      await client.callTool({
        name: "claim_task",
        arguments: { platform: "hermes", agent_id: agentId },
      }),
      "claim_task"
    );
    assertDemo(again, "claim_task empty");
    assert.match(again, /No queued tasks for your platform\./);
    assert.equal(again.includes(taskTitle), false);
    assert.equal(again.includes("task_not_claimable"), false);
  });

  it("remember then recall round-trips a key, and a second write upserts it", async () => {
    const key = `${probe}-key`;
    const stored = toolText(
      await client.callTool({
        name: "remember",
        arguments: { content: noteA, key, agent_id: agentId },
      }),
      "remember"
    );
    const replaced = toolText(
      await client.callTool({
        name: "remember",
        arguments: { content: noteB, key, agent_id: `${agentId}-other` },
      }),
      "remember"
    );
    assertDemo(stored, "remember");
    assertDemo(replaced, "remember");
    const firstId = stored.match(/Stored memory #(\d+)/)?.[1];
    const secondId = replaced.match(/Stored memory #(\d+)/)?.[1];
    assert.ok(firstId, stored);
    assert.equal(secondId, firstId);
    const recalled = toolText(
      await client.callTool({
        name: "recall",
        arguments: { key },
      }),
      "recall"
    );
    assertDemo(recalled, "recall");
    assert.match(recalled, new RegExp(noteB));
    assert.equal(recalled.includes(noteA), false);

    const onlyA = `${probe}-only-a`;
    const onlyB = `${probe}-only-b`;
    toolText(
      await client.callTool({
        name: "remember",
        arguments: { content: onlyA, key: `${probe}-key-a`, agent_id: agentId },
      }),
      "remember a"
    );
    toolText(
      await client.callTool({
        name: "remember",
        arguments: { content: onlyB, key: `${probe}-key-b`, agent_id: `${agentId}-other` },
      }),
      "remember b"
    );
    const both = toolText(
      await client.callTool({ name: "recall", arguments: { query: probe } }),
      "recall both"
    );
    assert.match(both, new RegExp(onlyA));
    assert.match(both, new RegExp(onlyB));
  });

  it("dry_run remember writes nothing, and a repeated create_task key replays", async () => {
    const ghost = `${probe}-ghost`;
    const preview = toolText(
      await client.callTool({
        name: "remember",
        arguments: { content: ghost, key: `${probe}-ghost-key`, dry_run: true },
      }),
      "remember dry_run"
    );
    const previewBody = JSON.parse(preview) as { dry_run: boolean; applied: boolean; would_write: boolean };
    assert.equal(previewBody.dry_run, true);
    assert.equal(previewBody.applied, false);
    assert.equal(previewBody.would_write, true);
    const recalled = toolText(
      await client.callTool({ name: "recall", arguments: { key: `${probe}-ghost-key` } }),
      "recall ghost"
    );
    assert.equal(recalled.includes(ghost), false);

    const idemKey = `${probe}-idem`;
    const title = `${probe}-idem-title`;
    const first = toolText(
      await client.callTool({
        name: "create_task",
        arguments: { title, platform: "grok", idempotency_key: idemKey },
      }),
      "create_task idempotent"
    );
    const second = toolText(
      await client.callTool({
        name: "create_task",
        arguments: { title, platform: "grok", idempotency_key: idemKey },
      }),
      "create_task replay"
    );
    assert.equal(second, first);
    const conflict = await client.callTool({
      name: "create_task",
      arguments: { title: `${title}-other`, platform: "grok", idempotency_key: idemKey },
    });
    assert.equal((conflict as { isError?: boolean }).isError, true);
    const conflictText = (conflict as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
    const conflictBody = JSON.parse(conflictText) as { code: string; error: string };
    assert.equal(conflictBody.code, "idempotency_conflict");
    assert.equal(conflictBody.error, "This idempotency key was already used with different arguments.");
  });

  it("update_task on a missing id is task_not_found, and the progress digest stays sample data", async () => {
    const missing = await client.callTool({
      name: "update_task",
      arguments: { id: 999999, status: "done" },
    });
    assert.equal((missing as { isError?: boolean }).isError, true);
    const missingText = (missing as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
    const missingBody = JSON.parse(missingText) as { code: string; error: string };
    assert.equal(missingBody.code, "task_not_found");
    assert.equal(missingBody.error, "Task not found");
    assert.equal(missingText.includes(DEMO_BANNER), false);

    const digest = toolText(
      await client.callTool({ name: "get_progress_digest", arguments: {} }),
      "get_progress_digest"
    );
    assert.match(digest, /\[demo mode — no database connected\]/);
    assert.match(digest, /App Server/);
    assert.equal(digest.includes(agentId), false);
    assert.equal(digest.includes(DEMO_BANNER), false);
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
