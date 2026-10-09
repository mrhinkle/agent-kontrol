import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DOCK_MIN_ARC,
  aggregate,
  deriveBanner,
  deriveCounts,
  layoutDocks,
  normalizeAgentStatus,
  shortLabel,
} from "../../src/lib/gibson-derive";
import { AGENT_STATUS_COLORS, platformShape, STATUS_COLORS } from "../../src/lib/gibson-types";
import type { FleetAgent, FleetResponse, Task } from "../../src/lib/types";

// Synthetic data only — ids, sessions and costs are made up.
const NOW = Date.parse("2026-10-05T20:00:00Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();

function agent(id: string, platform: string, machine: string | null, status: FleetAgent["derived_status"], project: string | null, name?: string): FleetAgent {
  const open = status === "active" || status === "waiting";
  const session = { id: `s-${id}`, agent_id: id, project, status, summary: open ? `working on ${project}` : null, started_at: ago(30), ended_at: open ? null : ago(5), updated_at: ago(2) };
  return {
    id, platform, machine, display_name: name ?? null, last_seen_at: ago(1), derived_status: status, pending_messages: 0, unread_replies: 0,
    current_session: open ? session : null, recent_sessions: [session],
  };
}

function task(id: number, project: string | null, status: Task["status"], extra: Partial<Task> = {}): Task {
  return {
    id, title: `task ${id}`, description: null, project, platform: "codex", machine: null, priority: 2, status,
    reviewer_platform: null, assigned_agent: null, session_id: null, result: null, cost_usd: null, created_by: "test",
    created_at: ago(120), claimed_at: null, updated_at: ago(10), completed_at: status === "done" ? ago(10) : null, ...extra,
  };
}

// Mirrors the shape of the live fleet the review found (9 agents, 3 machines).
const NINE: FleetAgent[] = [
  agent("hermes-carmack", "hermes", "mini", "active", "mission-control", "Carmack (mini)"),
  agent("hermes-mini", "hermes", "mini", "done", null, "Hermes (mini)"),
  agent("grok-mini", "grok", "mini", "active", "site", "Grok (mini)"),
  agent("codex-mini", "codex", "mini", "done", null, "Codex (mini)"),
  agent("claude-mini", "claude-code", "mini", "failed", "conf", "Claude Code (mini)"),
  agent("codex-mbp", "codex", "mbp", "active", "mission-control", "Codex (mbp)"),
  agent("claude-mbp", "claude-code", "mbp", "active", "Claude Cowork", "Claude Code (mbp)"),
  agent("grok-mbp", "grok", "mbp", "done", null),
  agent("merge-captain", "hermes", null, "active", "fleet", "Hermes Merge Captain"),
];

function fleet(agents: FleetAgent[]): FleetResponse {
  return { demo: false, agents, events: [], generated_at: ago(0) };
}

describe("aggregate: every agent Fleet knows is drawn", () => {
  it("draws all nine agents, including idle ones with no project or tower", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [] }, progress: { alerts: [] }, now: NOW });
    assert.equal(m.orbs.length, 9);
    assert.deepEqual(new Set(m.orbs.map((o) => o.id)), new Set(NINE.map((a) => a.id)));
    assert.equal(m.counts.agents, 9);
  });

  it("draws agents on platforms with no known shape and agents with no machine", () => {
    const m = aggregate({ fleet: fleet([agent("x", "mystery-bot", null, "done", null)]), tasks: { tasks: [] }, progress: { alerts: [] }, now: NOW });
    assert.equal(m.orbs.length, 1);
    assert.equal(m.orbs[0].shape, "hex");
    assert.equal(m.orbs[0].machine, "unassigned");
  });

  it("only attaches active/waiting agents to a tower", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [] }, progress: { alerts: [] }, now: NOW });
    const byId = new Map(m.orbs.map((o) => [o.id, o]));
    assert.equal(byId.get("codex-mbp")?.towerId, "mission-control");
    assert.equal(byId.get("claude-mini")?.towerId, null);
    assert.equal(byId.get("grok-mbp")?.towerId, null);
  });

  it("links an agent to its open assigned task", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [task(7, "mission-control", "running", { assigned_agent: "codex-mbp" })] }, progress: null, now: NOW });
    assert.deepEqual(m.orbs.find((o) => o.id === "codex-mbp")?.currentTask, { id: 7, title: "task 7", status: "running" });
  });

  it("an idle agent keeps a stale assignment as assigned, not current", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [task(8, "app-server", "claimed", { assigned_agent: "grok-mbp" })] }, progress: null, now: NOW });
    const grok = m.orbs.find((o) => o.id === "grok-mbp");
    assert.equal(grok?.status, "done");
    assert.equal(grok?.currentTask, null);
    assert.deepEqual(grok?.assignedTask, { id: 8, title: "task 8", status: "claimed" });
  });
});

