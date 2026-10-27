import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runWithActor } from "../../src/lib/actor";
import { setSqlForTests } from "../../src/lib/db";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { renderLaneSkillPointers } from "../../src/lib/skills/inject";
import { getSkillTool, listSkillsTool, runSkillTool } from "../../src/lib/skills/mcp";
import { finishSkillRun, startSkillRun } from "../../src/lib/skills/runs";
import { callsOf, installSkillsSql, skillsMemory, type MemSkill } from "./skills-memory";

const NOW = "2026-10-27T12:00:00.000Z";
const env = process.env as Record<string, string | undefined>;
const savedDb = env.DATABASE_URL;

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
    version: "1.2.0",
    sha: "ab".repeat(32),
    commit_sha: "c".repeat(40),
    body: partial.body ?? "Follow these steps.",
    references: partial.references ?? [{ path: "notes.md", content: "note body" }],
    runtimes: partial.runtimes ?? { claude: true, codex: true, grok: true, hermes: true, mini: true },
    category: partial.category ?? null,
    tags: partial.tags ?? [],
    frontmatter: {},
    removed_at: partial.removed_at ?? null,
    synced_at: NOW,
  };
}

const actorA = { actor_type: "agent" as const, actor_id: "cred-a" };
const actorB = { actor_type: "agent" as const, actor_id: "cred-b" };

