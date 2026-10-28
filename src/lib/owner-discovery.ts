/**
 * Pure planner for one owner's discovery tick.
 *
 * A failed, rate-limited, or empty `gh repo list` changes nothing. A repo
 * that goes quiet stays in the list and drops off the brief only once its
 * age is greater than `activity_days` (the boundary day is still shown).
 * Hide wins over pin. A repo marked gone is not shown, including when it is pinned.
 * Forks and archived repos are not added unless that owner's flag says so.
 * Identity is `owner/name`, never the short name.
 */

import { PALETTE } from "./repo-settings-helpers";

export const MS_PER_DAY = 86_400_000;
export const DISCOVERY_LIST_CAP = 1000;

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
  for (const row of existing) byIdentity.set(repoIdentity(row.repo), { ...row });
  const usedShorts = new Set(existing.map((row) => row.short.toLowerCase()));
  let nextPosition = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
  const seen = new Set<string>();
  const added: string[] = [];
  const updated: string[] = [];

  for (const item of listed) {
    const repo = `${ownerKey}/${item.name}`;
    const id = repoIdentity(repo);
    if (seen.has(id)) continue;
    seen.add(id);
    const activity = parseActivity(item.pushedAt);
    const inWindow = activity !== null && now.getTime() - activity <= owner.activityDays * MS_PER_DAY;
    const current = byIdentity.get(id);
    if (!current) {
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
      updated.push(repo);
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
