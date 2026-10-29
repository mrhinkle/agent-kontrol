/**
 * Threshold alerts between morning briefs.
 *
 * Three conditions, and no others:
 * - coordinator work-event silence past `brief.coordinator.maxSilenceHours`
 * - a repo that merged in the lookback and then went quiet
 * - an open decision older than `decisionAgeDays`
 *
 * `brief.alerts.enabled` defaults to false. While it is off, evaluate still
 * computes every condition and sends nothing, including no clear and no re-arm.
 * Unknown (a failed or incomplete read) never sends and never clears.
 * A zero-merge latch whose repo is no longer in the visible set is cleared
 * on the enabled live path, after the watched-repo read and the latch read
 * both succeeded, using the same clear statement and its compute-instant
 * guard. A failed watched-repo read clears nothing. `readAlerts` does not clear.
 *
 * The claim is one INSERT ... ON CONFLICT statement. It carries the compute
 * instant. Episode and repeat claims re-arm a cleared latch only when
 * cleared_at is null or older than that instant, so a clear that observed
 * newer evidence wins. A clear writes cleared_at only when the latch is
 * still active and last_sent_at is older than the clear's instant, so a
 * delayed clear cannot erase a newer claim. A decision claim inserts only
 * while that row is still open and still old enough. An event that lands
 * between compute and claim, with no concurrent evaluation, can still send
 * once; the next evaluation clears it. The statement stores a random
 * claim_token. A failed message insert puts the previous row back only
 * while that token still matches and cleared_at is still the null the claim
 * wrote, so a concurrent clear stays cleared.
 */

import { randomUUID } from "node:crypto";
import type { Actor } from "./actor";
import { coordinatorFromDb, toSecondIso } from "./brief";
import { isConfigured, sql } from "./db";
import {
  briefConfig,
  REPOS,
  type BriefAlertSettings,
  type BriefSettings,
  type RepoConfig,
} from "./progress-config";
import { enqueueMessage } from "./store";
import { getWatchedRepos, visibleOnBoard } from "./watched-repos";

export type AlertKind = "coordinator_silent" | "zero_merge" | "decision_age";
export type AlertCondition = "firing" | "clear" | "unknown";
export type AlertDelivery = "read" | "disabled" | "live";

export interface AlertItem {
  key: string;
  kind: AlertKind;
  condition: AlertCondition;
  /**
   * True when a latch row exists and has not been cleared.
   * False when the latch table was read and this key is not latched.
   * Null when the latch table could not be read.
   */
  sent: boolean | null;
  last_sent_at: string | null;
  summary: string;
}

/** One latch read, claim, clear, message, or restore that threw. */
export interface AlertFailure {
  step: "latches" | "claim" | "clear" | "message" | "restore";
  key?: string;
}

export interface AlertEvaluation {
  enabled: boolean;
  delivery: AlertDelivery;
  generated_at: string;
  /** Messages inserted by this call. A read, and a disabled evaluate, are 0. */
  sent_count: number;
  alerts: AlertItem[];
  /** "unknown" when brief_alerts could not be read. "ok" after a successful read. */
  latches?: "ok" | "unknown";
  /** Present when a latch step threw. Omitted when every attempted step succeeded. */
  failures?: AlertFailure[];
  note?: string;
}

interface Draft {
  key: string;
  kind: AlertKind;
  condition: AlertCondition;
  summary: string;
}

interface ClaimPrev {
  first: string;
  last: string;
  cleared: string | null;
}

type ClaimMode = "repeat" | "episode" | "once";

let settingsOverride: BriefSettings | null = null;

/**
 * Tests only. Runs after compute and before the claim statement, so a test
 * can clear the latch or resolve the decision the statement is about to check.
 * Production leaves this null.
 */
let beforeClaimForTests: ((key: string, computedAt: string) => Promise<void>) | null = null;

/** Tests interleave a concurrent write between compute and the claim statement. */
export function setBeforeClaimForTests(
  hook: ((key: string, computedAt: string) => Promise<void>) | null,
): void {
  beforeClaimForTests = hook;
}

