import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCredential, plantCredentialForTests, resetCredentialsForTests, revokeCredential } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { demoStoreSize, resetDemoStoreForTests } from "../../src/lib/demo-store";
import { enrichMcpResponse } from "../../src/lib/mcp-protocol";

/**
 * Issue #52 Q6, MCP response boundary. Drives the exported /api/mcp route
 * and the app-owned adapter. Synthetic fixtures only.
 */

const env = process.env as Record<string, string | undefined>;
const KEYS = ["MC_TOKEN", "DATABASE_URL", "NODE_ENV", "MC_DASHBOARD_PASSWORD", "MC_OAUTH_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));
const SECRET = "password=synthetic-probe-secret";

after(() => {
  const code = process.exitCode ?? 0;
  setImmediate(() => process.exit(code));
});

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  delete env.MC_OAUTH_SECRET;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
  resetDemoStoreForTests();
  setSqlForTests(null);
});

afterEach(() => {
  resetCredentialsForTests();
  resetDemoStoreForTests();
  setSqlForTests(null);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function post(token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import("../../src/app/api/[transport]/route");
  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  if (token !== null) requestHeaders.authorization = `Bearer ${token}`;
  return POST(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "protocol-test", version: "0" } },
};

function toolCall(id: number, name: string, args: unknown) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function rpc(res: Response): Promise<any> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text) return null;
  if (type.includes("application/json")) return JSON.parse(text);
  const frames = text.split(/\n\n|\r\n\r\n/).filter((frame) => frame.trim().length > 0);
  const messages = frames.flatMap((frame) => frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim())));
  if (messages.length === 1) return messages[0];
  return messages;
}

function challenge(res: Response): string {
  return res.headers.get("www-authenticate") ?? "";
}

describe("MCP auth teaching and initial store outage", { concurrency: false }, () => {
  it("adds teaching fields to a missing bearer and keeps the SDK challenge", async () => {
    const res = await post(null, initBody);
    assert.equal(res.status, 401);
    assert.match(challenge(res), /error="invalid_token"/);
    assert.match(challenge(res), /error_description="No authorization provided"/);
    assert.match(challenge(res), /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource"/);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "invalid_token");
    assert.equal(body.error_description, "No authorization provided");
    assert.equal(body.code, "unauthorized");
    assert.equal(body.cause, "No authorization provided");
    assert.equal(body.fix, "Send Authorization: Bearer with a current agent credential, legacy token, or OAuth access token.");
    assert.equal(body.retryable, false);
    assert.equal(body.jsonrpc, undefined);
  });

  it("keeps unknown, revoked, and expired credentials on the SDK 401", async () => {
    const revoked = await createCredential({ label: "revoked", scopes: ["fleet:read"] });
    assert.equal(revoked.ok, true);
    if (!revoked.ok) return;
    await revokeCredential(revoked.credential.id);
    const expiredToken = "akc_expired-token-value";
    plantCredentialForTests({
      token: expiredToken,
      scopes: ["fleet:read"],
      expires_at: "2000-01-01T00:00:00.000Z",
    });

    for (const token of [revoked.token, expiredToken, "akc_not-a-real-credential"]) {
      const res = await post(token, initBody);
      assert.equal(res.status, 401, token);
      assert.match(challenge(res), /error="invalid_token"/);
      assert.match(challenge(res), /error_description="No authorization provided"/);
      assert.match(challenge(res), /resource_metadata=/);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.error, "invalid_token");
      assert.equal(body.error_description, "No authorization provided");
      assert.equal(body.code, "unauthorized");
      assert.equal(body.cause, "No authorization provided");
      assert.equal(body.retryable, false);
      assert.equal(typeof body.fix, "string");
    }
  });

  it("classifies an initial credential-store outage as 503 with one lookup and no challenge", async () => {
    env.DATABASE_URL = "postgresql://protocol-test.invalid/none";
    let calls = 0;
    setSqlForTests(async () => {
      calls += 1;
      throw new Error(SECRET);
    });
    const res = await post("akc_store-outage-token", { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("www-authenticate"), null);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.error, "credential_store_unavailable");
    assert.equal(body.code, "credential_store_unavailable");
    assert.equal(body.retryable, true);
    assert.match(String(body.fix), /Retry the request/);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "fix", "retryable"]);
    assert.equal(calls, 1);
  });

  it("does not let an overlapping outage cross into a valid request or add a second lookup", async () => {
    env.MC_TOKEN = "test-mc-token";
    env.DATABASE_URL = "postgresql://protocol-test.invalid/none";
    const invalid = "akc_invalid-token-value";
    const outage = "akc_outage-token-value";
    const invalidHash = sha256(invalid);
    const outageHash = sha256(outage);
    let calls = 0;
    setSqlForTests(async (_strings, ...values) => {
      calls += 1;
      const hash = String(values[0] ?? "");
      if (hash === outageHash) throw new Error(SECRET);
      if (hash === invalidHash) return [];
      throw new Error(`unexpected lookup ${hash}`);
    });

    const [valid, unavailable, rejected] = await Promise.all([
      post("test-mc-token", initBody),
      post(outage, initBody),
      post(invalid, initBody),
    ]);

    assert.equal(valid.status, 200);
    const validBody = await rpc(valid);
    assert.equal(validBody.result.protocolVersion !== undefined, true);
    assert.equal(JSON.stringify(validBody).includes("credential_store_unavailable"), false);
    assert.equal(JSON.stringify(validBody).includes(outage), false);
    assert.equal(JSON.stringify(validBody).includes(invalid), false);

    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("www-authenticate"), null);
    const outageBody = await unavailable.json() as Record<string, unknown>;
    assert.equal(outageBody.code, "credential_store_unavailable");
    assert.equal(JSON.stringify(outageBody).includes(SECRET), false);
    assert.equal(JSON.stringify(outageBody).includes("test-mc-token"), false);
    assert.equal(JSON.stringify(outageBody).includes(invalid), false);

    assert.equal(rejected.status, 401);
    assert.match(challenge(rejected), /error_description="No authorization provided"/);
    const rejectedBody = await rejected.json() as Record<string, unknown>;
    assert.equal(rejectedBody.code, "unauthorized");
    assert.equal(rejectedBody.error, "invalid_token");
    assert.notEqual(rejectedBody.code, "credential_store_unavailable");

    assert.equal(calls, 2);
  });
});

