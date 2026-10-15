import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveAttention, sortAgentsByUrgency, FAILED_TASK_WINDOW_MS } from "../../src/lib/attention";
import { PLATFORM_META, platformMeta } from "../../src/components/ui";

// Synthetic data only.
const NOW = Date.parse("2026-10-15T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const agent = (derived_status: "active" | "waiting" | "done" | "failed" | "offline") => ({ derived_status });

describe("attention strip derivation", () => {
  it("is empty when nothing needs the operator", () => {
    const items = deriveAttention({ agents: [agent("active"), agent("done"), agent("offline")], tasks: [{ status: "queued", updated_at: iso(0) }], progressAlerts: 0, now: NOW });
    assert.deepEqual(items, []);
  });

  it("orders failures before needs-you before review, each with a destination", () => {
    const items = deriveAttention({
      agents: [agent("waiting"), agent("failed"), agent("waiting")],
      tasks: [
        { status: "review", updated_at: iso(0) },
        { status: "failed", updated_at: iso(60_000) },
      ],
      progressAlerts: 3,
      now: NOW,
    });
    assert.deepEqual(
      items.map((i) => [i.key, i.count, i.tone, i.href]),
      [
        ["failed-agents", 1, "red", "/"],
        ["failed-tasks", 1, "red", "/tasks"],
        ["waiting", 2, "amber", "/"],
        ["needs-you", 3, "amber", "/progress"],
        ["review", 1, "cyan", "/tasks"],
      ],
    );
    assert.equal(items[2].label, "2 need you");
    assert.equal(deriveAttention({ agents: [agent("waiting")], tasks: [], progressAlerts: null, now: NOW })[0].label, "1 needs you");
  });

  it("drops failed tasks older than the window and tolerates a dead progress feed", () => {
    const items = deriveAttention({
      agents: [],
      tasks: [{ status: "failed", updated_at: iso(FAILED_TASK_WINDOW_MS + 1) }],
      progressAlerts: null,
      now: NOW,
    });
    assert.deepEqual(items, []);
  });
});

describe("fleet urgency order", () => {
  it("puts failed and waiting agents first and keeps server order within a tier", () => {
    const agents = [
      { id: "a", derived_status: "active" as const },
      { id: "b", derived_status: "offline" as const },
      { id: "c", derived_status: "waiting" as const },
      { id: "d", derived_status: "active" as const },
      { id: "e", derived_status: "failed" as const },
      { id: "f", derived_status: "done" as const },
    ];
    assert.deepEqual(sortAgentsByUrgency(agents).map((a) => a.id), ["e", "c", "a", "d", "f", "b"]);
  });

  it("does not mutate its input", () => {
    const agents = [{ id: "a", derived_status: "offline" as const }, { id: "b", derived_status: "active" as const }];
    sortAgentsByUrgency(agents);
    assert.deepEqual(agents.map((a) => a.id), ["a", "b"]);
  });
});

describe("platform marks", () => {
  it("every platform the task form offers has a mark, and unknown platforms degrade to the raw id", () => {
    for (const p of ["any", "claude-code", "codex", "grok", "hermes", "cowork-cloud", "cowork-local", "chatgpt-work", "cline-roo"]) {
      assert.ok(PLATFORM_META[p], `no mark for ${p}`);
      assert.ok(PLATFORM_META[p].glyph.length <= 2, `glyph too long for ${p}`);
    }
    const m = platformMeta("something-new");
    assert.equal(m.label, "something-new");
    assert.equal(m.glyph, "SO");
  });
});