/** Tests pin thresholds without editing progress.config.json. Production never calls this. */
export function setBriefSettingsForTests(value: BriefSettings | null): void {
  settingsOverride = value;
}

function activeSettings(explicit?: BriefSettings): BriefSettings {
  return explicit ?? settingsOverride ?? briefConfig();
}

function hourMs(hours: number): number {
  return hours * 3_600_000;
}

/**
 * Default progress-collector period (`MC_PROGRESS_INTERVAL`, 900s).
 * A snapshot this fresh still covers through `now`. The collector does not
 * run at the evaluate instant, so the quiet window is unmeasured only when
 * the newest snapshot is older than one cadence.
 */
const COLLECTOR_CADENCE_MS = 15 * 60 * 1000;

function stamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || value.length === 0) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function asIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = stamp(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function item(draft: Draft, sent: boolean | null, lastSent: string | null): AlertItem {
  return {
    key: draft.key,
    kind: draft.kind,
    condition: draft.condition,
    sent,
    last_sent_at: lastSent,
    summary: draft.summary,
  };
}

function unknownDraft(key: string, kind: AlertKind, summary: string): Draft {
  return { key, kind, condition: "unknown", summary };
}

function unmeasured(settings: BriefSettings, now: Date, delivery: AlertDelivery, note: string): AlertEvaluation {
  const drafts: Draft[] = [
    unknownDraft("coordinator-silent", "coordinator_silent", note),
    unknownDraft("zero-merge", "zero_merge", note),
    unknownDraft("decision-age", "decision_age", note),
  ];
  return {
    enabled: settings.alerts.enabled,
    delivery,
    generated_at: toSecondIso(now),
    sent_count: 0,
    // No latch row was read, so whether an alert was sent is unknown, never false.
    latches: "unknown",
    alerts: drafts.map((draft) => item(draft, null, null)),
    failures: [{ step: "latches" }],
    note,
  };
}

async function databaseNow(): Promise<Date> {
  const rows = await sql()`select now() as now`;
  const raw = rows[0]?.now;
  const parsed = raw instanceof Date ? raw : new Date(String(raw ?? ""));
  if (Number.isNaN(parsed.getTime())) throw new Error("database clock unavailable");
  return parsed;
}

function inboxAgent(settings: BriefSettings): string {
  return settings.coordinator.agentId ?? "operator";
}

async function readCoordinator(settings: BriefSettings, now: Date): Promise<Draft[]> {
  const key = settings.coordinator.agentId
    ? `coordinator-silent:${settings.coordinator.agentId}`
    : "coordinator-silent";
  if (!settings.coordinator.agentId) {
    return [{
      key,
      kind: "coordinator_silent",
      condition: "clear",
      summary: "No coordinator is configured.",
    }];
  }
  try {
    const status = await coordinatorFromDb(settings, toSecondIso(now));
    const verdict = status.verdict ?? "";
    if (!status.configured) {
      return [{ key, kind: "coordinator_silent", condition: "clear", summary: "No coordinator is configured." }];
    }
    if (verdict.startsWith("unknown") || verdict.length === 0) {
      return [unknownDraft(key, "coordinator_silent", verdict || "Coordinator liveness could not be read.")];
    }
    const working = verdict.startsWith("working:");
    if (working) {
      return [{ key, kind: "coordinator_silent", condition: "clear", summary: verdict }];
    }
    if (verdict.startsWith("NOT WORKING") || verdict.startsWith("FAILING")) {
      return [{ key, kind: "coordinator_silent", condition: "firing", summary: verdict }];
    }
    return [unknownDraft(key, "coordinator_silent", verdict || "Coordinator liveness could not be read.")];
  } catch {
    return [unknownDraft(key, "coordinator_silent", "Coordinator liveness could not be read.")];
  }
}

interface MergeSnap {
  repo: string;
  collectedAt: number;
  merged: unknown[] | null;
}

function mergePoints(merged: unknown[]): number[] {
  const points: number[] = [];
  for (const row of merged) {
    if (!row || typeof row !== "object") continue;
    const at = stamp((row as { merged_at?: unknown }).merged_at);
    if (!Number.isNaN(at)) points.push(at);
  }
  return points;
}

/**
 * Quiet is strict: a merge at exactly `zeroMergeHours` ago is not inside the
 * open window, so the quiet stretch has reached the threshold.
 * Lookback is closed at the far end: a merge at exactly N days ago still counts.
 * Coverage is the union of each measured snapshot's quiet-width window. A hole
 * in that union is unknown unless a timestamp already proves the condition.
 * `firing` also requires that union to cover `[now - zeroMergeHours, now]`.
 * The newest snapshot may lag `now` by one collector cadence; an older gap
 * leaves the tail unmeasured. A merge timestamp inside the quiet window is
 * `clear` without that coverage check, because the timestamp proves the repo
 * is not quiet.
 */
export function classifyZeroMerge(
  snapshots: MergeSnap[],
  nowMs: number,
  alerts: BriefAlertSettings,
): AlertCondition {
  if (snapshots.length === 0) return "unknown";
  const newest = snapshots.reduce((best, snap) => (snap.collectedAt > best.collectedAt ? snap : best));
  if (newest.merged === null) return "unknown";
  if (newest.merged.length > 0 && mergePoints(newest.merged).length === 0) return "unknown";

  const quietMs = hourMs(alerts.zeroMergeHours);
  const lookbackMs = alerts.zeroMergeLookbackDays * 24 * hourMs(1);
  const quietStart = nowMs - quietMs;
  const lookbackStart = nowMs - lookbackMs;
  const measured = snapshots.filter((snap) => snap.merged !== null);
  const points = measured.flatMap((snap) => mergePoints(snap.merged ?? []));
  const recent = points.some((at) => at > quietStart && at <= nowMs);
  if (recent) return "clear";
  const intervals = coverageIntervals(measured, nowMs, quietMs);
  const inLookback = points.some((at) => at >= lookbackStart && at <= quietStart);
  if (inLookback) return covers(intervals, quietStart, nowMs) ? "firing" : "unknown";
  return covers(intervals, lookbackStart, nowMs) ? "clear" : "unknown";
}

function coverageIntervals(measured: MergeSnap[], nowMs: number, quietMs: number): Array<[number, number]> {
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const snap of measured) {
    if (snap.collectedAt > newestAt) newestAt = snap.collectedAt;
  }
  const fresh = newestAt <= nowMs && nowMs - newestAt <= COLLECTOR_CADENCE_MS;
  return measured.map((snap) => {
    const end = fresh && snap.collectedAt === newestAt ? nowMs : snap.collectedAt;
    return [snap.collectedAt - quietMs, end];
  });
}

