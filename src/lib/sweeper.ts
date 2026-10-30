import { sql, withTransaction, type Row, type SqlTag } from "./db";
import { insertGhEvent } from "./gh-events";
import { briefConfig } from "./progress-config";
import { dbInstant } from "./sweep-clock";
import {
  DECISION_AGING_DAYS,
  RETENTION_DAYS,
  WORK_EVENT_KINDS,
  consumerSilent,
  consumerVerdict,
  decisionVerdict,
  dispatchVerdict,
  evaluatePr,
  ms,
  pauseVerdicts,
  pausedSection,
  queueReady,
  resumeVerdict,
  stepLatch,
  unmeasuredPaused,
  type LatchState,
  type PausedSection,
  type PrFacts,
  type PrSourceFacts,
  type QueueFacts,
  type SchedulerJobFacts,
  type SweepCondition,
  type Tri,
  type Verdict,
} from "./sweep-logic";

/**
 * The absence sweeper (#79). One run evaluates six independent domains, each
 * in its own transaction, then prunes the inbox:
 *
 *   consumers  consumer-silent
 *   prs        pr-stuck
 *   pauses     pause-unexplained, pause-expired (one pause, one alarm)
 *   resumes    resume-uncited
 *   decisions  decision-aging
 *   dispatch   dispatch-ready-empty
 *
 * Each domain takes a transaction advisory lock, reads one database instant
 * after it, reads its evidence with row locks, and writes latch changes and
 * inbox rows before commit. A concurrent run waits on the lock and then sees
 * the committed latches, so it cannot emit the same row twice or overwrite a
 * newer evaluation. A failed statement aborts only its own domain; the others
 * still run. No network call happens inside a transaction. The caller cannot
 * pass "now".
 *
 * Synthetic inbox rows use `sweep:` delivery ids (gh-events.ts reserves the
 * namespace). The payload is bounded evidence references, never a prompt.
 */

export const SWEEP_SOURCE = "agent-kontrol-sweeper";
/** Entities one domain evaluates per run. More is reported as incomplete; unvisited is not clear. */
export const DOMAIN_ENTITY_LIMIT = 500;
export const RESULT_ENTITY_LIMIT = 100;
export const RETENTION_BATCH = 1000;
export const RETENTION_MAX_BATCHES = 10;

export type CheckState = "firing" | "clear" | "held" | "unknown" | "not_configured";

export interface EntityResult {
  entity_key: string;
  verdict: Verdict;
  emitted: string | null;
  detail?: Record<string, unknown>;
}

export interface CheckResult {
  check: SweepCondition;
  state: CheckState;
  evaluated_at: string | null;
  complete: boolean;
  unvisited: number;
  counts: Record<Verdict, number>;
  emitted: string[];
  entities: EntityResult[];
  entities_truncated: boolean;
  error: string | null;
  note?: string;
}

export interface RetentionResult {
  state: "ok" | "unknown";
  evaluated_at: string | null;
  deleted: number;
  batches: number;
  complete: boolean;
  horizon_days: number;
  error: string | null;
}

export interface SweepRun {
  checks: CheckResult[];
  retention: RetentionResult;
}

interface Finding {
  condition: SweepCondition;
  entity_key: string;
  verdict: Verdict;
  version: number | null;
  meta?: { repo?: string | null; number?: number | null; head_sha?: string | null };
  evidence: Record<string, unknown>;
}

interface DomainOutput {
  conditions: SweepCondition[];
  findings: Finding[];
  configured: boolean;
  unvisited: number;
  note?: string;
}

const EMPTY_COUNTS = (): Record<Verdict, number> => ({ firing: 0, clear: 0, held: 0, unknown: 0 });

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorText(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : null;
  const name = err instanceof Error ? err.name : "Error";
  return code ? `${name} (${code}): the check could not read or write its evidence.` : `${name}: the check could not read or write its evidence.`;
}

