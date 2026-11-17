import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, planSync } from "../../src/lib/skills/plan";
import type { AssembledSkill } from "../../src/lib/skills/assemble";
import type { SkillRecord } from "../../src/lib/skills/types";

function candidate(frontmatter: Record<string, unknown>, over: Partial<AssembledSkill> = {}): AssembledSkill {
  return {
    id: "alpha",
    source_id: "master-skills",
    position: 0,
    path: "skills/alpha/SKILL.md",
    name: "alpha",
    description: "alpha does a job.",
    version: "1.0.0",
    sha: "a".repeat(64),
    body: "one",
    references: [{ path: "skills/alpha/references/a.md", content: "ref" }],
    runtimes: { claude: true, codex: true, grok: false, hermes: false, mini: false, nemoclaw: false },
    category: "build",
    tags: ["x", "y"],
    frontmatter,
    problems: [],
    ...over,
  };
}

function stored(skill: AssembledSkill, frontmatter: Record<string, unknown>): SkillRecord {
  return {
    id: skill.id,
    source_id: skill.source_id,
    path: skill.path,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    sha: skill.sha,
    commit_sha: "b".repeat(40),
    body: skill.body,
    references: skill.references,
    runtimes: skill.runtimes,
    category: skill.category,
    tags: skill.tags,
    frontmatter,
    removed_at: null,
    synced_at: "2026-10-27T12:00:00.000Z",
  };
}

function plan(existing: SkillRecord, next: AssembledSkill) {
  return planSync({
    failedSourceIds: [],
    successfulSourceIds: ["master-skills"],
    existing: [existing],
    candidates: [next],
    preserved: [],
  });
}

const upstream = {
  name: "alpha",
  description: "alpha does a job.",
  version: "1.0.0",
  metadata: { author: "vercel", version: "1.0.0", internal: false },
  runtimes: ["claude", "codex"],
  tags: ["x", "y"],
  list: [{ b: 1, a: 2 }, { d: null, c: "3" }],
};

/** Same values, keys in the order jsonb hands them back: shorter first, at every depth. */
const reordered = {
  name: "alpha",
  tags: ["x", "y"],
  list: [{ a: 2, b: 1 }, { c: "3", d: null }],
  version: "1.0.0",
  metadata: { author: "vercel", version: "1.0.0", internal: false },
  runtimes: ["claude", "codex"],
  description: "alpha does a job.",
};

describe("skill sync plan fingerprint", () => {
  it("plans no upsert when stored frontmatter keys come back reordered", () => {
    const next = candidate(upstream);
    const result = plan(stored(next, reordered), next);
    assert.deepEqual(result.upserts, []);
    assert.deepEqual(result.unchanged, ["alpha"]);
    assert.equal(fingerprint(next), fingerprint(stored(next, reordered)));
  });

  it("ignores key order inside nested maps and inside objects held in arrays", () => {
    const a = candidate({ outer: { z: { q: 1, p: [{ k: 1, j: 2 }] }, y: 2 } });
    const b = candidate({ outer: { y: 2, z: { p: [{ j: 2, k: 1 }], q: 1 } } });
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it("keeps array order meaningful", () => {
    const next = candidate({ ...upstream, runtimes: ["codex", "claude"] });
    assert.notEqual(fingerprint(next), fingerprint(candidate(upstream)));
    assert.deepEqual(plan(stored(next, upstream), next).upserts.map((row) => row.id), ["alpha"]);
    const objects = candidate({ list: [{ c: "3", d: null }, { a: 2, b: 1 }] });
    assert.notEqual(fingerprint(objects), fingerprint(candidate({ list: [{ a: 2, b: 1 }, { c: "3", d: null }] })));
  });

  it("tells boolean, string, number and null apart", () => {
    const values: unknown[] = [true, "true", false, "false", 1, "1", 0, "0", null, "null", "", [], {}];
    const prints = values.map((value) => fingerprint(candidate({ flag: value })));
    assert.equal(new Set(prints).size, values.length);
    assert.notEqual(fingerprint(candidate({ flag: null })), fingerprint(candidate({})));
  });

  it("still upserts a real content, metadata, runtime or source change", () => {
    const base = candidate(upstream);
    const changes: Partial<AssembledSkill>[] = [
      { body: "two" },
      { sha: "c".repeat(64) },
      { description: "alpha does another job." },
      { version: "1.0.1" },
      { category: "ops" },
      { tags: ["y", "x"] },
      { references: [{ path: "skills/alpha/references/a.md", content: "ref2" }] },
      { runtimes: { ...base.runtimes, grok: true } },
      { source_id: "other-skills" },
      { path: "skills/alpha2/SKILL.md" },
      { frontmatter: { ...reordered, metadata: { author: "vercel", version: "1.0.1", internal: false } } },
      { frontmatter: { ...reordered, extra: "new" } },
    ];
    for (const change of changes) {
      const next = candidate(upstream, change);
      const result = planSync({
        failedSourceIds: [],
        successfulSourceIds: ["master-skills", "other-skills"],
        existing: [stored(base, reordered)],
        candidates: [next],
        preserved: [],
      });
      assert.deepEqual(result.upserts.map((row) => row.id), ["alpha"], JSON.stringify(change));
    }
  });
});
