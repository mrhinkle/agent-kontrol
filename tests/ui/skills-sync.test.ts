import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setSqlForTests } from "../../src/lib/db";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { syncSkills } from "../../src/lib/skills/sync";
import type { SkillSnapshot, SkillSnapshotFetcher } from "../../src/lib/skills/source";
import type { SkillSourceRow } from "../../src/lib/skills/types";
import { callsOf, installSkillsSql, skillsMemory } from "./skills-memory";

const NOW = "2026-10-27T12:00:00.000Z";

function md(dir: string, body: string, extra = ""): { path: string; content: string } {
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  return {
    path: `${dir}/SKILL.md`,
    content: `---\nname: ${name}\ndescription: ${name} does a job.\nversion: 1.0.0\n${extra}---\n${body}\n`,
  };
}

function fetcher(map: Record<string, Partial<SkillSnapshot> | Error>): SkillSnapshotFetcher {
  return {
    async fetch(source: SkillSourceRow) {
      const hit = map[source.id];
      if (!hit) return { commit_sha: "0".repeat(40), files: [], skipped: [], preserved_dirs: [] };
      if (hit instanceof Error) throw hit;
      return {
        commit_sha: hit.commit_sha ?? "0".repeat(40),
        files: hit.files ?? [],
        skipped: hit.skipped ?? [],
        preserved_dirs: hit.preserved_dirs ?? [],
      };
    },
  };
}

