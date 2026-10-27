import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setSqlForTests } from "../../src/lib/db";
import { demoSkillsDigest } from "../../src/lib/skills/demo";
import { skillsDigest } from "../../src/lib/skills/digest";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { formatDigest } from "../../src/lib/progress-digest";
import { buildAlerts } from "../../src/lib/progress-store";
import type { ProgressResponse } from "../../src/lib/progress-types";
import { installSkillsSql, skillsMemory } from "./skills-memory";

const NOW = "2026-10-27T12:00:00.000Z";
const env = process.env as Record<string, string | undefined>;
const saved = { db: env.DATABASE_URL, stall: env.AK_SKILL_STALL_MINUTES };

function shell(skills: ProgressResponse["skills"]): ProgressResponse {
  return {
    demo: false,
    window: "7d",
    last_sync: null,
    baseline_at: null,
    window_complete: true,
    repos: [],
    totals: {
      merged_prs: 0,
      issues_closed: 0,
      issues_opened: 0,
      net_backlog: 0,
      open_issues: 0,
      open_prs: 0,
      spend_usd: null,
      lane_mix: {},
    },
    history: [],
    alerts: [],
    skills,
    generated_at: NOW,
  };
}

describe("skills digest and stalled alerts", { concurrency: false }, () => {
  beforeEach(() => {
    installSkillsSql();
    setSkillNowForTests(() => new Date(NOW));
    env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
    env.AK_SKILL_STALL_MINUTES = "60";
    skillsMemory.skills.push(
      {
        id: "alpha",
        source_id: "master-skills",
        path: "skills/alpha/SKILL.md",
        name: "alpha",
        description: "Alpha",
        version: "1",
        sha: "a".repeat(64),
        commit_sha: null,
        body: "a",
        references: [],
        runtimes: { claude: true, codex: false, grok: false, hermes: false, mini: false },
        frontmatter: {},
        removed_at: null,
        synced_at: NOW,
      },
      {
        id: "beta",
        source_id: "master-skills",
        path: "skills/beta/SKILL.md",
        name: "beta",
        description: "Beta",
        version: "1",
        sha: "b".repeat(64),
        commit_sha: null,
        body: "b",
        references: [],
        runtimes: { claude: false, codex: true, grok: false, hermes: false, mini: false },
        frontmatter: {},
        removed_at: null,
        synced_at: NOW,
      },
    );
    skillsMemory.settings.push(
      { skill_id: "alpha", trigger: "on_request", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
      { skill_id: "beta", trigger: "auto_inject", scope: { mode: "all", lanes: [] }, schedule: null, updated_by: null, updated_at: NOW },
    );
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
    if (saved.db === undefined) delete env.DATABASE_URL;
    else env.DATABASE_URL = saved.db;
    if (saved.stall === undefined) delete env.AK_SKILL_STALL_MINUTES;
    else env.AK_SKILL_STALL_MINUTES = saved.stall;
  });

  it("counts the window, keeps an older stall, and names skills that were not used", async () => {
    skillsMemory.runs.push(
      {
        run_id: "00000000-0000-4000-8000-000000000001",
        skill_id: "alpha",
        skill_sha: "a".repeat(64),
        agent_id: "grok-1",
        lane: null,
        runtime: "grok",
        started_at: "2026-10-27T11:00:00.000Z",
        ended_at: "2026-10-27T11:05:00.000Z",
        status: "done",
        note: null,
        actor_type: "agent",
        actor_id: "a",
      },
      {
        run_id: "00000000-0000-4000-8000-000000000002",
        skill_id: "alpha",
        skill_sha: "a".repeat(64),
        agent_id: "codex-1",
        lane: null,
        runtime: "codex",
        started_at: "2026-10-01T08:00:00.000Z",
        ended_at: null,
        status: "running",
        note: null,
        actor_type: "agent",
        actor_id: "b",
      },
    );
    const digest = await skillsDigest("7d");
    assert.equal(digest.note, "Only triggers routed through Agent Kontrol are counted.");
    assert.deepEqual(digest.triggers_by_skill, [{ id: "alpha", count: 1 }]);
    assert.equal(digest.triggers_by_runtime.grok, 1);
    assert.equal(digest.triggers_by_runtime.codex, 0);
    assert.deepEqual(digest.stalled.map((row) => row.run_id), ["00000000-0000-4000-8000-000000000002"]);
    assert.deepEqual(digest.enabled_never_used, ["beta"]);
    const text = formatDigest(shell(digest));
    assert.match(text, /Skills — triggers in the last 7d/);
    assert.match(text, /Only triggers routed through Agent Kontrol are counted/);
    assert.match(text, /alpha {2}1/);
    assert.match(text, /Stalled runs: alpha \(codex-1\)/);
    assert.match(text, /Enabled, not used in this window: beta/);
  });

  it("rolls more than three stalled runs into one alert and leaves a two-argument call alone", async () => {
    const one = buildAlerts([], []);
    assert.equal(one.some((alert) => alert.rule === "skillStalled"), false);
    const two = buildAlerts([], [], [
      { run_id: "r1", skill_id: "alpha", agent: "a", at: NOW },
      { run_id: "r2", skill_id: "beta", agent: "b", at: NOW },
    ]);
    assert.equal(two.filter((alert) => alert.rule === "skillStalled").length, 2);
    assert.equal(two[0]?.id, "skill-stalled:r1");
    assert.equal(two[0]?.level, "warn");
    const many = buildAlerts([], [], [
      { run_id: "r1", skill_id: "alpha", agent: "a", at: NOW },
      { run_id: "r2", skill_id: "beta", agent: "b", at: NOW },
      { run_id: "r3", skill_id: "c", agent: "c", at: NOW },
      { run_id: "r4", skill_id: "d", agent: "d", at: NOW },
    ]);
    assert.equal(many.length, 1);
    assert.equal(many[0]?.id, "skill-stalled:4");
    assert.match(many[0]?.message ?? "", /after 60 minutes/);
    env.AK_SKILL_STALL_MINUTES = "15";
    const overridden = buildAlerts([], [], [
      { run_id: "r1", skill_id: "alpha", agent: "a", at: NOW },
      { run_id: "r2", skill_id: "beta", agent: "b", at: NOW },
      { run_id: "r3", skill_id: "c", agent: "c", at: NOW },
      { run_id: "r4", skill_id: "d", agent: "d", at: NOW },
    ]);
    assert.match(overridden[0]?.message ?? "", /after 15 minutes/);
    const demo = demoSkillsDigest("7d");
    assert.equal(demo.note, "Only triggers routed through Agent Kontrol are counted.");
    assert.equal(demo.stalled[0]?.skill_id, "verify-gibson");
    assert.match(formatDigest(shell(demo)), /Enabled, not used in this window: operator-voice, spec-writer/);
  });
});
