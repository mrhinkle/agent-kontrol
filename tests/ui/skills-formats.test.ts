import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runWithActor } from "../../src/lib/actor";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { buildBundle, bundleGzip, visibleForExport, type BundleSkill } from "../../src/lib/skills/formats/bundle";
import { renderAgentSkillsDocument, renderAgentSkillsTree } from "../../src/lib/skills/formats/agentskills";
import { renderClaudeTree } from "../../src/lib/skills/formats/claude";
import { hermesKnown, renderHermesTree, storedFromHermesMarkdown } from "../../src/lib/skills/formats/hermes";
import { categoryFolder, isSafeArchivePath, safeReferencePath, safeSegment } from "../../src/lib/skills/formats/paths";
import { tarGzip } from "../../src/lib/skills/formats/tar";
import { formatForRuntime } from "../../src/lib/skills/formats";
import { getSkillTool, runSkillTool } from "../../src/lib/skills/mcp";
import { renderSkillText, startSkillRun } from "../../src/lib/skills/runs";
import { RUNTIMES } from "../../src/lib/skills/types";
import { authorizeRoute, scopeForRoute } from "../../src/lib/scopes";
import { callsOf, installSkillsSql, skillsMemory, type MemSkill } from "./skills-memory";

const NOW = "2026-10-28T12:00:00.000Z";
const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};

function fixture(name: string): string {
  return fs.readFileSync(path.join("tests/fixtures/skills/hermes", name), "utf8");
}

function textOf(result: { content?: { text?: string }[]; isError?: boolean }): string {
  return result.content?.[0]?.text ?? "";
}

function skill(partial: Partial<MemSkill> & Pick<MemSkill, "id">): MemSkill {
  return {
    id: partial.id,
    source_id: "master-skills",
    path: `skills/${partial.id}/SKILL.md`,
    name: partial.name ?? partial.id,
    description: partial.description ?? `${partial.id} description`,
    version: partial.version === undefined ? "1.2.0" : partial.version,
    sha: partial.sha ?? "ab".repeat(32),
    commit_sha: "c".repeat(40),
    body: partial.body ?? "Follow these steps.",
    references: partial.references ?? [],
    runtimes: partial.runtimes ?? { claude: true, codex: true, grok: true, hermes: true, mini: true },
    category: partial.category ?? null,
    tags: partial.tags ?? [],
    frontmatter: partial.frontmatter ?? {},
    removed_at: partial.removed_at ?? null,
    synced_at: NOW,
  };
}

function bundleSkill(partial: Partial<BundleSkill["skill"]> & Pick<BundleSkill["skill"], "id"> & Partial<Omit<BundleSkill, "skill">>): BundleSkill {
  return {
    skill: {
      id: partial.id,
      name: partial.name ?? partial.id,
      description: partial.description ?? `${partial.id} description`,
      version: partial.version === undefined ? "1.0.0" : partial.version,
      sha: partial.sha ?? "cd".repeat(32),
      body: partial.body ?? "body",
      category: partial.category ?? null,
      tags: partial.tags ?? [],
      references: partial.references ?? [],
      frontmatter: partial.frontmatter ?? {},
    },
    trigger: partial.trigger ?? "on_request",
    scope: partial.scope ?? { mode: "all", lanes: [] },
    runtimes: partial.runtimes ?? { claude: true, codex: true, grok: true, hermes: true, mini: true },
  };
}

