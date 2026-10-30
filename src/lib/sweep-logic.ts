import { createHash } from "node:crypto";

/**
 * Absence sweeper rules (#79), as pure functions over stored facts.
 *
 * Every predicate is true, false, or null (unknown). A combined predicate uses
 * three-valued logic: one true term makes an OR true, one false term makes an
 * AND false, and anything else that is not decided is unknown. Unknown never
 * emits and never clears a latch.
 *
 * Every instant passed in here is database time (sweep-clock.ts). Source
 * timestamps are facts compared against that clock, never the clock itself.
 */

export const SWEEP_CONDITIONS = [
  "consumer-silent",
  "pr-stuck",
  "pause-unexplained",
  "pause-expired",
  "resume-uncited",
  "decision-aging",
  "dispatch-ready-empty",
] as const;
export type SweepCondition = (typeof SWEEP_CONDITIONS)[number];

/** Events that prove a consumer worked. Heartbeats and errors do not. */
export const WORK_EVENT_KINDS = ["session_end", "milestone", "status"] as const;

export const REPEAT_HOURS = 12;
export const DEFAULT_SILENCE_HOURS = 3;
export const GREEN_WAIT_MINUTES = 30;
export const DECISION_AGING_DAYS = 14;
export const DISPATCH_EMPTY_MINUTES = 60;
/** Twice the 15 minute collector tick. A source may override it per observation. */
export const DEFAULT_STALE_MINUTES = 30;
export const RETENTION_DAYS = 30;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export type Tri = boolean | null;
export type Verdict = "firing" | "clear" | "held" | "unknown";

export function or3(...terms: Tri[]): Tri {
  if (terms.some((t) => t === true)) return true;
  if (terms.every((t) => t === false)) return false;
  return null;
}

export function and3(...terms: Tri[]): Tri {
  if (terms.some((t) => t === false)) return false;
  if (terms.every((t) => t === true)) return true;
  return null;
}

export function not3(term: Tri): Tri {
  return term === null ? null : !term;
}

function verdictOf(term: Tri): Verdict {
  if (term === true) return "firing";
  if (term === false) return "clear";
  return "unknown";
}

