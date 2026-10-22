import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as getLlms } from "../../src/app/llms.txt/route";
import { GET as getDoc } from "../../src/app/docs/[name]/route";
import {
  MCP_TOOL_NAMES,
  PUBLIC_DOC_FILES,
  buildLlmsTxt,
  llmsTxtResponse,
  readPublicDoc,
  resolvePublicDoc,
  toolLinesFromMcpDoc,
} from "../../src/lib/public-docs";

// Prior art: tests/ui/middleware.test.ts (gate), tests/ui/traces-route.test.ts
// (call the route handler), tests/ui/help-docs.test.ts (doc bytes), tests/ui/mcp-tools.test.ts
// (tool names locked to the MCP route source).

const ORIGIN = "https://kontrol.example";
const mcp = fs.readFileSync("docs/MCP.md", "utf8");
const routeSrc = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");

const docGet = (name: string) =>
  getDoc(new NextRequest(`${ORIGIN}/docs/${encodeURIComponent(name)}`), {
    params: Promise.resolve({ name }),
  });

describe("public markdown docs", () => {
  it("allowlists exactly the three markdown names", () => {
    assert.deepEqual(Object.keys(PUBLIC_DOC_FILES).sort(), ["agents.md", "api.md", "mcp.md"]);
  });

  it("serves the three repo files as text/markdown with a non-empty body", async () => {
    for (const name of Object.keys(PUBLIC_DOC_FILES) as (keyof typeof PUBLIC_DOC_FILES)[]) {
      const res = await docGet(name);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^text\/markdown\b/);
      const body = await res.text();
      assert.ok(body.length > 100);
      assert.equal(body, fs.readFileSync(PUBLIC_DOC_FILES[name], "utf8"));
    }
  });

  it("404s any name that is not the allowlist, including traversal", async () => {
    const rejected = [
      "deploy.md",
      "MCP.md",
      "mcp.MD",
      "mcp.md ",
      "mcp.md/",
      "./mcp.md",
      "docs/MCP.md",
      "../package.json",
      "..\\package.json",
      "..%2Fpackage.json",
      "%2e%2e%2fpackage.json",
      "mcp.md/../../package.json",
      "mcp.md%00",
      "mcp.md\0.md",
      "....//....//package.json",
      "",
      ".",
      "..",
      "mcp.md\n",
      "__proto__",
      "constructor",
      "api.md.bak",
      "agents.mdx",
    ];
    for (const name of rejected) {
      assert.equal(resolvePublicDoc(name), null, name);
      const read = readPublicDoc(name);
      assert.equal(read.ok, false);
      assert.equal(read.ok ? 0 : read.status, 404, name);
      const res = await docGet(name);
      assert.equal(res.status, 404, name);
      assert.match(res.headers.get("content-type") ?? "", /^text\/plain\b/);
      const body = await res.text();
      assert.equal(body, "not found");
      assert.equal(body.includes("package.json"), false);
    }
  });

  it("returns 500 when an allowlisted file cannot be read or is empty", () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "ak-docs-"));
    const unread = readPublicDoc("mcp.md", missing);
    assert.equal(unread.ok, false);
    assert.equal(unread.ok ? 0 : unread.status, 500);
    const res = llmsTxtResponse(ORIGIN, unread);
    assert.equal(res.status, 500);
    assert.equal(res.body, "document unavailable");
    assert.equal(res.body.includes(missing), false);

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ak-docs-"));
    fs.mkdirSync(path.join(emptyRoot, "docs"));
    fs.writeFileSync(path.join(emptyRoot, "docs", "MCP.md"), "");
    const empty = readPublicDoc("mcp.md", emptyRoot);
    assert.equal(empty.ok, false);
    assert.equal(empty.ok ? 0 : empty.status, 500);
  });
});

describe("GET /llms.txt", () => {
  it("is text/plain, non-empty, and built from the request origin", async () => {
    const res = await getLlms(new NextRequest(`${ORIGIN}/llms.txt`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain\b/);
    const body = await res.text();
    assert.ok(body.length > 100);
    assert.ok(body.startsWith("# Agent Kontrol\n"));
    assert.ok(body.includes(`${ORIGIN}/api/mcp`));
    assert.ok(body.includes("Streamable HTTP"));
    assert.match(body, /bearer token/i);
    assert.match(body, /OAuth/);
    assert.ok(body.includes(`${ORIGIN}/.well-known/oauth-protected-resource`));
    assert.ok(body.includes(`${ORIGIN}/docs/mcp.md`));
    assert.ok(body.includes(`${ORIGIN}/docs/api.md`));
    assert.ok(body.includes(`${ORIGIN}/docs/agents.md`));
    assert.equal(body.includes("reply_to_mark"), false);

    const other = buildLlmsTxt("http://other.example", mcp);
    assert.ok(other.includes("http://other.example/api/mcp"));
    assert.equal(other.includes(ORIGIN), false);
  });

  it("lists the 11 tool names with a line taken from docs/MCP.md", () => {
    const tools = toolLinesFromMcpDoc(mcp);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...MCP_TOOL_NAMES]
    );
    const body = buildLlmsTxt(ORIGIN, mcp);
    for (const tool of tools) {
      assert.equal(tool.line.includes("\n"), false);
      assert.ok(tool.line.length > 0, tool.name);
      assert.ok(mcp.includes(tool.line), tool.line);
      assert.ok(body.includes(`- \`${tool.name}\`: ${tool.line}`));
      assert.ok(routeSrc.includes(`"${tool.name}"`), tool.name);
    }
    assert.equal(body.includes("`reply_to_mark`"), false);
    const reply = tools.find((tool) => tool.name === "reply_to_operator");
    assert.ok(reply);
    assert.equal(reply.line.startsWith("`reply_to_mark`"), false);
    assert.ok(reply.line.startsWith("Reply to the operator."));
  });

  it("refuses to publish an index when the tool sections cannot be read", () => {
    assert.throws(() => buildLlmsTxt(ORIGIN, "# no tools\n"));
    assert.throws(() => buildLlmsTxt("not a url", mcp));
    assert.throws(() => buildLlmsTxt("file:///tmp/x", mcp));
    const res = llmsTxtResponse(ORIGIN, { ok: true, body: "# no tools\n", file: "docs/MCP.md" });
    assert.equal(res.status, 500);
    assert.equal(res.body, "document unavailable");
    assert.equal(res.body.includes("missing"), false);
  });
});

describe("deployment wiring", () => {
  it("copies the three docs into the image and traces them for Vercel", () => {
    const docker = fs.readFileSync("Dockerfile", "utf8");
    assert.match(docker, /COPY --from=build \/app\/docs\/MCP\.md \/app\/docs\/API\.md \/app\/docs\/AGENTS\.md \/app\/docs\//);
    const config = fs.readFileSync("next.config.ts", "utf8");
    assert.match(config, /outputFileTracingIncludes/);
    assert.match(config, /\/llms\.txt/);
    assert.match(config, /\/docs\/\[name\]/);
    for (const rel of Object.values(PUBLIC_DOC_FILES)) assert.match(config, new RegExp(rel.replace("/", "\\/")));
  });
});
