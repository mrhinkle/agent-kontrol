import type { Provenance } from "./actor";
import { withTransaction, type SqlTag } from "./db";
import { slugify } from "./store";
import { dbInstant } from "./sweep-clock";
import { DEFAULT_SILENCE_HOURS, DEFAULT_STALE_MINUTES, SWEEP_CONDITIONS, ms, repoKey } from "./sweep-logic";

/**
 * Trusted evidence for the absence sweeper (#79).
 *
 * Three observation kinds arrive through POST /api/ingest and consumer
 * registrations through POST /api/sweep/consumers. Both require the legacy
 * MC_TOKEN (or the signed-in dashboard for registrations). The route checks
 * the principal; this module validates, then writes the audit row and the
 * projection in one transaction. Nothing here reads events.detail: generic
 * telemetry never becomes evidence.
 *
 * Every field is bounded and validated before any SQL runs. Unknown keys are
 * rejected. Values reach SQL only as bound parameters.
 */

export const SWEEP_OBSERVATION_KINDS = ["sweep.scheduler_job", "sweep.queue", "sweep.pr_snapshot"] as const;
export type SweepObservationKind = (typeof SWEEP_OBSERVATION_KINDS)[number];

export const QUEUE_CLASSIFICATIONS = ["issue_dispatch", "pr_review"] as const;
export const PRINCIPAL_KINDS = ["legacy", "agent", "oauth", "session"] as const;

export const REASON_MAX = 500;
export const CITATION_MAX = 300;
export const ERROR_MAX = 300;
export const REFS_MAX = 50;
export const REF_MAX = 200;
export const PRS_MAX = 200;
export const COUNT_MAX = 1_000_000;
export const REPORTERS_MAX = 20;
export const AGENT_IDS_MAX = 20;

const IDENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const QUEUE_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
// Same rule as gh-events REPO_FULL_NAME: `_` owners and `.`-leading names are real repos.
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * A citation is a bounded reference to a decision record, an issue or PR, or
 * a document: `decision:<id>`, `owner/name#<n>`, an https URL, or
 * `doc:<path>`. Syntax is all this checks; it does not prove an approval.
 */