async function activeLatchKeys(tx: SqlTag, conditions: SweepCondition[]): Promise<Map<SweepCondition, string[]>> {
  const rows = await tx`
    select condition, entity_key from sweep_latches
    where active and condition = any(${conditions}::text[])
    order by condition, entity_key
    limit ${DOMAIN_ENTITY_LIMIT * 2}
  `;
  const out = new Map<SweepCondition, string[]>();
  for (const row of rows) {
    const c = row.condition as SweepCondition;
    out.set(c, [...(out.get(c) ?? []), String(row.entity_key)]);
  }
  return out;
}

/** Active latches first, then the rest, capped. Returns the visited keys and how many were left out. */
function bounded(active: string[], candidates: string[]): { keys: string[]; unvisited: number } {
  const all = [...new Set([...active, ...candidates])];
  return { keys: all.slice(0, DOMAIN_ENTITY_LIMIT), unvisited: Math.max(0, all.length - DOMAIN_ENTITY_LIMIT) };
}

function payloadFor(finding: Finding, step: NonNullable<ReturnType<typeof stepLatch>["emit"]>, now: string): Record<string, unknown> {
  return {
    condition: finding.condition,
    entity_key: finding.entity_key,
    state: step.cleared ? "cleared" : "firing",
    verdict: finding.verdict,
    episode: step.episode,
    sequence: step.seq,
    source: SWEEP_SOURCE,
    evaluated_at: now,
    evidence: finding.evidence,
  };
}

/**
 * Lock or create the latch row, step it, and write the inbox row in the same
 * transaction. A latch evaluated at a later instant is never overwritten.
 * Unknown leaves active, episode, seq, and last_emitted_at as they are.
 */
async function applyFinding(tx: SqlTag, finding: Finding, now: string): Promise<string | null> {
  await tx`
    insert into sweep_latches (condition, entity_key) values (${finding.condition}, ${finding.entity_key})
    on conflict (condition, entity_key) do nothing
  `;
  const rows = await tx`
    select active, episode, seq, last_emitted_at, last_evaluated_at, evidence_version::text as evidence_version
    from sweep_latches where condition = ${finding.condition} and entity_key = ${finding.entity_key}
    for update
  `;
  const row = rows[0];
  const lastEvaluated = ms(iso(row.last_evaluated_at));
  if (lastEvaluated !== null && lastEvaluated > (ms(now) ?? 0)) return null;
  const storedVersion = num(row.evidence_version);
  if (finding.version !== null && storedVersion !== null && storedVersion > finding.version) return null;
  const prev: LatchState = {
    active: row.active === true,
    episode: Number(row.episode),
    seq: Number(row.seq),
    last_emitted_at: iso(row.last_emitted_at),
  };
  const step = stepLatch(finding.condition, finding.entity_key, prev, finding.verdict, now);
  if (step.emit) {
    await insertGhEvent({
      delivery_id: step.emit.delivery_id,
      event: step.emit.event,
      repo: finding.meta?.repo ?? null,
      number: finding.meta?.number ?? null,
      head_sha: finding.meta?.head_sha ?? null,
      payload: payloadFor(finding, step.emit, now),
    }, tx);
  }
  const fired = step.emit && !step.emit.cleared;
  const cleared = step.emit?.cleared === true;
  await tx`
    update sweep_latches set
      active = ${step.next.active},
      episode = ${step.next.episode},
      seq = ${step.next.seq},
      last_emitted_at = ${step.next.last_emitted_at}::timestamptz,
      first_fired_at = case when ${Boolean(fired && step.emit?.seq === 1)}::boolean then ${now}::timestamptz else first_fired_at end,
      cleared_at = case when ${cleared}::boolean then ${now}::timestamptz else cleared_at end,
      last_state = ${finding.verdict},
      last_evaluated_at = ${now}::timestamptz,
      evidence_version = coalesce(${finding.version}::bigint, evidence_version),
      updated_at = ${now}::timestamptz
    where condition = ${finding.condition} and entity_key = ${finding.entity_key}
  `;
  return step.emit?.delivery_id ?? null;
}

