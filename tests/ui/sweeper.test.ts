import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  DEFAULT_STALE_MINUTES,
  and3,
  classifyPause,
  clearedDeliveryId,
  consumerVerdict,
  decisionVerdict,
  dispatchVerdict,
  entityDigest,
  evaluatePr,
  firingDeliveryId,
  formatPausedLines,
  not3,
  or3,
  pausedSection,
  queueReady,
  resumeVerdict,
  stepLatch,
  unmeasuredPaused,
  type PrFacts,
  type SchedulerJobFacts,
} from "../../src/lib/sweep-logic";
import {
  checkConsumerRegistration,
  checkPrSnapshotObservation,
  checkQueueObservation,
  checkSchedulerObservation,
  isReservedIngestKind,
} from "../../src/lib/sweep-evidence";
import { SYNTHETIC_DELIVERY_PREFIX, isWebhookDeliveryId } from "../../src/lib/gh-events";
import { provenanceFromPrincipal } from "../../src/lib/actor";
import { isTrustedWriter } from "../../src/lib/auth";
import { POST as ingestPost } from "../../src/app/api/ingest/route";
import { POST as sweepPost } from "../../src/app/api/sweep/route";
import { POST as consumerPost } from "../../src/app/api/sweep/consumers/route";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const env = process.env as Record<string, string | undefined>;
const saved = { db: env.DATABASE_URL, token: env.MC_TOKEN, nodeEnv: env.NODE_ENV, password: env.MC_DASHBOARD_PASSWORD };