const CITATION = /^(?:decision:[0-9]{1,18}|[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[0-9]{1,9}|https:\/\/[^\s<>"'`\\]{1,290}|doc:[A-Za-z0-9._/#-]{1,200})$/;

/** Kinds no ingest caller may store as telemetry: the observation namespace and the synthetic event names. */
export function isReservedIngestKind(kind: unknown): boolean {
  if (typeof kind !== "string") return false;
  if (kind.startsWith("sweep.") || kind.startsWith("sweep:")) return true;
  return SWEEP_CONDITIONS.some((c) => kind === c || kind === `${c}-cleared`);
}

export function isSweepObservationKind(kind: unknown): kind is SweepObservationKind {
  return typeof kind === "string" && (SWEEP_OBSERVATION_KINDS as readonly string[]).includes(kind);
}

export type Fields = Record<string, string>;
export type Checked<T> = { ok: true; value: T } | { ok: false; fields: Fields };

/** `detail` is our own text about transitions, safe to return to the caller. */
export class SweepEvidenceConflict extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "SweepEvidenceConflict";
    this.detail = detail;
  }
}

// ---------------------------------------------------------------- readers

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Reader {
  readonly fields: Fields = {};
  constructor(private readonly obj: Record<string, unknown>, private readonly prefix: string, allowed: readonly string[]) {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) this.fail(key, "is not a known field.");
    }
  }

  private name(key: string): string {
    return this.prefix ? `${this.prefix}.${key}` : key;
  }

  fail(key: string, message: string): void {
    const name = this.name(key);
    if (!(name in this.fields)) this.fields[name] = `${name} ${message}`;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.obj, key) && this.obj[key] !== undefined;
  }

  raw(key: string): unknown {
    return this.obj[key];
  }

  ident(key: string, pattern = IDENT): string {
    const value = this.obj[key];
    if (typeof value !== "string" || !pattern.test(value)) {
      this.fail(key, `must match ${pattern.source}.`);
      return "";
    }
    return value;
  }

  text(key: string, max: number, opts: { required?: boolean } = {}): string | null {
    const value = this.obj[key];
    if (value === undefined || value === null) {
      if (opts.required) this.fail(key, "is required.");
      return null;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL.test(value)) {
      this.fail(key, `must be a string of 1 to ${max} characters with no control characters.`);
      return null;
    }
    return value;
  }

  citation(key: string): string | null {
    const value = this.obj[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > CITATION_MAX || !CITATION.test(value)) {
      this.fail(key, "must be decision:<id>, owner/name#<n>, an https URL, or doc:<path>, at most 300 characters.");
      return null;
    }
    return value;
  }

  timestamp(key: string, opts: { required?: boolean } = {}): string | null {
    const value = this.obj[key];
    if (value === undefined || value === null) {
      if (opts.required) this.fail(key, "is required.");
      return null;
    }
    const parsed = typeof value === "string" && ISO.test(value) ? ms(value) : null;
    if (parsed === null) {
      this.fail(key, "must be an ISO 8601 timestamp with a time zone.");
      return null;
    }
    const year = new Date(parsed).getUTCFullYear();
    if (year < 2000 || year > 2100) {
      this.fail(key, "must be between the years 2000 and 2100.");
      return null;
    }
    return new Date(parsed).toISOString();
  }

  positiveInt(key: string): number {
    const value = this.obj[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      this.fail(key, "must be a positive integer.");
      return 0;
    }
    return value;
  }

  count(key: string): number | null {
    const value = this.obj[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > COUNT_MAX) {
      this.fail(key, `must be an integer from 0 to ${COUNT_MAX}.`);
      return null;
    }
    return value;
  }

  bool(key: string, opts: { required?: boolean; fallback?: boolean } = {}): boolean | null {
    const value = this.obj[key];
    if (value === undefined || value === null) {
      if (opts.required) this.fail(key, "is required.");
      return opts.fallback ?? null;
    }
    if (typeof value !== "boolean") {
      this.fail(key, "must be a boolean.");
      return null;
    }
    return value;
  }

  staleAfter(key: string): number {
    if (!this.has(key) || this.obj[key] === null) return DEFAULT_STALE_MINUTES;
    const value = this.obj[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > 1440) {
      this.fail(key, "must be an integer from 5 to 1440 minutes.");
      return DEFAULT_STALE_MINUTES;
    }
    return value;
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const value = this.obj[key];
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      this.fail(key, `must be one of ${values.join(", ")}.`);
      return values[0];
    }
    return value as T;
  }

  repo(key: string, opts: { required?: boolean } = {}): string | null {
    const value = this.obj[key];
    if (value === undefined || value === null) {
      if (opts.required) this.fail(key, "is required.");
      return null;
    }
    if (typeof value !== "string" || !REPO.test(value)) {
      this.fail(key, "must be owner/name.");
      return null;
    }
    return value;
  }

  sha(key: string): string | null {
    const value = this.obj[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !SHA.test(value)) {
      this.fail(key, "must be a lowercase hex commit id.");
      return null;
    }
    return value;
  }

  refs(key: string): string[] {
    const value = this.obj[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > REFS_MAX) {
      this.fail(key, `must be an array of at most ${REFS_MAX} strings.`);
      return [];
    }
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0 || item.length > REF_MAX || CONTROL.test(item)) {
        this.fail(key, `items must be strings of 1 to ${REF_MAX} characters.`);
        return [];
      }
    }
    return value as string[];
  }

  object(key: string, opts: { required?: boolean } = {}): Record<string, unknown> | null {
    const value = this.obj[key];
    if (value === undefined || value === null) {
      if (opts.required) this.fail(key, "is required.");
      return null;
    }
    if (!isObject(value)) {
      this.fail(key, "must be an object.");
      return null;
    }
    return value;
  }

  child(key: string, value: Record<string, unknown>, allowed: readonly string[]): Reader {
    return new Reader(value, this.name(key), allowed);
  }

  merge(other: Reader): void {
    for (const [k, v] of Object.entries(other.fields)) if (!(k in this.fields)) this.fields[k] = v;
  }

  done<T>(value: T): Checked<T> {
    return Object.keys(this.fields).length > 0 ? { ok: false, fields: this.fields } : { ok: true, value };
  }
}

function rootReader(body: unknown, allowed: readonly string[]): Reader | Checked<never> {
  if (!isObject(body)) return { ok: false, fields: { observation: "observation must be an object." } };
  return new Reader(body, "observation", allowed);
}

// ------------------------------------------------------------ scheduler job

export interface SchedulerObservation {
  source: string;
  job_id: string;
  state: "active" | "paused";
  transition: number;
  paused_at: string | null;
  paused_reason: string | null;
  until: string | null;
  decision: string | null;
  observed_at: string;
  /** Null when omitted: a new transition uses the default, a refresh keeps the stored window. */
  stale_after_minutes: number | null;
}

const SCHEDULER_FIELDS = ["source", "job_id", "state", "transition", "paused_at", "paused_reason", "until", "decision", "observed_at", "stale_after_minutes"];

/**
 * A paused observation may carry paused_at, paused_reason, until, and the
 * pause's decision. An active observation may carry only its own decision:
 * the citation for that resume. A pause field on an active observation is
 * rejected rather than guessed at.
 */