function summarize(condition: SweepCondition, output: DomainOutput | null, now: string | null, emittedBy: Map<string, string | null>, error: string | null): CheckResult {
  const counts = EMPTY_COUNTS();
  if (!output) {
    return {
      check: condition, state: "unknown", evaluated_at: now, complete: false, unvisited: 0, counts,
      emitted: [], entities: [], entities_truncated: false, error,
    };
  }
  const mine = output.findings.filter((f) => f.condition === condition);
  const entities: EntityResult[] = [];
  const emitted: string[] = [];
  for (const f of mine) {
    counts[f.verdict] += 1;
    const id = emittedBy.get(`${f.condition}\u0000${f.entity_key}`) ?? null;
    if (id) emitted.push(id);
    entities.push({ entity_key: f.entity_key, verdict: f.verdict, emitted: id, detail: f.evidence });
  }
  const complete = output.unvisited === 0;
  let state: CheckState;
  if (!output.configured && mine.length === 0) state = "not_configured";
  else if (counts.firing > 0) state = "firing";
  else if (counts.unknown > 0 || !complete) state = "unknown";
  else if (counts.held > 0) state = "held";
  else state = "clear";
  return {
    check: condition,
    state,
    evaluated_at: now,
    complete,
    unvisited: output.unvisited,
    counts,
    emitted,
    entities: entities.slice(0, RESULT_ENTITY_LIMIT),
    entities_truncated: entities.length > RESULT_ENTITY_LIMIT,
    error,
    ...(output.note ? { note: output.note } : {}),
  };
}

