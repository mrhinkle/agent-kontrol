import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBackground, isHeartbeat } from "../../src/lib/events";
import { cleanTitle, filterEvents, historySessions, isPlaceholder, looksLikeRawId, paginate, sessionSpan, sessionTitle, shortId } from "../../src/lib/history";
import type { Event, FleetAgent, Session } from "../../src/lib/types";

// Synthetic data only.
const NOW = Date.parse("2026-10-05T18:00:00Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const ROLLOUT = "rollout-2026-10-05T14-02-11-0199b2f4-7c1e-7a10-9d3e-5f2a8c1b0e42";

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, agent_id: "a", project: "demo-app", status: "done", summary: null, started_at: ago(90), ended_at: ago(30), updated_at: ago(30), ...extra };
}
let nextId = 1;
function event(session_id: string | null, kind: string, title: string | null, minsAgo: number, agent_id = "a"): Event {
  return { id: nextId++, agent_id, session_id, kind, title, detail: null, created_at: ago(minsAgo) };
}
function agent(id: string, sessions: Session[], extra: Partial<FleetAgent> = {}): FleetAgent {
  return {
    id, platform: "codex", machine: "box-1", display_name: null, last_seen_at: ago(1), derived_status: "done",
    current_session: null, recent_sessions: sessions, pending_messages: 0, unread_replies: 0, ...extra,
  };
}

describe("session titles never show a raw rollout id", () => {
  it("uses the summary when there is one", () => {
    assert.deepEqual(sessionTitle(session(ROLLOUT, { summary: "Fix the login form" }), "codex", []), { title: "Fix the login form", source: "summary" });
  });

  it("falls back to the first turn in that session, skipping heartbeats and boilerplate", () => {
    const events = [
      event(ROLLOUT, "session_start", "Session started in ~/code/demo-app", 89),
      event(ROLLOUT, "heartbeat", "heartbeat", 88),
      event(ROLLOUT, "status", "Ran 40 tests", 60),
      event(ROLLOUT, "turn_start", "Add pagination to the list view", 85),
      event("other", "turn_start", "Not this session", 80),
    ];
    assert.deepEqual(sessionTitle(session(ROLLOUT), "codex", events), { title: "Add pagination to the list view", source: "event" });
  });

  it("uses any meaningful event when there is no turn", () => {
    const events = [event(ROLLOUT, "status", "Ran 40 tests", 60)];
    assert.equal(sessionTitle(session(ROLLOUT), "codex", events).title, "Ran 40 tests");
  });

  it("falls back to platform and project, never the id", () => {
    const t = sessionTitle(session(ROLLOUT), "codex", []);
    assert.deepEqual(t, { title: "Codex session in demo-app", source: "fallback" });
    assert.equal(sessionTitle(session(ROLLOUT, { project: null }), "grok", []).title, "Grok session");
  });

  it("ignores summaries and event titles that are themselves raw ids", () => {
    const events = [event(ROLLOUT, "status", ROLLOUT, 60)];
    assert.equal(sessionTitle(session(ROLLOUT, { summary: ROLLOUT }), "codex", events).source, "fallback");
  });

  it("skips lifecycle placeholders and cleans instruction titles", () => {
    for (const p of ["codex session active", "grok session resumed (x)", "Session started in /home/demo/app", "Turn finished — waiting for input", "stop", "Codex session idle — marking done"]) {
      assert.ok(isPlaceholder(p), p);
    }
    assert.ok(!isPlaceholder("Fix the session timeout bug"));
    const events = [
      event(ROLLOUT, "status", "codex session active", 89),
      event(ROLLOUT, "turn_start", "New instruction: <task-notification><id>1</id>", 88),
      event(ROLLOUT, "turn_start", "New instruction: Add CSV export to the report page\nwith tests", 87),
    ];
    assert.deepEqual(sessionTitle(session(ROLLOUT, { summary: "codex session active" }), "codex", events), { title: "Add CSV export to the report page", source: "event" });
    assert.equal(cleanTitle("New instruction: " + "x".repeat(300))?.length, 140);
  });

  it("recognizes rollout, uuid and timestamped run ids", () => {
    assert.ok(looksLikeRawId(ROLLOUT));
    assert.ok(looksLikeRawId("5e7a1c2d-91b4-4f0a-8c3e-2d1f0a9b8c7d"));
    assert.ok(looksLikeRawId("grok-7f3a91c2-5d0e-4b8a-a1f2-0c9d8e7b6a51"));
    assert.ok(looksLikeRawId("20261005_154211_c4rm4k"));
    assert.ok(!looksLikeRawId("Fix the login form"));
  });

  it("shortens ids for the secondary label", () => {
    assert.equal(shortId(ROLLOUT), "0199b2f4…0e42");
    assert.equal(shortId("sess-1"), "sess-1");
  });
});