describe("skill sync", { concurrency: false }, () => {
  beforeEach(() => {
    installSkillsSql();
    setSkillNowForTests(() => new Date(NOW));
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
  });

  it("adds, changes, removes, and does not write rows when nothing changed", async () => {
    const first = fetcher({
      "master-skills": { commit_sha: "a".repeat(40), files: [md("skills/alpha", "one")] },
    });
    const added = await syncSkills({ trigger: "manual", fetcher: first });
    assert.equal(added.status, "ok");
    assert.deepEqual(added.added.map((row) => row.id), ["alpha"]);
    assert.deepEqual(added.changed, []);
    assert.deepEqual(added.removed, []);
    assert.equal(skillsMemory.skills[0]?.commit_sha, "a".repeat(40));
    assert.equal(skillsMemory.skills[0]?.path, "skills/alpha/SKILL.md");
    assert.equal(added.upstream.sha, "a".repeat(40));
    assert.equal(added.upstream.source, "master-skills");
    const upserts = callsOf("sk:upsert-skill");

    const same = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "b".repeat(40), files: [md("skills/alpha", "one")] },
      }),
    });
    assert.equal(same.status, "ok");
    assert.deepEqual(same.added, []);
    assert.deepEqual(same.changed, []);
    assert.deepEqual(same.removed, []);
    assert.equal(callsOf("sk:upsert-skill"), upserts);
    assert.equal(callsOf("sk:remove-skill"), 0);
    assert.equal(skillsMemory.skills[0]?.commit_sha, "a".repeat(40));
    assert.equal(same.upstream.sha, "b".repeat(40));

    const changed = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "c".repeat(40), files: [md("skills/alpha", "two")] },
      }),
    });
    assert.equal(changed.status, "ok");
    assert.deepEqual(changed.changed.map((row) => row.id), ["alpha"]);
    assert.equal(skillsMemory.skills[0]?.commit_sha, "c".repeat(40));
    assert.notEqual(skillsMemory.skills[0]?.sha, added.added[0]?.sha);

    const removed = await syncSkills({
      trigger: "scheduled",
      fetcher: fetcher({ "master-skills": { commit_sha: "d".repeat(40), files: [] } }),
    });
    assert.equal(removed.status, "ok");
    assert.deepEqual(removed.removed, ["alpha"]);
    assert.ok(skillsMemory.skills[0]?.removed_at);
  });

  it("keeps existing rows when a source cannot be fetched", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "a".repeat(40), files: [md("skills/keep", "stay")] },
      }),
    });
    const before = skillsMemory.skills[0]?.sha;
    const failed = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({ "master-skills": new Error("GitHub 503") }),
    });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.removed, []);
    assert.equal(callsOf("sk:remove-skill"), 0);
    assert.equal(skillsMemory.skills[0]?.sha, before);
    assert.equal(skillsMemory.skills[0]?.removed_at, null);
    assert.match(failed.errors.map((item) => item.message).join(" "), /GitHub 503/);
    assert.equal(failed.upstream.sha, "a".repeat(40));
  });

  it("does not let a later source take an id owned by a source that failed", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "a".repeat(40), files: [md("skills/shared", "original")] },
      }),
    });
    const failed = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": new Error("cannot fetch"),
        "the-gibson": { commit_sha: "e".repeat(40), files: [md("skills/shared", "stolen")] },
      }),
    });
    assert.equal(failed.status, "failed");
    assert.equal(skillsMemory.skills.filter((row) => row.id === "shared").length, 1);
    assert.equal(skillsMemory.skills[0]?.source_id, "master-skills");
    assert.match(skillsMemory.skills[0]?.body ?? "", /original/);
    assert.equal(failed.removed.length, 0);
    assert.ok(failed.conflicts.some((row) => row.id === "shared" && row.kept_source === "master-skills" && row.dropped_source === "the-gibson"));
  });

  it("reports an id collision and stores the earlier source", async () => {
    const result = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "a".repeat(40), files: [md("skills/shared", "first")] },
        "the-gibson": { commit_sha: "e".repeat(40), files: [md("skills/shared", "second")] },
      }),
    });
    assert.equal(result.status, "ok");
    assert.equal(skillsMemory.skills.length, 1);
    assert.equal(skillsMemory.skills[0]?.source_id, "master-skills");
    assert.match(skillsMemory.skills[0]?.body ?? "", /first/);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.kept_source, "master-skills");
    assert.equal(result.conflicts[0]?.dropped_source, "the-gibson");
    assert.equal(result.conflicts[0]?.path, "skills/shared/SKILL.md");
  });

  it("keeps the first path when one source emits the same id twice", async () => {
    const result = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "the-gibson": {
          commit_sha: "e".repeat(40),
          files: [md("skills/dup", "later"), md(".agents/skills/dup", "earlier")],
        },
      }),
    });
    assert.equal(result.status, "ok");
    assert.equal(skillsMemory.skills.filter((row) => row.id === "dup").length, 1);
    assert.equal(skillsMemory.skills[0]?.path, ".agents/skills/dup/SKILL.md");
    assert.equal(result.conflicts[0]?.kept_source, "the-gibson");
    assert.equal(result.conflicts[0]?.dropped_source, "the-gibson");
    assert.equal(result.conflicts[0]?.path, "skills/dup/SKILL.md");
  });

  it("stores a parse problem as claude-only and marks the sync failed", async () => {
    const result = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": {
          commit_sha: "a".repeat(40),
          files: [{ path: "skills/bad/SKILL.md", content: "---\nname: bad\n\tops: 1\n---\nBody\n" }],
        },
      }),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.added[0]?.id, "bad");
    assert.equal(skillsMemory.skills[0]?.runtimes.claude, true);
    assert.equal(skillsMemory.skills[0]?.runtimes.codex, false);
    assert.equal(skillsMemory.skills[0]?.runtimes.grok, false);
    assert.equal(skillsMemory.skills[0]?.runtimes.hermes, false);
    assert.equal(skillsMemory.skills[0]?.runtimes.mini, false);
  });

  it("records an unknown runtime name without failing the sync", async () => {
    const result = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": {
          commit_sha: "a".repeat(40),
          files: [md("skills/partial", "Body", "runtimes: [grok, not-a-runtime]\n")],
        },
      }),
    });
    assert.equal(result.status, "ok");
    assert.equal(skillsMemory.skills[0]?.runtimes.grok, true);
    assert.equal(skillsMemory.skills[0]?.runtimes.claude, false);
    assert.match(result.errors.map((item) => item.message).join(" "), /not-a-runtime/);
  });

  it("keeps a skill whose SKILL.md could not be read", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "a".repeat(40), files: [md("skills/keep", "stay")] },
      }),
    });
    const result = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": {
          commit_sha: "b".repeat(40),
          files: [],
          skipped: [{ path: "skills/keep/SKILL.md", reason: "over 1 MB" }],
          preserved_dirs: ["skills/keep"],
        },
      }),
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.removed, []);
    assert.equal(skillsMemory.skills[0]?.removed_at, null);
    assert.match(skillsMemory.skills[0]?.body ?? "", /stay/);
  });

  it("returns busy and does not fetch when a sync is already running", async () => {
    skillsMemory.syncRuns.push({
      id: "11111111-1111-4111-8111-111111111111",
      started_at: "2026-10-27T11:55:00.000Z",
      finished_at: null,
      trigger: "manual",
      status: "running",
      summary: null,
      error: null,
    });
    let fetched = false;
    const result = await syncSkills({
      trigger: "manual",
      fetcher: {
        async fetch() {
          fetched = true;
          throw new Error("must not fetch");
        },
      },
    });
    assert.equal(result.status, "busy");
    assert.equal(fetched, false);
    assert.deepEqual(result.added, []);
    assert.equal(callsOf("sk:upsert-skill"), 0);
    assert.equal(skillsMemory.syncRuns.filter((row) => row.status === "running").length, 1);
  });

  it("expires a running row older than 10 minutes and then syncs", async () => {
    skillsMemory.syncRuns.push({
      id: "22222222-2222-4222-8222-222222222222",
      started_at: "2026-10-27T11:49:00.000Z",
      finished_at: null,
      trigger: "manual",
      status: "running",
      summary: null,
      error: null,
    });
    const result = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "a".repeat(40), files: [md("skills/alpha", "one")] },
      }),
    });
    assert.equal(result.status, "ok");
    const expired = skillsMemory.syncRuns.find((row) => row.id.startsWith("22222222"));
    assert.equal(expired?.status, "failed");
    assert.equal(expired?.error, "sync lease expired");
    assert.equal(result.added[0]?.id, "alpha");
  });

  it("brings a removed skill back as added", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "a".repeat(40), files: [md("skills/alpha", "one")] },
      }),
    });
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({ "master-skills": { commit_sha: "b".repeat(40), files: [] } }),
    });
    const back = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { commit_sha: "c".repeat(40), files: [md("skills/alpha", "one")] },
      }),
    });
    assert.deepEqual(back.added.map((row) => row.id), ["alpha"]);
    assert.equal(skillsMemory.skills[0]?.removed_at, null);
  });
});
