import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithActor } from "../../src/lib/actor";
import { setSqlForTests } from "../../src/lib/db";
import { buildBundle, type BundleSkill } from "../../src/lib/skills/formats/bundle";
import { renderAgentSkillsDocument } from "../../src/lib/skills/formats/agentskills";
import { renderHermesDocument } from "../../src/lib/skills/formats/hermes";
import {
  renderNemoClawDocument,
  storedFromNemoClawMarkdown,
} from "../../src/lib/skills/formats/nemoclaw";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { skillsDigest } from "../../src/lib/skills/digest";
import { getSkillTool, listSkillsTool } from "../../src/lib/skills/mcp";
import { parseSkillMarkdown } from "../../src/lib/skills/parse";
import { resolveRuntimes } from "../../src/lib/skills/runtimes";
import { startSkillRun } from "../../src/lib/skills/runs";
import {
  ALL_RUNTIMES,
  CLAUDE_ONLY,
  flagsFromStored,
  runtimeMustBeMessage,
} from "../../src/lib/skills/types";
import type { FormatSkill as StoredFormat } from "../../src/lib/skills/formats/types";
import { installSkillsSql, skillsMemory, type MemSkill } from "./skills-memory";

const NOW = "2026-10-28T12:00:00.000Z";
const env = process.env as Record<string, string | undefined>;
const saved = { token: env.MC_TOKEN, db: env.DATABASE_URL, password: env.MC_DASHBOARD_PASSWORD, node: env.NODE_ENV };

function fixture(name: string): string {
  return fs.readFileSync(path.join("tests/fixtures/skills/nemoclaw", name), "utf8");
}

function textOf(result: { content?: { text?: string }[]; isError?: boolean }): string {
  return result.content?.[0]?.text ?? "";
}

function readArchive(bytes: Buffer): Map<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-nemoclaw-"));
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
      out.set(name, fs.readFileSync(path.join(dir, name), "utf8"));
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function skill(partial: Partial<MemSkill> & Pick<MemSkill, "id">): MemSkill {
  return {
    id: partial.id,
    source_id: "master-skills",
    path: `skills/${partial.id}/SKILL.md`,
    name: partial.name ?? partial.id,
    description: partial.description ?? "",
    version: partial.version === undefined ? null : partial.version,
    sha: partial.sha ?? "ab".repeat(32),
    commit_sha: "c".repeat(40),
    body: partial.body ?? "NemoClaw skill fixture.\n",
    references: partial.references ?? [],
    runtimes: partial.runtimes ?? {
      claude: true,
      codex: true,
      grok: true,
      hermes: true,
      mini: true,
      nemoclaw: true,
    },
    category: partial.category ?? null,
    tags: partial.tags ?? [],
    frontmatter: partial.frontmatter ?? {},
    removed_at: null,
    synced_at: NOW,
  };
}

function bundleRow(partial: Partial<BundleSkill["skill"]> & Pick<BundleSkill["skill"], "id"> & Partial<Omit<BundleSkill, "skill">>): BundleSkill {
  return {
    skill: {
      id: partial.id,
      name: partial.name ?? partial.id,
      description: partial.description ?? "",
      version: null,
      sha: "cd".repeat(32),
      body: partial.body ?? "body\n",
      category: partial.category ?? null,
      tags: partial.tags ?? [],
      references: partial.references ?? [],
      frontmatter: partial.frontmatter ?? {},
    },
    trigger: partial.trigger ?? "on_request",
    scope: partial.scope ?? { mode: "all", lanes: [] },
    runtimes: partial.runtimes ?? {
      claude: true,
      codex: true,
      grok: true,
      hermes: true,
      mini: true,
      nemoclaw: true,
    },
  };
}

function roundTrip(raw: string, id: string): { first: ReturnType<typeof parseSkillMarkdown>; second: ReturnType<typeof parseSkillMarkdown>; rendered: string } {
  const stored = storedFromNemoClawMarkdown({ raw, id });
  if (!stored.ok) throw new Error(stored.reason);
  const rendered = renderNemoClawDocument(stored.skill);
  assert.ok(rendered);
  const second = parseSkillMarkdown(rendered, id);
  assert.equal(second.parseProblem, null);
  return { first: parseSkillMarkdown(raw, id), second, rendered };
}