/** Milliseconds from an ISO string, or null. */
export function ms(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

function isFresh(receivedAt: string | null, staleAfterMinutes: number, nowMs: number): boolean {
  const at = ms(receivedAt);
  return at !== null && at >= nowMs - staleAfterMinutes * MINUTE_MS;
}

// ------------------------------------------------------------------ entities

export function entityDigest(entityKey: string): string {
  return createHash("sha256").update(entityKey).digest("hex").slice(0, 24);
}

/** `sweep:<condition>:<entity digest>:e<episode>:s<seq>`. */
export function firingDeliveryId(condition: SweepCondition, entityKey: string, episode: number, seq: number): string {
  return `sweep:${condition}:${entityDigest(entityKey)}:e${episode}:s${seq}`;
}

/** `sweep:<condition>-cleared:<entity digest>:e<episode>`. One clear per episode. */
export function clearedDeliveryId(condition: SweepCondition, entityKey: string, episode: number): string {
  return `sweep:${condition}-cleared:${entityDigest(entityKey)}:e${episode}`;
}

export function repoKey(repo: string): string {
  return repo.toLowerCase();
}

// -------------------------------------------------------------------- latch

export interface LatchState {
  active: boolean;
  episode: number;
  seq: number;
  last_emitted_at: string | null;
}

export interface LatchStep {
  next: LatchState;
  /** Set when this evaluation writes one inbox row. */
  emit: { event: string; delivery_id: string; episode: number; seq: number; cleared: boolean } | null;
  /** False when the latch row keeps its active and emission fields as they were. */
  changed: boolean;
}

/**
 * One latch transition.
 * - firing from clear starts a new episode and emits at once;
 * - firing while active emits again only 12 hours after the last emission;
 * - clear or held from active emits one `<condition>-cleared`;
 * - clear or held while clear, and unknown in any state, emit nothing and
 *   leave active and the last emission untouched.
 */
export function stepLatch(
  condition: SweepCondition,
  entityKey: string,
  prev: LatchState,
  verdict: Verdict,
  nowIso: string,
): LatchStep {
  const nowMs = ms(nowIso);
  if (nowMs === null) throw new Error("stepLatch needs a database instant");
  if (verdict === "unknown") return { next: prev, emit: null, changed: false };
  if (verdict === "firing") {
    if (!prev.active) {
      const episode = prev.episode + 1;
      return {
        next: { active: true, episode, seq: 1, last_emitted_at: nowIso },
        emit: { event: condition, delivery_id: firingDeliveryId(condition, entityKey, episode, 1), episode, seq: 1, cleared: false },
        changed: true,
      };
    }
    const last = ms(prev.last_emitted_at);
    if (last !== null && nowMs - last < REPEAT_HOURS * HOUR_MS) return { next: prev, emit: null, changed: false };
    const seq = prev.seq + 1;
    return {
      next: { ...prev, seq, last_emitted_at: nowIso },
      emit: { event: condition, delivery_id: firingDeliveryId(condition, entityKey, prev.episode, seq), episode: prev.episode, seq, cleared: false },
      changed: true,
    };
  }
  if (!prev.active) return { next: prev, emit: null, changed: false };
  return {
    next: { ...prev, active: false },
    emit: {
      event: `${condition}-cleared`,
      delivery_id: clearedDeliveryId(condition, entityKey, prev.episode),
      episode: prev.episode,
      seq: prev.seq,
      cleared: true,
    },
    changed: true,
  };
}

// --------------------------------------------------------------- scheduler

export interface SchedulerJobFacts {
  source: string;
  job_id: string;
  state: "active" | "paused";
  transition: number;
  paused_at: string | null;
  paused_reason: string | null;
  until: string | null;
  decision: string | null;
  prior_state: string | null;
  resumed: boolean;
  stale_after_minutes: number;
  last_received_at: string;
}

export type PauseClass = "active" | "held" | "unexplained" | "expired" | "unknown";

/**
 * Held is applied first: a citation plus a future `until` never alerts, even
 * with no displayed reason. A pause whose explicit `until` has passed is
 * expired, and expired wins over unexplained for the same pause. Expiry is
 * never invented from `paused_at`. A stale record is unknown.
 */
export function classifyPause(job: SchedulerJobFacts, nowMs: number): PauseClass {
  if (!isFresh(job.last_received_at, job.stale_after_minutes, nowMs)) return "unknown";
  if (job.state === "active") return "active";
  const until = ms(job.until);
  if (until !== null && until <= nowMs) return "expired";
  if (job.decision && until !== null && until > nowMs) return "held";
  return "unexplained";
}

export function pauseVerdicts(job: SchedulerJobFacts, nowMs: number): {
  unexplained: Verdict;
  expired: Verdict;
  classification: PauseClass;
} {
  const classification = classifyPause(job, nowMs);
  switch (classification) {
    case "unknown":
      return { unexplained: "unknown", expired: "unknown", classification };
    case "active":
      return { unexplained: "clear", expired: "clear", classification };
    case "expired":
      return { unexplained: "clear", expired: "firing", classification };
    case "held":
      return { unexplained: "held", expired: "held", classification };
    case "unexplained":
      return { unexplained: "firing", expired: "clear", classification };
  }
}

/**
 * Fires while the current transition is an observed paused-to-active resume
 * with no citation of its own. A first active observation is not a resume.
 * A citation on that transition, or any later transition, clears it.
 */
export function resumeVerdict(job: SchedulerJobFacts): Verdict {
  if (job.state === "active" && job.resumed && !job.decision) return "firing";
  return "clear";
}

// ---------------------------------------------------------------- consumers

export interface ConsumerFacts {
  /** True or false from a successful queue read; null when the queue is unknown. */
  ready: Tri;
  /** Database time of the newest matching work event, or null if none. */
  last_work_at: string | null;
  registered_at: string;
  max_silence_hours: number;
  /** True when a mapped scheduler job is validly held; null when unknown; false otherwise. */
  held: Tri;
}

/** Never-seen consumers get the silence limit as grace from registration. */
export function consumerSilent(facts: ConsumerFacts, nowMs: number): boolean {
  const registered = ms(facts.registered_at) ?? nowMs;
  const work = ms(facts.last_work_at);
  const baseline = work === null ? registered : Math.max(work, registered);
  return nowMs - baseline > facts.max_silence_hours * HOUR_MS;
}

export function consumerVerdict(facts: ConsumerFacts, nowMs: number): Verdict {
  const owed = and3(facts.ready, consumerSilent(facts, nowMs));
  if (owed === false) return "clear";
  if (facts.held === true) return "held";
  return verdictOf(and3(owed, not3(facts.held)));
}

// ---------------------------------------------------------------------- PRs

export interface PrSourceFacts {
  complete: boolean;
  received_at: string;
  stale_after_minutes: number;
}

export interface PrFacts {
  open: boolean;
  draft: boolean | null;
  opened_at: string | null;
  mergeable: string | null;
  head_sha: string | null;
  checks_state: string | null;
  checks_head_sha: string | null;
  review_started: boolean | null;
  review_head_sha: string | null;
  green_since: string | null;
}

export interface PrEvaluation {
  verdict: Verdict;
  reasons: string[];
  terms: { age: Tri; conflicting: Tri; green_unreviewed: Tri; draft: Tri };
}

/**
 * Non-draft, open, and one of: older than the stuck threshold, conflicting,
 * or green at its exact head for 30 minutes with no review started at that
 * head. A proven age or conflict term fires even when green or review facts
 * are unknown. Clearing needs fresh, complete evidence that every term is
 * false or that the PR closed.
 */
export function evaluatePr(pr: PrFacts | null, source: PrSourceFacts | null, nowMs: number, stuckHours: number): PrEvaluation {
  const none = { age: null, conflicting: null, green_unreviewed: null, draft: null } as PrEvaluation["terms"];
  if (!source || !source.complete || !isFresh(source.received_at, source.stale_after_minutes, nowMs)) {
    return { verdict: "unknown", reasons: ["pr evidence stale, incomplete, or missing"], terms: none };
  }
  if (!pr) return { verdict: "unknown", reasons: ["pr not in evidence"], terms: none };
  if (!pr.open) return { verdict: "clear", reasons: ["closed"], terms: none };
  const opened = ms(pr.opened_at);
  const age: Tri = opened === null ? null : nowMs - opened > stuckHours * HOUR_MS;
  const conflicting: Tri = pr.mergeable === "conflicting" ? true : pr.mergeable === "mergeable" ? false : null;
  const atHead = pr.head_sha !== null && pr.checks_head_sha === pr.head_sha;
  let green: Tri = null;
  if (atHead && pr.checks_state === "success") green = true;
  else if (atHead && (pr.checks_state === "pending" || pr.checks_state === "failure")) green = false;
  const greenSince = ms(pr.green_since);
  const greenLong: Tri = green === true ? greenSince !== null && nowMs - greenSince >= GREEN_WAIT_MINUTES * MINUTE_MS : green;
  let reviewStarted: Tri = null;
  if (pr.review_started === false) reviewStarted = false;
  else if (pr.review_started === true && pr.head_sha !== null) reviewStarted = pr.review_head_sha === pr.head_sha;
  const greenUnreviewed = and3(greenLong, not3(reviewStarted));
  const draft: Tri = pr.draft;
  const stuck = and3(not3(draft), or3(age, conflicting, greenUnreviewed));
  const reasons: string[] = [];
  if (draft === true) reasons.push("draft");
  if (age === true) reasons.push(`open over ${stuckHours}h`);
  if (conflicting === true) reasons.push("conflicting");
  if (greenUnreviewed === true) reasons.push(`green ${GREEN_WAIT_MINUTES}m+ at head with no review started`);
  return { verdict: verdictOf(stuck), reasons, terms: { age, conflicting, green_unreviewed: greenUnreviewed, draft } };
}

// ---------------------------------------------------------------- decisions

export interface DecisionFacts {
  status: string;
  defer_until: string | null;
  opened_at: string | null;
  first_seen_at: string | null;
}

export function decisionVerdict(row: DecisionFacts | null, nowMs: number): Verdict {
  if (!row) return "clear";
  if (row.status !== "open" && row.status !== "deferred") return "clear";
  const defer = ms(row.defer_until);
  // Only a deferral with a future defer_until holds. A deferred row without
  // one is not a valid deferral and ages like an open row.
  if (row.status === "deferred" && defer !== null && defer > nowMs) return "held";
  const since = ms(row.opened_at) ?? ms(row.first_seen_at);
  if (since === null) return "unknown";
  return nowMs - since >= DECISION_AGING_DAYS * 24 * HOUR_MS ? "firing" : "clear";
}

// ------------------------------------------------------------------- queues

export interface QueueFacts {
  complete: boolean;
  ready_count: number | null;
  raw_count: number | null;
  received_at: string;
  stale_after_minutes: number;
  empty_since: string | null;
}

/** Ready work from a collector queue: null unless the newest observation is complete and fresh. */
export function queueReady(queue: QueueFacts | null, nowMs: number): Tri {
  if (!queue || !queue.complete || queue.ready_count === null) return null;
  if (!isFresh(queue.received_at, queue.stale_after_minutes, nowMs)) return null;
  return queue.ready_count > 0;
}

/**
 * Raw unspecced issues and nothing dispatch-ready, continuously for an hour.
 * empty_since is reset at write time by any incomplete observation or any
 * gap longer than the freshness window, so unknown evidence never extends it.
 */
export function dispatchVerdict(queue: QueueFacts | null, nowMs: number): { verdict: Verdict; pending_since: string | null } {
  if (!queue || !queue.complete || queue.ready_count === null || queue.raw_count === null) {
    return { verdict: "unknown", pending_since: null };
  }
  if (!isFresh(queue.received_at, queue.stale_after_minutes, nowMs)) return { verdict: "unknown", pending_since: null };
  if (!(queue.raw_count > 0 && queue.ready_count === 0)) return { verdict: "clear", pending_since: null };
  const since = ms(queue.empty_since);
  if (since === null) return { verdict: "unknown", pending_since: null };
  const verdict = nowMs - since >= DISPATCH_EMPTY_MINUTES * MINUTE_MS ? "firing" : "clear";
  return { verdict, pending_since: queue.empty_since };
}

// ------------------------------------------------------------------- brief

export interface PausedJobRow {
  source: string;
  job_id: string;
  classification: PauseClass;
  state: "active" | "paused";
  age_hours: number | null;
  report_age_hours: number | null;
  paused_at: string | null;
  reason: string | null;
  until: string | null;
  decision: string | null;
}

export interface PausedSection {
  /** False when the scheduler records could not be read. */
  measured: boolean;
  error: string | null;
  generated_at: string | null;
  /** Jobs ever reported. Zero is a measured empty registry, which is still not "none paused". */
  jobs_total: number | null;
  /** Paused and stale rows, oldest pause first. Active fresh jobs are omitted. */
  jobs: PausedJobRow[];
  truncated: boolean;
  counts: { held: number; unexplained: number; expired: number; unknown: number };
}

export const PAUSED_ROW_LIMIT = 50;

export function unmeasuredPaused(error: string): PausedSection {
  return {
    measured: false,
    error,
    generated_at: null,
    jobs_total: null,
    jobs: [],
    truncated: false,
    counts: { held: 0, unexplained: 0, expired: 0, unknown: 0 },
  };
}

function hours(fromMs: number | null, nowMs: number): number | null {
  if (fromMs === null) return null;
  return Math.max(0, (nowMs - fromMs) / HOUR_MS);
}

/** The Paused section from every scheduler_jobs row and one database instant. */
export function pausedSection(rows: readonly SchedulerJobFacts[], nowIso: string): PausedSection {
  const nowMs = ms(nowIso);
  if (nowMs === null) return unmeasuredPaused("no database time");
  const counts = { held: 0, unexplained: 0, expired: 0, unknown: 0 };
  const listed: PausedJobRow[] = [];
  for (const job of rows) {
    const classification = classifyPause(job, nowMs);
    if (classification === "active") continue;
    counts[classification] += 1;
    listed.push({
      source: job.source,
      job_id: job.job_id,
      classification,
      state: job.state,
      age_hours: job.state === "paused" ? hours(ms(job.paused_at), nowMs) : null,
      report_age_hours: hours(ms(job.last_received_at), nowMs),
      paused_at: job.paused_at,
      reason: job.paused_reason,
      until: job.until,
      decision: job.decision,
    });
  }
  listed.sort((a, b) => (b.age_hours ?? -1) - (a.age_hours ?? -1) || `${a.source}/${a.job_id}`.localeCompare(`${b.source}/${b.job_id}`));
  return {
    measured: true,
    error: null,
    generated_at: nowIso,
    jobs_total: rows.length,
    jobs: listed.slice(0, PAUSED_ROW_LIMIT),
    truncated: listed.length > PAUSED_ROW_LIMIT,
    counts,
  };
}

function tenths(n: number): string {
  return String(Math.floor(n * 10) / 10);
}

function dash(value: string | null): string {
  return value && value.length > 0 ? value : "-";
}

/**
 * Text lines for the brief. `scripts/morning-brief.sh` prints the same lines
 * from the same JSON (its paused_lines function).
 */
export function formatPausedLines(paused: PausedSection): string[] {
  if (!paused.measured) return [`PAUSED: DATA INCOMPLETE (${paused.error ?? "scheduler status unavailable"}).`];
  if (paused.jobs_total === 0) return ["PAUSED: DATA INCOMPLETE (no scheduler job has reported)."];
  const c = paused.counts;
  const lines: string[] = [];
  const paused_n = c.held + c.unexplained + c.expired;
  if (c.unknown > 0) lines.push(`PAUSED: DATA INCOMPLETE — ${c.unknown} job(s) stale; known rows below`);
  else if (paused_n === 0) lines.push("PAUSED: none.");
  else lines.push(`PAUSED (${paused_n}) — job, age, reason, until, decision`);
  for (const job of paused.jobs) {
    if (job.classification === "unknown") {
      const seen = job.report_age_hours === null ? "-" : `${tenths(job.report_age_hours)}h`;
      lines.push(`  ?? ${job.source}/${job.job_id}  stale: last report ${seen} ago, last state ${job.state}`);
      continue;
    }
    const age = job.age_hours === null ? "-" : `${tenths(job.age_hours)}h`;
    const mark = job.classification === "held" ? "held" : job.classification === "expired" ? "EXPIRED" : "UNEXPLAINED";
    lines.push(`  ${job.source}/${job.job_id}  ${age}  ${mark}  reason: ${dash(job.reason)}  until: ${dash(job.until)}  decision: ${dash(job.decision)}`);
  }
  if (paused.truncated) lines.push(`  (first ${PAUSED_ROW_LIMIT} rows shown)`);
  const unknown = c.unknown > 0 ? `, ${c.unknown} unknown` : "";
  lines.push(`HELD VERSUS UNEXPLAINED: ${c.held} held, ${c.unexplained} unexplained, ${c.expired} expired${unknown}`);
  return lines;
}