export function checkSchedulerObservation(body: unknown): Checked<SchedulerObservation> {
  const r = rootReader(body, SCHEDULER_FIELDS);
  if (!(r instanceof Reader)) return r;
  const state = r.oneOf("state", ["active", "paused"] as const);
  const value: SchedulerObservation = {
    source: r.ident("source"),
    job_id: r.ident("job_id"),
    state,
    transition: r.positiveInt("transition"),
    paused_at: r.timestamp("paused_at"),
    paused_reason: r.text("paused_reason", REASON_MAX),
    until: r.timestamp("until"),
    decision: r.citation("decision"),
    observed_at: r.timestamp("observed_at", { required: true }) ?? "",
    stale_after_minutes: r.has("stale_after_minutes") && r.raw("stale_after_minutes") !== null ? r.staleAfter("stale_after_minutes") : null,
  };
  if (state === "active") {
    for (const key of ["paused_at", "paused_reason", "until"] as const) {
      if (r.has(key) && r.raw(key) !== null) r.fail(key, "is only valid on a paused observation.");
    }
  }
  return r.done(value);
}

// ------------------------------------------------------------------- queue

export interface QueueObservation {
  source: string;
  queue: string;
  classification: (typeof QUEUE_CLASSIFICATIONS)[number];
  repo: string | null;
  seq: number;
  observed_at: string;
  complete: boolean;
  error: string | null;
  ready_count: number | null;
  raw_count: number | null;
  ready_refs: string[];
  raw_refs: string[];
  stale_after_minutes: number;
}

const QUEUE_FIELDS = ["source", "queue", "classification", "repo", "seq", "observed_at", "complete", "error", "ready", "raw", "stale_after_minutes"];

/**
 * issue_dispatch: ready is open issues labelled dispatch-ready and not
 * blocked; raw is open issues with neither the dispatch-ready nor the blocked
 * label (unspecced). pr_review: ready is open non-draft PRs at their current
 * head waiting on a reviewer; raw is every open PR. A complete observation
 * must carry both counts. An incomplete one is stored as unknown, never zero.
 */
export function checkQueueObservation(body: unknown): Checked<QueueObservation> {
  const r = rootReader(body, QUEUE_FIELDS);
  if (!(r instanceof Reader)) return r;
  const complete = r.bool("complete", { required: true }) === true;
  const readCounts = (key: "ready" | "raw") => {
    const obj = r.object(key, { required: complete });
    if (!obj) return { count: null, refs: [] as string[] };
    const child = r.child(key, obj, ["count", "refs"]);
    const count = child.count("count");
    const refs = child.refs("refs");
    r.merge(child);
    return { count, refs };
  };
  const ready = readCounts("ready");
  const raw = readCounts("raw");
  const queueRaw = r.raw("queue");
  const value: QueueObservation = {
    source: r.ident("source"),
    queue: typeof queueRaw === "string" ? queueRaw.toLowerCase() : "",
    classification: r.oneOf("classification", QUEUE_CLASSIFICATIONS),
    repo: r.repo("repo"),
    seq: r.positiveInt("seq"),
    observed_at: r.timestamp("observed_at", { required: true }) ?? "",
    complete,
    error: r.text("error", ERROR_MAX),
    ready_count: complete ? ready.count : null,
    raw_count: complete ? raw.count : null,
    ready_refs: complete ? ready.refs : [],
    raw_refs: complete ? raw.refs : [],
    stale_after_minutes: r.staleAfter("stale_after_minutes"),
  };
  if (!QUEUE_ID.test(value.queue)) r.fail("queue", `must match ${QUEUE_ID.source} (case-insensitive).`);
  return r.done(value);
}

// -------------------------------------------------------------- PR snapshot

export interface PrObservationRow {
  number: number;
  title: string | null;
  url: string | null;
  draft: boolean;
  opened_at: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  head_sha: string;
  checks_state: "success" | "pending" | "failure" | "unknown";
  checks_head_sha: string | null;
  review_started: boolean | null;
  review_head_sha: string | null;
}

export interface PrSnapshotObservation {
  source: string;
  repo: string;
  seq: number;
  observed_at: string;
  complete: boolean;
  error: string | null;
  stale_after_minutes: number;
  prs: PrObservationRow[];
}

const PR_SNAPSHOT_FIELDS = ["source", "repo", "seq", "observed_at", "complete", "error", "stale_after_minutes", "prs"];
const PR_FIELDS = ["number", "title", "url", "draft", "opened_at", "mergeable", "head_sha", "required_checks", "review"];

