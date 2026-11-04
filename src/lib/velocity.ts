import { z } from "zod";

export const VELOCITY_VERSION = "observed-development-velocity-v1.0";
export const VELOCITY_MAX_BYTES = 2 * 1024 * 1024;
const count = z.number().int().min(0).max(10_000_000);
const sample = z.number().finite().min(0).max(1_000_000);
const samples = z.array(sample).max(100_000).transform((a) => [...a].sort((a, b) => a - b));
const attempts = z.array(count.min(1)).max(100_000).transform((a) => [...a].sort((a, b) => a - b));
const instant = z.string().datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const owner = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/).transform((s) => s.toLowerCase());
const coverage = z.enum(["complete", "partial", "unavailable"]);
const daySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), opened: count, merged: count }).strict();
const cdSchema = z.object({ targets: count, records: count, attempts }).strict().superRefine((v, c) => {
  if (v.attempts.length > v.targets || v.records < v.targets || v.attempts.reduce((a, b) => a + b, 0) > v.records) {
    c.addIssue({ code: "custom", message: "Deployment targets, records and success samples do not reconcile." });
  }
});
const repoSchema = z.object({
  repo: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/).refine((s) => ![".", ".."].includes(s.split("/")[1]), "Invalid repository name.").transform((s) => s.toLowerCase()),
  archived: z.boolean(), fork: z.boolean(),
  coverage: z.object({ prs: coverage, ci: coverage, cd: coverage }).strict(),
  prs: z.object({
    opened: count, merged: count, openCurrent: count, mergeHours: samples,
    daily: z.array(daySchema).max(366),
  }).strict().nullable(),
  ci: z.object({
    covered: count, noGreen: count, noCI: count, revisionSamples: attempts,
    firstPass: count, reruns: count, sameShaRepeats: count,
  }).strict().nullable(),
  cd: z.object({ production: cdSchema, preview: cdSchema, other: cdSchema }).strict().nullable(),
}).strict().superRefine((v, c) => {
  const fail = (message: string) => c.addIssue({ code: "custom", message });
  for (const stream of ["prs", "ci", "cd"] as const) {
    if ((v.coverage[stream] === "unavailable") !== (v[stream] === null)) fail(`${stream} availability does not match its coverage.`);
  }
  if (v.prs && (v.prs.mergeHours.length !== v.prs.merged ||
    v.prs.daily.reduce((n, d) => n + d.opened, 0) !== v.prs.opened ||
    v.prs.daily.reduce((n, d) => n + d.merged, 0) !== v.prs.merged)) fail("PR samples and daily counts do not reconcile.");
  if (v.ci) {
    if (v.ci.covered !== v.ci.revisionSamples.length + v.ci.noGreen) fail("Covered PRs must equal observed green plus no observed green.");
    if (v.prs && v.prs.opened !== v.ci.covered + v.ci.noCI) fail("Created PRs must equal CI-covered plus no-CI PRs.");
    if (v.ci.firstPass > v.ci.revisionSamples.filter((n) => n === 1).length) fail("First-pass count exceeds one-revision successes.");
  }
});

/** Calendar dates are deliberately independent of elapsed hours (DST). */
export function localDate(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function windowDates(start: string, end: string, timeZone: string): string[] {
  const first = Date.parse(`${localDate(start, timeZone)}T00:00:00Z`);
  const stop = Date.parse(`${localDate(end, timeZone)}T00:00:00Z`);
  const result: string[] = [];
  for (let t = first; t < stop && result.length <= 366; t += 86_400_000) result.push(new Date(t).toISOString().slice(0, 10));
  return result;
}
function isMidnight(value: string, timeZone: string): boolean {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value));
  return p === "00:00:00" && Date.parse(value) % 1000 === 0;
}
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), metricVersion: z.literal(VELOCITY_VERSION), capturedAt: instant,
  captureKind: z.enum(["observed", "reconstructed"]),
  window: z.object({ start: instant, end: instant, days: z.number().int().min(1).max(366), timezone: z.string().min(1).max(80) }).strict(),
  scope: z.object({ owners: z.array(owner).min(1).max(20), includeForks: z.boolean(), includeArchived: z.boolean(), cohort: z.literal("pr-created-in-window") }).strict(),
  inventoryComplete: z.boolean(),
  source: z.object({ artifactSha256: z.string().regex(/^[0-9a-f]{64}$/), evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/), collectorVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/) }).strict(),
  repositories: z.array(repoSchema).max(1000),
}).strict().superRefine((v, c) => {
  const fail = (message: string) => c.addIssue({ code: "custom", message });
  let dates: string[];
  try {
    dates = windowDates(v.window.start, v.window.end, v.window.timezone);
    if (!isMidnight(v.window.start, v.window.timezone) || !isMidnight(v.window.end, v.window.timezone) || dates.length !== v.window.days) fail("Window must contain the stated number of complete local calendar days.");
  } catch { fail("Reporting timezone is invalid."); return; }
  if (Date.parse(v.window.start) >= Date.parse(v.window.end) || Date.parse(v.window.end) > Date.parse(v.capturedAt)) fail("Window must end at or before capture time.");
  if (new Set(v.scope.owners).size !== v.scope.owners.length) fail("Owners must be unique.");
  if (new Set(v.repositories.map((r) => r.repo)).size !== v.repositories.length) fail("Repositories must be unique, ignoring case.");
  for (const r of v.repositories) {
    if (!v.scope.owners.includes(r.repo.split("/")[0])) fail("Repository owner is outside the declared scope.");
    if ((!v.scope.includeForks && r.fork) || (!v.scope.includeArchived && r.archived)) fail("Repository is excluded by the declared policy.");
    if (r.prs && (r.prs.daily.length !== dates.length || r.prs.daily.some((d, i) => d.date !== dates[i]))) fail("Daily buckets must cover every date in window order.");
  }
}).transform((v) => ({ ...v, scope: { ...v.scope, owners: [...v.scope.owners].sort() }, repositories: [...v.repositories].sort((a, b) => a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) }));

