import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSessionNote, isUsefulTitle, sessionKey, type SessionFacts } from "../../src/lib/session-note";

const base: SessionFacts = {
  session_id: "s1", agent_id: "agent-1", display_name: "Agent One", platform: "codex", project: "Web App",
  status: "done", started_at: "2026-10-09T12:00:00.000Z", ended_at: "2026-10-09T12:10:00.000Z",
  event_count: 5, error_count: 0, tools: [{ name: "Bash", count: 3, failed: 0 }], milestones: [], summary: null,
};

describe("hidden: robustness", () => {
  it("bad or missing dates drop the duration instead of throwing", () => {
    const n = buildSessionNote({ ...base, started_at: "garbage", ended_at: null })!;
    assert.doesNotMatch(n.content, /Ran |NaN|Invalid/);
    assert.match(n.content, /Outcome: done\.$/m);
  });
  it("an end before the start clamps the duration to zero", () => {
    const n = buildSessionNote({ ...base, ended_at: "2026-10-09T11:00:00.000Z" })!;
    assert.match(n.content, /Ran <1ms\./);
  });
  it("redacts credentials in the display name, platform, project and tool names", () => {
    const n = buildSessionNote({ ...base, display_name: "bot sk-abcdefghijklmnopqrstuv", project: "ghp_abcdefghijklmnopqrstuvwxyz0123", tools: [{ name: "Bearer abcdefghijklmnop1234", count: 1, failed: 0 }] })!;
    assert.doesNotMatch(n.content, /sk-abcdef|ghp_abcdef|abcdefghijklmnop1234/);
  });
  it("slugs odd platform and project names and removes duplicate tags", () => {
    const n = buildSessionNote({ ...base, platform: "Open  AI!!", project: "open  ai!!" })!;
    assert.deepEqual(n.tags, ["session-summary", "open-ai"]);
    const u = buildSessionNote({ ...base, project: "日本語 プロジェクト" })!;
    assert.deepEqual(u.tags.filter((t) => t !== "session-summary" && t !== "codex"), [], "a name with no a-z0-9 characters yields no tag");
    assert.ok(buildSessionNote({ ...base, project: "x".repeat(100) })!.tags.every((t) => t.length <= 40));
  });
  it("uses the agent id when the display name is blank", () => {
    assert.match(buildSessionNote({ ...base, display_name: "   " })!.content, /^Session summary \(automatic\): agent-1 \[codex\] on Web App\./);
  });
  it("counts only useful milestones and keeps the last five in order", () => {
    const ms = ["Session ended", "m1", "m2", "m3", "m4", "m5", "m6", "Heartbeat"];
    const n = buildSessionNote({ ...base, milestones: ms }, { includeText: true })!;
    assert.match(n.content, /Milestones reported: 6\./);
    const lines = n.content.split("\n");
    assert.deepEqual(lines.slice(lines.indexOf("Reported:") + 1), ["- m2", "- m3", "- m4", "- m5", "- m6"]);
  });
  it("lists at most 8 tools in the given order and marks failures", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `T${i}`, count: i + 1, failed: i === 1 ? 1 : 0 }));
    const line = buildSessionNote({ ...base, tools })!.content.split("\n").find((l) => l.startsWith("Tools:"))!;
    assert.equal(line, "Tools: T0×1, T1×2 (1 failed), T2×3, T3×4, T4×5, T5×6, T6×7, T7×8.");
  });
  it("a prompt-derived title never counts without both opt-ins", () => {
    const f = { ...base, tools: [], started_at: "2026-10-09T12:00:00.000Z", ended_at: "2026-10-09T12:00:30.000Z", milestones: ["New instruction: fix prod"] };
    assert.equal(buildSessionNote(f), null);
    assert.equal(buildSessionNote(f, { includeText: true }), null);
    assert.equal(buildSessionNote(f, { includePrompts: true }), null, "prompts alone do nothing");
    assert.ok(buildSessionNote(f, { includeText: true, includePrompts: true }));
  });
  it("an unknown status is treated as done; failed is reported", () => {
    assert.match(buildSessionNote({ ...base, status: "weird" })!.content, /Outcome: done\./);
    assert.match(buildSessionNote({ ...base, status: "failed" })!.content, /Outcome: failed\./);
  });
  it("is deterministic and does not mutate its input", () => {
    const f = { ...base, milestones: ["a", "b"], tools: [{ name: "Bash", count: 1, failed: 0 }] };
    const copy = JSON.stringify(f);
    const a = buildSessionNote(f, { includeText: true });
    const b = buildSessionNote(f, { includeText: true });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(f), copy);
  });
  it("never exceeds 1500 characters", () => {
    const f = { ...base, summary: "s".repeat(5000), milestones: Array.from({ length: 50 }, (_, i) => `m${i} ` + "x".repeat(1000)) };
    assert.ok(buildSessionNote(f, { includeText: true })!.content.length <= 1500);
  });
});

describe("hidden: keys and titles", () => {
  it("long ids keep a stable hash of the whole id", () => {
    const a = sessionKey("x".repeat(150));
    assert.equal(a, "session/" + "x".repeat(150), "exactly 150 characters stays readable");
    const long = sessionKey("x".repeat(151));
    assert.match(long, /^session\/x{150}~[0-9a-f]{16}$/);
    assert.equal(sessionKey("x".repeat(151)), long, "stable");
    assert.notEqual(sessionKey("x".repeat(151)), sessionKey("x".repeat(150) + "y"));
  });
  it("title rules", () => {
    for (const t of ["SESSION STARTED in /x", "Session ended at noon", "turn finished — waiting", "HEARTBEAT 3", "PreCompact", "stop", "Notification"]) assert.equal(isUsefulTitle(t, true), false, t);
    for (const t of ["Stop the world", "Status report ready", "Notification system migrated"]) assert.equal(isUsefulTitle(t, false), true, t);
    assert.equal(isUsefulTitle("new instruction: x", false), false);
    assert.equal(isUsefulTitle("new instruction: x", true), true);
    assert.equal(isUsefulTitle(undefined, true), false);
  });
});
