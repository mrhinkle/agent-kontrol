import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSessionNote, isUsefulTitle, writebackEnabled, writebackDays, includePrompts, type SessionFacts } from "../../src/lib/session-note";

const base: SessionFacts = {
  session_id: "sess-1",
  agent_id: "claude-code-mbp",
  display_name: "Claude Code (mbp)",
  platform: "claude-code",
  project: "API Server",
  status: "done",
  started_at: "2026-10-09T12:00:00.000Z",
  ended_at: "2026-10-09T13:12:00.000Z",
  event_count: 31,
  error_count: 2,
  tools: [
    { name: "Bash", count: 12, failed: 2 },
    { name: "Read", count: 9, failed: 0 },
  ],
  milestones: ["Migrated the users table", "Tests green"],
  summary: null,
};

describe("buildSessionNote", () => {
  it("summarizes duration, outcome, tools and reported milestones", () => {
    const n = buildSessionNote(base)!;
    assert.equal(n.key, "session/sess-1");
    assert.deepEqual(n.tags, ["session-summary", "claude-code", "api-server"]);
    assert.match(n.content, /Claude Code \(mbp\) \[claude-code\] on API Server/);
    assert.match(n.content, /Outcome: done\. Ran 72m 0s/);
    assert.match(n.content, /Events: 31, errors: 2\./);
    assert.match(n.content, /Tools: Bash×12 \(2 failed\), Read×9\./);
    assert.match(n.content, /- Migrated the users table/);
    assert.match(n.content, /- Tests green/);
  });

  it("marks failed sessions as failed", () => {
    assert.match(buildSessionNote({ ...base, status: "failed" })!.content, /Outcome: failed\./);
  });

  it("returns null for a thin session", () => {
    const thin = { ...base, tools: [], milestones: [], ended_at: "2026-10-09T12:00:40.000Z" };
    assert.equal(buildSessionNote(thin), null);
  });

  it("keeps a thin-looking session that ran long enough", () => {
    const long = { ...base, tools: [], milestones: [], ended_at: "2026-10-09T12:10:00.000Z" };
    assert.ok(buildSessionNote(long));
  });

  it("leaves out prompt text and mechanical titles by default", () => {
    const n = buildSessionNote({
      ...base,
      milestones: ["New instruction: rotate the production keys", "Turn finished — waiting for input", "Session ended", "PreCompact", "Shipped the fix"],
      summary: "New instruction: rotate the production keys",
    })!;
    assert.doesNotMatch(n.content, /rotate the production keys/);
    assert.doesNotMatch(n.content, /Turn finished|Session ended|PreCompact/);
    assert.match(n.content, /Shipped the fix/);
  });

  it("includes prompt-derived titles only when asked", () => {
    const n = buildSessionNote({ ...base, milestones: ["New instruction: rotate keys"] }, { includePrompts: true })!;
    assert.match(n.content, /New instruction: rotate keys/);
  });

  it("caps the number of tools, milestones and total length", () => {
    const n = buildSessionNote({
      ...base,
      tools: Array.from({ length: 20 }, (_, i) => ({ name: `T${i}`, count: 1, failed: 0 })),
      milestones: Array.from({ length: 30 }, (_, i) => `m${i} ` + "x".repeat(400)),
    })!;
    assert.ok(n.content.length <= 1500);
    assert.doesNotMatch(n.content, /T9×/);
    assert.doesNotMatch(n.content, /- m0 /, "only the last milestones are kept");
  });

  it("works with no platform or project", () => {
    const n = buildSessionNote({ ...base, platform: null, project: null, display_name: null })!;
    assert.deepEqual(n.tags, ["session-summary"]);
    assert.match(n.content, /claude-code-mbp\./);
  });
});

describe("isUsefulTitle", () => {
  it("filters empty and mechanical titles", () => {
    for (const t of [null, "", "  ", "Session started in /work/x", "Heartbeat", "Stop"]) assert.equal(isUsefulTitle(t as string, false), false, String(t));
    assert.equal(isUsefulTitle("Deployed v2", false), true);
  });
});

describe("settings", () => {
  it("defaults on, prompts off, 30 days; honors the environment", () => {
    const saved = { ...process.env };
    try {
      delete process.env.MC_MEMORY_WRITEBACK;
      delete process.env.MC_MEMORY_WRITEBACK_PROMPTS;
      delete process.env.MC_MEMORY_WRITEBACK_DAYS;
      assert.equal(writebackEnabled(), true);
      assert.equal(includePrompts(), false);
      assert.equal(writebackDays(), 30);
      process.env.MC_MEMORY_WRITEBACK = "0";
      process.env.MC_MEMORY_WRITEBACK_PROMPTS = "1";
      process.env.MC_MEMORY_WRITEBACK_DAYS = "7";
      assert.equal(writebackEnabled(), false);
      assert.equal(includePrompts(), true);
      assert.equal(writebackDays(), 7);
    } finally {
      process.env = saved;
    }
  });
});