/**
 * Every open PR in one repository at one instant. complete true means the
 * list is the whole open set (at most 200); a PR missing from a complete
 * snapshot is closed. required_checks is the rollup of the required checks at
 * one head; "unknown" when the required set is not known. review.head_sha is
 * the head the latest review started on.
 */
export function checkPrSnapshotObservation(body: unknown): Checked<PrSnapshotObservation> {
  const r = rootReader(body, PR_SNAPSHOT_FIELDS);
  if (!(r instanceof Reader)) return r;
  const complete = r.bool("complete", { required: true }) === true;
  const prs: PrObservationRow[] = [];
  const list = r.raw("prs");
  if (list !== undefined && list !== null) {
    if (!Array.isArray(list) || list.length > PRS_MAX) {
      r.fail("prs", `must be an array of at most ${PRS_MAX} PRs. Send complete false when there are more.`);
    } else {
      const seen = new Set<number>();
      list.forEach((item, index) => {
        if (!isObject(item)) {
          r.fail(`prs[${index}]`, "must be an object.");
          return;
        }
        const p = r.child(`prs[${index}]`, item, PR_FIELDS);
        const checks = p.object("required_checks");
        const review = p.object("review");
        const c = checks ? p.child("required_checks", checks, ["state", "head_sha"]) : null;
        const v = review ? p.child("review", review, ["started", "head_sha"]) : null;
        const url = p.text("url", 300);
        if (url !== null && !url.startsWith("https://")) p.fail("url", "must be an https URL.");
        const row: PrObservationRow = {
          number: p.positiveInt("number"),
          title: p.text("title", 200),
          url,
          draft: p.bool("draft", { required: true }) === true,
          opened_at: p.timestamp("opened_at", { required: true }) ?? "",
          mergeable: p.oneOf("mergeable", ["mergeable", "conflicting", "unknown"] as const),
          head_sha: p.sha("head_sha") ?? "",
          checks_state: c ? c.oneOf("state", ["success", "pending", "failure", "unknown"] as const) : "unknown",
          checks_head_sha: c ? c.sha("head_sha") : null,
          review_started: v ? v.bool("started", { required: true }) : null,
          review_head_sha: v ? v.sha("head_sha") : null,
        };
        if (!p.has("head_sha")) p.fail("head_sha", "is required.");
        if (seen.has(row.number)) p.fail("number", "appears twice in one snapshot.");
        seen.add(row.number);
        if (c) p.merge(c);
        if (v) p.merge(v);
        r.merge(p);
        prs.push(row);
      });
    }
  } else if (complete) {
    r.fail("prs", "is required when complete is true.");
  }
  const value: PrSnapshotObservation = {
    source: r.ident("source"),
    repo: r.repo("repo", { required: true }) ?? "",
    seq: r.positiveInt("seq"),
    observed_at: r.timestamp("observed_at", { required: true }) ?? "",
    complete,
    error: r.text("error", ERROR_MAX),
    stale_after_minutes: r.staleAfter("stale_after_minutes"),
    prs: complete ? prs : [],
  };
  return r.done(value);
}

// ------------------------------------------------------------- consumers

export interface ConsumerRegistration {
  id: string;
  agent_ids: string[];
  reporters: { kind: (typeof PRINCIPAL_KINDS)[number]; id: string }[];
  queue: { type: "tasks"; platform: string; machine: string | null } | { type: "collector"; queue: string };
  scheduler: { source: string; job_id: string } | null;
  enabled: boolean;
  max_silence_hours: number;
}

const CONSUMER_FIELDS = ["id", "agent_ids", "reporters", "queue", "scheduler", "enabled", "max_silence_hours"];

/**
 * agent_ids are the slugs report() stores. reporters are the authenticated
 * principals whose work events count: an agent_id alone proves nothing. A
 * tasks queue is ready work as claimNextTask sees it (queued, this platform
 * or any, and unpinned or pinned to this machine). A collector queue names a
 * sweep.queue observation.
 */
