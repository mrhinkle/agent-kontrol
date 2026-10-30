/**
 * Pure planner for one owner's discovery tick.
 *
 * A failed, rate-limited, or empty `gh repo list` changes nothing. A repo
 * that goes quiet stays in the list and drops off the brief only once its
 * age is greater than `activity_days` (the boundary day is still shown).
 * Hide wins over pin. A repo marked gone is not shown, including when it is pinned.
 * Forks and archived repos are not added unless that owner's flag says so.
 * A pin still shows a fork or archive that is already stored.
 * Identity is `owner/name`, compared case-insensitively. The stored casing
 * is kept. The short name is not an identity.
 */

import { PALETTE } from "./repo-settings-helpers";

export const MS_PER_DAY = 86_400_000;
export const DISCOVERY_LIST_CAP = 1000;

/**
 * One lock for owner-list replacement, discovery apply, and clearing a
 * hand-added field override. Short-name allocation stays serialized because
 * every one of those writes takes this same lock, and never around `gh`.
 */
export const DISCOVERY_WRITE_LOCK = 87216667;

export interface GhListedRepo {
  name: string;
  pushedAt: string | null;
  isArchived: boolean;
  isFork: boolean;
}

export interface TrackedRepo {
  repo: string;
  label: string;
  short: string;
  color: string;
  blockedLabel: string | null;
  origin: "manual" | "auto";
  pinned: boolean;
  hidden: boolean;
  gone: boolean;
  isFork: boolean;
  isArchived: boolean;
  lastActivityAt: string | null;
  position: number;
  /**
   * True after a hand-added save wrote label, short, color, or blocked label.
   * False after that override was cleared. Null when discovery owns the fields.
   */
  fieldsOverridden?: boolean | null;
}

export interface OwnerRule {
  owner: string;
  activityDays: number;
  includeForks: boolean;
  includeArchived: boolean;
}

export interface DiscoverySweep {
  /** null when `gh` failed. An empty array is also a failure. */
  repos: GhListedRepo[] | null;
  error: string | null;
  /** The list was cut at the cap. Seen repos update; absent repos are not marked gone. */
  truncated?: boolean;
  /**
   * When the collector started `gh repo list`. A sweep that is not newer
   * than the stored `last_discovered_at` is stale and must not write.
   */
  sweptAt?: string | null;
}

export interface DiscoveryOutcome {
  /** Set when the sweep must not change tracked repos. */
  failure: string | null;
  /** Set when the sweep applied, but the operator should still see a problem. */
  warning: string | null;
  repos: TrackedRepo[];
  added: string[];
  updated: string[];
  markedGone: string[];
}

const NAME_RE = /^[\w.-]+$/;

export function repoOwner(repo: string): string {
  const slash = repo.indexOf("/");
  return (slash === -1 ? repo : repo.slice(0, slash)).toLowerCase();
}

export function repoName(repo: string): string {
  const slash = repo.indexOf("/");
  return slash === -1 ? "" : repo.slice(slash + 1);
}

/** Canonical `owner/name`, lowercased. Short names are not an identity. */
export function repoIdentity(repo: string): string {
  return `${repoOwner(repo)}/${repoName(repo).toLowerCase()}`;
}

/**
 * RFC 3339 timestamp: calendar date, `T`/`t`, time, optional fraction,
 * and `Z` or a numeric offset. A date that is not a real civil day is rejected.
 */
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i;

/** A collector clock may sit this far ahead of the server before discovery rejects it. */
export const SWEPT_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60) return false;
  const civil = new Date(Date.UTC(year, month - 1, day));
  if (civil.getUTCFullYear() !== year || civil.getUTCMonth() !== month - 1 || civil.getUTCDate() !== day) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * `swept_at` from the collector. Required, RFC 3339, and not more than
 * five minutes ahead of `now`. The returned value is the parsed instant.
 */
export function parseCollectorSweptAt(
  raw: unknown,
  now: Date,
): { ok: true; sweptAt: string } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: false, error: "swept_at is required." };
  if (!isRfc3339(raw)) return { ok: false, error: "swept_at must be an RFC 3339 timestamp." };
  const ms = Date.parse(raw);
  if (ms > now.getTime() + SWEPT_AT_FUTURE_SKEW_MS) {
    return { ok: false, error: "swept_at must not be more than 5 minutes in the future." };
  }
  return { ok: true, sweptAt: new Date(ms).toISOString() };
}