async function runDomain(
  name: string,
  conditions: SweepCondition[],
  evaluate: (tx: SqlTag, now: string) => Promise<DomainOutput>,
): Promise<CheckResult[]> {
  let now: string | null = null;
  try {
    const { output, emittedBy } = await withTransaction(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`agent-kontrol:sweep:${name}`}))`;
      now = await dbInstant(tx);
      const out = await evaluate(tx, now);
      const map = new Map<string, string | null>();
      for (const finding of out.findings) {
        map.set(`${finding.condition}\u0000${finding.entity_key}`, await applyFinding(tx, finding, now));
      }
      return { output: out, emittedBy: map };
    });
    return conditions.map((c) => summarize(c, output, now, emittedBy, null));
  } catch (err) {
    console.error(`[sweep] ${name} failed`, err);
    return conditions.map((c) => summarize(c, null, now, new Map(), errorText(err)));
  }
}

// ---------------------------------------------------------------- consumers

function schedulerFacts(row: Row): SchedulerJobFacts {
  return {
    source: String(row.source),
    job_id: String(row.job_id),
    state: row.state === "paused" ? "paused" : "active",
    transition: Number(row.transition),
    paused_at: iso(row.paused_at),
    paused_reason: str(row.paused_reason),
    until: iso(row.until),
    decision: str(row.decision),
    prior_state: str(row.prior_state),
    resumed: row.resumed === true,
    stale_after_minutes: Number(row.stale_after_minutes),
    last_received_at: iso(row.last_received_at) ?? "",
  };
}

function queueFacts(row: Row | undefined): QueueFacts | null {
  if (!row) return null;
  return {
    complete: row.complete === true,
    ready_count: num(row.ready_count),
    raw_count: num(row.raw_count),
    received_at: iso(row.received_at) ?? "",
    stale_after_minutes: Number(row.stale_after_minutes),
    empty_since: iso(row.empty_since),
  };
}

async function evaluateConsumers(tx: SqlTag, now: string): Promise<DomainOutput> {
  const nowMs = ms(now)!;
  const conditions: SweepCondition[] = ["consumer-silent"];
  const registry = await tx`
    select id, agent_ids, reporters, queue, scheduler_source, scheduler_job, enabled,
           max_silence_hours::float8 as max_silence_hours, registered_at
    from sweep_consumers order by id
  `;
  const latches = (await activeLatchKeys(tx, conditions)).get("consumer-silent") ?? [];
  const byKey = new Map(registry.map((row) => [`consumer:${String(row.id)}`, row]));
  const { keys, unvisited } = bounded(latches, [...byKey.keys()]);
  const findings: Finding[] = [];
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row || row.enabled !== true) {
      findings.push({ condition: "consumer-silent", entity_key: key, verdict: "clear", version: null, evidence: { registration: row ? "disabled" : "absent" } });
      continue;
    }
    const agentIds = (row.agent_ids as string[]) ?? [];
    const reporters = Array.isArray(row.reporters) ? (row.reporters as { kind: string; id: string }[]) : [];
    const kinds = reporters.map((r) => String(r.kind));
    const ids = reporters.map((r) => String(r.id));
    const work = await tx`
      select max(e.created_at) as last_work
      from events e
      where e.agent_id = any(${agentIds}::text[])
        and e.kind = any(${[...WORK_EVENT_KINDS]}::text[])
        and e.principal_kind is not null
        and (e.principal_kind, e.principal_id) in (select k, i from unnest(${kinds}::text[], ${ids}::text[]) as r(k, i))
    `;
    const queue = row.queue as { type?: string; platform?: string; machine?: string | null; queue?: string };
    let ready: Tri = null;
    let queueEvidence: Record<string, unknown> = { type: queue.type ?? null };
    if (queue.type === "tasks") {
      const counted = await tx`
        select count(*)::int as n from tasks
        where status = 'queued'
          and platform = any(${[String(queue.platform), "any"]}::text[])
          and (machine is null or machine = ${queue.machine ?? null}::text)
      `;
      const n = Number(counted[0].n);
      ready = n > 0;
      queueEvidence = { type: "tasks", platform: queue.platform, machine: queue.machine ?? null, queued: n };
    } else if (queue.type === "collector" && queue.queue) {
      const q = await tx`
        select queue, complete, ready_count, raw_count, received_at, stale_after_minutes, empty_since, last_observation_id::text as obs
        from sweep_queues where queue = ${queue.queue}
        for share
      `;
      ready = queueReady(queueFacts(q[0]), nowMs);
      queueEvidence = { type: "collector", queue: queue.queue, observation_id: q[0]?.obs ?? null, ready_count: num(q[0]?.ready_count) };
    }
    let held: Tri = false;
    let jobEvidence: Record<string, unknown> | null = null;
    if (row.scheduler_source && row.scheduler_job) {
      const job = await tx`
        select * from scheduler_jobs where source = ${row.scheduler_source} and job_id = ${row.scheduler_job}
        for share
      `;
      if (!job[0]) held = null;
      else {
        const c = pauseVerdicts(schedulerFacts(job[0]), nowMs).classification;
        held = c === "held" ? true : c === "unknown" ? null : false;
        jobEvidence = { job: `${row.scheduler_source}/${row.scheduler_job}`, classification: c, transition: num(job[0].transition) };
      }
    }
    const facts = {
      ready,
      last_work_at: iso(work[0]?.last_work),
      registered_at: iso(row.registered_at) ?? now,
      max_silence_hours: Number(row.max_silence_hours),
      held,
    };
    findings.push({
      condition: "consumer-silent",
      entity_key: key,
      verdict: consumerVerdict(facts, nowMs),
      version: null,
      evidence: {
        consumer: String(row.id),
        ready,
        silent: consumerSilent(facts, nowMs),
        last_work_at: facts.last_work_at,
        registered_at: facts.registered_at,
        max_silence_hours: facts.max_silence_hours,
        held,
        queue: queueEvidence,
        ...(jobEvidence ? { scheduler: jobEvidence } : {}),
      },
    });
  }
  return { conditions, findings, configured: registry.length > 0, unvisited, ...(registry.length === 0 ? { note: "no consumer is registered" } : {}) };
}

// ---------------------------------------------------------------------- PRs

async function evaluatePrs(tx: SqlTag, now: string): Promise<DomainOutput> {
  const nowMs = ms(now)!;
  const stuckHours = briefConfig().stuckPrHours;
  const conditions: SweepCondition[] = ["pr-stuck"];
  const sources = await tx`select * from sweep_pr_sources for share`;
  const sourceMap = new Map(sources.map((row) => [String(row.repo_key), row]));
  const latches = (await activeLatchKeys(tx, conditions)).get("pr-stuck") ?? [];
  const open = await tx`
    select repo_key, number from sweep_prs where open order by repo_key, number limit ${DOMAIN_ENTITY_LIMIT + 1}
  `;
  const { keys, unvisited } = bounded(latches, open.map((row) => `pr:${String(row.repo_key)}#${Number(row.number)}`));
  const findings: Finding[] = [];
  for (const key of keys) {
    const match = /^pr:(.+)#(\d+)$/.exec(key);
    if (!match) continue;
    const [, repoKeyValue, numberText] = match;
    const prRows = await tx`
      select * from sweep_prs where repo_key = ${repoKeyValue} and number = ${Number(numberText)}
      for share
    `;
    const pr = prRows[0];
    const src = sourceMap.get(repoKeyValue);
    const sourceFacts: PrSourceFacts | null = src
      ? { complete: src.complete === true, received_at: iso(src.received_at) ?? "", stale_after_minutes: Number(src.stale_after_minutes) }
      : null;
    const facts: PrFacts | null = pr
      ? {
          open: pr.open === true,
          draft: bool(pr.draft),
          opened_at: iso(pr.opened_at),
          mergeable: str(pr.mergeable),
          head_sha: str(pr.head_sha),
          checks_state: str(pr.checks_state),
          checks_head_sha: str(pr.checks_head_sha),
          review_started: bool(pr.review_started),
          review_head_sha: str(pr.review_head_sha),
          green_since: iso(pr.green_since),
        }
      : null;
    // A PR the evidence no longer has at all is unknown, unless a complete fresh snapshot covers its repo.
    const evaluated = evaluatePr(facts, sourceFacts, nowMs, stuckHours);
    findings.push({
      condition: "pr-stuck",
      entity_key: key,
      verdict: evaluated.verdict,
      version: num(pr?.version),
      meta: { repo: str(pr?.repo) ?? str(src?.repo), number: Number(numberText), head_sha: str(pr?.head_sha) },
      evidence: {
        repo: str(pr?.repo) ?? str(src?.repo),
        number: Number(numberText),
        head_sha: str(pr?.head_sha),
        reasons: evaluated.reasons,
        terms: evaluated.terms,
        snapshot_seq: num(src?.seq),
        observation_id: src?.last_observation_id != null ? String(src.last_observation_id) : null,
        stuck_hours: stuckHours,
      },
    });
  }
  return { conditions, findings, configured: sources.length > 0, unvisited, ...(sources.length === 0 ? { note: "no PR snapshot has been received" } : {}) };
}