export function checkConsumerRegistration(body: unknown): Checked<ConsumerRegistration> {
  if (!isObject(body)) return { ok: false, fields: { body: "Send a JSON object." } };
  const r = new Reader(body, "", CONSUMER_FIELDS);
  const id = r.ident("id");
  const agentIds: string[] = [];
  const rawIds = r.raw("agent_ids");
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > AGENT_IDS_MAX) {
    r.fail("agent_ids", `must be an array of 1 to ${AGENT_IDS_MAX} agent ids.`);
  } else {
    for (const item of rawIds) {
      if (typeof item !== "string" || item.length === 0 || slugify(item) !== item) {
        r.fail("agent_ids", "items must be agent id slugs (lowercase letters, digits, and hyphens).");
        break;
      }
      if (!agentIds.includes(item)) agentIds.push(item);
    }
  }
  const reporters: ConsumerRegistration["reporters"] = [];
  const rawReporters = r.raw("reporters");
  if (!Array.isArray(rawReporters) || rawReporters.length === 0 || rawReporters.length > REPORTERS_MAX) {
    r.fail("reporters", `must be an array of 1 to ${REPORTERS_MAX} {kind, id} principals.`);
  } else {
    rawReporters.forEach((item, index) => {
      if (!isObject(item)) {
        r.fail(`reporters[${index}]`, "must be an object.");
        return;
      }
      const p = r.child(`reporters[${index}]`, item, ["kind", "id"]);
      const kind = p.oneOf("kind", PRINCIPAL_KINDS);
      const pid = p.ident("id", PRINCIPAL_ID);
      r.merge(p);
      if (!reporters.some((x) => x.kind === kind && x.id === pid)) reporters.push({ kind, id: pid });
    });
  }
  let queue: ConsumerRegistration["queue"] = { type: "collector", queue: "" };
  const rawQueue = r.object("queue", { required: true });
  if (rawQueue) {
    const type = rawQueue.type;
    if (type === "tasks") {
      const q = r.child("queue", rawQueue, ["type", "platform", "machine"]);
      queue = { type: "tasks", platform: q.ident("platform"), machine: q.text("machine", 100) };
      r.merge(q);
    } else if (type === "collector") {
      const q = r.child("queue", rawQueue, ["type", "queue"]);
      const name = typeof rawQueue.queue === "string" ? rawQueue.queue.toLowerCase() : "";
      if (!QUEUE_ID.test(name)) q.fail("queue", "must name a sweep.queue queue id.");
      queue = { type: "collector", queue: name };
      r.merge(q);
    } else {
      r.fail("queue", "type must be tasks or collector.");
    }
  }
  let scheduler: ConsumerRegistration["scheduler"] = null;
  const rawScheduler = r.object("scheduler");
  if (rawScheduler) {
    const s = r.child("scheduler", rawScheduler, ["source", "job_id"]);
    scheduler = { source: s.ident("source"), job_id: s.ident("job_id") };
    r.merge(s);
  }
  let maxSilence = DEFAULT_SILENCE_HOURS;
  if (r.has("max_silence_hours") && r.raw("max_silence_hours") !== null) {
    const value = r.raw("max_silence_hours");
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 168) {
      r.fail("max_silence_hours", "must be a number greater than 0 and at most 168.");
    } else maxSilence = value;
  }
  const enabled = r.bool("enabled", { fallback: true });
  return r.done({
    id,
    agent_ids: agentIds,
    reporters,
    queue,
    scheduler,
    enabled: enabled !== false,
    max_silence_hours: maxSilence,
  });
}

// ------------------------------------------------------------------ writes

export interface WriteOutcome {
  outcome: "applied" | "refreshed" | "older" | "replay";
  observation_id: string;
  received_at: string;
}

async function lockSubject(tx: SqlTag, subject: string): Promise<string> {
  await tx`select pg_advisory_xact_lock(hashtext(${`agent-kontrol:sweep-evidence:${subject}`}))`;
  return dbInstant(tx);
}

async function audit(
  tx: SqlTag,
  kind: string,
  source: string,
  subject: string,
  seq: number | null,
  outcome: string,
  payload: unknown,
  provenance: Provenance,
  now: string,
): Promise<string> {
  const rows = await tx`
    insert into sweep_observations (kind, source, subject, seq, outcome, payload, principal_kind, principal_id, received_at)
    values (${kind}, ${source}, ${subject}, ${seq}, ${outcome}, ${JSON.stringify(payload)}::jsonb,
            ${provenance.principal_kind}, ${provenance.principal_id}, ${now}::timestamptz)
    returning id::text as id
  `;
  return String(rows[0].id);
}

function prevFresh(receivedAt: unknown, staleMinutes: unknown, nowIso: string): boolean {
  const at = ms(receivedAt instanceof Date ? receivedAt.toISOString() : String(receivedAt ?? ""));
  const now = ms(nowIso);
  const minutes = Number(staleMinutes);
  return at !== null && now !== null && Number.isFinite(minutes) && at >= now - minutes * 60_000;
}

/**
 * Lower transition: audit only. Same transition: a refresh; a different
 * state is 409 and writes nothing; a non-null field adds or replaces, an
 * omitted or null field keeps what is stored, so a replay cannot drop a
 * citation. Higher transition: fresh fields, prior_* keeps what it replaced,
 * and resumed marks an observed paused-to-active change. The pause's
 * decision moves to prior_decision; it never cites the resume.
 */
