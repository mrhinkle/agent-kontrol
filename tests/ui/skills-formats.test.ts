import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithActor } from "../../src/lib/actor";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { buildBundle, bundleGzip, visibleForExport, type BundleSkill } from "../../src/lib/skills/formats/bundle";
import { renderAgentSkillsDocument } from "../../src/lib/skills/formats/agentskills";
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
    assert.equal(spaced.ok, true);
    if (!spaced.ok) return;
    assert.equal(spaced.files[0]?.path, "engineering-tools/labeled/SKILL.md");
  });

  it("F7 bundles references beside SKILL.md and sanitizes their paths", () => {
    const tree = renderHermesTree(bundleSkill({
      id: "apple-notes",
      category: "Apple",
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

    const { GET } = await import("../../src/app/api/skills/export/route");
    const open = await GET(new Request("http://localhost/api/skills/export?runtime=hermes", {
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

    const lane = await GET(new Request("http://localhost/api/skills/export?runtime=hermes&lane=conference-os", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    const laneFiles = readArchive(Buffer.from(await lane.arrayBuffer()));
    assert.match(laneFiles.get("apple/picked/SKILL.md") ?? "", /picked body/);
    assert.equal(laneFiles.has("apple/other-lane/SKILL.md"), false);
    assert.match(laneFiles.get("apple/shown/SKILL.md") ?? "", /shown body/);

    const wrongCase = await GET(new Request("http://localhost/api/skills/export?runtime=hermes&lane=Conference-OS", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    const wrongFiles = readArchive(Buffer.from(await wrongCase.arrayBuffer()));
    assert.equal(wrongFiles.has("apple/picked/SKILL.md"), false);

    const query = await GET(new Request("http://localhost/api/skills/export?runtime=hermes&q=target", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    const queryFiles = readArchive(Buffer.from(await query.arrayBuffer()));
    assert.equal(queryFiles.size, 0);

    const missing = await GET(new Request("http://localhost/api/skills/export"));
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, "validation_failed");
    const repeated = await GET(new Request("http://localhost/api/skills/export?runtime=hermes&runtime=claude"));
    assert.equal(repeated.status, 400);
    const nemoclaw = await GET(new Request("http://localhost/api/skills/export?runtime=nemoclaw"));
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

    assert.equal(scopeForRoute("GET", "/api/skills/export"), null);
    assert.equal(authorizeRoute({ kind: "agent", id: "cred", scopes: ["skills:read", "skills:write"] }, "GET", "/api/skills/export").ok, false);
    assert.equal(authorizeRoute({ kind: "legacy" }, "GET", "/api/skills/export").ok, true);
    assert.equal(authorizeRoute({ kind: "agent", id: "cred", scopes: ["skills:read"] }, "GET", "/api/skills/verify-gibson").ok, true);

    const { GET } = await import("../../src/app/api/skills/export/route");
    for (const token of [reader.token, writer.token, both.token]) {
      const denied = await GET(new Request("http://localhost/api/skills/export?runtime=hermes", {
        headers: { authorization: `Bearer ${token}` },
      }));
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "insufficient_scope");
    }

    env.MC_TOKEN = "test-mc-token";
    const allowed = await GET(new Request("http://localhost/api/skills/export?runtime=hermes", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("x-ak-demo"), "true");
    const files = readArchive(Buffer.from(await allowed.arrayBuffer()));
    assert.equal(files.has("uncategorized/verify-gibson/SKILL.md"), true);
    assert.equal([...files.keys()].some((name) => name.includes("spec-writer")), false);
    assert.equal([...files.keys()].some((name) => name.includes("operator-voice")), false);
  });

  it("documents the route in OpenAPI and API.md", () => {
    const api = fs.readFileSync("docs/API.md", "utf8");
    assert.match(api, /\/api\/skills\/export/);
    const { openApiDocument } = require("../../src/lib/openapi") as typeof import("../../src/lib/openapi");
    const doc = openApiDocument() as { paths: Record<string, { get?: { parameters?: { name: string; required?: boolean }[] } }> };
    const get = doc.paths["/api/skills/export"]?.get;
    assert.ok(get);
    assert.equal(get.parameters?.find((item) => item.name === "runtime")?.required, true);
  });
});