// ------------------------------------------------------------ scheduler jobs

async function schedulerRows(tx: SqlTag): Promise<Row[]> {
  return tx`select * from scheduler_jobs order by source, job_id limit ${DOMAIN_ENTITY_LIMIT + 1} for share`;
}

async function evaluatePauses(tx: SqlTag, now: string): Promise<DomainOutput> {
  const nowMs = ms(now)!;
  const conditions: SweepCondition[] = ["pause-unexplained", "pause-expired"];
  const rows = await schedulerRows(tx);
  const latches = await activeLatchKeys(tx, conditions);
  const byKey = new Map(rows.slice(0, DOMAIN_ENTITY_LIMIT).map((row) => [`job:${String(row.source)}/${String(row.job_id)}`, row]));
  const { keys, unvisited } = bounded([...(latches.get("pause-unexplained") ?? []), ...(latches.get("pause-expired") ?? [])], [...byKey.keys()]);
  const findings: Finding[] = [];
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) {
      // An active latch whose job row is not in this read: unknown, never clear.
      for (const condition of conditions) findings.push({ condition, entity_key: key, verdict: "unknown", version: null, evidence: { job: key.slice(4), note: "job not in this read" } });
      continue;
    }
    const facts = schedulerFacts(row);
    const v = pauseVerdicts(facts, nowMs);
    const evidence = {
      job: `${facts.source}/${facts.job_id}`,
      classification: v.classification,
      transition: facts.transition,
      paused_at: facts.paused_at,
      paused_reason: facts.paused_reason,
      until: facts.until,
      decision: facts.decision,
      last_received_at: facts.last_received_at,
      observation_id: row.last_observation_id != null ? String(row.last_observation_id) : null,
    };
    findings.push({ condition: "pause-unexplained", entity_key: key, verdict: v.unexplained, version: num(row.version), evidence });
    findings.push({ condition: "pause-expired", entity_key: key, verdict: v.expired, version: num(row.version), evidence });
  }
  return { conditions, findings, configured: rows.length > 0, unvisited: unvisited + Math.max(0, rows.length - DOMAIN_ENTITY_LIMIT), ...(rows.length === 0 ? { note: "no scheduler job has reported" } : {}) };
}