describe("MCP SDK errors, quota, and success", { concurrency: false }, () => {
  it("lets a narrow credential read the fleet and refuses remember without running it", async () => {
    const created = await createCredential({ label: "narrow", scopes: ["fleet:read"] });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const ok = await post(created.token, toolCall(2, "get_fleet_status", {}));
    assert.equal(ok.status, 200);
    const okBody = await rpc(ok);
    assert.equal(okBody.result.isError, undefined);
    assert.equal(okBody.result.structuredContent, undefined);
    assert.equal(typeof okBody.result.content[0].text, "string");

    const denied = await post(created.token, toolCall(3, "remember", { content: "should not write" }));
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json() as Record<string, unknown>;
    assert.equal(deniedBody.code, "insufficient_scope");
    assert.equal(deniedBody.retryable, false);
    assert.equal(typeof deniedBody.fix, "string");
    assert.equal("cause" in deniedBody, false);
    assert.deepEqual(Object.keys(deniedBody).sort(), ["code", "error", "fix", "retryable"]);
    assert.equal(demoStoreSize().notes, 0);
  });

  it("returns 429 after exactly one charge per request and leaves the rate body unchanged", async () => {
    const created = await createCredential({
      label: "quota",
      scopes: ["fleet:read"],
      rate_limit_per_minute: 2,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const note = { jsonrpc: "2.0", method: "notifications/initialized" };
    assert.equal((await post(created.token, note)).status, 202);
    assert.equal((await post(created.token, note)).status, 202);
    const limited = await post(created.token, note);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after") !== null, true);
    const body = await limited.json() as Record<string, unknown>;
    assert.equal(body.code, "rate_limited");
    assert.equal(body.retryable, true);
    assert.equal(typeof body.retry_after, "number");
    assert.equal("cause" in body, false);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "fix", "limit", "retry_after", "retryable", "window"]);
  });

  it("keeps a quota-store 503 on the catalogue keys", async () => {
    const created = await createCredential({ label: "quota-outage", scopes: ["fleet:read"] });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const hash = sha256(created.token);
    env.DATABASE_URL = "postgresql://protocol-test.invalid/none";
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join("?");
      if (/where token_hash =/.test(text) && values[0] === hash) {
        return [{
          id: created.credential.id,
          label: "quota-outage",
          token_prefix: created.token.slice(0, 8),
          token_hash: hash,
          scopes: ["fleet:read"],
          created_at: new Date().toISOString(),
          expires_at: null,
          revoked_at: null,
          last_used_at: null,
          rate_limit_per_minute: 60,
          rate_limit_per_day: 10000,
        }];
      }
      if (/for update/.test(text)) throw new Error(SECRET);
      return [];
    });
    const res = await post(created.token, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("www-authenticate"), null);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "fix", "retryable"]);
  });

  it("rejects invalid remember arguments before the tool writes and adds tool teaching", async () => {
    env.MC_TOKEN = "test-mc-token";
    const res = await post("test-mc-token", toolCall(4, "remember", { content: 42 }));
    assert.equal(res.status, 200);
    const body = await rpc(res);
    assert.equal(body.id, 4);
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /-32602/);
    assert.equal(body.result.structuredContent.code, "mcp_tool_error");
    assert.equal(body.result.structuredContent.retryable, false);
    assert.equal(typeof body.result.structuredContent.cause, "string");
    assert.match(body.result.structuredContent.cause, /-32602/);
    assert.equal(body.result.structuredContent.code === "mcp_invalid_params", false);
    assert.equal(demoStoreSize().notes, 0);
  });

  it("passes an application error envelope through without structuredContent", async () => {
    env.MC_TOKEN = "test-mc-token";
    const res = await post("test-mc-token", toolCall(5, "remember", { content: "note", key: "" }));
    assert.equal(res.status, 200);
    const body = await rpc(res);
    assert.equal(body.result.isError, true);
    const envelope = JSON.parse(body.result.content[0].text);
    assert.equal(envelope.code, "memory_key_invalid");
    assert.equal(typeof envelope.fix, "string");
    assert.equal(typeof envelope.retryable, "boolean");
    assert.equal(body.result.structuredContent, undefined);
    assert.equal(demoStoreSize().notes, 0);
  });

  it("teaches an unknown tool and an unknown method without dropping protocol fields", async () => {
    env.MC_TOKEN = "test-mc-token";
    // Unmapped tool names are denied for every principal before the SDK runs.
    const unknownTool = await post("test-mc-token", toolCall(6, "not_a_real_tool", {}));
    assert.equal(unknownTool.status, 403);
    const toolBody = await unknownTool.json() as Record<string, unknown>;
    assert.equal(toolBody.code, "insufficient_scope");
    assert.equal(toolBody.retryable, false);
    assert.equal(typeof toolBody.fix, "string");
    assert.equal("cause" in toolBody, false);
    assert.deepEqual(Object.keys(toolBody).sort(), ["code", "error", "fix", "retryable"]);
    assert.equal(demoStoreSize().notes, 0);

    const unknownMethod = await post("test-mc-token", { jsonrpc: "2.0", id: 7, method: "nope" });
    assert.equal(unknownMethod.status, 200);
    const methodBody = await rpc(unknownMethod);
    assert.equal(methodBody.id, 7);
    assert.equal(methodBody.error.code, -32601);
    assert.equal(typeof methodBody.error.message, "string");
    assert.equal(methodBody.error.data.code, "mcp_method_not_found");
    assert.equal(methodBody.error.data.cause, methodBody.error.message);
    assert.equal(methodBody.error.data.retryable, false);
    assert.equal(typeof methodBody.error.data.fix, "string");
  });

  it("teaches a native JSON-RPC parse error under error.data", async () => {
    env.MC_TOKEN = "test-mc-token";
    const malformed = await post("test-mc-token", "{");
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json() as Record<string, unknown>;
    assert.equal(malformedBody.code, "invalid_json");
    assert.equal("cause" in malformedBody, false);
    assert.deepEqual(Object.keys(malformedBody).sort(), ["code", "error", "fix", "retryable"]);

    const res = await post("test-mc-token", { id: 11, method: "initialize" });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json() as any;
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32700);
    assert.equal(body.error.data.code, "mcp_parse_error");
    assert.equal(body.error.data.cause, body.error.message);
    assert.equal(body.error.data.retryable, false);
    assert.equal(typeof body.error.data.fix, "string");
  });

  it("accepts a notification, a mixed batch, and a successful initialize", async () => {
    env.MC_TOKEN = "test-mc-token";
    const note = await post("test-mc-token", { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), "");

    const batch = await post("test-mc-token", [
      toolCall(8, "get_fleet_status", {}),
      { jsonrpc: "2.0", id: 9, method: "nope" },
    ]);
    assert.equal(batch.status, 200);
    const batchText = await batch.text();
    const messages = [...batchText.matchAll(/data: (\{.*\})/g)].map((match) => JSON.parse(match[1]));
    const success = messages.find((message) => message.id === 8);
    const failure = messages.find((message) => message.id === 9);
    assert.equal(success.result.isError, undefined);
    assert.equal(success.result.structuredContent, undefined);
    assert.equal(failure.error.code, -32601);
    assert.equal(failure.error.data.code, "mcp_method_not_found");

    const init = await post("test-mc-token", initBody);
    assert.equal(init.status, 200);
    const initBodyParsed = await rpc(init);
    assert.equal(initBodyParsed.id, 1);
    assert.equal(typeof initBodyParsed.result.protocolVersion, "string");
    assert.equal(initBodyParsed.error, undefined);
    assert.equal(initBodyParsed.result.structuredContent, undefined);
  });
});