afterEach(() => {
  for (const [key, value] of [["DATABASE_URL", saved.db], ["MC_TOKEN", saved.token], ["NODE_ENV", saved.nodeEnv], ["MC_DASHBOARD_PASSWORD", saved.password]] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
});

function job(over: Partial<SchedulerJobFacts>): SchedulerJobFacts {
  return {
    source: "mini",
    job_id: "carmack",
    state: "paused",
    transition: 1,
    paused_at: at(-2 * HOUR),
    paused_reason: null,
    until: null,
    decision: null,
    prior_state: null,
    resumed: false,
    stale_after_minutes: DEFAULT_STALE_MINUTES,
    last_received_at: at(-MIN),
    ...over,
  };
}

function pr(over: Partial<PrFacts>): PrFacts {
  return {
    open: true,
    draft: false,
    opened_at: at(-HOUR),
    mergeable: "mergeable",
    head_sha: "a".repeat(40),
    checks_state: "pending",
    checks_head_sha: "a".repeat(40),
    review_started: false,
    review_head_sha: null,
    green_since: null,
    ...over,
  };
}

const freshSource = { complete: true, received_at: at(-MIN), stale_after_minutes: 30 };

describe("three-valued logic", () => {
  it("decides only what the known terms decide", () => {
    assert.equal(or3(null, true), true);
    assert.equal(or3(false, false), false);
    assert.equal(or3(false, null), null);
    assert.equal(and3(null, false), false);
    assert.equal(and3(true, true), true);
    assert.equal(and3(true, null), null);
    assert.equal(not3(null), null);
    assert.equal(not3(true), false);
  });
});

describe("latch", () => {
  const empty = { active: false, episode: 0, seq: 0, last_emitted_at: null };
  it("emits once on first firing, repeats only at 12 hours, and clears once", () => {
    const first = stepLatch("pr-stuck", "pr:a/b#1", empty, "firing", at(0));
    assert.equal(first.emit?.delivery_id, firingDeliveryId("pr-stuck", "pr:a/b#1", 1, 1));
    assert.equal(first.emit?.event, "pr-stuck");
    assert.equal(stepLatch("pr-stuck", "pr:a/b#1", first.next, "firing", at(MIN)).emit, null, "a minute later: nothing");
    assert.equal(stepLatch("pr-stuck", "pr:a/b#1", first.next, "firing", at(12 * HOUR - 1)).emit, null, "just under 12 hours: nothing");
    const repeat = stepLatch("pr-stuck", "pr:a/b#1", first.next, "firing", at(12 * HOUR));
    assert.equal(repeat.emit?.seq, 2);
    assert.match(repeat.emit!.delivery_id, /:e1:s2$/);
    const cleared = stepLatch("pr-stuck", "pr:a/b#1", repeat.next, "clear", at(13 * HOUR));
    assert.equal(cleared.emit?.event, "pr-stuck-cleared");
    assert.equal(cleared.emit?.delivery_id, clearedDeliveryId("pr-stuck", "pr:a/b#1", 1));
    assert.equal(stepLatch("pr-stuck", "pr:a/b#1", cleared.next, "clear", at(14 * HOUR)).emit, null, "already clear");
    const again = stepLatch("pr-stuck", "pr:a/b#1", cleared.next, "firing", at(14 * HOUR));
    assert.match(again.emit!.delivery_id, /:e2:s1$/, "a new episode emits at once");
  });

  it("held clears an active latch; unknown never emits and preserves everything", () => {
    const active = { active: true, episode: 3, seq: 2, last_emitted_at: at(-20 * HOUR) };
    assert.equal(stepLatch("pause-unexplained", "job:x", active, "held", at(0)).emit?.event, "pause-unexplained-cleared");
    const unknown = stepLatch("pause-unexplained", "job:x", active, "unknown", at(0));
    assert.equal(unknown.emit, null);
    assert.equal(unknown.changed, false);
    assert.deepEqual(unknown.next, active);
  });

  it("uses the reserved sweep: namespace the webhook route rejects", () => {
    const id = firingDeliveryId("dispatch-ready-empty", "queue:issues:acme/a", 4_000_000, 9_000_000);
    assert.ok(id.startsWith(SYNTHETIC_DELIVERY_PREFIX));
    assert.ok(id.length <= 200);
    assert.equal(isWebhookDeliveryId(id), false);
    assert.equal(entityDigest("x").length, 24);
    assert.notEqual(entityDigest("pr:a/b#1"), entityDigest("pr:a/b#2"));
  });
});

describe("pauses", () => {
  it("applies held first, prefers expired, and never invents expiry", () => {
    assert.equal(classifyPause(job({}), NOW), "unexplained");
    assert.equal(classifyPause(job({ paused_reason: "travel" }), NOW), "unexplained", "a reason alone is not a decision");
    assert.equal(classifyPause(job({ decision: "decision:1" }), NOW), "unexplained", "a citation with no until");
    assert.equal(classifyPause(job({ decision: "decision:1", until: at(MIN) }), NOW), "held", "held even with no displayed reason");
    assert.equal(classifyPause(job({ decision: "decision:1", until: at(0) }), NOW), "expired", "until equal to now is expired");
    assert.equal(classifyPause(job({ until: at(-MIN) }), NOW), "expired", "expired wins over unexplained");
    assert.equal(classifyPause(job({ paused_at: at(-500 * HOUR) }), NOW), "unexplained", "a 500 hour pause is not expired without until");
    assert.equal(classifyPause(job({ state: "active" }), NOW), "active");
  });

  it("is unknown when the record is stale, at the freshness boundary", () => {
    assert.equal(classifyPause(job({ last_received_at: at(-30 * MIN) }), NOW), "unexplained");
    assert.equal(classifyPause(job({ last_received_at: at(-30 * MIN - 1) }), NOW), "unknown");
    assert.equal(classifyPause(job({ last_received_at: at(-50 * MIN), stale_after_minutes: 60 }), NOW), "unexplained", "source override");
  });

  it("flags only an observed, uncited resume", () => {
    assert.equal(resumeVerdict(job({ state: "active", resumed: true })), "firing");
    assert.equal(resumeVerdict(job({ state: "active", resumed: true, decision: "doc:runbook" })), "clear");
    assert.equal(resumeVerdict(job({ state: "active", resumed: false })), "clear", "a first active observation");
    assert.equal(resumeVerdict(job({ state: "paused", resumed: false })), "clear");
  });
});

describe("consumer-silent", () => {
  const base = { ready: true as boolean | null, last_work_at: null as string | null, registered_at: at(-4 * HOUR), max_silence_hours: 3, held: false as boolean | null };
  it("needs ready work and silence past the limit", () => {
    assert.equal(consumerVerdict(base, NOW), "firing");
    assert.equal(consumerVerdict({ ...base, ready: false }, NOW), "clear", "a measured empty queue never fires");
    assert.equal(consumerVerdict({ ...base, ready: null }, NOW), "unknown", "a missing queue is unknown");
    assert.equal(consumerVerdict({ ...base, last_work_at: at(-3 * HOUR) }, NOW), "clear", "exactly at the limit is not silent");
    assert.equal(consumerVerdict({ ...base, last_work_at: at(-3 * HOUR - 1) }, NOW), "firing");
    assert.equal(consumerVerdict({ ...base, registered_at: at(-2 * HOUR) }, NOW), "clear", "never seen: grace from registration");
    assert.equal(consumerVerdict({ ...base, last_work_at: at(-30 * HOUR), registered_at: at(-HOUR) }, NOW), "clear", "older work does not shorten the grace");
  });

  it("is held by a validly held job and unknown when the job is unknown", () => {
    assert.equal(consumerVerdict({ ...base, held: true }, NOW), "held");
    assert.equal(consumerVerdict({ ...base, held: null }, NOW), "unknown");
    assert.equal(consumerVerdict({ ...base, ready: false, held: null }, NOW), "clear");
  });

  it("reads a collector queue only when it is complete and fresh", () => {
    const q = { complete: true, ready_count: 2, raw_count: 5, received_at: at(-MIN), stale_after_minutes: 30, empty_since: null };
    assert.equal(queueReady(q, NOW), true);
    assert.equal(queueReady({ ...q, ready_count: 0 }, NOW), false);
    assert.equal(queueReady({ ...q, complete: false }, NOW), null, "incomplete is unknown, never zero");
    assert.equal(queueReady({ ...q, received_at: at(-31 * MIN) }, NOW), null);
    assert.equal(queueReady(null, NOW), null);
  });
});

describe("pr-stuck", () => {
  it("fires on age, conflict, or green-unreviewed at the exact head", () => {
    assert.equal(evaluatePr(pr({ opened_at: at(-48 * HOUR - 1) }), freshSource, NOW, 48).verdict, "firing");
    assert.equal(evaluatePr(pr({ opened_at: at(-48 * HOUR) }), freshSource, NOW, 48).verdict, "clear", "48h exactly is not over");
    assert.equal(evaluatePr(pr({ mergeable: "conflicting" }), freshSource, NOW, 48).verdict, "firing");
    const green = { checks_state: "success", green_since: at(-30 * MIN) };
    assert.equal(evaluatePr(pr(green), freshSource, NOW, 48).verdict, "firing");
    assert.equal(evaluatePr(pr({ ...green, green_since: at(-29 * MIN) }), freshSource, NOW, 48).verdict, "clear");
    assert.equal(evaluatePr(pr({ ...green, checks_head_sha: "b".repeat(40) }), freshSource, NOW, 48).verdict, "unknown", "checks for another head are not green");
    assert.equal(evaluatePr(pr({ ...green, review_started: true, review_head_sha: "a".repeat(40) }), freshSource, NOW, 48).verdict, "clear");
    assert.equal(evaluatePr(pr({ ...green, review_started: true, review_head_sha: "c".repeat(40) }), freshSource, NOW, 48).verdict, "firing", "a review on an older head");
    assert.equal(evaluatePr(pr({ ...green, review_started: null }), freshSource, NOW, 48).verdict, "unknown");
  });

  it("lets proven age or conflict fire through unknown facts, and needs fresh complete evidence to clear", () => {
    const unknownFacts = { checks_state: "unknown", review_started: null, mergeable: "unknown" };
    assert.equal(evaluatePr(pr(unknownFacts), freshSource, NOW, 48).verdict, "unknown");
    assert.equal(evaluatePr(pr({ ...unknownFacts, opened_at: at(-49 * HOUR) }), freshSource, NOW, 48).verdict, "firing");
    assert.equal(evaluatePr(pr({ draft: true, opened_at: at(-99 * HOUR) }), freshSource, NOW, 48).verdict, "clear");
    assert.equal(evaluatePr(pr({ draft: null, opened_at: at(-99 * HOUR) }), freshSource, NOW, 48).verdict, "unknown");
    assert.equal(evaluatePr(pr({ open: false }), freshSource, NOW, 48).verdict, "clear");
    assert.equal(evaluatePr(pr({ opened_at: at(-99 * HOUR) }), { ...freshSource, complete: false }, NOW, 48).verdict, "unknown");
    assert.equal(evaluatePr(pr({ open: false }), { ...freshSource, received_at: at(-31 * MIN) }, NOW, 48).verdict, "unknown");
    assert.equal(evaluatePr(null, freshSource, NOW, 48).verdict, "unknown");
  });
});

describe("decision-aging and dispatch-ready-empty", () => {
  it("ages from opened_at, else first_seen_at, and honors a valid deferral", () => {
    const row = { status: "open", defer_until: null, opened_at: at(-14 * 24 * HOUR), first_seen_at: at(0) };
    assert.equal(decisionVerdict(row, NOW), "firing", "14 days exactly");
    assert.equal(decisionVerdict({ ...row, opened_at: at(-14 * 24 * HOUR + 1) }, NOW), "clear");
    assert.equal(decisionVerdict({ ...row, opened_at: null, first_seen_at: at(-15 * 24 * HOUR) }, NOW), "firing");
    assert.equal(decisionVerdict({ ...row, status: "deferred", defer_until: at(MIN) }, NOW), "held");
    assert.equal(decisionVerdict({ ...row, status: "deferred", defer_until: at(0) }, NOW), "firing", "an expired deferral ages");
    assert.equal(decisionVerdict({ ...row, status: "deferred", defer_until: null }, NOW), "firing", "a deferral with no date is not valid");
    assert.equal(decisionVerdict({ ...row, status: "decided" }, NOW), "clear");
    assert.equal(decisionVerdict({ ...row, status: "withdrawn" }, NOW), "clear");
    assert.equal(decisionVerdict(null, NOW), "clear");
    assert.equal(decisionVerdict({ ...row, opened_at: null, first_seen_at: null }, NOW), "unknown");
  });

  it("needs a continuous hour of complete evidence with raw work and nothing ready", () => {
    const q = { complete: true, ready_count: 0, raw_count: 4, received_at: at(-MIN), stale_after_minutes: 30, empty_since: at(-HOUR) };
    assert.equal(dispatchVerdict(q, NOW).verdict, "firing");
    assert.equal(dispatchVerdict({ ...q, empty_since: at(-HOUR + 1) }, NOW).verdict, "clear");
    assert.equal(dispatchVerdict({ ...q, ready_count: 1 }, NOW).verdict, "clear");
    assert.equal(dispatchVerdict({ ...q, raw_count: 0 }, NOW).verdict, "clear");
    assert.equal(dispatchVerdict({ ...q, complete: false }, NOW).verdict, "unknown");
    assert.equal(dispatchVerdict({ ...q, received_at: at(-31 * MIN) }, NOW).verdict, "unknown");
    assert.equal(dispatchVerdict(null, NOW).verdict, "unknown");
  });
});

describe("observation validation", () => {
  const obs = { source: "mini", job_id: "carmack", state: "paused", transition: 3, observed_at: "2026-10-29T12:00:00Z" };
  it("accepts a bounded scheduler observation and rejects unknown or unbounded fields", () => {
    const ok = checkSchedulerObservation({ ...obs, paused_reason: "travel", decision: "mrhinkle/agent-kontrol#79", until: "2026-10-30T00:00:00-04:00" });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.until, "2026-10-30T04:00:00.000Z");
    for (const decision of ["decision:12", "owner/name#4", "https://example.com/adr/9", "doc:docs/VELOCITY.md#absence-sweeper"]) {
      assert.equal(checkSchedulerObservation({ ...obs, decision }).ok, true, decision);
    }
    for (const bad of [
      { ...obs, extra: true },
      { ...obs, decision: "approved by mark" },
      { ...obs, decision: `https://x/${"a".repeat(300)}` },
      { ...obs, paused_reason: "x".repeat(501) },
      { ...obs, paused_reason: "line\nbreak" },
      { ...obs, transition: 0 },
      { ...obs, transition: 1.5 },
      { ...obs, state: "stopped" },
      { ...obs, source: "Mini" },
      { ...obs, observed_at: "yesterday" },
      { ...obs, until: "2026-10-30" },
      { ...obs, state: "active", until: "2026-10-30T00:00:00Z" },
      { ...obs, stale_after_minutes: 2 },
      null,
      [],
    ]) {
      assert.equal(checkSchedulerObservation(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("stores an incomplete queue as unknown and requires counts for a complete one", () => {
    const q = { source: "collector", queue: "Issues:Acme/App", classification: "issue_dispatch", seq: 1, observed_at: "2026-10-29T12:00:00Z" };
    const failed = checkQueueObservation({ ...q, complete: false, error: "timeout", ready: { count: 0 } });
    assert.equal(failed.ok, true);
    if (failed.ok) {
      assert.equal(failed.value.ready_count, null, "never zero");
      assert.equal(failed.value.queue, "issues:acme/app");
    }
    assert.equal(checkQueueObservation({ ...q, complete: true }).ok, false);
    assert.equal(checkQueueObservation({ ...q, complete: true, ready: { count: 0 }, raw: { count: 2, refs: Array(51).fill("#1") } }).ok, false);
    assert.equal(checkQueueObservation({ ...q, complete: true, ready: { count: -1 }, raw: { count: 2 } }).ok, false);
    assert.equal(checkQueueObservation({ ...q, classification: "open_minus_blocked", complete: true, ready: { count: 0 }, raw: { count: 0 } }).ok, false);
  });

  it("bounds PR snapshots", () => {
    const row = { number: 1, draft: false, opened_at: "2026-10-27T00:00:00Z", mergeable: "mergeable", head_sha: "a".repeat(40) };
    const snap = { source: "collector", repo: "acme/app", seq: 1, observed_at: "2026-10-29T12:00:00Z", complete: true };
    assert.equal(checkPrSnapshotObservation({ ...snap, prs: [row] }).ok, true);
    assert.equal(checkPrSnapshotObservation({ ...snap, repo: "emu_owner/.github", prs: [row] }).ok, true, "matches the webhook repo rule");
    assert.equal(checkPrSnapshotObservation({ ...snap, prs: Array.from({ length: 201 }, (_, i) => ({ ...row, number: i + 1 })) }).ok, false);
    assert.equal(checkPrSnapshotObservation({ ...snap, prs: [row, row] }).ok, false, "a duplicate number");
    assert.equal(checkPrSnapshotObservation({ ...snap, prs: [{ ...row, head_sha: "HEAD" }] }).ok, false);
    assert.equal(checkPrSnapshotObservation({ ...snap, prs: [{ ...row, url: "javascript:alert(1)" }] }).ok, false);
    assert.equal(checkPrSnapshotObservation({ ...snap, prs: [{ ...row, required_checks: { state: "green" } }] }).ok, false);
    assert.equal(checkPrSnapshotObservation({ ...snap }).ok, false, "complete needs the list");
    assert.equal(checkPrSnapshotObservation({ ...snap, complete: false }).ok, true);
  });

  it("requires explicit reporters for a consumer and no implicit defaults beyond the documented ones", () => {
    const reg = { id: "carmack", agent_ids: ["hermes-carmack"], reporters: [{ kind: "agent", id: "cred-1" }], queue: { type: "tasks", platform: "codex" } };
    const ok = checkConsumerRegistration(reg);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.value.max_silence_hours, 3);
      assert.equal(ok.value.enabled, true);
    }
    assert.equal(checkConsumerRegistration({ ...reg, reporters: [] }).ok, false);
    assert.equal(checkConsumerRegistration({ ...reg, reporters: [{ kind: "dev-open", id: "x" }] }).ok, false);
    assert.equal(checkConsumerRegistration({ ...reg, agent_ids: ["Hermes Carmack"] }).ok, false);
    assert.equal(checkConsumerRegistration({ ...reg, queue: { type: "open_minus_blocked" } }).ok, false);
    assert.equal(checkConsumerRegistration({ ...reg, max_silence_hours: 0 }).ok, false);
  });

  it("reserves the sweeper namespace and the synthetic event names", () => {
    for (const kind of ["sweep.scheduler_job", "sweep.anything", "consumer-silent", "pr-stuck-cleared", "dispatch-ready-empty"]) {
      assert.equal(isReservedIngestKind(kind), true, kind);
    }
    for (const kind of ["milestone", "status", "heartbeat", "sweeping", "pr-stuck-ish"]) {
      assert.equal(isReservedIngestKind(kind), false, kind);
    }
  });
});

describe("trusted writers and provenance", () => {
  it("allows only MC_TOKEN, or the session where supported", () => {
    assert.equal(isTrustedWriter({ kind: "legacy" }, { allowSession: false }), true);
    assert.equal(isTrustedWriter({ kind: "session" }, { allowSession: true }), true);
    assert.equal(isTrustedWriter({ kind: "session" }, { allowSession: false }), false);
    assert.equal(isTrustedWriter({ kind: "dev-open" }, { allowSession: true }), false);
    assert.equal(isTrustedWriter({ kind: "oauth", id: "c" }, { allowSession: true }), false);
    assert.equal(isTrustedWriter({ kind: "agent", id: "a", scopes: ["status:write", "progress:read"] }, { allowSession: true }), false);
  });

  it("derives provenance from the principal, and none from dev-open", () => {
    assert.deepEqual(provenanceFromPrincipal({ kind: "legacy" }), { principal_kind: "legacy", principal_id: "mc-token" });
    assert.deepEqual(provenanceFromPrincipal({ kind: "session" }), { principal_kind: "session", principal_id: "operator" });
    assert.deepEqual(provenanceFromPrincipal({ kind: "agent", id: "c1", scopes: [] }), { principal_kind: "agent", principal_id: "c1" });
    assert.deepEqual(provenanceFromPrincipal({ kind: "oauth", id: "client" }), { principal_kind: "oauth", principal_id: "client" });
    assert.equal(provenanceFromPrincipal({ kind: "dev-open" }), null);
    assert.equal(provenanceFromPrincipal(null), null);
  });

  it("refuses dev-open on the sweep routes before reading the database", async () => {
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "test";
    env.DATABASE_URL = "postgres://none:none@127.0.0.1:9/none";
    const post = (url: string, body: unknown, handler: (r: Request) => Promise<Response>) =>
      handler(new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal((await post("/api/sweep", {}, sweepPost)).status, 401);
    assert.equal((await post("/api/sweep/consumers", { id: "x" }, consumerPost)).status, 401);
    const res = await post("/api/ingest", { agent_id: "mini", kind: "sweep.scheduler_job", observation: {} }, ingestPost);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "trusted_writer_required");
  });

  it("does not let an MC_TOKEN-less production caller in", async () => {
    delete env.MC_TOKEN;
    env.NODE_ENV = "production";
    env.MC_DASHBOARD_PASSWORD = "pw";
    const res = await sweepPost(new Request("http://localhost/api/sweep", { method: "POST", headers: { authorization: "Bearer guess" } }));
    assert.equal(res.status, 401);
  });
});

describe("brief Paused section", () => {
  const rows = [
    job({ job_id: "a-unexplained", paused_at: at(-64 * HOUR) }),
    job({ job_id: "b-held", paused_reason: "owner travel", decision: "mrhinkle/agent-kontrol#79", until: at(6 * HOUR), paused_at: at(-3 * HOUR) }),
    job({ job_id: "c-expired", decision: "decision:7", until: at(-MIN), paused_at: at(-10 * HOUR) }),
    job({ job_id: "d-active", state: "active", paused_at: null }),
  ];

  function shell(section: unknown): string {
    const src = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const fn = src.slice(src.indexOf("# BEGIN paused_lines"), src.indexOf("# END paused_lines"));
    return execFileSync("bash", ["-c", `${fn}\npaused_lines`], { input: JSON.stringify({ paused: section }), encoding: "utf8" });
  }

  it("lists held, unexplained, and expired with counts", () => {
    const section = pausedSection(rows, at(0));
    assert.deepEqual(section.counts, { held: 1, unexplained: 1, expired: 1, unknown: 0 });
    const lines = formatPausedLines(section);
    assert.equal(lines[0], "PAUSED (3) — job, age, reason, until, decision");
    assert.equal(lines[1], "  mini/a-unexplained  64h  UNEXPLAINED  reason: -  until: -  decision: -");
    assert.equal(lines[2], `  mini/c-expired  10h  EXPIRED  reason: -  until: ${at(-MIN)}  decision: decision:7`);
    assert.equal(lines[3], `  mini/b-held  3h  held  reason: owner travel  until: ${at(6 * HOUR)}  decision: mrhinkle/agent-kontrol#79`);
    assert.equal(lines[4], "HELD VERSUS UNEXPLAINED: 1 held, 1 unexplained, 1 expired");
    assert.equal(lines.some((l) => l.includes("d-active")), false);
  });

  it("is DATA INCOMPLETE, never none, when unavailable, empty, or stale, and keeps known rows", () => {
    assert.deepEqual(formatPausedLines(unmeasuredPaused("scheduler status unavailable")), ["PAUSED: DATA INCOMPLETE (scheduler status unavailable)."]);
    assert.deepEqual(formatPausedLines(pausedSection([], at(0))), ["PAUSED: DATA INCOMPLETE (no scheduler job has reported)."]);
    assert.deepEqual(formatPausedLines(pausedSection([job({ state: "active" })], at(0))), ["PAUSED: none.", "HELD VERSUS UNEXPLAINED: 0 held, 0 unexplained, 0 expired"]);
    const stale = pausedSection([...rows, job({ job_id: "e-stale", last_received_at: at(-2 * HOUR) })], at(0));
    const lines = formatPausedLines(stale);
    assert.equal(lines[0], "PAUSED: DATA INCOMPLETE — 1 job(s) stale; known rows below");
    assert.ok(lines.includes("  ?? mini/e-stale  stale: last report 2h ago, last state paused"));
    assert.ok(lines.some((l) => l.includes("b-held")), "known rows stay listed");
    assert.equal(lines.at(-1), "HELD VERSUS UNEXPLAINED: 1 held, 1 unexplained, 1 expired, 1 unknown");
  });

  it("prints the same lines from scripts/morning-brief.sh", () => {
    const cases = [
      pausedSection(rows, at(0)),
      pausedSection([...rows, job({ job_id: "e-stale", last_received_at: at(-2.25 * HOUR) })], at(0)),
      pausedSection([job({ state: "active" })], at(0)),
      pausedSection([], at(0)),
      unmeasuredPaused("dashboard unreachable"),
      pausedSection(Array.from({ length: 55 }, (_, i) => job({ job_id: `j${String(i).padStart(2, "0")}`, paused_at: at(-(i + 1) * 1.37 * HOUR) })), at(0)),
    ];
    for (const section of cases) {
      assert.equal(shell(section), `${formatPausedLines(section).join("\n")}\n`);
    }
    assert.equal(shell(undefined), "PAUSED: DATA INCOMPLETE (scheduler status unavailable).\n");
  });
});