async function evaluateResumes(tx: SqlTag, _now: string): Promise<DomainOutput> {
  const conditions: SweepCondition[] = ["resume-uncited"];
  const rows = await schedulerRows(tx);
  const latches = (await activeLatchKeys(tx, conditions)).get("resume-uncited") ?? [];
  const byKey = new Map(rows.slice(0, DOMAIN_ENTITY_LIMIT).map((row) => [`job:${String(row.source)}/${String(row.job_id)}`, row]));
  const { keys, unvisited } = bounded(latches, [...byKey.keys()]);
  const findings: Finding[] = [];
  for (const key of keys) {
    const row = byKey.get(key);
    if (!row) {
      findings.push({ condition: "resume-uncited", entity_key: key, verdict: "unknown", version: null, evidence: { job: key.slice(4), note: "job not in this read" } });
      continue;
    }
    const facts = schedulerFacts(row);
    findings.push({
      condition: "resume-uncited",
      entity_key: key,
      verdict: resumeVerdict(facts),
      version: num(row.version),
      evidence: {
        job: `${facts.source}/${facts.job_id}`,
        transition: facts.transition,
        prior_transition: num(row.prior_transition),
        prior_state: facts.prior_state,
        resumed: facts.resumed,
        decision: facts.decision,
        observation_id: row.last_observation_id != null ? String(row.last_observation_id) : null,
      },
    });
  }
  return { conditions, findings, configured: rows.length > 0, unvisited: unvisited + Math.max(0, rows.length - DOMAIN_ENTITY_LIMIT), ...(rows.length === 0 ? { note: "no scheduler job has reported" } : {}) };
}

// ---------------------------------------------------------------- decisions

async function evaluateDecisions(tx: SqlTag, now: string): Promise<DomainOutput> {
  const nowMs = ms(now)!;
  const conditions: SweepCondition[] = ["decision-aging"];
  const latches = (await activeLatchKeys(tx, conditions)).get("decision-aging") ?? [];
  const latchKeys = latches.map((key) => key.slice("decision:".length));
  const rows = await tx`
    select key, status, defer_until, opened_at, first_seen_at, repo, number
    from decisions
    where key = any(${latchKeys}::text[])
       or (status in ('open', 'deferred')
           and coalesce(opened_at, first_seen_at) <= ${now}::timestamptz - make_interval(days => ${DECISION_AGING_DAYS}))
    order by coalesce(opened_at, first_seen_at), key
    limit ${DOMAIN_ENTITY_LIMIT * 2 + 1}
  `;
  const byKey = new Map(rows.map((row) => [`decision:${String(row.key)}`, row]));
  const { keys, unvisited } = bounded(latches, [...byKey.keys()]);
  const findings: Finding[] = [];
  for (const key of keys) {
    const row = byKey.get(key);
    const facts = row
      ? { status: String(row.status), defer_until: iso(row.defer_until), opened_at: iso(row.opened_at), first_seen_at: iso(row.first_seen_at) }
      : null;
    findings.push({
      condition: "decision-aging",
      entity_key: key,
      verdict: decisionVerdict(facts, nowMs),
      // Decisions can be deleted and re-created with revision 0, so their revision is not a version fence.
      version: null,
      meta: { repo: str(row?.repo), number: num(row?.number) },
      evidence: {
        decision_key: key.slice("decision:".length),
        status: facts?.status ?? "absent",
        since: facts ? facts.opened_at ?? facts.first_seen_at : null,
        since_field: facts?.opened_at ? "opened_at" : "first_seen_at",
        defer_until: facts?.defer_until ?? null,
        aging_days: DECISION_AGING_DAYS,
      },
    });
  }
  return { conditions, findings, configured: true, unvisited: unvisited + Math.max(0, rows.length - DOMAIN_ENTITY_LIMIT * 2) };
}