/**
 * New-repo activity uses the collector's `sweptAt` when it parses.
 * Callers that have not been given one still use `now`.
 */
export function discoveryCutoff(sweep: { sweptAt?: string | null }, now: Date): Date {
  const at = parseActivity(sweep.sweptAt ?? null);
  return at === null ? now : new Date(at);
}

/**
 * When a stored row matches by case-insensitive identity, keep that row's
 * casing. The first stored row wins. A name with no match keeps the
 * casing the payload or GitHub sent.
 */
export function alignRepoCasing<T extends { repo: string }>(
  stored: readonly { repo: string }[],
  incoming: readonly T[],
): T[] {
  const storedById = new Map<string, string>();
  for (const row of stored) {
    const id = repoIdentity(row.repo);
    if (!storedById.has(id)) storedById.set(id, row.repo);
  }
  return incoming.map((row) => {
    const kept = storedById.get(repoIdentity(row.repo));
    if (!kept || kept === row.repo) return row;
    return { ...row, repo: kept };
  });
}

export function parseActivity(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Inclusive of the exact `activityDays` boundary. A repo drops off only
 * after that instant: age `activityDays` is still shown, age + 1ms is not.
 */
export function withinActivityWindow(lastActivityAt: string, activityDays: number, now: Date): boolean {
  const at = parseActivity(lastActivityAt);
  if (at === null) return false;
  return now.getTime() - at <= activityDays * MS_PER_DAY;
}

/**
 * Hide wins over pin. Gone wins over pin. A hidden repo stays in the
 * database so the collector can still read it.
 */
export function briefShown(repo: TrackedRepo, owner: OwnerRule | null, now: Date): boolean {
  if (repo.gone) return false;
  if (repo.hidden) return false;
  if (repo.pinned) return true;
  if (owner && repoOwner(repo.repo) === owner.owner.toLowerCase()) {
    if (repo.isFork && !owner.includeForks) return false;
    if (repo.isArchived && !owner.includeArchived) return false;
  }
  if (!repo.lastActivityAt) return repo.origin !== "auto";
  if (!owner || repoOwner(repo.repo) !== owner.owner.toLowerCase()) return repo.origin !== "auto";
  return withinActivityWindow(repo.lastActivityAt, owner.activityDays, now);
}

function eligible(listed: GhListedRepo, owner: OwnerRule): boolean {
  if (listed.isFork && !owner.includeForks) return false;
  if (listed.isArchived && !owner.includeArchived) return false;
  return true;
}

function colorFor(repo: string): string {
  let hash = 0;
  for (let i = 0; i < repo.length; i++) hash = (hash * 33 + repo.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function shortBase(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 12);
  return cleaned.length > 0 ? cleaned : "repo";
}

function takeShort(name: string, used: Set<string>): string {
  const base = shortBase(name);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 10000; n++) {
    const suffix = String(n);
    const next = `${base.slice(0, 12 - suffix.length)}${suffix}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
  const fallback = `r${used.size}`.slice(0, 12);
  used.add(fallback);
  return fallback;
}

function labelFor(name: string): string {
  const label = name.trim().slice(0, 40);
  return label.length > 0 ? label : "repo";
}

/** Label, short, color, and blocked label that a new discovery row would get. */
export function discoveryDefaults(repo: string, usedShorts: Set<string>): {
  label: string;
  short: string;
  color: string;
  blockedLabel: null;
} {
  const name = repoName(repo);
  return {
    label: labelFor(name),
    short: takeShort(name, usedShorts),
    color: colorFor(repo),
    blockedLabel: null,
  };
}

/**
 * Auto rows a hand-added save omits after a previous save set
 * `fieldsOverridden`. Each one returns to the discovery defaults.
 * Submitted shorts and shorts of auto rows that stay overridden-or-not are
 * already taken, so the allocator will not steal them.
 */
export function planOverrideResets<T extends {
  repo: string;
  short: string;
  origin?: "manual" | "auto";
  fieldsOverridden?: boolean | null;
}>(stored: T[], submitted: { repo: string; short: string }[]): Array<T & {
  label: string;
  short: string;
  color: string;
  blockedLabel: null;
  fieldsOverridden: false;
}> {
  const submittedIds = new Set(submitted.map((row) => repoIdentity(row.repo)));
  const resetting = stored.filter(
    (row) => row.origin === "auto" && row.fieldsOverridden === true && !submittedIds.has(repoIdentity(row.repo)),
  );
  const resettingIds = new Set(resetting.map((row) => row.repo));
  const used = new Set<string>();
  for (const row of submitted) used.add(row.short.toLowerCase());
  for (const row of stored) {
    if (resettingIds.has(row.repo) || submittedIds.has(repoIdentity(row.repo))) continue;
    if (row.origin !== "auto") continue;
    used.add(row.short.toLowerCase());
  }
  return [...resetting]
    .sort((a, b) => a.repo.localeCompare(b.repo))
    .map((row) => ({
      ...row,
      ...discoveryDefaults(row.repo, used),
      fieldsOverridden: false as const,
    }));
}

function untouched(existing: TrackedRepo[], failure: string): DiscoveryOutcome {
  return { failure, warning: null, repos: existing.map((row) => ({ ...row })), added: [], updated: [], markedGone: [] };
}

export function planDiscovery(
  existing: TrackedRepo[],
  owner: OwnerRule,
  sweep: DiscoverySweep,
  now: Date,
): DiscoveryOutcome {
  const ownerKey = owner.owner.toLowerCase();
  if (sweep.repos === null) {
    return untouched(existing, sweep.error?.trim() || "gh repo list failed");
  }
  if (sweep.repos.length === 0) {
    return untouched(existing, sweep.error?.trim() || "gh repo list returned no repos");
  }

  const listed = [...sweep.repos].sort((a, b) => a.name.localeCompare(b.name));
  for (const item of listed) {
    if (typeof item.name !== "string" || !NAME_RE.test(item.name) || item.name.length > 100) {
      return untouched(existing, "gh repo list included a repo name that is not safe to store");
    }
  }

  const byIdentity = new Map<string, TrackedRepo>();
  for (const row of existing) {
    const id = repoIdentity(row.repo);
    // First stored casing wins, so a later case-variant is not a second repo.
    if (!byIdentity.has(id)) byIdentity.set(id, { ...row });
  }
  const usedShorts = new Set(existing.map((row) => row.short.toLowerCase()));
  let nextPosition = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
  const seen = new Set<string>();
  const added: string[] = [];
  const updated: string[] = [];
  const cutoff = discoveryCutoff(sweep, now);

  for (const item of listed) {
    const repo = `${ownerKey}/${item.name}`;
    const id = repoIdentity(repo);
    if (seen.has(id)) continue;
    seen.add(id);
    const activity = parseActivity(item.pushedAt);
    const current = byIdentity.get(id);
    if (!current) {
      const inWindow = item.pushedAt != null && withinActivityWindow(item.pushedAt, owner.activityDays, cutoff);
      if (!eligible(item, owner) || !inWindow) continue;
      const created: TrackedRepo = {
        repo,
        label: labelFor(item.name),
        short: takeShort(item.name, usedShorts),
        color: colorFor(repo),
        blockedLabel: null,
        origin: "auto",
        pinned: false,
        hidden: false,
        gone: false,
        isFork: item.isFork,
        isArchived: item.isArchived,
        lastActivityAt: activity === null ? null : new Date(activity).toISOString(),
        position: nextPosition++,
      };
      byIdentity.set(id, created);
      added.push(repo);
      continue;
    }
    const nextActivity = activity === null
      ? current.lastActivityAt
      : current.lastActivityAt && parseActivity(current.lastActivityAt) === activity
        ? current.lastActivityAt
        : new Date(activity).toISOString();
    const next: TrackedRepo = {
      ...current,
      isFork: item.isFork,
      isArchived: item.isArchived,
      gone: false,
      lastActivityAt: nextActivity,
    };
    if (
      next.gone !== current.gone ||
      next.isFork !== current.isFork ||
      next.isArchived !== current.isArchived ||
      next.lastActivityAt !== current.lastActivityAt
    ) {
      updated.push(current.repo);
    }
    byIdentity.set(id, next);
  }

  const markedGone: string[] = [];
  if (!sweep.truncated) {
    for (const [id, row] of byIdentity) {
      if (repoOwner(row.repo) !== ownerKey) continue;
      if (seen.has(id) || row.gone) continue;
      byIdentity.set(id, { ...row, gone: true });
      markedGone.push(row.repo);
    }
  }

  const repos = [...byIdentity.values()].sort((a, b) => a.position - b.position || a.repo.localeCompare(b.repo));
  const warning = sweep.truncated
    ? `gh repo list hit the ${DISCOVERY_LIST_CAP}-repo cap; repos absent from this page were not marked gone`
    : null;
  return { failure: null, warning, repos, added, updated, markedGone };
}