export async function writeSchedulerObservation(obs: SchedulerObservation, provenance: Provenance): Promise<WriteOutcome> {
  return withTransaction(async (tx) => {
    const now = await lockSubject(tx, `scheduler:${obs.source}/${obs.job_id}`);
    const rows = await tx`
      select state, transition::text as transition from scheduler_jobs
      where source = ${obs.source} and job_id = ${obs.job_id}
      for update
    `;
    const current = rows[0];
    const currentTransition = current ? Number(current.transition) : 0;
    let outcome: WriteOutcome["outcome"];
    if (!current || obs.transition > currentTransition) outcome = "applied";
    else if (obs.transition < currentTransition) outcome = "older";
    else {
      if (current.state !== obs.state) {
        throw new SweepEvidenceConflict(`transition ${obs.transition} is already recorded as ${String(current.state)}. A state change needs a higher transition.`);
      }
      outcome = "refreshed";
    }
    const id = await audit(tx, "scheduler_job", obs.source, `${obs.source}/${obs.job_id}`, obs.transition, outcome, obs, provenance, now);
    if (outcome === "applied") {
      await tx`
        insert into scheduler_jobs (
          source, job_id, state, transition, paused_at, paused_reason, until, decision,
          prior_state, prior_transition, prior_decision, resumed, observed_at, stale_after_minutes,
          transition_received_at, last_received_at, last_observation_id, version
        ) values (
          ${obs.source}, ${obs.job_id}, ${obs.state}, ${obs.transition}, ${obs.paused_at}::timestamptz,
          ${obs.paused_reason}, ${obs.until}::timestamptz, ${obs.decision},
          null, null, null, false, ${obs.observed_at}::timestamptz, ${obs.stale_after_minutes ?? DEFAULT_STALE_MINUTES},
          ${now}::timestamptz, ${now}::timestamptz, ${id}::bigint, 1
        )
        on conflict (source, job_id) do update set
          prior_state = scheduler_jobs.state,
          prior_transition = scheduler_jobs.transition,
          prior_decision = scheduler_jobs.decision,
          resumed = (scheduler_jobs.state = 'paused' and excluded.state = 'active'),
          state = excluded.state,
          transition = excluded.transition,
          paused_at = excluded.paused_at,
          paused_reason = excluded.paused_reason,
          until = excluded.until,
          decision = excluded.decision,
          observed_at = excluded.observed_at,
          stale_after_minutes = excluded.stale_after_minutes,
          transition_received_at = excluded.transition_received_at,
          last_received_at = excluded.last_received_at,
          last_observation_id = excluded.last_observation_id,
          version = scheduler_jobs.version + 1
        where excluded.transition > scheduler_jobs.transition
      `;
    } else if (outcome === "refreshed") {
      await tx`
        update scheduler_jobs set
          paused_at = coalesce(${obs.paused_at}::timestamptz, paused_at),
          paused_reason = coalesce(${obs.paused_reason}::text, paused_reason),
          until = coalesce(${obs.until}::timestamptz, until),
          decision = coalesce(${obs.decision}::text, decision),
          observed_at = greatest(observed_at, ${obs.observed_at}::timestamptz),
          stale_after_minutes = coalesce(${obs.stale_after_minutes}::integer, stale_after_minutes),
          last_received_at = greatest(last_received_at, ${now}::timestamptz),
          last_observation_id = ${id}::bigint,
          version = version + 1
        where source = ${obs.source} and job_id = ${obs.job_id} and transition = ${obs.transition}
      `;
    }
    return { outcome, observation_id: id, received_at: now };
  });
}

/**
 * seq orders one queue's observations. A seq at or below the stored one is a
 * replay or an older collection: audit only, so it cannot replace newer state
 * or a newer failure. empty_since continues only from a complete observation
 * that was still fresh when this one arrived.
 */