// ---------------------------------------------------------------- dispatch

async function evaluateDispatch(tx: SqlTag, now: string): Promise<DomainOutput> {
  const nowMs = ms(now)!;
  const conditions: SweepCondition[] = ["dispatch-ready-empty"];
  const rows = await tx`
    select * from sweep_queues where classification = 'issue_dispatch' order by queue limit ${DOMAIN_ENTITY_LIMIT + 1} for share
  `;
  const latches = (await activeLatchKeys(tx, conditions)).get("dispatch-ready-empty") ?? [];
  const byKey = new Map(rows.slice(0, DOMAIN_ENTITY_LIMIT).map((row) => [`queue:${String(row.queue)}`, row]));
  const { keys, unvisited } = bounded(latches, [...byKey.keys()]);
  const findings: Finding[] = [];
  for (const key of keys) {
    const row = byKey.get(key);
    const facts = queueFacts(row);
    const v = dispatchVerdict(facts, nowMs);
    findings.push({
      condition: "dispatch-ready-empty",
      entity_key: key,
      verdict: v.verdict,
      version: num(row?.version),
      meta: { repo: str(row?.repo) },
      evidence: {
        queue: key.slice("queue:".length),
        repo: str(row?.repo),
        ready_count: facts?.ready_count ?? null,
        raw_count: facts?.raw_count ?? null,
        complete: facts?.complete ?? null,
        pending_since: v.pending_since,
        observation_id: row?.last_observation_id != null ? String(row.last_observation_id) : null,
        note: "emit only: no Spec Writer is invoked and no work is queued",
      },
    });
  }
  return { conditions, findings, configured: rows.length > 0, unvisited: unvisited + Math.max(0, rows.length - DOMAIN_ENTITY_LIMIT), ...(rows.length === 0 ? { note: "no issue_dispatch queue has reported" } : {}) };
}

// --------------------------------------------------------------- retention

/**
 * Deletes inbox rows received more than 30 days ago by database time, oldest
 * first, in indexed batches. This is an age horizon, not processing
 * completion: GitHub and synthetic rows alike are removed at 30 days, as #77
 * assigns. Latches and evidence tables are not touched.
 */
export async function pruneInbox(): Promise<RetentionResult> {
  let deleted = 0;
  let batches = 0;
  let evaluatedAt: string | null = null;
  try {
    for (; batches < RETENTION_MAX_BATCHES; ) {
      const n = await withTransaction(async (tx) => {
        const now = await dbInstant(tx);
        evaluatedAt = evaluatedAt ?? now;
        const rows = await tx`
          with doomed as (
            select id from gh_events
            where received_at < ${now}::timestamptz - make_interval(days => ${RETENTION_DAYS})
            order by received_at, id
            limit ${RETENTION_BATCH}
            for update skip locked
          )
          delete from gh_events g using doomed where g.id = doomed.id
          returning g.id
        `;
        return rows.length;
      });
      batches += 1;
      deleted += n;
      if (n < RETENTION_BATCH) {
        return { state: "ok", evaluated_at: evaluatedAt, deleted, batches, complete: true, horizon_days: RETENTION_DAYS, error: null };
      }
    }
    return { state: "ok", evaluated_at: evaluatedAt, deleted, batches, complete: false, horizon_days: RETENTION_DAYS, error: null };
  } catch (err) {
    console.error("[sweep] retention failed", err);
    return { state: "unknown", evaluated_at: evaluatedAt, deleted, batches, complete: false, horizon_days: RETENTION_DAYS, error: errorText(err) };
  }
}

// --------------------------------------------------------------------- run

const DOMAINS: [string, SweepCondition[], (tx: SqlTag, now: string) => Promise<DomainOutput>][] = [
  ["consumers", ["consumer-silent"], evaluateConsumers],
  ["prs", ["pr-stuck"], evaluatePrs],
  ["pauses", ["pause-unexplained", "pause-expired"], evaluatePauses],
  ["resumes", ["resume-uncited"], evaluateResumes],
  ["decisions", ["decision-aging"], evaluateDecisions],
  ["dispatch", ["dispatch-ready-empty"], evaluateDispatch],
];