export type VelocitySnapshot = z.infer<typeof snapshotSchema>;
export type VelocityRepo = VelocitySnapshot["repositories"][number];
export function parseVelocity(value: unknown, now = new Date()): VelocitySnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid benchmark capture.");
  if (Date.parse(result.data.capturedAt) > now.getTime() + 300_000) throw new Error("Capture time is in the future.");
  return result.data;
}
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function compatibility(snapshot: VelocitySnapshot): string {
  return canonicalJSON({ metricVersion: snapshot.metricVersion, scope: snapshot.scope, timezone: snapshot.window.timezone, days: snapshot.window.days });
}
export function distribution(values: readonly number[]) {
  const a = [...values].sort((a, b) => a - b), n = a.length;
  return { n, sum: a.reduce((n, v) => n + v, 0), mean: n ? a.reduce((n, v) => n + v, 0) / n : null,
    median: n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : null,
    p90: n ? a[Math.ceil(n * 0.9) - 1] : null };
}
export function summarizeVelocity(snapshot: VelocitySnapshot) {
  const rows = snapshot.repositories, prs = rows.flatMap((r) => r.prs ? [r.prs] : []), ci = rows.flatMap((r) => r.ci ? [r.ci] : []), cd = rows.flatMap((r) => r.cd ? [r.cd] : []);
  const sum = <T>(a: T[], pick: (v: T) => number) => a.reduce((n, v) => n + pick(v), 0);
  const covered = sum(ci, (v) => v.covered), firstPass = sum(ci, (v) => v.firstPass);
  const deployment = (kind: "production" | "preview" | "other") => ({ targets: sum(cd, (v) => v[kind].targets), records: sum(cd, (v) => v[kind].records), turns: distribution(cd.flatMap((v) => v[kind].attempts)) });
  return {
    repositories: rows.length, archived: rows.filter((r) => r.archived).length, forks: rows.filter((r) => r.fork).length,
    active: rows.filter((r) => r.prs && (r.prs.opened || r.prs.merged)).length,
    coverage: { prs: prs.length, ci: ci.length, cd: cd.length, complete: rows.filter((r) => Object.values(r.coverage).every((c) => c === "complete")).length },
    prs: prs.length ? { opened: sum(prs, (v) => v.opened), merged: sum(prs, (v) => v.merged), openCurrent: sum(prs, (v) => v.openCurrent), mergeHours: distribution(prs.flatMap((v) => v.mergeHours)), daily: windowDates(snapshot.window.start, snapshot.window.end, snapshot.window.timezone).map((date, i) => ({ date, opened: sum(prs, (v) => v.daily[i].opened), merged: sum(prs, (v) => v.daily[i].merged) })) } : null,
    ci: ci.length ? { covered, green: sum(ci, (v) => v.revisionSamples.length), noGreen: sum(ci, (v) => v.noGreen), noCI: sum(ci, (v) => v.noCI), firstPass, firstPassRate: covered ? firstPass / covered : null, reruns: sum(ci, (v) => v.reruns), sameShaRepeats: sum(ci, (v) => v.sameShaRepeats), revisions: distribution(ci.flatMap((v) => v.revisionSamples)) } : null,
    cd: cd.length ? { production: deployment("production"), preview: deployment("preview"), other: deployment("other") } : null,
  };
}
export type VelocitySummary = ReturnType<typeof summarizeVelocity>;
export type VelocityPoint = { id: string; windowStart: string; windowEnd: string; capturedAt: string; recordedAt: string; captureKind: VelocitySnapshot["captureKind"]; inventoryKey: string; summary: VelocitySummary };
export type VelocityResponse = {
  series: { key: string; owners: string[]; days: number; timezone: string; metricVersion: string }[];
  selectedKey: string | null;
  latest: (VelocityPoint & { snapshot: VelocitySnapshot }) | null;
  baseline: VelocityPoint | null;
  history: VelocityPoint[];
  historyLimited: boolean;
};