describe("counts are derived from drawn data", () => {
  it("tower count equals towers drawn (projects from tasks + active sessions)", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [task(1, "site", "queued"), task(2, "conf", "failed")] }, progress: { alerts: [] }, now: NOW });
    assert.equal(m.counts.towers, m.towers.length);
    assert.deepEqual(m.towers.map((t) => t.label).sort(), ["Claude Cowork", "conf", "fleet", "mission-control", "site"]);
    assert.equal(m.counts.openFloors, 2);
    assert.equal(m.counts.failedTasks, 1);
  });

  it("ignores failed tasks older than 24h and done tasks older than 7d", () => {
    const m = aggregate({
      fleet: fleet([]),
      tasks: { tasks: [task(1, "p", "failed", { updated_at: ago(60 * 30) }), task(2, "p", "done", { completed_at: ago(60 * 24 * 8) })] },
      progress: { alerts: [] },
      now: NOW,
    });
    assert.equal(m.counts.towers, 0);
    assert.equal(m.counts.failedTasks, 0);
  });

  it("drops review streams that have no reviewer agent to draw to", () => {
    const tasks = { tasks: [task(1, "mission-control", "review", { reviewer_platform: "grok" }), task(2, "mission-control", "review", { reviewer_platform: "nobody" })] };
    const m = aggregate({ fleet: fleet(NINE), tasks, progress: { alerts: [] }, now: NOW });
    assert.equal(m.streams.length, 1);
    assert.equal(m.counts.streams, 1);
    assert.equal(m.streams[0].toAgentId, "grok-mini"); // prefers an active reviewer
    assert.equal(m.counts.reviewTasks, 2);
  });

  it("counts agents by status", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [] }, progress: { alerts: [] }, now: NOW });
    assert.deepEqual(m.counts.byStatus, { active: 5, waiting: 0, failed: 1, done: 3, offline: 0 });
    assert.equal(m.counts.machines, 3);
  });
});

describe("status mapping", () => {
  it("normalises unknown statuses to offline", () => {
    assert.equal(normalizeAgentStatus("active"), "active");
    assert.equal(normalizeAgentStatus("bogus"), "offline");
    assert.equal(normalizeAgentStatus(undefined), "offline");
  });

  it("status hues are distinct and never reused for platforms", () => {
    const hues = Object.values(AGENT_STATUS_COLORS);
    assert.equal(new Set(hues).size, hues.length);
    assert.equal(AGENT_STATUS_COLORS.active, STATUS_COLORS.running);
    assert.equal(AGENT_STATUS_COLORS.failed, STATUS_COLORS.failed);
  });

  it("maps platforms to shapes", () => {
    assert.equal(platformShape("claude-code"), "diamond");
    assert.equal(platformShape("cowork-cloud"), "diamond");
    assert.equal(platformShape("codex"), "cube");
    assert.equal(platformShape("grok"), "pyramid");
    assert.equal(platformShape("hermes"), "sphere");
    assert.equal(platformShape("other"), "hex");
  });
});

