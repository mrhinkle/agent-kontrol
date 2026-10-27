import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { openApiDocument } from "../../src/lib/openapi";
import { applyPointerBlock, POINTERS_BEGIN, POINTERS_END } from "../../src/lib/skills/agents-md";
import { renderPointers } from "../../src/lib/skills/inject";
import { authorizeRoute, scopeForRoute } from "../../src/lib/scopes";

const BLOCK = `${POINTERS_BEGIN}\n- a (1.0.0, aaaaaaa) — first. Fetch: get_skill {"id":"a"}\n${POINTERS_END}`;
const BLOCK_2 = `${POINTERS_BEGIN}\n- b (2.0.0, bbbbbbb) — second. Fetch: get_skill {"id":"b"}\n${POINTERS_END}`;

describe("applyPointerBlock", () => {
  it("uses the same markers as the renderer", () => {
    const rendered = renderPointers([{ id: "a", version: "1.0.0", sha: "a".repeat(64), description: "first" }], { runtime: "grok", lane: "x" });
    assert.ok(rendered.startsWith(POINTERS_BEGIN));
    assert.ok(rendered.endsWith(POINTERS_END));
  });

  it("appends the block after a blank line when the file has none", () => {
    const out = applyPointerBlock("# Repo\nRules.\n", BLOCK);
    assert.equal(out.changed, true);
    assert.equal(out.content, `# Repo\nRules.\n\n${BLOCK}\n`);
  });

  it("adds a line break when the file does not end in one", () => {
    assert.equal(applyPointerBlock("# Repo", BLOCK).content, `# Repo\n\n${BLOCK}\n`);
  });

  it("fills an empty file with just the block", () => {
    assert.equal(applyPointerBlock("", BLOCK).content, `${BLOCK}\n`);
  });

  it("replaces the block in place and keeps text on both sides", () => {
    const file = `top\n\n${BLOCK}\n\nbottom\n`;
    const out = applyPointerBlock(file, BLOCK_2);
    assert.equal(out.content, `top\n\n${BLOCK_2}\n\nbottom\n`);
    assert.equal(out.changed, true);
  });

  it("is a no-op on a second run", () => {
    const first = applyPointerBlock("# Repo\n", BLOCK);
    const second = applyPointerBlock(first.content, BLOCK);
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
    assert.equal((second.content ?? "").split(POINTERS_BEGIN).length, 2);
  });

  it("removes the block when the result is empty and restores the original", () => {
    const original = "# Repo\nRules.\n";
    const withBlock = applyPointerBlock(original, BLOCK).content;
    const removed = applyPointerBlock(withBlock, "");
    assert.equal(removed.content, original);
    assert.equal(removed.changed, true);
    assert.equal(applyPointerBlock(removed.content, "").changed, false);
  });

  it("removes a block in the middle without leaving two blank lines", () => {
    const out = applyPointerBlock(`top\n\n${BLOCK}\n\nbottom\n`, "");
    assert.equal(out.content, "top\n\nbottom\n");
  });

  it("collapses duplicate blocks into one", () => {
    const out = applyPointerBlock(`${BLOCK}\n\nmid\n\n${BLOCK}\n`, BLOCK_2);
    assert.equal(out.content, `${BLOCK_2}\n\nmid\n`);
    const gone = applyPointerBlock(`${BLOCK}\n\nmid\n\n${BLOCK}\n`, "");
    assert.equal(gone.content, "mid\n");
  });

  it("keeps CRLF files CRLF through insert, replace, remove", () => {
    const original = "# Repo\r\nRules.\r\n";
    const inserted = applyPointerBlock(original, BLOCK).content ?? "";
    assert.equal(inserted, `# Repo\r\nRules.\r\n\r\n${BLOCK.replace(/\n/g, "\r\n")}\r\n`);
    assert.equal(inserted.replace(/\r\n/g, "").includes("\n"), false);
    const replaced = applyPointerBlock(inserted, BLOCK_2).content ?? "";
    assert.equal(replaced.replace(/\r\n/g, "").includes("\n"), false);
    assert.ok(replaced.includes("get_skill {\"id\":\"b\"}"));
    assert.equal(applyPointerBlock(replaced, BLOCK_2).changed, false);
    assert.equal(applyPointerBlock(replaced, "").content, original);
  });

  it("handles a missing file", () => {
    assert.deepEqual(applyPointerBlock(null, ""), { content: null, changed: false });
    assert.deepEqual(applyPointerBlock(undefined, ""), { content: null, changed: false });
    assert.deepEqual(applyPointerBlock(null, BLOCK), { content: `${BLOCK}\n`, changed: true });
  });

  it("ignores markers quoted inside prose", () => {
    const prose = `Wrap it in ${POINTERS_BEGIN} and ${POINTERS_END} lines.\nKeep ${POINTERS_BEGIN} in docs.\n`;
    assert.equal(applyPointerBlock(prose, "").changed, false);
    assert.equal(applyPointerBlock(prose, BLOCK).content, `${prose}\n${BLOCK}\n`);
  });

  it("refuses an unpaired or nested marker instead of guessing", () => {
    assert.throws(() => applyPointerBlock(`a\n${POINTERS_BEGIN}\nb\n`, BLOCK), /begin marker without end/);
    assert.throws(() => applyPointerBlock(`a\n${POINTERS_END}\nb\n`, BLOCK), /end marker without begin/);
    assert.throws(() => applyPointerBlock(`${POINTERS_END}\n${POINTERS_BEGIN}\n`, ""), /end marker without begin/);
    assert.throws(() => applyPointerBlock(`${POINTERS_BEGIN}\n${POINTERS_BEGIN}\n${POINTERS_END}\n`, BLOCK), /nested/);
  });
});