describe("NemoClaw frontmatter", () => {
  it("F1 keeps name, description, license, user_invocable, and metadata from NVIDIA shapes", () => {
    const guide = roundTrip(fixture("nemoclaw-skills-guide.md"), "nemoclaw-skills-guide");
    assert.equal(guide.second.name, "nemoclaw-skills-guide");
    assert.equal(guide.second.description, guide.first.description);
    assert.match(guide.second.description, /browse the skill catalog/);
    assert.equal(guide.second.frontmatter.license, "Apache-2.0");
    assert.equal(Object.prototype.hasOwnProperty.call(guide.second.frontmatter, "user_invocable"), false);
    assert.equal(guide.second.frontmatter.metadata, undefined);
    assert.equal(guide.rendered.includes("user_invocable"), false);
    assert.equal(guide.rendered.includes("metadata:"), false);
    assert.equal(guide.rendered.includes("version:"), false);
    assert.match(guide.second.body, /^NemoClaw skill fixture\./);

    const morning = roundTrip(fixture("nemoclaw-maintainer-morning.md"), "nemoclaw-maintainer-morning");
    assert.equal(morning.second.name, "nemoclaw-maintainer-morning");
    assert.equal(morning.second.description, morning.first.description);
    assert.match(morning.second.description, /select a target version/);
    assert.equal(morning.second.frontmatter.user_invocable, true);
    assert.equal(morning.second.frontmatter.license, undefined);
    assert.equal(morning.rendered.includes("license:"), false);
    assert.equal(morning.rendered.includes("metadata:"), false);

    const bare = roundTrip(fixture("nemoclaw-contributor-create-pr.md"), "nemoclaw-contributor-create-pr");
    assert.equal(bare.second.name, "nemoclaw-contributor-create-pr");
    assert.equal(bare.second.description, bare.first.description);
    assert.equal(bare.rendered.includes("license:"), false);
    assert.equal(bare.rendered.includes("user_invocable"), false);
    assert.equal(bare.rendered.includes("metadata:"), false);
    assert.equal(bare.rendered.includes("author:"), false);

    const meta = roundTrip(fixture("nemoclaw-user-agent-skills.md"), "nemoclaw-user-agent-skills");
    assert.equal(meta.second.frontmatter.license, "Apache-2.0");
    const metadata = meta.second.frontmatter.metadata as { author: string; tags: string[] };
    assert.equal(metadata.author, "Miyoung Choi <miyoungc@nvidia.com>");
    assert.deepEqual(metadata.tags, ["nemoclaw", "agent-skills", "installation", "claude-code", "cursor", "copilot"]);
    assert.equal(Object.prototype.hasOwnProperty.call(meta.second.frontmatter, "user_invocable"), false);

    const hidden = storedFromNemoClawMarkdown({
      raw: [
        "---",
        "name: hidden-fields",
        "description: Keep only the NemoClaw keys.",
        "license: Apache-2.0",
        "user_invocable: false",
        "homepage: https://example.invalid",
        "compatibility: Requires a sandbox",
        "allowed-tools: Read",
        "metadata:",
        "  author: Ada",
        "  extra: drop-me",
        "  tags:",
        "    - one",
        "---",
        "NemoClaw skill fixture.",
        "",
      ].join("\n"),
      id: "hidden-fields",
    });
    assert.equal(hidden.ok, true);
    if (!hidden.ok) return;
    hidden.skill.tags = ["store-tag-must-not-leak"];
    const leaked = renderNemoClawDocument(hidden.skill);
    assert.ok(leaked);
    const again = parseSkillMarkdown(leaked, "hidden-fields");
    assert.equal(again.parseProblem, null);
    assert.equal(again.frontmatter.user_invocable, false);
    assert.equal(again.frontmatter.license, "Apache-2.0");
    assert.equal(again.frontmatter.homepage, undefined);
    assert.equal(again.frontmatter.compatibility, undefined);
    assert.equal(again.frontmatter["allowed-tools"], undefined);
    const kept = again.frontmatter.metadata as { author?: string; extra?: string; tags?: string[] };
    assert.equal(kept.author, "Ada");
    assert.equal(kept.extra, undefined);
    assert.deepEqual(kept.tags, ["one"]);
    assert.equal(leaked.includes("store-tag-must-not-leak"), false);
    assert.equal(leaked.includes("drop-me"), false);
    assert.equal(leaked.includes("homepage"), false);
  });
});

