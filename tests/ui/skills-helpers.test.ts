import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyOptimisticSkillPatch,
  dimSkillRow,
  excludedByRuntime,
  filterSkills,
  formatVersion,
  isClaudeOnly,
  isCronNonEmpty,
  laneOptions,
  mergePolledSkills,
  rollbackSkill,
  shortSha,
  showClaudeOnlyFlag,
  showHermesClaudeOnlyNote,
  skillDetailPath,
  skillSourceUrl,
  skillsQuery,
} from "../../src/components/SkillHelpers";
import { skillDetailFixture, skillsListFixture } from "./skills-fixtures";

const skills = skillsListFixture.skills;

describe("skills helpers", () => {
  it("detects a runtime list that is exactly claude", () => {
    assert.equal(isClaudeOnly(["claude"]), true);
    assert.equal(isClaudeOnly(skills.find((skill) => skill.id === "mark-hinkle-voice")!.runtimes), true);
    assert.equal(isClaudeOnly(["claude", "codex"]), false);
    assert.equal(isClaudeOnly(["Claude"]), false);
    assert.equal(isClaudeOnly([]), false);
  });

  it("flags claude-only skills and skills excluded by the active runtime filter", () => {
    const voice = ["claude"];
    assert.equal(showClaudeOnlyFlag(voice, "all"), true);
    assert.equal(showClaudeOnlyFlag(voice, "grok"), true);
    assert.equal(dimSkillRow(voice, "grok"), true);
    assert.equal(dimSkillRow(voice, "all"), false);
    assert.equal(dimSkillRow(voice, "claude"), false);
    assert.equal(excludedByRuntime(["hermes"], "grok"), true);
    assert.equal(showClaudeOnlyFlag(["claude", "grok"], "grok"), false);
    assert.equal(dimSkillRow(["claude", "grok"], "grok"), false);
  });

  it("unions lane names across the fixture", () => {
    assert.deepEqual(laneOptions(skills), ["agent-kontrol", "chatterbuilt", "conference-os", "owner"]);
    assert.deepEqual(laneOptions([{ scope: { lanes: [" z ", "a", ""] } }, { scope: { lanes: ["a", "z"] } }]), ["a", "z"]);
  });

  it("accepts only a non-empty cron string", () => {
    assert.equal(isCronNonEmpty("0 7 * * *"), true);
    assert.equal(isCronNonEmpty("  0 7 * * *  "), true);
    assert.equal(isCronNonEmpty(skills.find((skill) => skill.id === "morning-brief")!.schedule), true);
    assert.equal(isCronNonEmpty("   "), false);
    assert.equal(isCronNonEmpty(""), false);
    assert.equal(isCronNonEmpty(null), false);
    assert.equal(isCronNonEmpty(undefined), false);
  });

  it("applies an optimistic patch without mutating, then rolls it back", () => {
    const before = skills.find((skill) => skill.id === "spec-writer")!;
    const patched = applyOptimisticSkillPatch(skills, "spec-writer", {
      trigger: "off",
      scope: { mode: "selected", lanes: ["conference-os"] },
    });
    const next = patched.find((skill) => skill.id === "spec-writer")!;
    assert.equal(next.trigger, "off");
    assert.deepEqual(next.scope, { mode: "selected", lanes: ["conference-os"] });
    assert.equal(before.trigger, "auto_inject");
    assert.deepEqual(before.scope.lanes, ["conference-os", "chatterbuilt"]);
    assert.notEqual(next, before);

    const rolled = rollbackSkill(patched, before);
    assert.equal(rolled.find((skill) => skill.id === "spec-writer"), before);
    assert.equal(applyOptimisticSkillPatch(skills, "missing", { trigger: "off" }).find((skill) => skill.id === "verify-gibson")?.trigger, "on_request");
  });

  it("keeps held rows when a poll arrives", () => {
    const current = skills;
    const incoming = skills.map((skill) => (skill.id === "verify-gibson" ? { ...skill, trigger: "off" as const } : skill));
    const withoutVoice = incoming.filter((skill) => skill.id !== "mark-hinkle-voice");
    const held = new Set(["verify-gibson", "mark-hinkle-voice"]);
    const merged = mergePolledSkills(current, withoutVoice, held);
    assert.equal(merged.find((skill) => skill.id === "verify-gibson")?.trigger, "on_request");
    assert.equal(merged.some((skill) => skill.id === "mark-hinkle-voice"), true);
    assert.equal(merged.find((skill) => skill.id === "morning-brief")?.trigger, "scheduled");
    assert.deepEqual(mergePolledSkills(current, incoming, new Set()), incoming);
  });

  it("builds the runtime and q query string", () => {
    assert.equal(skillsQuery({}), "");
    assert.equal(skillsQuery({ runtime: "all", q: "  " }), "");
    assert.equal(skillsQuery({ runtime: "grok" }), "?runtime=grok");
    assert.equal(skillsQuery({ q: "voice" }), "?q=voice");
    assert.equal(skillsQuery({ runtime: "claude", q: "spec writer" }), "?runtime=claude&q=spec+writer");
  });

  it("filters, formats, and reads a source url only when one was sent", () => {
    assert.equal(filterSkills(skills, "VOICE").map((skill) => skill.id).join(), "mark-hinkle-voice");
    assert.equal(filterSkills(skills, "  ").length, skills.length);
    assert.equal(formatVersion("1.2.0"), "v1.2.0");
    assert.equal(formatVersion("v2"), "v2");
    assert.equal(shortSha(skillsListFixture.upstream.sha), "a1b2c3d");
    assert.equal(skillDetailPath("a/b"), "/skills/a%2Fb");
    assert.equal(skillSourceUrl(skillDetailFixture), skillDetailFixture.sourceUrl);
    assert.equal(skillSourceUrl({ url: "javascript:alert(1)" }), null);
    assert.equal(skillSourceUrl({ name: "verify-gibson" }), null);
    assert.equal(showHermesClaudeOnlyNote(skillDetailFixture.runtimes), true);
    assert.equal(showHermesClaudeOnlyNote({ claude: false, codex: false, grok: false, hermes: false, mini: true }), false);
    const stalled = skillDetailFixture.triggers.find((trigger) => trigger.status === "stalled");
    assert.equal(stalled?.ended, false);
    assert.equal(stalled?.started, true);
  });

  it("does not share the patched lanes array with the caller", () => {
    const sample = skills[0];
    const lanes = ["lane-a"];
    const patched = applyOptimisticSkillPatch([sample], sample.id, { scope: { mode: "selected", lanes } });
    lanes.push("lane-b");
    assert.deepEqual(patched[0].scope.lanes, ["lane-a"]);
  });
});