describe("banner", () => {
  const base = deriveCounts({ towers: [], orbs: [], streams: [], machines: [] }, 0);

  it("is NOMINAL only when nothing failed, nobody waits, and Progress has 0 needs-you", () => {
    assert.equal(deriveBanner(base).level, "nominal");
    assert.equal(deriveBanner(base).headline, "All systems nominal");
  });

  it("is critical when an agent failed", () => {
    const b = deriveBanner({ ...base, byStatus: { ...base.byStatus, failed: 1 } });
    assert.equal(b.level, "critical");
    assert.ok(b.items.some((i) => i.key === "failed-agents" && i.count === 1));
  });

  it("is critical when a task failed even if every agent is fine", () => {
    assert.equal(deriveBanner({ ...base, failedTasks: 2 }).level, "critical");
  });

  it("is attention when Progress has needs-you items", () => {
    const b = deriveBanner({ ...base, needsYou: 12 });
    assert.equal(b.level, "attention");
    assert.ok(b.items.some((i) => i.key === "needs-you" && i.label === "12 need you"));
    assert.ok(deriveBanner({ ...base, needsYou: 1 }).items.some((i) => i.key === "needs-you" && i.label === "1 needs you"));
  });

  it("is attention when an agent is waiting", () => {
    assert.equal(deriveBanner({ ...base, byStatus: { ...base.byStatus, waiting: 1 } }).level, "attention");
  });

  it("refuses to say NOMINAL when the progress feed is unavailable", () => {
    const b = deriveBanner({ ...base, needsYou: null });
    assert.equal(b.level, "unknown");
    assert.doesNotMatch(b.headline, /nominal/i);
  });

  it("the live-review scenario (1 failed agent, 1 failed task, 12 needs-you) is not nominal", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [task(2, "conf", "failed")] }, progress: { alerts: new Array(12).fill({}) }, now: NOW });
    assert.equal(m.banner.level, "critical");
    assert.deepEqual(m.banner.items.map((i) => i.key), ["failed-agents", "failed-tasks", "needs-you"]);
  });
});

describe("labels and docks never collide", () => {
  it("shortLabel drops the machine suffix, then truncates", () => {
    assert.equal(shortLabel("Codex (macbook-pro-4)", "macbook-pro-4"), "Codex");
    assert.equal(shortLabel("grok-macbook-pro-4", "macbook-pro-4"), "grok");
    assert.equal(shortLabel("Hermes Merge Captain", null), "Hermes Merge Capt…");
    assert.ok(shortLabel("x".repeat(60)).length <= 18);
  });

  it("neighbouring docks are at least DOCK_MIN_ARC apart, for any fleet size", () => {
    for (const n of [1, 3, 9, 24, 60]) {
      const agents = Array.from({ length: n }, (_, i) => ({ id: `a${i}`, machine: `m${i % 4}` }));
      const { docks, ringRadius } = layoutDocks(agents, 8);
      const pts = [...docks.values()];
      assert.equal(pts.length, n);
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
          assert.ok(d >= DOCK_MIN_ARC * 0.95, `n=${n} docks ${i},${j} only ${d.toFixed(2)} apart (r=${ringRadius})`);
        }
      }
    }
  });

  it("the dock ring clears the towers and machine labels sit outside it", () => {
    const { ringRadius, machines } = layoutDocks([{ id: "a", machine: "m" }, { id: "b", machine: "n" }], 14);
    assert.ok(ringRadius >= 14 + 4.5);
    for (const m of machines) assert.ok(Math.hypot(m.x, m.z) >= ringRadius, `${m.machine} label inside the ring`);
  });

  it("groups docks by machine with machine labels", () => {
    const m = aggregate({ fleet: fleet(NINE), tasks: { tasks: [] }, progress: { alerts: [] }, now: NOW });
    assert.deepEqual(m.machines.map((x) => [x.machine, x.count]), [["mbp", 3], ["mini", 5], ["unassigned", 1]]);
  });
});