function covers(intervals: Array<[number, number]>, start: number, end: number): boolean {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cursor = start;
  for (const [lo, hi] of sorted) {
    if (hi < cursor) continue;
    if (lo > cursor) return false;
    if (hi > cursor) cursor = hi;
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

interface MergeRead {
  drafts: Draft[];
  /** False only when the watched-repo read threw. A later snapshot failure is still true. */
  reposRead: boolean;
}

async function readMerges(settings: BriefSettings, now: Date): Promise<MergeRead> {
  let repos: RepoConfig[];
  try {
    // Same repo set as the brief: a hidden, gone, or out-of-window repo does not alert.
    repos = (await getWatchedRepos(REPOS)).repos.filter(visibleOnBoard);
  } catch {
    return {
      drafts: [unknownDraft("zero-merge", "zero_merge", "Watched repos could not be read.")],
      reposRead: false,
    };
  }
  const nowIso = toSecondIso(now);
  const since = new Date(now.getTime() - hourMs(settings.alerts.zeroMergeLookbackDays * 24 + settings.alerts.zeroMergeHours));
  let rows: Record<string, unknown>[];
  try {
    rows = await sql()`
      select repo, collected_at, detail
      from repo_snapshots
      where repo = any(${repos.map((repo) => repo.repo)}::text[])
        and collected_at <= ${nowIso}::timestamptz
        and collected_at >= ${toSecondIso(since)}::timestamptz
      order by repo, collected_at desc
    `;
  } catch {
    return {
      drafts: repos.map((repo) => unknownDraft(
        `zero-merge:${repo.repo}`,
        "zero_merge",
        `${repo.label} merges could not be read.`,
      )),
      reposRead: true,
    };
  }
  const byRepo = new Map<string, MergeSnap[]>();
  for (const row of rows) {
    const name = String(row.repo);
    const collectedAt = stamp(row.collected_at instanceof Date ? row.collected_at.toISOString() : row.collected_at);
    if (Number.isNaN(collectedAt) || collectedAt > now.getTime()) continue;
    const detail = row.detail;
    const merged = detail && typeof detail === "object" && Array.isArray((detail as { merged?: unknown }).merged)
      ? (detail as { merged: unknown[] }).merged
      : null;
    const list = byRepo.get(name) ?? [];
    list.push({ repo: name, collectedAt, merged });
    byRepo.set(name, list);
  }
  return {
    reposRead: true,
    drafts: repos.map((repo) => {
    const key = `zero-merge:${repo.repo}`;
    const snaps = byRepo.get(repo.repo) ?? [];
    const condition = classifyZeroMerge(snaps, now.getTime(), settings.alerts);
    if (condition === "unknown") {
      return unknownDraft(key, "zero_merge", `${repo.label} merge history is incomplete.`);
    }
    if (condition === "firing") {
      return {
        key,
        kind: "zero_merge",
        condition,
        summary: `${repo.label} has no merges for ${settings.alerts.zeroMergeHours}h after merging within ${settings.alerts.zeroMergeLookbackDays}d.`,
      };
    }
    return {
      key,
      kind: "zero_merge",
      condition,
      summary: `${repo.label} is not in a zero-merge stretch.`,
    };
  }),
  };
}

async function readDecisions(settings: BriefSettings, now: Date): Promise<Draft[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await sql()`
      select id, key, title, opened_at, first_seen_at
      from decisions
      where status = 'open'
      order by id asc
    `;
  } catch {
    return [unknownDraft("decision-age", "decision_age", "Open decisions could not be read.")];
  }
  const limit = settings.alerts.decisionAgeDays * 24 * hourMs(1);
  const nowMs = now.getTime();
  const drafts: Draft[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id)) continue;
    const key = `decision:${id}`;
    const opened = asIso(row.opened_at) ?? asIso(row.first_seen_at);
    if (!opened) {
      drafts.push(unknownDraft(key, "decision_age", `Decision ${id} has no opened_at or first_seen_at.`));
      continue;
    }
    const age = nowMs - stamp(opened);
    const title = typeof row.title === "string" ? row.title.slice(0, 160) : "";
    if (age > limit) {
      drafts.push({
        key,
        kind: "decision_age",
        condition: "firing",
        summary: `Decision ${String(row.key)} is past ${settings.alerts.decisionAgeDays}d. ${title}`.trim(),
      });
    } else {
      drafts.push({
        key,
        kind: "decision_age",
        condition: "clear",
        summary: `Decision ${String(row.key)} is under ${settings.alerts.decisionAgeDays}d.`,
      });
    }
  }
  return drafts;
}