describe("MCP response adapter stream behavior", { concurrency: false }, () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function sseResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index]);
        index += 1;
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    });
  }

  let cancelled = false;

  it("reassembles UTF-8 and frame delimiters split across chunks", async () => {
    const frame = encoder.encode("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":\"caf\u00e9\"}}\n\n");
    const splitAt = frame.indexOf(0xc3); // first byte of é
    assert.equal(splitAt > 0, true);
    const res = await enrichMcpResponse(sseResponse([
      frame.subarray(0, splitAt),
      frame.subarray(splitAt, frame.length - 1),
      frame.subarray(frame.length - 1),
    ]));
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(bytes, frame);
  });

  it("preserves comments, event, id, and retry while teaching an error frame", async () => {
    const cause = "MCP error -32602: bad \u00e9";
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: cause }], isError: true },
    });
    const frame = `: keep \u00e9\nid: 7\nretry: 1500\nevent: message\ndata: ${payload}\n\n`;
    const res = await enrichMcpResponse(sseResponse([encoder.encode(frame)]));
    const text = decoder.decode(await res.arrayBuffer());
    assert.match(text, /^: keep \u00e9\nid: 7\nretry: 1500\nevent: message\ndata: /);
    const data = JSON.parse(text.split("data: ")[1]);
    assert.equal(data.id, 3);
    assert.equal(data.result.isError, true);
    assert.equal(data.result.content[0].text, cause);
    assert.equal(data.result.structuredContent.code, "mcp_tool_error");
    assert.equal(data.result.structuredContent.cause, cause);
    assert.equal(data.result.structuredContent.retryable, false);
  });

  it("leaves a non-message event and a primitive error.data untouched", async () => {
    const comment = "event: ping\ndata: {\"error\":true}\n\n";
    const primitive = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "bad", data: "leave-me" },
    })}\n\n`;
    const input = encoder.encode(comment + primitive);
    const res = await enrichMcpResponse(sseResponse([input.subarray(0, 5), input.subarray(5)]));
    const text = decoder.decode(await res.arrayBuffer());
    assert.equal(text.startsWith(comment), true);
    const data = JSON.parse(text.slice(comment.length).split("data: ")[1]);
    assert.equal(data.error.code, -32602);
    assert.equal(data.error.data, "leave-me");
    assert.equal(data.error.data.code, undefined);
  });

  it("adds teaching beside a plain error.data object and keeps its keys", async () => {
    const raw = {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32000, message: "nope", data: { existing: 1 } },
    };
    const res = await enrichMcpResponse(new Response(JSON.stringify(raw), {
      status: 400,
      headers: { "content-type": "application/json", "content-length": "8", "x-kept": "yes" },
    }));
    assert.equal(res.headers.get("content-length"), null);
    assert.equal(res.headers.get("x-kept"), "yes");
    const body = await res.json() as any;
    assert.equal(body.error.code, -32000);
    assert.equal(body.error.message, "nope");
    assert.equal(body.error.data.existing, 1);
    assert.equal(body.error.data.code, "mcp_server_error");
    assert.equal(body.error.data.cause, "nope");
    assert.equal(body.error.data.retryable, false);
    assert.equal(body.id, 4);
  });

  it("keeps content-length when the SSE body does not change", async () => {
    const frame = encoder.encode("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n");
    const res = await enrichMcpResponse(sseResponse([frame], { "content-length": String(frame.length), "x-kept": "yes" }));
    assert.equal(res.headers.get("content-length"), String(frame.length));
    assert.equal(res.headers.get("x-kept"), "yes");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), frame);
  });

  it("strips stale length headers only when the first chunk mutates", async () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
    const frame = `event: message\ndata: ${payload}\n\n`;
    const res = await enrichMcpResponse(sseResponse([encoder.encode(frame)], {
      "content-length": "5",
      "content-md5": "stale",
      digest: "stale",
    }));
    assert.equal(res.headers.get("content-length"), null);
    assert.equal(res.headers.get("content-md5"), null);
    assert.equal(res.headers.get("digest"), null);
    const data = JSON.parse(decoder.decode(await res.arrayBuffer()).split("data: ")[1]);
    assert.equal(data.error.code, -32601);
    assert.equal(data.error.data.code, "mcp_method_not_found");
  });

  it("cancels the upstream stream", async () => {
    cancelled = false;
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(encoder.encode(": wait\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await enrichMcpResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const reader = res.body!.getReader();
    const pending = reader.read();
    await reader.cancel("stop");
    await pending.catch(() => undefined);
    assert.equal(cancelled, true);
    assert.equal(pullCount < 5, true);
  });

  it("applies backpressure instead of draining the source", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode(`: ping ${pulls}\n\n`));
      },
    }, { highWaterMark: 0 });
    const res = await enrichMcpResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const reader = res.body!.getReader();
    await reader.read();
    assert.equal(pulls <= 2, true);
    await reader.read();
    assert.equal(pulls <= 3, true);
    await reader.cancel();
  });

  it("emits an oversized incomplete frame before the delimiter arrives", async () => {
    const big = new Uint8Array(1024 * 1024 + 32).fill(0x61);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(big);
        await gate;
        controller.enqueue(encoder.encode("\n\n"));
        controller.close();
      },
    });
    const res = await enrichMcpResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal((first.value?.byteLength ?? 0) > 1024 * 1024, true);
    release?.();
    await reader.cancel();
  });

  it("uses the SDK description for Invalid token and Token has expired", async () => {
    for (const [description, fix] of [
      ["Invalid token", "Send a current bearer token. This token is unknown or was rejected."],
      ["Token has expired", "Send a current bearer token. This token is expired."],
    ] as const) {
      const res = await enrichMcpResponse(new Response(JSON.stringify({
        error: "invalid_token",
        error_description: description,
      }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}"`,
        },
      }));
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate") ?? "", new RegExp(description));
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.error, "invalid_token");
      assert.equal(body.error_description, description);
      assert.equal(body.code, "unauthorized");
      assert.equal(body.cause, description);
      assert.equal(body.fix, fix);
      assert.equal(body.retryable, false);
    }
  });

  it("does not add cause to a body that already has code, fix, and retryable", async () => {
    const original = { error: "credential_store_unavailable", code: "credential_store_unavailable", fix: "Retry the request.", retryable: true };
    const res = await enrichMcpResponse(new Response(JSON.stringify(original), {
      status: 503,
      headers: { "content-type": "application/json", "x-kept": "yes" },
    }));
    assert.equal(res.headers.get("x-kept"), "yes");
    const body = await res.json() as Record<string, unknown>;
    assert.deepEqual(body, original);
  });
});