/** One sweep. Every check runs even when another fails. The clock is the database's. */
export async function runSweep(): Promise<SweepRun> {
  const checks: CheckResult[] = [];
  for (const [name, conditions, evaluate] of DOMAINS) {
    checks.push(...(await runDomain(name, conditions, evaluate)));
  }
  const retention = await pruneInbox();
  return { checks, retention };
}

// ------------------------------------------------------------------ status

export const STATUS_JOB_LIMIT = 1000;
export const STATUS_CONSUMER_LIMIT = 200;
export const STATUS_LATCH_LIMIT = 500;

export interface SweepStatus {
  generated_at: string;
  consumers: Record<string, unknown>[] | null;
  /** True when more rows exist than the list holds. The list is then partial, never the whole set. */
  consumers_truncated: boolean;
  latches: Record<string, unknown>[] | null;
  latches_truncated: boolean;
  paused: PausedSection;
  errors: string[];
}

/** Read-only. Each part fails on its own and says so; nothing here writes. */
export async function readPaused(db: SqlTag = sql()): Promise<PausedSection> {
  try {
    const now = await dbInstant(db);
    const rows = await db`select * from scheduler_jobs order by source, job_id limit ${STATUS_JOB_LIMIT + 1}`;
    // A bounded read that hit its limit could hide a paused or stale job: unmeasured, never "none".
    if (rows.length > STATUS_JOB_LIMIT) return unmeasuredPaused(`more than ${STATUS_JOB_LIMIT} scheduler jobs; the read is bounded`);
    return pausedSection(rows.map(schedulerFacts), now);
  } catch (err) {
    console.error("[sweep] paused read failed", err);
    return unmeasuredPaused("scheduler status unavailable");
  }
}

export async function readSweepStatus(): Promise<SweepStatus> {
  const db = sql();
  const errors: string[] = [];
  const generatedAt = await dbInstant(db);
  let consumers: Record<string, unknown>[] | null = null;
  let latches: Record<string, unknown>[] | null = null;
  let consumersTruncated = false;
  let latchesTruncated = false;
  try {
    const rows = await db`
      select id, agent_ids, reporters, queue, scheduler_source, scheduler_job, enabled,
             max_silence_hours::float8 as max_silence_hours, registered_at, updated_at
      from sweep_consumers order by id limit ${STATUS_CONSUMER_LIMIT + 1}
    `;
    consumersTruncated = rows.length > STATUS_CONSUMER_LIMIT;
    if (consumersTruncated) errors.push(`consumers truncated at ${STATUS_CONSUMER_LIMIT}`);
    consumers = rows.slice(0, STATUS_CONSUMER_LIMIT).map((row) => ({ ...row, registered_at: iso(row.registered_at), updated_at: iso(row.updated_at) }));
  } catch {
    errors.push("consumers unavailable");
  }
  try {
    const rows = await db`
      select condition, entity_key, active, episode, seq, first_fired_at, last_emitted_at, cleared_at, last_state, last_evaluated_at
      from sweep_latches where active order by condition, entity_key limit ${STATUS_LATCH_LIMIT + 1}
    `;
    latchesTruncated = rows.length > STATUS_LATCH_LIMIT;
    if (latchesTruncated) errors.push(`active latches truncated at ${STATUS_LATCH_LIMIT}`);
    latches = rows.slice(0, STATUS_LATCH_LIMIT).map((row) => ({
      ...row,
      first_fired_at: iso(row.first_fired_at),
      last_emitted_at: iso(row.last_emitted_at),
      cleared_at: iso(row.cleared_at),
      last_evaluated_at: iso(row.last_evaluated_at),
    }));
  } catch {
    errors.push("latches unavailable");
  }
  const paused = await readPaused(db);
  if (!paused.measured) errors.push(paused.error ?? "scheduler status unavailable");
  return {
    generated_at: generatedAt,
    consumers,
    consumers_truncated: consumersTruncated,
    latches,
    latches_truncated: latchesTruncated,
    paused,
    errors,
  };
}