async function compute(settings: BriefSettings, now: Date): Promise<{ drafts: Draft[]; zeroMergeReposRead: boolean }> {
  const [coordinator, merges, decisions] = await Promise.all([
    readCoordinator(settings, now),
    readMerges(settings, now),
    readDecisions(settings, now),
  ]);
  return {
    zeroMergeReposRead: merges.reposRead,
    drafts: [...coordinator, ...merges.drafts, ...decisions].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * Clears uncleared zero-merge latches whose repo was not evaluated.
 * Uses `clearLatch`, so a latch sent at this same instant stays.
 */
async function clearAbsentZeroMergeLatches(drafts: Draft[], nowIso: string): Promise<AlertFailure[]> {
  const evaluated = new Set(
    drafts.filter((draft) => draft.key.startsWith("zero-merge:")).map((draft) => draft.key),
  );
  let rows: Record<string, unknown>[];
  try {
    rows = await sql()`
      select key, cleared_at
      from brief_alerts
      where key like 'zero-merge:%'
        and cleared_at is null
    `;
  } catch {
    return [{ step: "clear" }];
  }
  const failures: AlertFailure[] = [];
  for (const row of rows) {
    const key = String(row.key);
    if (!key.startsWith("zero-merge:") || evaluated.has(key)) continue;
    if (row.cleared_at != null) continue;
    try {
      await clearLatch(key, nowIso);
    } catch {
      failures.push({ step: "clear", key });
    }
  }
  return failures;
}

interface Latch {
  key: string;
  first: string;
  last: string;
  cleared: string | null;
}

async function readLatches(keys: string[]): Promise<Map<string, Latch> | null> {
  if (keys.length === 0) return new Map();
  try {
    const rows = await sql()`
      select key, first_sent_at, last_sent_at, cleared_at
      from brief_alerts
      where key = any(${keys}::text[])
    `;
    const map = new Map<string, Latch>();
    for (const row of rows) {
      const last = asIso(row.last_sent_at);
      const first = asIso(row.first_sent_at);
      if (!last || !first) continue;
      map.set(String(row.key), {
        key: String(row.key),
        first,
        last,
        cleared: asIso(row.cleared_at),
      });
    }
    return map;
  } catch {
    return null;
  }
}

function decorate(drafts: Draft[], latches: Map<string, Latch> | null): AlertItem[] {
  if (latches == null) return drafts.map((draft) => item(draft, null, null));
  return drafts.map((draft) => {
    const latch = latches.get(draft.key) ?? null;
    const sent = latch != null && latch.cleared == null;
    return item(draft, sent, latch?.last ?? null);
  });
}

function claimMode(draft: Draft): ClaimMode {
  if (draft.kind === "coordinator_silent") return "repeat";
  if (draft.kind === "zero_merge") return "episode";
  return "once";
}

/** `decision:<id>` keys are the decisions.id the once-claim rechecks. */
function decisionIdFromKey(key: string): number | null {
  const match = /^decision:(\d+)$/.exec(key);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * One statement. RETURNING is empty when this caller did not win the claim.
 * `nowIso` is the compute instant. Episode and repeat re-arm only when
 * `cleared_at` is null or older than that instant. A decision insert runs
 * only while the row is still open and still old enough. `prior` is the row
 * as it was before this statement, so a failed message insert can put that
 * row back.
 */
async function claimSend(
  draft: Draft,
  nowIso: string,
  alerts: BriefAlertSettings,
): Promise<{ ok: boolean; prev: ClaimPrev | null; token: string }> {
  const mode = claimMode(draft);
  const hours = alerts.coordinatorRepeatHours;
  const token = randomUUID();
  if (beforeClaimForTests) await beforeClaimForTests(draft.key, nowIso);
  const decisionId = decisionIdFromKey(draft.key);
  const decisionAgeDays = alerts.decisionAgeDays;
  const rows = mode === "once"
    ? await sql()`
        -- brief-alert-claim:once
        with prior as (
          select first_sent_at, last_sent_at, cleared_at
          from brief_alerts
          where key = ${draft.key}
        ),
        claimed as (
          insert into brief_alerts (key, first_sent_at, last_sent_at, cleared_at, claim_token)
          select ${draft.key}, ${nowIso}::timestamptz, ${nowIso}::timestamptz, null, ${token}
          where exists (
            select 1 from decisions
            where id = ${decisionId}
              and status = 'open'
              and (
                opened_at <= ${nowIso}::timestamptz - (${decisionAgeDays}::numeric * interval '1 day')
                or (
                  opened_at is null
                  and first_seen_at <= ${nowIso}::timestamptz - (${decisionAgeDays}::numeric * interval '1 day')
                )
              )
          )
          on conflict (key) do nothing
          returning key
        )
        select claimed.key,
               prior.first_sent_at as prev_first,
               prior.last_sent_at as prev_last,
               prior.cleared_at as prev_cleared
        from claimed
        left join prior on true
      `
    : mode === "episode"
      ? await sql()`
          -- brief-alert-claim:episode
          with prior as (
            select first_sent_at, last_sent_at, cleared_at
            from brief_alerts
            where key = ${draft.key}
          ),
          claimed as (
            insert into brief_alerts (key, first_sent_at, last_sent_at, cleared_at, claim_token)
            values (${draft.key}, ${nowIso}::timestamptz, ${nowIso}::timestamptz, null, ${token})
            on conflict (key) do update
            set last_sent_at = excluded.last_sent_at,
                cleared_at = null,
                claim_token = excluded.claim_token
            where brief_alerts.cleared_at is not null
              and (
                brief_alerts.cleared_at is null
                or brief_alerts.cleared_at < ${nowIso}::timestamptz
              )
            returning key
          )
          select claimed.key,
                 prior.first_sent_at as prev_first,
                 prior.last_sent_at as prev_last,
                 prior.cleared_at as prev_cleared
          from claimed
          left join prior on true
        `
      : await sql()`
          -- brief-alert-claim:repeat
          with prior as (
            select first_sent_at, last_sent_at, cleared_at
            from brief_alerts
            where key = ${draft.key}
          ),
          claimed as (
            insert into brief_alerts (key, first_sent_at, last_sent_at, cleared_at, claim_token)
            values (${draft.key}, ${nowIso}::timestamptz, ${nowIso}::timestamptz, null, ${token})
            on conflict (key) do update
            set last_sent_at = excluded.last_sent_at,
                cleared_at = null,
                claim_token = excluded.claim_token
            where (
                brief_alerts.cleared_at is not null
                or brief_alerts.last_sent_at <= ${nowIso}::timestamptz - (${hours}::numeric * interval '1 hour')
              )
              and (
                brief_alerts.cleared_at is null
                or brief_alerts.cleared_at < ${nowIso}::timestamptz
              )
            returning key
          )
          select claimed.key,
                 prior.first_sent_at as prev_first,
                 prior.last_sent_at as prev_last,
                 prior.cleared_at as prev_cleared
          from claimed
          left join prior on true
        `;
  const row = rows[0];
  if (!row?.key) return { ok: false, prev: null, token };
  const first = asIso(row.prev_first);
  const last = asIso(row.prev_last);
  return {
    ok: true,
    token,
    prev: first && last ? { first, last, cleared: asIso(row.prev_cleared) } : null,
  };
}

/**
 * Undo a claim whose message insert failed. The claim left `cleared_at`
 * null. The predicate keeps a concurrent clear, and a later claim that
 * replaced `claim_token`, from being overwritten.
 */
async function restoreClaim(
  key: string,
  token: string,
  observedClearedAt: string | null,
  prev: ClaimPrev | null,
): Promise<void> {
  if (!prev) {
    await sql()`
      delete from brief_alerts
      where key = ${key}
        and claim_token = ${token}
        and cleared_at is not distinct from ${observedClearedAt}::timestamptz
    `;
    return;
  }
  await sql()`
    update brief_alerts
    set first_sent_at = ${prev.first}::timestamptz,
        last_sent_at = ${prev.last}::timestamptz,
        cleared_at = ${prev.cleared}::timestamptz
    where key = ${key}
      and claim_token = ${token}
      and cleared_at is not distinct from ${observedClearedAt}::timestamptz
  `;
}

async function clearLatch(key: string, nowIso: string): Promise<void> {
  await sql()`
    -- brief-alert-clear
    update brief_alerts
    set cleared_at = ${nowIso}::timestamptz
    where key = ${key}
      and cleared_at is null
      and last_sent_at < ${nowIso}::timestamptz
    returning key
  `;
}

async function deliver(
  drafts: Draft[],
  settings: BriefSettings,
  now: Date,
  actor: Actor | null,
): Promise<{ sent: number; failures: AlertFailure[] }> {
  const nowIso = toSecondIso(now);
  const agentId = inboxAgent(settings);
  const failures: AlertFailure[] = [];
  let sent = 0;
  for (const draft of drafts) {
    if (draft.condition === "unknown") continue;
    if (draft.condition === "clear") {
      if (draft.kind === "decision_age") continue;
      try {
        await clearLatch(draft.key, nowIso);
      } catch {
        failures.push({ step: "clear", key: draft.key });
      }
      continue;
    }
    let claimed: { ok: boolean; prev: ClaimPrev | null; token: string };
    try {
      claimed = await claimSend(draft, nowIso, settings.alerts);
    } catch {
      failures.push({ step: "claim", key: draft.key });
      continue;
    }
    if (!claimed.ok) continue;
    try {
      await enqueueMessage({
        agent_id: agentId,
        body: `brief-alert ${draft.key}\n${draft.summary}`,
        created_by: "brief-alerts",
        actor,
      });
      sent += 1;
    } catch {
      failures.push({ step: "message", key: draft.key });
      try {
        // The claim wrote cleared_at null. A concurrent clear changes it.
        await restoreClaim(draft.key, claimed.token, null, claimed.prev);
      } catch {
        failures.push({ step: "restore", key: draft.key });
      }
    }
  }
  return { sent, failures };
}

function pack(
  settings: BriefSettings,
  now: Date,
  delivery: AlertDelivery,
  drafts: Draft[],
  latches: Map<string, Latch> | null,
  sentCount: number,
  failures?: AlertFailure[],
  note?: string,
): AlertEvaluation {
  const reported = [...(failures ?? [])];
  if (latches == null) reported.push({ step: "latches" });
  return {
    enabled: settings.alerts.enabled,
    delivery,
    generated_at: toSecondIso(now),
    sent_count: sentCount,
    latches: latches == null ? "unknown" : "ok",
    alerts: decorate(drafts, latches),
    ...(reported.length > 0 ? { failures: reported } : {}),
    ...(note ? { note } : {}),
  };
}

export async function readAlerts(input: { now?: Date; settings?: BriefSettings } = {}): Promise<AlertEvaluation> {
  const settings = activeSettings(input.settings);
  const fallbackNow = input.now ?? new Date();
  if (!isConfigured()) {
    return unmeasured(settings, fallbackNow, "read", "No database, so every condition is unmeasured.");
  }
  let now = fallbackNow;
  if (!input.now) {
    try {
      now = await databaseNow();
    } catch {
      return unmeasured(settings, fallbackNow, "read", "The database clock could not be read.");
    }
  }
  const computed = await compute(settings, now);
  const latches = await readLatches(computed.drafts.map((draft) => draft.key));
  return pack(settings, now, "read", computed.drafts, latches, 0, undefined, "Read only. This route does not send.");
}

export async function evaluateAlerts(input: {
  now?: Date;
  settings?: BriefSettings;
  actor?: Actor | null;
} = {}): Promise<AlertEvaluation> {
  const settings = activeSettings(input.settings);
  const fallbackNow = input.now ?? new Date();
  if (!isConfigured()) {
    return unmeasured(
      settings,
      fallbackNow,
      settings.alerts.enabled ? "live" : "disabled",
      "No database, so nothing was sent.",
    );
  }
  let now = fallbackNow;
  if (!input.now) {
    try {
      now = await databaseNow();
    } catch {
      return unmeasured(settings, fallbackNow, settings.alerts.enabled ? "live" : "disabled", "The database clock could not be read.");
    }
  }
  const computed = await compute(settings, now);
  const drafts = computed.drafts;
  if (!settings.alerts.enabled) {
    const latches = await readLatches(drafts.map((draft) => draft.key));
    return pack(
      settings,
      now,
      "disabled",
      drafts,
      latches,
      0,
      undefined,
      "brief.alerts.enabled is false. Conditions were computed and nothing was sent.",
    );
  }
  // Fail closed: with latch state unreadable, nothing is claimed, sent or cleared.
  const before = await readLatches(drafts.map((draft) => draft.key));
  if (before == null) {
    return pack(settings, now, "live", drafts, null, 0, undefined, "Latch state could not be read, so nothing was sent or cleared.");
  }
  const delivery = await deliver(drafts, settings, now, input.actor ?? null);
  const absent = computed.zeroMergeReposRead
    ? await clearAbsentZeroMergeLatches(drafts, toSecondIso(now))
    : [];
  const failures = absent.length > 0 ? [...delivery.failures, ...absent] : delivery.failures;
  const latches = await readLatches(drafts.map((draft) => draft.key));
  return pack(settings, now, "live", drafts, latches, delivery.sent, failures);
}