describe("NemoClaw MCP rendering", { concurrency: false }, () => {
  const actor = { actor_type: "agent" as const, actor_id: "cred-nemoclaw" };

  beforeEach(() => {
    installSkillsSql();
    setSkillNowForTests(() => new Date(NOW));
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.NODE_ENV = "test";
    const raw = fixture("nemoclaw-user-agent-skills.md");
    const morning = fixture("nemoclaw-maintainer-morning.md");
    const meta = storedFromNemoClawMarkdown({ raw, id: "nemoclaw-user-agent-skills" });
    const day = storedFromNemoClawMarkdown({ raw: morning, id: "nemoclaw-maintainer-morning" });
    assert.equal(meta.ok && day.ok, true);
    if (!meta.ok || !day.ok) return;
    skillsMemory.skills.push(
      skill({
        id: meta.skill.id,
        name: meta.skill.name,
        description: meta.skill.description,
        sha: meta.skill.sha,
        body: meta.skill.body,
        tags: ["store-tag-must-not-leak"],
        frontmatter: meta.skill.frontmatter,
        references: [{ path: "references/agent-skills.md", content: "one reference line\n" }],
      }),
      skill({
        id: day.skill.id,
        name: day.skill.name,
        description: day.skill.description,
        sha: day.skill.sha,
        body: day.skill.body,
        frontmatter: day.skill.frontmatter,
      }),
      skill({
        id: "old-row",
        description: "Stored before nemoclaw existed.",
        body: "Old body.\n",
        runtimes: { claude: true, codex: true, grok: true, hermes: true, mini: true },
        frontmatter: { name: "old-row", description: "Stored before nemoclaw existed." },
      }),
    );
    for (const id of ["nemoclaw-user-agent-skills", "nemoclaw-maintainer-morning", "old-row"]) {
      skillsMemory.settings.push({
        skill_id: id,
        trigger: "on_request",
        scope: { mode: "all", lanes: [] },
        schedule: null,
        updated_by: null,
        updated_at: NOW,
      });
    }
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
    env.MC_TOKEN = saved.token;
    env.DATABASE_URL = saved.db;
    env.MC_DASHBOARD_PASSWORD = saved.password;
    env.NODE_ENV = saved.node;
  });

  it("F2 gives a nemoclaw caller the NemoClaw frontmatter and leaves other callers on their formats", async () => {
    const metaRow = skillsMemory.skills.find((item) => item.id === "nemoclaw-user-agent-skills");
    assert.ok(metaRow);
    const asFormat = metaRow as unknown as StoredFormat;
    const nemoclaw = textOf(await getSkillTool({ id: metaRow.id, runtime: "nemoclaw" }));
    assert.match(nemoclaw, /You are NemoClaw/);
    assert.match(nemoclaw, /license: Apache-2.0/);
    assert.match(nemoclaw, /author: "Miyoung Choi <miyoungc@nvidia.com>"/);
    assert.match(nemoclaw, /tags: \[nemoclaw, agent-skills, installation, claude-code, cursor, copilot\]/);
    assert.equal(nemoclaw.includes("user_invocable"), false);
    assert.equal(nemoclaw.includes("store-tag-must-not-leak"), false);
    assert.equal(nemoclaw.includes("allowed-tools"), false);
    const expected = renderNemoClawDocument(asFormat);
    assert.ok(expected);
    assert.ok(nemoclaw.includes(expected.trimEnd()));

    const claude = textOf(await getSkillTool({ id: metaRow.id, runtime: "claude" }));
    assert.match(claude, /You are Claude/);
    assert.match(claude, /NemoClaw skill fixture/);
    const beforeBody = claude.slice(0, claude.indexOf("NemoClaw skill fixture"));
    assert.equal(beforeBody.includes("---"), false);
    assert.equal(beforeBody.includes("metadata:"), false);
    assert.equal(beforeBody.includes("license:"), false);
    assert.equal(claude.includes("user_invocable"), false);

    const codex = textOf(await getSkillTool({ id: metaRow.id, runtime: "codex" }));
    const agents = renderAgentSkillsDocument(asFormat);
    assert.ok(agents);
    assert.ok(codex.includes(agents.trimEnd()));
    assert.match(codex, /You are Codex/);
    assert.equal(codex.includes("user_invocable"), false);

    const grok = textOf(await getSkillTool({ id: metaRow.id, runtime: "grok" }));
    assert.ok(grok.includes(agents.trimEnd()));
    assert.equal(grok.includes("user_invocable"), false);

    const hermes = textOf(await getSkillTool({ id: metaRow.id, runtime: "hermes" }));
    const hermesDoc = renderHermesDocument(asFormat);
    assert.ok(hermesDoc);
    assert.ok(hermes.includes(hermesDoc.trimEnd()));
    assert.match(hermes, /You are Hermes/);
    assert.equal(hermes.includes("user_invocable"), false);

    const mini = textOf(await getSkillTool({ id: metaRow.id, runtime: "mini" }));
    assert.match(mini, /You are the Mini worker/);
    assert.equal(mini.slice(0, mini.indexOf("NemoClaw skill fixture")).includes("---"), false);

    const omitted = textOf(await getSkillTool({ id: metaRow.id }));
    assert.match(omitted, /Runtime: not filtered/);
    assert.equal(omitted.includes("metadata:"), false);

    const morning = textOf(await getSkillTool({ id: "nemoclaw-maintainer-morning", runtime: "nemoclaw" }));
    assert.match(morning, /user_invocable: true/);
    assert.equal(morning.includes("license:"), false);
    const morningClaude = textOf(await getSkillTool({ id: "nemoclaw-maintainer-morning", runtime: "claude" }));
    assert.equal(morningClaude.includes("user_invocable"), false);

    const started = await runWithActor(actor, () => startSkillRun({
      id: "nemoclaw-maintainer-morning",
      runtime: "nemoclaw",
    }));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.match(started.text, /You are NemoClaw/);
    assert.match(started.text, /user_invocable: true/);

    const oldCaller = await getSkillTool({ id: "old-row", runtime: "nemoclaw" });
    assert.equal(oldCaller.isError, true);
    assert.match(textOf(oldCaller), /not compatible/);
    const oldClaude = textOf(await getSkillTool({ id: "old-row", runtime: "claude" }));
    assert.match(oldClaude, /Old body/);
    assert.equal(oldClaude.includes("metadata:"), false);
  });
});