export async function writeQueueObservation(obs: QueueObservation, provenance: Provenance): Promise<WriteOutcome> {
  return withTransaction(async (tx) => {
    const now = await lockSubject(tx, `queue:${obs.queue}`);
    const rows = await tx`
      select seq::text as seq, complete, received_at, stale_after_minutes, empty_since
      from sweep_queues where queue = ${obs.queue}
      for update
    `;
    const current = rows[0];
    const outcome: WriteOutcome["outcome"] = !current
      ? "applied"
      : obs.seq > Number(current.seq) ? "applied" : obs.seq === Number(current.seq) ? "replay" : "older";
    const payload = { ...obs, ready_refs: obs.ready_refs, raw_refs: obs.raw_refs };
    const id = await audit(tx, "queue", obs.source, obs.queue, obs.seq, outcome, payload, provenance, now);
    if (outcome !== "applied") return { outcome, observation_id: id, received_at: now };
    const emptyNow = obs.complete && (obs.raw_count ?? 0) > 0 && obs.ready_count === 0;
    let emptySince: string | null = null;
    if (emptyNow) {
      const continues = current && current.complete === true && current.empty_since
        && prevFresh(current.received_at, current.stale_after_minutes, now);
      emptySince = continues ? new Date(current.empty_since as string).toISOString() : now;
    }
    await tx`
      insert into sweep_queues (
        queue, source, classification, repo, complete, error, ready_count, raw_count, ready_refs, raw_refs,
        seq, observed_at, stale_after_minutes, received_at, empty_since, last_observation_id, version
      ) values (
        ${obs.queue}, ${obs.source}, ${obs.classification}, ${obs.repo}, ${obs.complete}, ${obs.error},
        ${obs.ready_count}, ${obs.raw_count}, ${JSON.stringify(obs.ready_refs)}::jsonb, ${JSON.stringify(obs.raw_refs)}::jsonb,
        ${obs.seq}, ${obs.observed_at}::timestamptz, ${obs.stale_after_minutes}, ${now}::timestamptz,
        ${emptySince}::timestamptz, ${id}::bigint, 1
      )
      on conflict (queue) do update set
        source = excluded.source,
        classification = excluded.classification,
        repo = excluded.repo,
        complete = excluded.complete,
        error = excluded.error,
        ready_count = excluded.ready_count,
        raw_count = excluded.raw_count,
        ready_refs = excluded.ready_refs,
        raw_refs = excluded.raw_refs,
        seq = excluded.seq,
        observed_at = excluded.observed_at,
        stale_after_minutes = excluded.stale_after_minutes,
        received_at = excluded.received_at,
        empty_since = excluded.empty_since,
        last_observation_id = excluded.last_observation_id,
        version = sweep_queues.version + 1
      where excluded.seq > sweep_queues.seq
    `;
    return { outcome, observation_id: id, received_at: now };
  });
}

/**
 * A complete snapshot replaces the repository's open set: listed PRs are
 * upserted, and open PRs it does not list are marked closed. An incomplete
 * snapshot only records the failure, so every PR in that repository is
 * unknown until a complete one arrives. green_since survives only when the
 * head and the green check state are unchanged and the previous snapshot was
 * complete and still fresh.
 */
export async function writePrSnapshot(obs: PrSnapshotObservation, provenance: Provenance): Promise<WriteOutcome> {
  const key = repoKey(obs.repo);
  return withTransaction(async (tx) => {
    const now = await lockSubject(tx, `pr:${key}`);
    const rows = await tx`
      select seq::text as seq, complete, received_at, stale_after_minutes
      from sweep_pr_sources where repo_key = ${key}
      for update
    `;
    const current = rows[0];
    const outcome: WriteOutcome["outcome"] = !current
      ? "applied"
      : obs.seq > Number(current.seq) ? "applied" : obs.seq === Number(current.seq) ? "replay" : "older";
    const id = await audit(tx, "pr_snapshot", obs.source, key, obs.seq, outcome, obs, provenance, now);
    if (outcome !== "applied") return { outcome, observation_id: id, received_at: now };
    const continuous = Boolean(current && current.complete === true && prevFresh(current.received_at, current.stale_after_minutes, now));
    await tx`
      insert into sweep_pr_sources (repo_key, repo, source, complete, error, seq, observed_at, stale_after_minutes, received_at, last_observation_id, version)
      values (${key}, ${obs.repo}, ${obs.source}, ${obs.complete}, ${obs.error}, ${obs.seq}, ${obs.observed_at}::timestamptz,
              ${obs.stale_after_minutes}, ${now}::timestamptz, ${id}::bigint, 1)
      on conflict (repo_key) do update set
        repo = excluded.repo,
        source = excluded.source,
        complete = excluded.complete,
        error = excluded.error,
        seq = excluded.seq,
        observed_at = excluded.observed_at,
        stale_after_minutes = excluded.stale_after_minutes,
        received_at = excluded.received_at,
        last_observation_id = excluded.last_observation_id,
        version = sweep_pr_sources.version + 1
    `;
    if (!obs.complete) return { outcome, observation_id: id, received_at: now };
    const existing = await tx`
      select number, head_sha, checks_state, checks_head_sha, green_since, open
      from sweep_prs where repo_key = ${key}
      for update
    `;
    const prior = new Map(existing.map((row) => [Number(row.number), row]));
    const upserts = obs.prs.map((pr) => {
      const before = prior.get(pr.number);
      const green = pr.checks_state === "success" && pr.checks_head_sha === pr.head_sha;
      let greenSince: string | null = null;
      if (green) {
        const same = continuous && before && before.open === true && before.head_sha === pr.head_sha
          && before.checks_state === "success" && before.checks_head_sha === pr.head_sha && before.green_since;
        greenSince = same ? new Date(before.green_since as string).toISOString() : now;
      }
      return { ...pr, green_since: greenSince };
    });
    if (upserts.length > 0) {
      await tx`
        insert into sweep_prs (
          repo_key, number, repo, title, url, open, draft, opened_at, mergeable, head_sha,
          checks_state, checks_head_sha, review_started, review_head_sha, green_since, seq, received_at, version
        )
        select ${key}, x.number, ${obs.repo}, x.title, x.url, true, x.draft, x.opened_at, x.mergeable, x.head_sha,
               x.checks_state, x.checks_head_sha, x.review_started, x.review_head_sha, x.green_since,
               ${obs.seq}, ${now}::timestamptz, 1
        from jsonb_to_recordset(${JSON.stringify(upserts)}::jsonb) as x(
          number integer, title text, url text, draft boolean, opened_at timestamptz, mergeable text, head_sha text,
          checks_state text, checks_head_sha text, review_started boolean, review_head_sha text, green_since timestamptz
        )
        on conflict (repo_key, number) do update set
          repo = excluded.repo,
          title = excluded.title,
          url = excluded.url,
          open = true,
          draft = excluded.draft,
          opened_at = excluded.opened_at,
          mergeable = excluded.mergeable,
          head_sha = excluded.head_sha,
          checks_state = excluded.checks_state,
          checks_head_sha = excluded.checks_head_sha,
          review_started = excluded.review_started,
          review_head_sha = excluded.review_head_sha,
          green_since = excluded.green_since,
          seq = excluded.seq,
          received_at = excluded.received_at,
          version = sweep_prs.version + 1
      `;
    }
    const listed = obs.prs.map((pr) => pr.number);
    await tx`
      update sweep_prs set open = false, green_since = null, seq = ${obs.seq}, received_at = ${now}::timestamptz, version = version + 1
      where repo_key = ${key} and open and not (number = any(${listed}::int[]))
    `;
    return { outcome, observation_id: id, received_at: now };
  });
}

