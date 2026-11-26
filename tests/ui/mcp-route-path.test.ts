import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

/** mcp-handler 2.x serves any path; the [transport] route must answer MCP on /api/mcp only. */
const env = process.env as Record<string, string | undefined>;
const savedToken = env.MC_TOKEN;
after(() => {
  if (savedToken === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = savedToken;
});

describe("MCP route path", () => {
  it("answers 404 for /api/<x> other than /api/mcp, before auth", async () => {
    env.MC_TOKEN = "test-mc-token";
    const { POST, GET } = await import(pathToFileURL(path.join(process.cwd(), "src/app/api/[transport]/route.ts")).href);
    for (const p of ["/api/sse", "/api/message", "/api/anything"]) {
      const res = await POST(new Request(`http://localhost${p}`, {
        method: "POST",
        headers: { authorization: "Bearer test-mc-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }));
      assert.equal(res.status, 404, p);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.code, "not_found", p);
      assert.equal((await GET(new Request(`http://localhost${p}`))).status, 404, p);
    }
  });

  it("still serves /api/mcp", async () => {
    env.MC_TOKEN = "test-mc-token";
    const { POST } = await import(pathToFileURL(path.join(process.cwd(), "src/app/api/[transport]/route.ts")).href);
    const res = await POST(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-mc-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    }));
    assert.equal(res.status, 200);
    await res.text();
  });
});