describe("NemoClaw bundle export", { concurrency: false }, () => {
  beforeEach(() => {
    installSkillsSql();
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.NODE_ENV = "test";
    env.MC_TOKEN = "test-mc-token";
    delete env.MC_DASHBOARD_PASSWORD;
  });

  afterEach(() => {
    setSqlForTests(null);
    env.MC_TOKEN = saved.token;
    env.DATABASE_URL = saved.db;
    env.MC_DASHBOARD_PASSWORD = saved.password;
    env.NODE_ENV = saved.node;
  });

  it("F3 writes .agents/skills/<id>/SKILL.md and applies the bundle skip list", async () => {
    const morning = storedFromNemoClawMarkdown({
      raw: fixture("nemoclaw-maintainer-morning.md"),
      id: "nemoclaw-maintainer-morning",
    });
    assert.equal(morning.ok, true);
    if (!morning.ok) return;
    skillsMemory.skills.push(
      skill({
        id: morning.skill.id,
        name: morning.skill.name,
        description: morning.skill.description,
        body: morning.skill.body,
        category: "Engineering",
        frontmatter: morning.skill.frontmatter,
        references: [
          { path: "references/validation.md", content: "reference line\n" },
          { path: "../escape.md", content: "nope\n" },
          { path: "References/Guide.md", content: "first\n" },
          { path: "references/guide.md", content: "second\n" },
        ],
      }),
      skill({ id: "turned-off", body: "off body\n", description: "off" }),
      skill({ id: "bad trigger", body: "bad trigger body\n", description: "bad" }),
      skill({ id: "Not Safe", body: "unsafe body\n", description: "unsafe" }),
      skill({
        id: "old-export",
        body: "old export body\n",
        description: "old",
        runtimes: { claude: true, codex: true, grok: true, hermes: true, mini: true },
      }),
    );
    skillsMemory.settings.push(
      { skill_id: morning.skill.id, trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "turned-off", trigger: "off", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "bad trigger", trigger: "nope" as "off", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "Not Safe", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "old-export", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
    );

    const { GET } = await import("../../src/app/api/skill-bundles/route");
    const open = await GET(new Request("http://localhost/api/skill-bundles?runtime=nemoclaw", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(open.status, 200);
    assert.match(open.headers.get("content-disposition") ?? "", /skills-nemoclaw\.tar\.gz/);
    const files = readArchive(Buffer.from(await open.arrayBuffer()));
    const docPath = ".agents/skills/nemoclaw-maintainer-morning/SKILL.md";
    assert.match(files.get(docPath) ?? "", /user_invocable: true/);
    assert.equal([...files.keys()].some((name) => name.startsWith("Engineering/")), false);
    assert.equal(files.get(".agents/skills/nemoclaw-maintainer-morning/references/validation.md"), "reference line\n");
    assert.equal([...files.keys()].some((name) => name.includes("escape")), false);
    assert.equal([...files.values()].join("\n").includes("off body"), false);
    assert.equal([...files.values()].join("\n").includes("bad trigger body"), false);
    assert.equal([...files.values()].join("\n").includes("unsafe body"), false);
    assert.equal([...files.values()].join("\n").includes("old export body"), false);
    const skipped = JSON.parse(files.get("manifest.json") ?? "{}") as { skipped: { skill: string; path?: string; reason: string }[] };
    const reasons = skipped.skipped.map((entry) => `${entry.skill}:${entry.reason}`);
    assert.ok(reasons.some((reason) => reason.startsWith("bad trigger:invalid trigger")));
    assert.ok(reasons.some((reason) => reason.includes("Not Safe:unsafe skill name")));
    assert.ok(skipped.skipped.some((entry) => entry.skill === morning.skill.id && entry.reason === "unsafe reference"));
    assert.equal(reasons.some((reason) => reason.startsWith("turned-off:")), false);

    const unknown = await GET(new Request("http://localhost/api/skill-bundles?runtime=openclaw", {
      headers: { authorization: "Bearer test-mc-token" },
    }));
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, "validation_failed");

    const collided = buildBundle([
      bundleRow({ id: "same-skill", body: "one\n" }),
      bundleRow({ id: "same-skill", body: "two\n" }),
    ], { runtime: "nemoclaw", lane: null, category: null, query: null });
    assert.equal(collided.files.length, 0);
    assert.deepEqual(collided.skipped.map((entry) => entry.reason), ["duplicate archive path", "duplicate archive path"]);
  });
});

describe("NemoClaw runtime flag", () => {
  it("F4 parses an old stored compatibility row without a migration and without flipping flags", () => {
    const old = { claude: true, codex: false, grok: true, hermes: false, mini: true };
    const flags = flagsFromStored(JSON.parse(JSON.stringify(old)));
    assert.equal(flags.claude, true);
    assert.equal(flags.codex, false);
    assert.equal(flags.grok, true);
    assert.equal(flags.hermes, false);
    assert.equal(flags.mini, true);
    assert.equal(flags.nemoclaw, false);
    assert.notDeepEqual(flags, ALL_RUNTIMES);

    const previousAll = flagsFromStored({ claude: true, codex: true, grok: true, hermes: true, mini: true });
    assert.equal(previousAll.claude, true);
    assert.equal(previousAll.hermes, true);
    assert.equal(previousAll.nemoclaw, false);

    const explicit = flagsFromStored({ ...old, nemoclaw: true });
    assert.equal(explicit.nemoclaw, true);
    assert.equal(explicit.codex, false);
    assert.equal(flagsFromStored({ ...old, nemoclaw: false }).nemoclaw, false);
    assert.deepEqual(flagsFromStored("nope"), CLAUDE_ONLY);
    assert.equal(CLAUDE_ONLY.nemoclaw, false);

    const listed = resolveRuntimes({
      frontmatter: { runtimes: ["claude"] },
      body: "Plain.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.equal(listed.flags.claude, true);
    assert.equal(listed.flags.nemoclaw, false);
    assert.equal(listed.flags.hermes, false);

    const named = resolveRuntimes({
      frontmatter: { runtimes: ["nemoclaw", "hermes"] },
      body: "Plain.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.equal(named.flags.nemoclaw, true);
    assert.equal(named.flags.hermes, true);
    assert.equal(named.flags.claude, false);

    const inferred = resolveRuntimes({
      frontmatter: { name: "plain" },
      body: "Plain instructions.",
      sibling: null,
      siblingProblem: null,
      parseProblem: null,
    });
    assert.deepEqual(inferred.flags, ALL_RUNTIMES);
    assert.equal(inferred.flags.nemoclaw, true);
  });

  it("counts a nemoclaw run in the digest and leaves the other runtime counters alone", async () => {
    installSkillsSql();
    setSkillNowForTests(() => new Date(NOW));
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    skillsMemory.runs.push({
      run_id: "00000000-0000-4000-8000-0000000000aa",
      skill_id: "nemoclaw-user-agent-skills",
      skill_sha: "ab".repeat(32),
      agent_id: "nemoclaw-1",
      lane: null,
      runtime: "nemoclaw",
      started_at: NOW,
      ended_at: NOW,
      status: "done",
      note: null,
      actor_type: "agent",
      actor_id: "nemoclaw-1",
    });
    const digest = await skillsDigest("7d");
    assert.equal(digest.triggers_by_runtime.nemoclaw, 1);
    assert.equal(digest.triggers_by_runtime.claude, 0);
    assert.equal(digest.triggers_by_runtime.hermes, 0);
    assert.equal(digest.triggers_by_runtime.mini, 0);
    setSqlForTests(null);
    setSkillNowForTests(null);
    env.DATABASE_URL = saved.db;
  });
});

describe("NemoClaw list filter", { concurrency: false }, () => {
  beforeEach(() => {
    installSkillsSql();
    setSkillNowForTests(() => new Date(NOW));
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.NODE_ENV = "test";
    delete env.MC_DASHBOARD_PASSWORD;
    delete env.MC_TOKEN;
    skillsMemory.skills.push(
      skill({ id: "for-nemoclaw", description: "Visible to NemoClaw", body: "yes\n" }),
      skill({
        id: "claude-only",
        description: "Claude only",
        body: "no\n",
        runtimes: { claude: true, codex: false, grok: false, hermes: false, mini: false },
      }),
    );
    skillsMemory.settings.push(
      { skill_id: "for-nemoclaw", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "claude-only", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
    );
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
    env.DATABASE_URL = saved.db;
    env.NODE_ENV = saved.node;
    env.MC_TOKEN = saved.token;
    env.MC_DASHBOARD_PASSWORD = saved.password;
  });

  it("F5 accepts nemoclaw and still rejects an unknown runtime", async () => {
    const listed = textOf(await listSkillsTool({ runtime: "nemoclaw" }));
    assert.match(listed, /runtime filter: nemoclaw/);
    assert.match(listed, /for-nemoclaw/);
    assert.equal(listed.includes("claude-only"), false);

    const all = textOf(await listSkillsTool({}));
    assert.match(all, /runtime filter: none/);
    assert.match(all, /for-nemoclaw/);
    assert.match(all, /claude-only/);

    const message = runtimeMustBeMessage();
    assert.match(message, /claude, codex, grok, hermes, mini, or nemoclaw/);
    for (const runtime of ["openclaw", "claude-code", "NemoClaw", "nemoclaw "]) {
      const rejected = await listSkillsTool({ runtime });
      assert.equal(rejected.isError, true, runtime);
      assert.match(textOf(rejected), /runtime must be claude, codex, grok, hermes, mini, or nemoclaw/);
    }

    delete env.DATABASE_URL;
    const { GET } = await import("../../src/app/api/skills/route");
    const demo = await GET(new Request("http://localhost/api/skills?runtime=nemoclaw"));
    assert.equal(demo.status, 200);
    const ids = ((await demo.json()) as { skills: { id: string }[] }).skills.map((row) => row.id);
    assert.deepEqual(ids, ["verify-gibson"]);
    const bad = await GET(new Request("http://localhost/api/skills?runtime=openclaw"));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "validation_failed");
    const unfiltered = await GET(new Request("http://localhost/api/skills"));
    const every = ((await unfiltered.json()) as { skills: { id: string }[] }).skills.map((row) => row.id);
    assert.deepEqual(every, ["verify-gibson", "spec-writer", "operator-voice"]);
  });
});