const env = process.env as Record<string, string | undefined>;
const saved = { token: env.MC_TOKEN, db: env.DATABASE_URL, password: env.MC_DASHBOARD_PASSWORD, node: env.NODE_ENV };

describe("skills pointers route", { concurrency: false }, () => {
  beforeEach(() => {
    delete env.DATABASE_URL;
    delete env.MC_DASHBOARD_PASSWORD;
    delete env.MC_TOKEN;
    env.NODE_ENV = "test";
    resetCredentialsForTests();
    setSqlForTests(null);
  });

  afterEach(() => {
    setSqlForTests(null);
    resetCredentialsForTests();
    for (const [key, value] of [["MC_TOKEN", saved.token], ["DATABASE_URL", saved.db], ["MC_DASHBOARD_PASSWORD", saved.password], ["NODE_ENV", saved.node]] as const) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });

  const url = (query: string) => `http://localhost/api/skills/pointers${query}`;
  const post = (body: unknown) =>
    new Request(url(""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("GET renders the block for a lane, as json or text", async () => {
    const { GET } = await import("../../src/app/api/skills/pointers/route");
    const res = await GET(new Request(url("?lane=conference-os&runtime=codex")));
    assert.equal(res.status, 200);
    const body = await res.json() as { empty: boolean; block: string; lane: string; runtime: string };
    assert.equal(body.empty, false);
    assert.ok(body.block.startsWith(POINTERS_BEGIN) && body.block.endsWith(POINTERS_END));
    assert.match(body.block, /spec-writer/);

    const text = await GET(new Request(url("?lane=conference-os&runtime=codex&format=text")));
    assert.match(text.headers.get("content-type") ?? "", /text\/plain/);
    assert.equal(await text.text(), `${body.block}\n`);

    const none = await GET(new Request(url("?lane=conference-os&runtime=grok")));
    assert.deepEqual(await none.json(), { demo: true, lane: "conference-os", runtime: "grok", empty: true, block: "" });
    const noneText = await GET(new Request(url("?lane=other&runtime=codex&format=text")));
    assert.equal(await noneText.text(), "");
  });

  it("GET rejects a missing lane, a bad runtime, and a bad format", async () => {
    const { GET } = await import("../../src/app/api/skills/pointers/route");
    for (const q of ["?runtime=codex", "?lane=x", "?lane=x&runtime=basic", "?lane=bad%20lane&runtime=codex", "?lane=x&runtime=codex&format=xml"]) {
      const res = await GET(new Request(url(q)));
      assert.equal(res.status, 400, q);
      assert.equal((await res.json()).code, "validation_failed");
    }
  });

  it("POST inserts, is a no-op the second time, and removes when nothing matches", async () => {
    const { POST } = await import("../../src/app/api/skills/pointers/route");
    const first = await (await POST(post({ lane: "conference-os", runtime: "codex", agents_md: "# Repo\r\n" }))).json() as { content: string; changed: boolean };
    assert.equal(first.changed, true);
    assert.match(first.content, /^# Repo\r\n\r\n<!-- ak-skills:begin -->\r\n/);
    const second = await (await POST(post({ lane: "conference-os", runtime: "codex", agents_md: first.content }))).json() as { content: string; changed: boolean };
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
    const removed = await (await POST(post({ lane: "conference-os", runtime: "grok", agents_md: first.content }))).json() as { content: string; changed: boolean; empty: boolean };
    assert.equal(removed.empty, true);
    assert.equal(removed.content, "# Repo\r\n");
  });

  it("POST handles a missing file and rejects bad input", async () => {
    const { POST } = await import("../../src/app/api/skills/pointers/route");
    const none = await (await POST(post({ lane: "other", runtime: "codex" }))).json() as { content: unknown; changed: boolean };
    assert.deepEqual([none.content, none.changed], [null, false]);
    const created = await (await POST(post({ lane: "conference-os", runtime: "codex", agents_md: null }))).json() as { content: string };
    assert.ok(created.content.startsWith(POINTERS_BEGIN));
    for (const body of [{ runtime: "codex" }, { lane: "x", runtime: "codex", agents_md: 5 }, { lane: "x", runtime: "codex", agents_md: `${POINTERS_BEGIN}\nx` }, []]) {
      const res = await POST(post(body));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "validation_failed");
    }
    const bad = await POST(new Request(url(""), { method: "POST", body: "nope" }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "invalid_json");
  });

  it("needs skills:read for an agent credential and is in OpenAPI", async () => {
    assert.equal(scopeForRoute("GET", "/api/skills/pointers"), "skills:read");
    assert.equal(scopeForRoute("POST", "/api/skills/pointers"), "skills:read");
    assert.equal(scopeForRoute("POST", "/api/skills/sync"), null);
    const principal = { kind: "agent" as const, id: "x", scopes: ["tasks:read"] };
    assert.equal(authorizeRoute(principal, "GET", "/api/skills/pointers").ok, false);
    assert.equal(authorizeRoute({ ...principal, scopes: ["skills:read"] }, "POST", "/api/skills/pointers").ok, true);
    const doc = openApiDocument() as { paths: Record<string, { get?: unknown; post?: unknown }> };
    assert.ok(doc.paths["/api/skills/pointers"]?.get);
    assert.ok(doc.paths["/api/skills/pointers"]?.post);
    assert.doesNotMatch(fs.readFileSync("docs/MCP.md", "utf8"), /Dispatch is not wired/);
  });
});
