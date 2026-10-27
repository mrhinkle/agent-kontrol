import type { DriftEntry } from "./types";

/**
 * Compare the mirror to one machine's report.
 * missing: in the mirror, not in the report.
 * extra: in the report, not in the mirror.
 * differs: both, and the SHA-256 of SKILL.md does not match.
 */

export interface DriftDiffItem {
  name: string;
  sha: string;
}

export interface DriftDifferItem {
  name: string;
  mirrorSha: string;
  localSha: string;
}

export interface DriftDiff {
  missing: DriftDiffItem[];
  extra: DriftDiffItem[];
  differs: DriftDifferItem[];
}

export function compareDrift(mirror: DriftEntry[], reported: DriftEntry[]): DriftDiff {
  const mirrorByName = new Map<string, string>();
  for (const entry of mirror) mirrorByName.set(entry.name, entry.sha);
  const reportedByName = new Map<string, string>();
  for (const entry of reported) reportedByName.set(entry.name, entry.sha);

  const missing: DriftDiffItem[] = [];
  const differs: DriftDifferItem[] = [];
  for (const [name, sha] of [...mirrorByName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const local = reportedByName.get(name);
    if (local === undefined) missing.push({ name, sha });
    else if (local !== sha) differs.push({ name, mirrorSha: sha, localSha: local });
  }
  const extra: DriftDiffItem[] = [];
  for (const [name, sha] of [...reportedByName.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!mirrorByName.has(name)) extra.push({ name, sha });
  }
  return { missing, extra, differs };
}

/**
 * Skills that disagree, summed across reports.
 * One skill missing from two hosts counts twice. A name is one item per report.
 */
export function driftItemCount(mirror: DriftEntry[], reports: DriftEntry[][]): number {
  let count = 0;
  for (const report of reports) {
    const diff = compareDrift(mirror, report);
    count += diff.missing.length + diff.extra.length + diff.differs.length;
  }
  return count;
}

/** Distinct names across the latest stored report for each (host, dir). */
export function driftCountOf(reports: { entries: DriftEntry[] }[], mirror: DriftEntry[]): number {
  return driftNameCount(mirror, reports.map((report) => report.entries));
}

/** Distinct skill names that disagree in any report. */
export function driftNameCount(mirror: DriftEntry[], reports: DriftEntry[][]): number {
  const names = new Set<string>();
  for (const report of reports) {
    const diff = compareDrift(mirror, report);
    for (const item of diff.missing) names.add(item.name);
    for (const item of diff.extra) names.add(item.name);
    for (const item of diff.differs) names.add(item.name);
  }
  return names.size;
}

/** Directories a collector is expected to report. `AK_SKILL_DRIFT_DIRS` replaces the default, comma-separated. */
export function driftDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AK_SKILL_DRIFT_DIRS?.trim();
  if (!raw) return ["~/.codex/skills", "~/.agents/skills"];
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}
