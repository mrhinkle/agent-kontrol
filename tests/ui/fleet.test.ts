import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFeed } from "../../src/lib/feed";
import { STATUS_STYLES } from "../../src/components/ui";
import { AGENT_STATUS_COLORS } from "../../src/lib/gibson-types";
import type { Event } from "../../src/lib/types";

// Synthetic data only.
const NOW = Date.parse("2026-10-05T18:00:00Z");
let id = 1;
const ev = (agent_id: string, kind: string, title: string | null, secsAgo: number): Event => ({
  id: id++, agent_id, session_id: null, kind, title, detail: null, created_at: new Date(NOW - secsAgo * 1000).toISOString(),
});

describe("live activity feed", () => {
  const events = [
    ev("a", "heartbeat", null, 1),
    ev("a", "telemetry", "Collector health", 2),
    ev("b", "status", "agent session active", 3),
    ev("b", "status", "agent session active", 4),
    ev("b", "status", "agent session active", 5),
    ev("a", "milestone", "Shipped the export", 6),
    ev("b", "status", "agent session active", 7),
    ev("a", "heartbeat", null, 8),
  ];

  it("hides heartbeats and telemetry by default and counts them", () => {
    const f = buildFeed(events, { showBackground: false, limit: 50 });
    assert.equal(f.hidden, 3);
    assert.ok(f.items.every((i) => i.event.kind !== "heartbeat" && i.event.kind !== "telemetry"));
  });

  it("folds runs of the same agent repeating the same line, but not across other events", () => {
    const f = buildFeed(events, { showBackground: false, limit: 50 });
    assert.deepEqual(f.items.map((i) => [i.event.agent_id, i.event.kind, i.count]), [["b", "status", 3], ["a", "milestone", 1], ["b", "status", 1]]);
    assert.equal(f.items[0].oldestAt, events[4].created_at);
    assert.equal(f.items[0].event.id, events[2].id); // newest of the run
  });

  it("never folds identical lines across two sessions", () => {
    const a = { ...ev("c", "session_start", "Session started in ~/app", 2), session_id: "s2" };
    const b = { ...ev("c", "session_start", "Session started in ~/app", 3), session_id: "s1" };
    assert.deepEqual(buildFeed([a, b], { showBackground: false, limit: 10 }).items.map((i) => i.count), [1, 1]);
  });

  it("shows everything when asked, still folding repeats", () => {
    const f = buildFeed(events, { showBackground: true, limit: 50 });
    assert.equal(f.hidden, 0);
    assert.equal(f.items.reduce((n, i) => n + i.count, 0), events.length);
  });

  it("sorts newest first regardless of input order and applies the limit after folding", () => {
    const f = buildFeed([...events].reverse(), { showBackground: false, limit: 2 });
    assert.deepEqual(f.items.map((i) => i.count), [3, 1]);
  });
});

describe("status colors match the Gibson", () => {
  it("uses the Gibson hex for every agent status dot", () => {
    for (const [status, hex] of Object.entries(AGENT_STATUS_COLORS)) {
      assert.ok(STATUS_STYLES[status].dot.includes(hex), `${status}: ${STATUS_STYLES[status].dot} should use ${hex}`);
    }
    assert.equal(STATUS_STYLES.waiting.label, "NEEDS YOU");
  });
});