describe("skill MCP tools", { concurrency: false }, () => {
  beforeEach(() => {
    installSkillsSql();
    setSkillNowForTests(() => new Date(NOW));
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    skillsMemory.skills.push(
      skill({ id: "open", description: "Open to every lane" }),
      skill({ id: "picked", description: "Selected lanes only" }),
      skill({ id: "claude-only", description: "Claude machinery", runtimes: { claude: true, codex: false, grok: false, hermes: false, mini: false } }),
      skill({ id: "retired", removed_at: NOW }),
    );
    skillsMemory.settings.push(
      { skill_id: "open", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "picked", trigger: "auto_inject", scope: { mode: "selected", lanes: ["conference-os"] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "claude-only", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "retired", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
    );
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
    if (savedDb === undefined) delete env.DATABASE_URL;
    else env.DATABASE_URL = savedDb;
  });

  it("filters by category, treats uncategorized as null, and prints tags", async () => {
    skillsMemory.skills.push(skill({
      id: "labeled",
      description: "Labeled skill",
      category: "Engineering Tools",
      tags: ["fleet"],
    }));
    skillsMemory.settings.push({
      skill_id: "labeled",
      trigger: "on_request",
      scope: { mode: "all", lanes: [] },
      schedule: null,
      updated_by: null,
      updated_at: NOW,
    });
    const hit = textOf(await listSkillsTool({ category: "engineering tools" }));
    assert.match(hit, /category filter: engineering tools/);
    assert.match(hit, /category: Engineering Tools; tags: fleet/);
    assert.equal(hit.includes("- open"), false);

    const none = textOf(await listSkillsTool({ category: "uncategorized" }));
    assert.match(none, /- open /);
    assert.match(none, /category: uncategorized; tags: none/);
    assert.equal(none.includes("labeled"), false);
  });

  it("hides off, removed, wrong runtime, and selected skills with no lane", async () => {
    const listed = await listSkillsTool({});
    const text = textOf(listed);
    assert.match(text, /runtime filter: none/);
    assert.match(text, /open /);
    assert.match(text, /claude-only/);
    assert.equal(text.includes("picked"), false);
    assert.equal(text.includes("retired"), false);
    assert.match(text, /\(1\.2\.0, abababa\)/);
    assert.equal(text.includes("abababab"), false);

    const grok = textOf(await listSkillsTool({ runtime: "grok" }));
    assert.equal(grok.includes("claude-only"), false);
    assert.match(grok, /open /);

    const lane = textOf(await listSkillsTool({ lane: "conference-os", query: "SELECTED" }));
    assert.match(lane, /picked/);
    assert.equal(lane.includes("open"), false);

    const wrongLane = textOf(await listSkillsTool({ lane: "chatterbuilt" }));
    assert.equal(wrongLane.includes("picked"), false);

    const off = await getSkillTool({ id: "retired" });
    assert.equal(off.isError, true);
    assert.match(textOf(off), /not available/);

    const noLane = await getSkillTool({ id: "picked" });
    assert.equal(noLane.isError, true);
    assert.match(textOf(noLane), /pass lane/);

    const otherLane = await getSkillTool({ id: "picked", lane: "chatterbuilt" });
    assert.equal(otherLane.isError, true);
    assert.match(textOf(otherLane), /not in scope/);

    const wrongRuntime = await getSkillTool({ id: "claude-only", runtime: "grok" });
    assert.equal(wrongRuntime.isError, true);
    assert.match(textOf(wrongRuntime), /not compatible/);

    const body = textOf(await getSkillTool({ id: "open", runtime: "grok" }));
    assert.match(body, /^# open/);
    assert.match(body, /Pinned SHA: abababababababababababababababababababababababababababababababab/);
    assert.match(body, /You are Grok/);
    assert.match(body, /Follow these steps/);
    assert.equal(callsOf("sk:upsert-skill"), 0);

    const ref = textOf(await getSkillTool({ id: "open", path: "notes.md" }));
    assert.match(ref, /note body/);
    assert.match(ref, /Pinned SHA:/);
    const missingRef = await getSkillTool({ id: "open", path: "nope.md" });
    assert.equal(missingRef.isError, true);
  });

  it("starts a run, writes a span, and lets only that actor finish it once", async () => {
    const started = await runWithActor(actorA, () => startSkillRun({
      id: "open",
      agentId: "grok-lane-1",
      runtime: "grok",
      lane: "conference-os",
    }));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.match(started.text, new RegExp(`Pinned SHA: ${"ab".repeat(32)}`));
    assert.match(started.text, /Call run_skill again with this run_id and complete:true when you finish/);
    assert.ok(started.text.includes(`run_id: ${started.runId}`));
    const span = skillsMemory.spans[0];
    assert.equal(span?.name, "skill:open");
    assert.equal(span?.kind, "tool");
    assert.equal(span?.status, "unset");
    assert.equal(span?.trace_id, started.runId.replace(/-/g, ""));
    assert.equal(span?.span_id, span?.trace_id.slice(0, 16));
    assert.equal(span?.agent_id, "grok-lane-1");
    assert.equal(span?.attributes.skill_id, "open");
    assert.equal(skillsMemory.runs[0]?.status, "running");

    const other = await runWithActor(actorB, () => finishSkillRun({ runId: started.runId, status: "done", note: "stolen" }));
    assert.equal(other.ok, false);
    if (other.ok) return;
    assert.equal(other.code, "forbidden");
    assert.equal(skillsMemory.runs[0]?.ended_at, null);
    assert.equal(skillsMemory.runs[0]?.note, null);

    const done = await runWithActor(actorA, () => finishSkillRun({ runId: started.runId, status: "failed", note: "first note" }));
    assert.equal(done.ok, true);
    if (!done.ok) return;
    assert.match(done.text, /status: failed/);
    assert.match(done.text, /first note/);
    const again = await runWithActor(actorA, () => finishSkillRun({ runId: started.runId, status: "done", note: "second note" }));
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.text, done.text);
    assert.equal(skillsMemory.runs[0]?.note, "first note");
    assert.equal(skillsMemory.runs[0]?.status, "failed");
    assert.equal(skillsMemory.spans[0]?.status, "error");
    assert.ok(skillsMemory.spans[0]?.ended_at);

    const unknown = await runWithActor(actorA, () => finishSkillRun({ runId: "00000000-0000-4000-8000-000000000099" }));
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, "not_found");
  });

  it("refuses a start with no actor and deletes the run when the span write fails", async () => {
    const none = await startSkillRun({ id: "open", agentId: "grok-lane-1", runtime: "grok" });
    assert.equal(none.ok, false);
    if (!none.ok) assert.equal(none.code, "forbidden");
    assert.equal(skillsMemory.runs.length, 0);

    skillsMemory.throwOnSpan = true;
    await assert.rejects(() => runWithActor(actorA, () => startSkillRun({
      id: "open",
      agentId: "grok-lane-1",
      runtime: "grok",
    })));
    assert.equal(skillsMemory.runs.length, 0);
  });

  it("rejects a partial completion and a note over 500 characters", async () => {
    const partial = await runSkillTool({ id: "open", run_id: "00000000-0000-4000-8000-000000000001" });
    assert.equal(partial.isError, true);
    assert.match(textOf(partial), /complete:true/);
    const noId = await runSkillTool({ id: "open", complete: true });
    assert.equal(noId.isError, true);
    const long = await runWithActor(actorA, () => startSkillRun({ id: "open", agentId: "a", runtime: "grok" }));
    assert.equal(long.ok, true);
    if (!long.ok) return;
    const tooLong = await runWithActor(actorA, () => finishSkillRun({ runId: long.runId, note: "x".repeat(501) }));
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.equal(tooLong.code, "validation_failed");
    assert.equal(skillsMemory.runs[0]?.ended_at, null);
  });

  it("gates run_skill the same way and does not serve trigger off", async () => {
    skillsMemory.settings.find((row) => row.skill_id === "open")!.trigger = "off";
    const off = await runWithActor(actorA, () => runSkillTool({ id: "open", agent_id: "g", runtime: "grok" }));
    assert.equal(off.isError, true);
    assert.match(textOf(off), /not available/);
    const picked = await runWithActor(actorA, () => runSkillTool({ id: "picked", agent_id: "g", runtime: "grok" }));
    assert.equal(picked.isError, true);
    const started = await runWithActor(actorA, () => runSkillTool({
      id: "picked",
      agent_id: "g",
      runtime: "grok",
      lane: "conference-os",
    }));
    assert.equal(started.isError, undefined);
    assert.match(textOf(started), /run_id:/);
  });

  it("renders auto-inject pointers for the lane and nothing when none match", async () => {
    const block = await renderLaneSkillPointers({ lane: "conference-os", runtime: "grok" });
    assert.match(block, /<!-- ak-skills:begin -->/);
    assert.match(block, /- picked \(1\.2\.0, abababa\)/);
    assert.equal(block.includes("open"), false);
    assert.equal(block.includes("claude-only"), false);
    const empty = await renderLaneSkillPointers({ lane: "chatterbuilt", runtime: "grok" });
    assert.equal(empty, "");
    const badRuntime = await renderLaneSkillPointers({ lane: "conference-os", runtime: "basic" });
    assert.equal(badRuntime, "");
  });

  it("treats a corrupt stored scope as selected with no lanes", async () => {
    skillsMemory.settings = skillsMemory.settings.filter((row) => row.skill_id !== "open");
    skillsMemory.settings.push({
      skill_id: "open",
      trigger: "on_request",
      scope: { mode: "everywhere" },
      schedule: null,
      updated_by: null,
      updated_at: NOW,
    });
    const listed = textOf(await listSkillsTool({ lane: "conference-os" }));
    assert.equal(listed.includes("- open"), false);
  });

  it("does not store a demo run and still rejects an incompatible runtime", async () => {
    delete env.DATABASE_URL;
    const started = await runSkillTool({
      id: "verify-gibson",
      agent_id: "grok-lane-1",
      runtime: "grok",
      note: "probe-note",
    });
    assert.equal(textOf(started), "DATABASE_URL not set; skill run not stored.");
    assert.equal(textOf(started).includes("probe-note"), false);
    const wrong = await runSkillTool({ id: "operator-voice", agent_id: "grok-lane-1", runtime: "grok" });
    assert.equal(wrong.isError, true);
    assert.match(textOf(wrong), /not compatible/);
  });
});