function archiveNames(bytes: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-skills-"));
  try {
    const file = path.join(dir, "bundle.tar.gz");
    fs.writeFileSync(file, bytes);
    const listing = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
    return listing.split("\n").map((line) => line.trim()).filter(Boolean);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Next serves a concrete segment ahead of `[id]`. Calling the handler that
 * wins for this URL is what an operator's GET /api/skills/:id actually hits.
 */
async function dispatchSkillsGet(id: string, url: string): Promise<Response> {
  const staticFile = path.join("src/app/api/skills", id, "route.ts");
  if (fs.existsSync(staticFile)) {
    const loaded = await import(pathToFileURL(path.resolve(staticFile)).href) as { GET: (req: Request) => Promise<Response> };
    return loaded.GET(new Request(url));
  }
  const dynamic = await import("../../src/app/api/skills/[id]/route");
  return dynamic.GET(new Request(url), { params: Promise.resolve({ id }) });
}

function readArchive(bytes: Buffer): Map<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-skills-"));
  try {
    const file = path.join(dir, "bundle.tar.gz");
    fs.writeFileSync(file, bytes);
    const listing = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
    const names = listing.split("\n").map((line) => line.trim()).filter(Boolean);
    execFileSync("tar", ["-xzf", file, "-C", dir]);
    const out = new Map<string, string>();
    for (const name of names) {
      assert.equal(name.startsWith("/"), false, name);
      assert.equal(name.includes(".."), false, name);
      assert.equal(isSafeArchivePath(name), true, name);
      const abs = path.resolve(dir, name);
      assert.equal(abs.startsWith(dir + path.sep), true, abs);
      out.set(name, fs.readFileSync(abs, "utf8"));
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["NODE_ENV", saved.node],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

describe("Hermes format adapters", () => {
  it("F1 round-trips known Hermes fields and drops unknown ones", () => {
    const cases = [
      { file: "apple-notes.md", category: "apple", id: "apple-notes" },
      { file: "notion.md", category: "productivity", id: "notion" },
      { file: "polymarket.md", category: "research", id: "polymarket" },
    ];
    for (const item of cases) {
      const raw = fixture(item.file);
      const stored = storedFromHermesMarkdown({ raw, category: item.category, id: item.id });
      assert.equal(stored.ok, true, item.file);
      if (!stored.ok) continue;
      const tree = renderHermesTree(stored.skill);
      assert.equal(tree.ok, true, item.file);
      if (!tree.ok) continue;
      const skillFile = tree.files.find((file) => file.path.endsWith("/SKILL.md"));
      assert.ok(skillFile, item.file);
      assert.equal(skillFile.path, `${item.category}/${item.id}/SKILL.md`);
      assert.equal(skillFile.content.includes("title:"), false, item.file);
      assert.equal(skillFile.content.includes("homepage:"), false, item.file);
      assert.equal(skillFile.content.includes("example.invalid"), false);
      assert.equal(skillFile.content.includes("developers.notion.com"), false);
      assert.equal(/^tags:/m.test(skillFile.content), false, item.file);
      const again = storedFromHermesMarkdown({ raw: skillFile.content, category: item.category, id: item.id });
      assert.equal(again.ok, true, item.file);
      if (!again.ok) continue;
      const before = hermesKnown(stored.skill);
      const after = hermesKnown(again.skill);
      assert.equal(after.name, before.name, item.file);
      assert.equal(after.description, before.description, item.file);
      assert.equal(after.version, before.version, item.file);
      assert.equal(after.author, before.author, item.file);
      assert.equal(after.license, before.license, item.file);
      assert.deepEqual(after.platforms, before.platforms, item.file);
      assert.deepEqual(after.tags, before.tags, item.file);
      assert.deepEqual(after.relatedSkills, before.relatedSkills, item.file);
      assert.deepEqual(after.prerequisites, before.prerequisites, item.file);
      assert.equal(after.body, before.body, item.file);
      assert.ok(before.tags.length > 0, item.file);
    }

    const bare = storedFromHermesMarkdown({
      raw: "---\nname: bare-skill\ndescription: Bare.\n---\nJust the body.\n",
      category: "notes",
      id: "bare-skill",
    });
    assert.equal(bare.ok, true);
    if (!bare.ok) return;
    bare.skill.version = null;
    bare.skill.sha = "ef".repeat(32);
    const bareTree = renderHermesTree(bare.skill);
    assert.equal(bareTree.ok, true);
    if (!bareTree.ok) return;
    const bareFile = bareTree.files[0]?.content ?? "";
    assert.match(bareFile, new RegExp(`version: ${"ef".repeat(32)}`));
    assert.equal(bareFile.includes("author:"), false);
    assert.equal(bareFile.includes("license:"), false);
    assert.equal(bareFile.includes("platforms:"), false);
    assert.equal(bareFile.includes("metadata:"), false);
    assert.equal(bareFile.includes("prerequisites:"), false);
    assert.equal(bareFile.includes("1.0.0"), false);

    const overridden = storedFromHermesMarkdown({ raw: fixture("apple-notes.md"), category: "apple", id: "apple-notes" });
    assert.equal(overridden.ok, true);
    if (!overridden.ok) return;
    overridden.skill.tags = ["from-store"];
    const overriddenTree = renderHermesTree(overridden.skill);
    assert.equal(overriddenTree.ok, true);
    if (!overriddenTree.ok) return;
    const overriddenText = overriddenTree.files[0]?.content ?? "";
    assert.match(overriddenText, /from-store/);
    assert.equal(overriddenText.includes("note-taking"), false);
  });

  it("F3 rejects traversal in category, name, and reference paths", () => {
    const attacks = [
      "../../etc",
      "..",
      ".",
      "/etc",
      "foo/../../../etc",
      "..\\..\\windows",
      "C:/Windows/system32",
      "apple\u0000/../../etc",
      "%2e%2e/%2e%2e/etc",
      "....//....//etc/passwd",
      "..../..../etc/passwd",
      "ok/../../etc",
      `a${"a".repeat(80)}`,
    ];
    for (const attack of attacks) {
      assert.equal(safeSegment(attack, false), null, attack);
      assert.equal(categoryFolder(attack).ok, false, attack);
      const rendered = renderHermesTree(bundleSkill({ id: "safe-name", category: attack }).skill);
      assert.equal(rendered.ok, false, attack);
      if (!rendered.ok) assert.match(rendered.reason, /unsafe category/);
    }
    assert.equal(safeSegment("../evil", false), null);
    const named = renderHermesTree(bundleSkill({ id: "../evil", category: "apple" }).skill);
    assert.equal(named.ok, false);
    if (!named.ok) assert.match(named.reason, /unsafe skill name/);

    const refs = [
      "../../etc/passwd",
      "/etc/passwd",
      "notes/../../secret.md",
      "..\\..\\secret",
      "C:/Windows/system32/config",
      "ok.md\u0000",
      "%2e%2e/%2e%2e/etc/passwd",
      "....//....//etc/passwd",
      "/tmp/secret.md",
      "SKILL.md",
      "subdir/SKILL.md",
    ];
    for (const ref of refs) {
      assert.equal(safeReferencePath(ref), null, ref);
    }
    const tree = renderHermesTree(bundleSkill({
      id: "apple-notes",
      category: "apple",
      references: [
        { path: "references/guide.md", content: "keep" },
        { path: "../../etc/passwd", content: "secret" },
        { path: "/etc/passwd", content: "secret" },
        { path: "notes/../../secret.md", content: "secret" },
      ],
    }).skill);
    assert.equal(tree.ok, true);
    if (!tree.ok) return;
    assert.deepEqual(tree.files.map((file) => file.path), [
      "apple/apple-notes/SKILL.md",
      "apple/apple-notes/references/guide.md",
    ]);
    assert.equal(tree.files.some((file) => file.content === "secret"), false);
    assert.equal(tree.rejected.length >= 3, true);

    const archive = readArchive(bundleGzip([
      bundleSkill({ id: "good", category: "apple", body: "visible" }),
      bundleSkill({ id: "../evil", category: "apple", body: "hidden-name" }),
      bundleSkill({ id: "also", category: "../../etc", body: "hidden-category" }),
    ], { runtime: "hermes", lane: null, category: null, query: null }));
    assert.equal([...archive.keys()].some((name) => name.includes("..")), false);
    assert.equal([...archive.values()].some((text) => text.includes("hidden-name") || text.includes("hidden-category")), false);
    assert.match(archive.get("apple/good/SKILL.md") ?? "", /visible/);

    assert.equal(isSafeArchivePath("apple/%2e%2e/notes"), false);
    assert.equal(isSafeArchivePath("apple/%2Fetc"), false);
    assert.equal(isSafeArchivePath("ok\n/etc"), false);
    assert.equal(isSafeArchivePath("C:/Windows/system32"), false);
    const packed = readArchive(tarGzip([
      { path: "apple/%2e%2e/secret.md", content: "escaped" },
      { path: "../etc/passwd", content: "escaped" },
      { path: "apple/notes/ok.md", content: "kept" },
    ]));
    assert.equal(packed.has("apple/%2e%2e/secret.md"), false);
    assert.equal(packed.get("apple/notes/ok.md"), "kept");
    assert.equal([...packed.values()].some((text) => text.includes("escaped")), false);
  });

  it("F6 puts a skill with no category under uncategorized/", () => {
    for (const category of [null, undefined, "", "   "]) {
      const folder = categoryFolder(category);
      assert.equal(folder.ok, true);
      if (!folder.ok) continue;
      assert.equal(folder.folder, "uncategorized");
    }
    const tree = renderHermesTree(bundleSkill({ id: "bare-skill", category: null, body: "loose" }).skill);
    assert.equal(tree.ok, true);
    if (!tree.ok) return;
    assert.equal(tree.files[0]?.path, "uncategorized/bare-skill/SKILL.md");
    assert.equal(tree.files[0]?.path.startsWith("/"), false);
    const spaced = renderHermesTree(bundleSkill({ id: "labeled", category: "Engineering Tools" }).skill);
    assert.equal(spaced.ok, false);
    if (!spaced.ok) assert.match(spaced.reason, /unsafe category/);
    const exactCategory = renderHermesTree(bundleSkill({ id: "labeled", category: "engineering-tools" }).skill);
    assert.equal(exactCategory.ok, true);
    if (!exactCategory.ok) return;
    assert.equal(exactCategory.files[0]?.path, "engineering-tools/labeled/SKILL.md");
  });

  it("F7 bundles references beside SKILL.md and sanitizes their paths", () => {
    const tree = renderHermesTree(bundleSkill({
      id: "apple-notes",
      category: "apple",
      references: [
        { path: "Notes/Guide.MD", content: "guide body" },
        { path: "checks.sh", content: "echo ok\n" },
        { path: "Guide.MD", content: "second" },
        { path: "guide.md", content: "first should win" },
      ],
    }).skill);
    assert.equal(tree.ok, true);
    if (!tree.ok) return;
    const byPath = new Map(tree.files.map((file) => [file.path, file.content]));
    assert.equal(byPath.get("apple/apple-notes/notes/guide.md"), "guide body");
    assert.equal(byPath.get("apple/apple-notes/checks.sh"), "echo ok\n");
    const guide = byPath.get("apple/apple-notes/guide.md");
    assert.ok(guide === "second" || guide === "first should win");
    assert.equal(guide?.includes("second") && guide.includes("first should win"), false);
    assert.equal(tree.rejected.length >= 1, true);
    for (const file of tree.files) {
      assert.equal(file.path.includes(".."), false);
      assert.equal(path.isAbsolute(file.path), false);
    }
  });

  it("does not add a nemoclaw runtime or invent Agent Skills fields", () => {
    assert.equal(RUNTIMES.includes("nemoclaw" as never), false);
    assert.equal(formatForRuntime("hermes"), "hermes");
    assert.equal(formatForRuntime("codex"), "agentskills");
    assert.equal(formatForRuntime("grok"), "agentskills");
    assert.equal(formatForRuntime("claude"), "claude");
    assert.equal(formatForRuntime("mini"), "claude");
    const doc = renderAgentSkillsDocument(bundleSkill({
      id: "open",
      description: "Open to every lane",
      version: "9.9.9",
      frontmatter: { name: "open", description: "Open to every lane", version: "9.9.9" },
    }).skill);
    assert.match(doc ?? "", /name: open/);
    assert.equal(doc?.includes("version:"), false);
    assert.equal(doc?.includes("metadata:"), false);
    assert.equal(doc?.includes("hermes:"), false);
    const claude = renderClaudeTree(bundleSkill({
      id: "open",
      description: "Open",
      frontmatter: { name: "open", description: "Open", "allowed-tools": "Read" },
      body: "Body only.",
    }).skill);
    assert.equal(claude.ok, true);
    if (!claude.ok) return;
    assert.match(claude.files[0]?.content ?? "", /allowed-tools: Read/);
    assert.equal(claude.files[0]?.content.includes("metadata:"), false);
    assert.equal(claude.files[0]?.path, "skills/open/SKILL.md");
  });
});

describe("skill MCP format rendering", { concurrency: false }, () => {
  const actor = { actor_type: "agent" as const, actor_id: "cred-hermes" };

  beforeEach(() => {
    installSkillsSql();
    setSkillNowForTests(() => new Date(NOW));
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.NODE_ENV = "test";
    const raw = fixture("apple-notes.md");
    const stored = storedFromHermesMarkdown({ raw, category: "apple", id: "apple-notes" });
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    skillsMemory.skills.push(skill({
      id: "apple-notes",
      name: stored.skill.name,
      description: stored.skill.description,
      version: stored.skill.version,
      sha: stored.skill.sha,
      body: stored.skill.body,
      category: "apple",
      tags: stored.skill.tags,
      frontmatter: stored.skill.frontmatter,
      references: [{ path: "references/guide.md", content: "guide" }],
    }));
    skillsMemory.skills.push(skill({ id: "open", description: "Open to every lane", body: "Follow these steps." }));
    skillsMemory.settings.push(
      { skill_id: "apple-notes", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "open", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
    );
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
    restoreEnv();
  });

  it("F2 hermes get_skill and run_skill carry Hermes frontmatter and claude stays the old text", async () => {
    const hermes = textOf(await getSkillTool({ id: "apple-notes", runtime: "hermes" }));
    assert.match(hermes, /^# apple-notes/);
    assert.match(hermes, /You are Hermes/);
    assert.match(hermes, /metadata:/);
    assert.match(hermes, /hermes:/);
    assert.match(hermes, /related_skills: \[obsidian\]/);
    assert.match(hermes, /commands: \[memo\]/);
    assert.match(hermes, /version: 1\.0\.1/);
    assert.equal(hermes.includes("homepage:"), false);
    assert.equal(hermes.includes("title:"), false);
    assert.match(hermes, /Manage notes\./);

    const claude = textOf(await getSkillTool({ id: "apple-notes", runtime: "claude" }));
    assert.match(claude, /^# apple-notes/);
    assert.match(claude, /You are Claude/);
    assert.match(claude, /Manage notes\./);
    assert.equal(claude.includes("metadata:"), false);
    assert.equal(claude.includes("related_skills:"), false);
    assert.equal(claude.includes("prerequisites:"), false);
    // The fixture body itself contains a "---" line. Frontmatter would put one before the body.
    const beforeBody = claude.slice(0, claude.indexOf("Manage notes."));
    assert.equal(beforeBody.includes("---"), false);
    assert.equal(beforeBody.includes("name:"), false);
    assert.equal(claude.includes("version: 1.0.1"), false);

    const row = skillsMemory.skills.find((item) => item.id === "open");
    assert.ok(row);
    const expected = [
      "# open",
      `Pinned SHA: ${row.sha}`,
      "Runtime: claude",
      "",
      "You are Claude. Follow this skill in your own session. Agent Kontrol does not execute it.",
      "",
      "Follow these steps.",
      "",
      "References (fetch with get_skill):",
      "- none",
    ].join("\n");
    assert.equal(renderSkillText(row as never, "claude"), expected);
    assert.equal(textOf(await getSkillTool({ id: "open", runtime: "claude" })), expected);

    const started = await runWithActor(actor, () => startSkillRun({
      id: "apple-notes",
      runtime: "hermes",
    }));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.match(started.text, /metadata:/);
    assert.match(started.text, /You are Hermes/);
    assert.match(started.text, new RegExp(`run_id: ${started.runId}`));
    assert.match(started.text, /complete:true/);

    const claudeRun = await runWithActor(actor, () => runSkillTool({
      id: "open",
      runtime: "claude",
    }));
    const claudeRunText = textOf(claudeRun);
    assert.match(claudeRunText, /You are Claude/);
    assert.match(claudeRunText, /Follow these steps\./);
    assert.equal(claudeRunText.includes("metadata:"), false);
    assert.equal(callsOf("sk:upsert-skill"), 0);
  });
});

describe("skill export route", { concurrency: false }, () => {
  beforeEach(() => {
    delete env.MC_DASHBOARD_PASSWORD;
    delete env.MC_TOKEN;
    env.NODE_ENV = "test";
    resetCredentialsForTests();
    setSqlForTests(null);
  });

  afterEach(() => {
    setSqlForTests(null);
    resetCredentialsForTests();
    restoreEnv();
  });

  it("F4 export respects trigger off and lane scope", async () => {
    installSkillsSql();
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.MC_TOKEN = "test-mc-token";
    skillsMemory.skills.push(
      skill({ id: "shown", category: "apple", body: "shown body", description: "shown skill" }),
      skill({ id: "disabled", category: "apple", body: "disabled body", description: "disabled skill" }),
      skill({ id: "picked", category: "apple", body: "picked body", description: "picked skill" }),
      skill({ id: "other-lane", category: "apple", body: "other body", description: "other lane" }),
      skill({ id: "claude-only", body: "claude body", runtimes: { claude: true, codex: false, grok: false, hermes: false, mini: false } }),
      skill({ id: "gone", body: "gone body", removed_at: NOW }),
      skill({ id: "named-only", name: "Query Target", description: "nothing", body: "named body" }),
      skill({ id: "bad-trigger", category: "apple", body: "bad trigger body" }),
    );
    skillsMemory.settings.push(
      { skill_id: "shown", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "disabled", trigger: "off", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "picked", trigger: "auto_inject", scope: { mode: "selected", lanes: ["conference-os"] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "other-lane", trigger: "scheduled", scope: { mode: "selected", lanes: ["chatterbuilt"] }, schedule: "0 * * * *", updated_by: null, updated_at: NOW },
      { skill_id: "claude-only", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "named-only", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "bad-trigger", trigger: "nope" as "off", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
    );

    const { GET } = await import("../../src/app/api/skill-bundles/route");
    const open = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(open.status, 200);
    assert.match(open.headers.get("content-type") ?? "", /application\/gzip/);
    assert.match(open.headers.get("content-disposition") ?? "", /skills-hermes\.tar\.gz/);
    const openFiles = readArchive(Buffer.from(await open.arrayBuffer()));
    assert.match(openFiles.get("apple/shown/SKILL.md") ?? "", /shown body/);
    assert.equal(openFiles.has("apple/disabled/SKILL.md"), false);
    assert.equal(openFiles.has("apple/picked/SKILL.md"), false);
    assert.equal(openFiles.has("apple/other-lane/SKILL.md"), false);
    assert.equal([...openFiles.keys()].some((name) => name.includes("claude-only")), false);
    assert.equal([...openFiles.values()].join("\n").includes("gone body"), false);
    assert.equal([...openFiles.values()].join("\n").includes("disabled body"), false);
    assert.equal([...openFiles.values()].join("\n").includes("bad trigger body"), false);

    const lane = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes&lane=conference-os", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    const laneFiles = readArchive(Buffer.from(await lane.arrayBuffer()));
    assert.match(laneFiles.get("apple/picked/SKILL.md") ?? "", /picked body/);
    assert.equal(laneFiles.has("apple/other-lane/SKILL.md"), false);
    assert.match(laneFiles.get("apple/shown/SKILL.md") ?? "", /shown body/);

    const wrongCase = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes&lane=Conference-OS", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    const wrongFiles = readArchive(Buffer.from(await wrongCase.arrayBuffer()));
    assert.equal(wrongFiles.has("apple/picked/SKILL.md"), false);

    const query = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes&q=target", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    const queryFiles = readArchive(Buffer.from(await query.arrayBuffer()));
    assert.equal(queryFiles.size, 0);

    const missing = await GET(new Request("http://localhost/api/skill-bundles"));
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, "validation_failed");
    const repeated = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes&runtime=claude"));
    assert.equal(repeated.status, 400);
    const nemoclaw = await GET(new Request("http://localhost/api/skill-bundles?runtime=nemoclaw"));
    assert.equal(nemoclaw.status, 400);

    const pure = visibleForExport([
      bundleSkill({ id: "off", trigger: "off" }),
      bundleSkill({ id: "selected", scope: { mode: "selected", lanes: ["conference-os"] } }),
    ], { runtime: "hermes", lane: null, category: null, query: null });
    assert.deepEqual(pure.map((row) => row.skill.id), []);
  });

  it("F5 export requires operator auth", async () => {
    delete env.DATABASE_URL;
    const reader = await createCredential({ label: "reader", scopes: ["skills:read"] });
    const writer = await createCredential({ label: "writer", scopes: ["skills:write"] });
    const both = await createCredential({ label: "both", scopes: ["skills:read", "skills:write"] });
    assert.equal(reader.ok && writer.ok && both.ok, true);
    if (!reader.ok || !writer.ok || !both.ok) return;

    assert.equal(scopeForRoute("GET", "/api/skill-bundles"), null);
    assert.equal(authorizeRoute({ kind: "agent", id: "cred", scopes: ["skills:read", "skills:write"] }, "GET", "/api/skill-bundles").ok, false);
    assert.equal(authorizeRoute({ kind: "legacy" }, "GET", "/api/skill-bundles").ok, true);
    assert.equal(scopeForRoute("GET", "/api/skills/export"), "skills:read");
    assert.equal(authorizeRoute({ kind: "agent", id: "cred", scopes: ["skills:read"] }, "GET", "/api/skills/export").ok, true);
    assert.equal(authorizeRoute({ kind: "agent", id: "cred", scopes: ["skills:read"] }, "GET", "/api/skills/verify-gibson").ok, true);

    const { GET } = await import("../../src/app/api/skill-bundles/route");
    for (const token of [reader.token, writer.token, both.token]) {
      const denied = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes", {
        headers: { authorization: `Bearer ${token}` },
      }));
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "insufficient_scope");
    }

    env.MC_TOKEN = "test-mc-token";
    const allowed = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("x-ak-demo"), "true");
    const files = readArchive(Buffer.from(await allowed.arrayBuffer()));
    assert.equal(files.has("uncategorized/verify-gibson/SKILL.md"), true);
    assert.equal([...files.keys()].some((name) => name.includes("spec-writer")), false);
    assert.equal([...files.keys()].some((name) => name.includes("operator-voice")), false);
  });

  it("GET /api/skills/export returns the skill whose id is export", async () => {
    installSkillsSql();
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    skillsMemory.skills.push(skill({
      id: "export",
      name: "export",
      body: "the export skill",
      description: "detail for the export id",
    }));
    for (const url of [
      "http://localhost/api/skills/export",
      "http://localhost/api/skills/export?runtime=hermes",
    ]) {
      const response = await dispatchSkillsGet("export", url);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/, url);
      const body = await response.json() as { id: string; body: string };
      assert.equal(body.id, "export", url);
      assert.equal(body.body, "the export skill", url);
    }
  });

  it("documents the route in OpenAPI and API.md", () => {
    const api = fs.readFileSync("docs/API.md", "utf8");
    const mcp = fs.readFileSync("docs/MCP.md", "utf8");
    assert.match(api, /\/api\/skill-bundles/);
    assert.equal(api.includes("/api/skills/export"), false);
    assert.equal(mcp.includes("/api/skills/export"), false);
    const { openApiDocument } = require("../../src/lib/openapi") as typeof import("../../src/lib/openapi");
    const doc = openApiDocument() as {
      paths: Record<string, { get?: { description?: string; security?: { cookieAuth?: unknown[]; bearerAuth?: unknown[]; mcToken?: unknown[] }[]; parameters?: { name: string; required?: boolean }[] } }>;
    };
    assert.equal(doc.paths["/api/skills/export"], undefined);
    const get = doc.paths["/api/skill-bundles"]?.get;
    assert.ok(get);
    assert.equal(get.parameters?.find((item) => item.name === "runtime")?.required, true);
    assert.deepEqual(get.security, [{ cookieAuth: [] }, { mcToken: [] }]);
    assert.equal(JSON.stringify(get.security).includes("bearerAuth"), false);
    assert.match(get.description ?? "", /dashboard session/i);
    assert.match(get.description ?? "", /MC_TOKEN/);
    assert.match(get.description ?? "", /agent credential/i);
    assert.match(`${api}\n${get.description ?? ""}`, /invalid trigger/);
    assert.match(`${api}\n${get.description ?? ""}`, /see manifest.json/);
    assert.match(`${api}\n${mcp}\n${get.description ?? ""}`, /Hermes/);
    assert.match(`${api}\n${get.description ?? ""}`, /4 KB/);
  });

  it("stored malformed trigger is skipped and reported", async () => {
    installSkillsSql();
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.MC_TOKEN = "test-mc-token";
    skillsMemory.skills.push(
      skill({ id: "bad-trigger", category: "apple", body: "bad trigger body" }),
      skill({ id: "disabled", category: "apple", body: "disabled body" }),
    );
    skillsMemory.settings.push(
      { skill_id: "bad-trigger", trigger: "nope" as "off", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "disabled", trigger: "off", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
    );
    const { GET } = await import("../../src/app/api/skill-bundles/route");
    const open = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(open.status, 200);
    const files = readArchive(Buffer.from(await open.arrayBuffer()));
    assert.equal([...files.values()].join("\n").includes("bad trigger body"), false);
    assert.equal([...files.values()].join("\n").includes("disabled body"), false);
    const header = open.headers.get("x-ak-skipped") ?? "";
    assert.match(header, /see manifest.json/);
    const parsed = JSON.parse(header) as { count: number; skipped: { skill?: string; reason?: string }[] };
    assert.equal(parsed.skipped.some((entry) => entry.skill === "bad-trigger" && entry.reason === "invalid trigger"), true);
    assert.equal(parsed.skipped.some((entry) => entry.skill === "disabled"), false);
    const manifest = JSON.parse(files.get("manifest.json") ?? "") as { skipped: { skill?: string; reason?: string }[] };
    assert.equal(manifest.skipped.some((entry) => entry.skill === "bad-trigger" && entry.reason === "invalid trigger"), true);
    assert.equal(manifest.skipped.some((entry) => entry.skill === "disabled"), false);
  });

  it("skip header is bounded at 20 while manifest.json has every skip", async () => {
    installSkillsSql();
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.MC_TOKEN = "test-mc-token";
    for (let i = 0; i < 25; i += 1) {
      const id = `Bad Name ${i}`;
      skillsMemory.skills.push(skill({ id, category: "notes", body: `body ${i}` }));
      skillsMemory.settings.push({
        skill_id: id,
        trigger: "on_request",
        scope: { mode: "all", lanes: [] },
        schedule: null,
        updated_by: null,
        updated_at: NOW,
      });
    }
    const { GET } = await import("../../src/app/api/skill-bundles/route");
    const open = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(open.status, 200);
    const header = open.headers.get("x-ak-skipped") ?? "";
    assert.ok(Buffer.byteLength(header, "utf8") <= 4096, `header is ${Buffer.byteLength(header, "utf8")} bytes`);
    assert.match(header, /see manifest.json/);
    const parsed = JSON.parse(header) as { count: number; skipped: { skill?: string }[] };
    assert.equal(parsed.count, 25);
    assert.equal(parsed.skipped.length, 20);
    const files = readArchive(Buffer.from(await open.arrayBuffer()));
    const manifest = JSON.parse(files.get("manifest.json") ?? "") as { skipped: { skill?: string }[] };
    assert.equal(manifest.skipped.length, 25);
    for (let i = 0; i < 25; i += 1) {
      assert.equal(manifest.skipped.some((entry) => entry.skill === `Bad Name ${i}`), true);
      assert.equal([...files.values()].some((text) => text.includes(`body ${i}`)), false);
    }
  });

  it("skip header stays within 4 KB when entries are large", async () => {
    installSkillsSql();
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.MC_TOKEN = "test-mc-token";
    for (let i = 0; i < 25; i += 1) {
      const id = `${"b".repeat(300)}-${i}`;
      skillsMemory.skills.push(skill({ id, category: "notes", body: `wide ${i}` }));
      skillsMemory.settings.push({
        skill_id: id,
        trigger: "on_request",
        scope: { mode: "all", lanes: [] },
        schedule: null,
        updated_by: null,
        updated_at: NOW,
      });
    }
    const { GET } = await import("../../src/app/api/skill-bundles/route");
    const open = await GET(new Request("http://localhost/api/skill-bundles?runtime=hermes", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(open.status, 200);
    const header = open.headers.get("x-ak-skipped") ?? "";
    assert.ok(Buffer.byteLength(header, "utf8") <= 4096, `header is ${Buffer.byteLength(header, "utf8")} bytes`);
    assert.match(header, /see manifest.json/);
    const parsed = JSON.parse(header) as { count: number; skipped: unknown[] };
    assert.equal(parsed.count, 25);
    assert.equal(parsed.skipped.length <= 20, true);
    assert.equal(parsed.skipped.length < 25, true);
    const files = readArchive(Buffer.from(await open.arrayBuffer()));
    const manifest = JSON.parse(files.get("manifest.json") ?? "") as { skipped: { skill?: string }[] };
    assert.equal(manifest.skipped.length, 25);
  });
});

describe("archive path collisions", () => {
  const filter = { runtime: "hermes" as const, lane: null, category: null, query: null };

  it("keeps foo-bar and skips foo bar instead of writing one path twice", () => {
    const rows = [
      bundleSkill({ id: "foo bar", category: "notes", body: "spaced body" }),
      bundleSkill({ id: "foo-bar", category: "notes", body: "dashed body" }),
    ];
    const names = archiveNames(bundleGzip(rows, filter));
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, count] of counts) assert.equal(count, 1, name);
    assert.equal(names.includes("notes/foo-bar/SKILL.md"), true);
    assert.equal(names.some((name) => name.includes("foo bar")), false);
    const built = buildBundle(rows, filter);
    const skipped = built.skipped ?? [];
    assert.equal(skipped.some((entry) => entry.skill === "foo bar" && entry.reason.length > 0), true);
    assert.equal(skipped.some((entry) => entry.skill === "foo-bar"), false);
    const archived = readArchive(bundleGzip(rows, filter));
    assert.equal(archived.get("notes/foo-bar/SKILL.md")?.includes("dashed body"), true);
    assert.equal([...archived.values()].some((text) => text.includes("spaced body")), false);
  });

  it("skips a category or name that is not already a safe folder and reports it", () => {
    const rows = [
      bundleSkill({ id: "safe-name", category: "Bad Category", body: "bad category body" }),
      bundleSkill({ id: "Bad Name", category: "notes", body: "bad name body" }),
      bundleSkill({ id: "kept", category: "notes", body: "kept body" }),
    ];
    const built = buildBundle(rows, filter);
    const paths = built.files.map((file) => file.path);
    assert.equal(paths.includes("bad-category/safe-name/SKILL.md"), false);
    assert.equal(paths.includes("notes/bad-name/SKILL.md"), false);
    assert.equal(paths.includes("notes/Bad Name/SKILL.md"), false);
    assert.equal(paths.includes("notes/kept/SKILL.md"), true);
    const skipped = built.skipped ?? [];
    assert.equal(skipped.some((entry) => entry.skill === "safe-name" && /category/i.test(entry.reason)), true);
    assert.equal(skipped.some((entry) => entry.skill === "Bad Name" && /name/i.test(entry.reason)), true);
    assert.equal(skipped.some((entry) => entry.skill === "kept"), false);
    const names = archiveNames(bundleGzip(rows, filter));
    assert.equal(new Set(names).size, names.length);
    assert.equal([...readArchive(bundleGzip(rows, filter)).values()].some((text) => text.includes("bad category body") || text.includes("bad name body")), false);
  });

  it("omits every skill that would share an archive path", () => {
    const rows = [
      bundleSkill({ id: "same", category: "notes", body: "first body" }),
      bundleSkill({ id: "same", category: "notes", body: "second body" }),
    ];
    const built = buildBundle(rows, filter);
    assert.equal(built.files.some((file) => file.path === "notes/same/SKILL.md"), false);
    const skipped = (built.skipped ?? []).filter((entry) => entry.skill === "same" && /duplicate/i.test(entry.reason));
    assert.equal(skipped.length, 2);
    const names = archiveNames(bundleGzip(rows, filter));
    assert.equal(names.includes("notes/same/SKILL.md"), false);
    assert.equal(new Set(names).size, names.length);
    const text = [...readArchive(bundleGzip(rows, filter)).values()].join("\n");
    assert.equal(text.includes("first body"), false);
    assert.equal(text.includes("second body"), false);

    const uncategorized = [
      bundleSkill({ id: "notes", category: null, body: "from null" }),
      bundleSkill({ id: "notes", category: "uncategorized", body: "from folder" }),
    ];
    const folded = buildBundle(uncategorized, filter);
    assert.equal(folded.files.some((file) => file.path === "uncategorized/notes/SKILL.md"), false);
    assert.equal((folded.skipped ?? []).filter((entry) => entry.skill === "notes" && /duplicate/i.test(entry.reason)).length, 2);
  });

  it("uses the skill id as the directory when the display name differs", () => {
    const row = bundleSkill({
      id: "apple-notes",
      name: "Apple Notes",
      category: "apple",
      description: "Manage notes.",
      body: "body",
    }).skill;
    const hermes = renderHermesTree(row);
    assert.equal(hermes.ok, true);
    if (!hermes.ok) return;
    assert.equal(hermes.files[0]?.path, "apple/apple-notes/SKILL.md");
    assert.match(hermes.files[0]?.content ?? "", /name: Apple Notes/);
    const claude = renderClaudeTree(row);
    assert.equal(claude.ok, true);
    if (!claude.ok) return;
    assert.equal(claude.files[0]?.path, "skills/apple-notes/SKILL.md");
    const agents = renderAgentSkillsTree(row);
    assert.equal(agents.ok, true);
    if (!agents.ok) return;
    assert.equal(agents.files[0]?.path, ".agents/skills/apple-notes/SKILL.md");
  });

  it("malformed trigger is skipped and reported", () => {
    const rows = [
      bundleSkill({ id: "bad-trigger", category: "apple", body: "bad trigger body", trigger: "nope" as "off" }),
      bundleSkill({ id: "disabled", category: "apple", body: "disabled body", trigger: "off" }),
      bundleSkill({ id: "shown", category: "apple", body: "shown body" }),
    ];
    const built = buildBundle(rows, filter);
    assert.equal(built.files.some((file) => file.content.includes("bad trigger body")), false);
    assert.equal(built.files.some((file) => file.content.includes("disabled body")), false);
    assert.equal(built.files.some((file) => file.content.includes("shown body")), true);
    assert.equal(built.skipped.some((entry) => entry.skill === "bad-trigger" && entry.reason === "invalid trigger"), true);
    assert.equal(built.skipped.some((entry) => entry.skill === "disabled"), false);
    const archived = readArchive(bundleGzip(rows, filter));
    assert.equal([...archived.values()].some((text) => text.includes("bad trigger body")), false);
    const manifest = JSON.parse(archived.get("manifest.json") ?? "") as { skipped: { skill?: string; reason?: string }[] };
    assert.equal(manifest.skipped.some((entry) => entry.skill === "bad-trigger" && entry.reason === "invalid trigger"), true);
  });

  it("over-long nested reference path is skipped and reported", () => {
    const segment = "a".repeat(80);
    const relative = `${segment}/${segment}/${segment}`;
    const full = `apple/notes/${relative}`;
    assert.equal(isSafeArchivePath(full), true);
    const rows = [bundleSkill({
      id: "notes",
      category: "apple",
      body: "kept body",
      references: [{ path: relative, content: "long reference body" }],
    })];
    const built = buildBundle(rows, filter);
    assert.equal(built.files.some((file) => file.content.includes("kept body")), true);
    assert.equal(built.files.some((file) => file.content === "long reference body"), false);
    assert.equal(built.skipped.some((entry) => entry.skill === "notes" && entry.path === relative && /limit|ustar|archive/i.test(entry.reason)), true);
    const archived = readArchive(bundleGzip(rows, filter));
    assert.match(archived.get("apple/notes/SKILL.md") ?? "", /kept body/);
    assert.equal([...archived.values()].some((text) => text.includes("long reference body")), false);
    const manifest = JSON.parse(archived.get("manifest.json") ?? "") as { skipped: { skill?: string; path?: string }[] };
    assert.equal(manifest.skipped.some((entry) => entry.skill === "notes" && entry.path === relative), true);
  });

  it("tarGzip throws on a path ustar cannot represent", () => {
    const segment = "a".repeat(80);
    const full = `apple/notes/${segment}/${segment}/${segment}`;
    assert.equal(isSafeArchivePath(full), true);
    assert.throws(() => tarGzip([{ path: full, content: "long reference body" }]));
    const kept = tarGzip([{ path: "apple/notes/ok.md", content: "kept" }]);
    assert.equal(readArchive(kept).get("apple/notes/ok.md"), "kept");
  });

  it("Guide.MD and guide.md collision is reported", () => {
    const rows = [bundleSkill({
      id: "notes",
      category: "apple",
      body: "kept body",
      references: [
        { path: "Guide.MD", content: "UPPER" },
        { path: "guide.md", content: "lower" },
      ],
    })];
    const built = buildBundle(rows, filter);
    assert.equal(built.files.some((file) => file.path === "apple/notes/SKILL.md"), true);
    const guide = built.files.find((file) => file.path === "apple/notes/guide.md");
    assert.equal(guide?.content, "UPPER");
    assert.equal(built.files.some((file) => file.content === "lower"), false);
    assert.equal(built.skipped.some((entry) => entry.skill === "notes" && entry.path === "guide.md" && entry.reason.length > 0), true);
    const archived = readArchive(bundleGzip(rows, filter));
    assert.equal(archived.get("apple/notes/guide.md"), "UPPER");
    assert.match(archived.get("apple/notes/SKILL.md") ?? "", /kept body/);
    const manifest = JSON.parse(archived.get("manifest.json") ?? "") as { skipped: { skill?: string; path?: string }[] };
    assert.equal(manifest.skipped.some((entry) => entry.skill === "notes" && entry.path === "guide.md"), true);
  });

  it("unsafe reference is reported and the skill is still exported", () => {
    const rows = [bundleSkill({
      id: "notes",
      category: "apple",
      body: "kept body",
      references: [
        { path: "references/guide.md", content: "guide body" },
        { path: "../../etc/passwd", content: "secret" },
      ],
    })];
    const built = buildBundle(rows, filter);
    assert.equal(built.files.some((file) => file.path === "apple/notes/SKILL.md" && file.content.includes("kept body")), true);
    assert.equal(built.files.some((file) => file.path === "apple/notes/references/guide.md"), true);
    assert.equal(built.files.some((file) => file.content === "secret"), false);
    assert.equal(built.skipped.some((entry) => entry.skill === "notes" && entry.path === "../../etc/passwd" && entry.reason.length > 0), true);
    const archived = readArchive(bundleGzip(rows, filter));
    assert.match(archived.get("apple/notes/SKILL.md") ?? "", /kept body/);
    assert.equal([...archived.values()].some((text) => text.includes("secret")), false);
    const manifest = JSON.parse(archived.get("manifest.json") ?? "") as { skipped: { path?: string }[] };
    assert.equal(manifest.skipped.some((entry) => entry.path === "../../etc/passwd"), true);
  });

  it("skips a skill whose SKILL.md does not fit ustar and still exports a bad category for claude", () => {
    const id = "i".repeat(80);
    const category = "c".repeat(80);
    const hermesRows = [bundleSkill({ id, category, body: "too long skill" })];
    const hermes = buildBundle(hermesRows, filter);
    assert.equal(hermes.files.some((file) => file.content.includes("too long skill")), false);
    assert.equal(hermes.skipped.some((entry) => entry.skill === id && entry.path == null && /limit|ustar|archive/i.test(entry.reason)), true);
    const claude = buildBundle([
      bundleSkill({ id: "kept", category: "Bad Category", body: "kept body" }),
    ], { runtime: "claude", lane: null, category: null, query: null });
    assert.equal(claude.files.some((file) => file.path === "skills/kept/SKILL.md" && file.content.includes("kept body")), true);
    assert.equal(claude.skipped.some((entry) => entry.skill === "kept"), false);
    const agents = buildBundle([
      bundleSkill({ id: "kept", category: "Bad Category", body: "kept body" }),
    ], { runtime: "codex", lane: null, category: null, query: null });
    assert.equal(agents.files.some((file) => file.path === ".agents/skills/kept/SKILL.md"), true);
    assert.equal(agents.skipped.some((entry) => entry.skill === "kept"), false);
  });
});