export async function writeObservation(kind: SweepObservationKind, body: unknown, provenance: Provenance): Promise<Checked<WriteOutcome>> {
  if (kind === "sweep.scheduler_job") {
    const checked = checkSchedulerObservation(body);
    return checked.ok ? { ok: true, value: await writeSchedulerObservation(checked.value, provenance) } : checked;
  }
  if (kind === "sweep.queue") {
    const checked = checkQueueObservation(body);
    return checked.ok ? { ok: true, value: await writeQueueObservation(checked.value, provenance) } : checked;
  }
  const checked = checkPrSnapshotObservation(body);
  return checked.ok ? { ok: true, value: await writePrSnapshot(checked.value, provenance) } : checked;
}

/** Upsert. registered_at is set on the first insert and never moved, so re-registering does not reset grace. */
export async function upsertConsumer(reg: ConsumerRegistration, provenance: Provenance, actor: { actor_type: string; actor_id: string }): Promise<{ id: string; registered_at: string; created: boolean }> {
  return withTransaction(async (tx) => {
    const now = await lockSubject(tx, `consumer:${reg.id}`);
    const rows = await tx`
      insert into sweep_consumers (
        id, agent_ids, reporters, queue, scheduler_source, scheduler_job, enabled, max_silence_hours,
        registered_at, updated_at, actor_type, actor_id
      ) values (
        ${reg.id}, ${reg.agent_ids}::text[], ${JSON.stringify(reg.reporters)}::jsonb, ${JSON.stringify(reg.queue)}::jsonb,
        ${reg.scheduler?.source ?? null}, ${reg.scheduler?.job_id ?? null}, ${reg.enabled}, ${reg.max_silence_hours},
        ${now}::timestamptz, ${now}::timestamptz, ${actor.actor_type}, ${actor.actor_id}
      )
      on conflict (id) do update set
        agent_ids = excluded.agent_ids,
        reporters = excluded.reporters,
        queue = excluded.queue,
        scheduler_source = excluded.scheduler_source,
        scheduler_job = excluded.scheduler_job,
        enabled = excluded.enabled,
        max_silence_hours = excluded.max_silence_hours,
        updated_at = excluded.updated_at,
        actor_type = excluded.actor_type,
        actor_id = excluded.actor_id
      returning registered_at, (xmax = 0) as created
    `;
    await audit(tx, "consumer", "registration", reg.id, null, "applied", reg, provenance, now);
    const row = rows[0];
    return { id: reg.id, registered_at: new Date(row.registered_at as string).toISOString(), created: row.created === true };
  });
}