describe("history sessions", () => {
  const a = agent("a", [session("s1", { updated_at: ago(30) }), session("s2", { updated_at: ago(300) })], { display_name: "Codex (box-1)" });
  const cur = session("s0", { status: "active", ended_at: null, updated_at: ago(1) });
  const b = agent("b", [cur, session("s3", { updated_at: ago(60) })], { current_session: cur, platform: "grok" });

  it("merges agents newest first and de-duplicates the current session", () => {
    const list = historySessions([a, b], [], null);
    assert.deepEqual(list.map((h) => h.session.id), ["s0", "s1", "s3", "s2"]);
    assert.equal(list[1].agentName, "Codex (box-1)");
    assert.equal(list[0].agentName, "b");
  });

  it("filters to one agent (the ?agent=<id> link from the Gibson)", () => {
    assert.deepEqual(historySessions([a, b], [], "b").map((h) => h.session.id), ["s0", "s3"]);
    assert.deepEqual(historySessions([a, b], [], "nobody"), []);
  });
});

describe("event filtering", () => {
  const events = [
    event("s", "heartbeat", null, 1),
    event("s", "status", "heartbeat", 2),
    event("s", "milestone", "Shipped", 3),
    event("t", "error", "push rejected", 4, "b"),
  ];
  it("detects heartbeats by kind or by a heartbeat status title", () => {
    assert.deepEqual(events.map(isHeartbeat), [true, true, false, false]);
  });
  it("treats collector telemetry as background, but not as a heartbeat", () => {
    const t = event(null, "telemetry", "Hermes collector health", 1);
    assert.equal(isHeartbeat(t), false);
    assert.equal(isBackground(t), true);
    assert.equal(filterEvents([t, ...events], { agentId: null, hideBackground: true }).length, 2);
  });
  it("hides heartbeats and filters by agent", () => {
    assert.deepEqual(filterEvents(events, { agentId: null, hideBackground: true }).map((e) => e.title), ["Shipped", "push rejected"]);
    assert.equal(filterEvents(events, { agentId: "a", hideBackground: false }).length, 3);
    assert.deepEqual(filterEvents(events, { agentId: "b", hideBackground: true }).map((e) => e.kind), ["error"]);
  });
});

describe("pagination", () => {
  const items = Array.from({ length: 23 }, (_, i) => i + 1);
  it("pages and reports ranges", () => {
    const p = paginate(items, 3, 10);
    assert.deepEqual(p.items, [21, 22, 23]);
    assert.deepEqual([p.page, p.pages, p.total, p.from, p.to], [3, 3, 23, 21, 23]);
  });
  it("clamps out-of-range and junk pages", () => {
    assert.equal(paginate(items, 99, 10).page, 3);
    assert.equal(paginate(items, 0, 10).page, 1);
    assert.equal(paginate(items, Number.NaN, 10).page, 1);
  });
  it("handles empty lists", () => {
    assert.deepEqual(paginate([], 1, 10), { items: [], page: 1, pages: 1, total: 0, from: 0, to: 0 });
  });
});

describe("session span", () => {
  it("formats finished and running sessions", () => {
    assert.equal(sessionSpan(session("x", { started_at: ago(90), ended_at: ago(30) }), NOW), "1h 0m");
    assert.equal(sessionSpan(session("x", { status: "active", started_at: ago(42), ended_at: null }), NOW), "42m, running");
  });
  it("stops the clock at the last update for closed sessions without ended_at", () => {
    assert.equal(sessionSpan(session("x", { status: "failed", started_at: ago(60), updated_at: ago(55), ended_at: null }), NOW), "5m");
  });
});
