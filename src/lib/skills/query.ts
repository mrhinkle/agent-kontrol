import { currentActor } from "../actor";
import { skillNow } from "./clock";
import { scheduleView } from "./schedule";
import { listLastScheduledTasks, type ScheduledTaskRow } from "./schedule-store";
import { driftNameCount } from "./drift";
import { presentRun } from "./present";
import { parseSettingsPatch } from "./settings";
import {
  getSkillRow,
  latestSyncRuns,
  listDrift,
  listSettings,
  listSkillRows,
  listSources,
  recentRuns,
  runStats,
  upsertSettings,
} from "./store";
import {
  DEFAULT_SCOPE,
  DEFAULT_TRIGGER,
  matchesCategory,
  runtimeList,
  type SettingsRecord,
  type SkillDetail,
  type SkillListItem,
  type SkillRecord,
  type UpstreamInfo,
} from "./types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function readUpstream(): Promise<UpstreamInfo> {
  const [sources, skills, runs, drift] = await Promise.all([
    listSources(),
    listSkillRows(),
    latestSyncRuns(),
    listDrift(),
  ]);
  const primary = sources[0];
  const mirror = skills.filter((skill) => !skill.removed_at).map((skill) => ({ name: skill.id, sha: skill.sha }));
  let sha: string | null = null;
  let syncedAt: string | null = null;
  if (primary) {
    for (const run of runs) {
      const summary = run.summary as { sources?: { id?: string; commit_sha?: string }[] } | null;
      const hit = summary?.sources?.find((source) => source.id === primary.id && source.commit_sha);
      if (hit?.commit_sha) {
        sha = hit.commit_sha;
        syncedAt = run.finished_at;
        break;
      }
    }
  }
  return {
    source: primary?.label ?? "",
    sha,
    syncedAt,
    driftCount: driftNameCount(mirror, drift.map((row) => row.entries)),
  };
}

export async function listSkillViews(filter: {
  runtime?: string | null;
  q?: string | null;
  category?: string | null;
}): Promise<{
  upstream: UpstreamInfo;
  skills: SkillListItem[];
}> {
  const now = skillNow();
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const [rows, settings, stats, upstream, scheduled] = await Promise.all([
    listSkillRows(),
    listSettings(),
    runStats(since),
    readUpstream(),
    lastScheduledById(),
  ]);
  const settingsById = new Map(settings.map((row) => [row.skill_id, row]));
  const statsById = new Map(stats.map((row) => [row.skill_id, row]));
  const q = filter.q?.trim().toLowerCase() ?? "";
  const skills = rows
    .filter((row) => !row.removed_at)
    .filter((row) => !filter.runtime || row.runtimes[filter.runtime as keyof typeof row.runtimes] === true)
    .filter((row) => matchesCategory(row.category, filter.category))
    .filter((row) => {
      if (!q) return true;
      return (
        row.id.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q)
      );
    })
    .map((row) => toListItem(row, settingsById.get(row.id), statsById.get(row.id), scheduled.get(row.id)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { upstream, skills };
}

export async function getSkillDetail(id: string): Promise<SkillDetail | null> {
  const row = await getSkillRow(id);
  if (!row) return null;
  const [settings, stats, triggers, scheduled] = await Promise.all([
    listSettings(),
    runStats(new Date(skillNow().getTime() - WEEK_MS).toISOString()),
    recentRuns(id, 50),
    lastScheduledById(),
  ]);
  const setting = settings.find((item) => item.skill_id === id);
  const stat = stats.find((item) => item.skill_id === id);
  const now = skillNow();
  const item = toListItem(row, setting, stat, scheduled.get(id));
  return {
    ...item,
    body: row.body,
    references: row.references.map((ref) => ({ path: ref.path })),
    runtimes: row.runtimes,
    schedule: setting?.schedule ?? null,
    triggers: triggers.map((run) => presentRun(run, now)),
  };
}

export async function patchSkillSettings(
  id: string,
  body: unknown,
): Promise<{ ok: true; detail: SkillDetail } | { ok: false; status: number; code: "not_found" | "validation_failed" | "missing_field"; message: string; fields?: Record<string, string> }> {
  const row = await getSkillRow(id);
  if (!row) return { ok: false, status: 404, code: "not_found", message: "Skill not found" };
  const settings = await listSettings();
  const current = settings.find((item) => item.skill_id === id) ?? null;
  const parsed = parseSettingsPatch(body, current);
  if (!parsed.ok) return { ok: false, status: 400, code: parsed.code, message: parsed.message, fields: parsed.fields };
  const actor = currentActor();
  const saved: SettingsRecord = {
    skill_id: id,
    trigger: parsed.value.trigger,
    scope: parsed.value.scope,
    schedule: parsed.value.schedule,
    updated_by: actor ? `${actor.actor_type}:${actor.actor_id}` : null,
    updated_at: skillNow().toISOString(),
  };
  await upsertSettings(saved);
  const detail = await getSkillDetail(id);
  if (!detail) return { ok: false, status: 404, code: "not_found", message: "Skill not found" };
  const warnings = runtimeList(row.runtimes).length === 0
    ? [`${id} has no compatible runtime. Agents will not see it from list_skills or run_skill.`]
    : [];
  return { ok: true, detail: warnings.length ? { ...detail, warnings } : detail };
}

function toListItem(
  row: SkillRecord,
  setting: SettingsRecord | undefined,
  stat: { triggers_7d: number; last_agent: string | null; last_at: string | null } | undefined,
  lastScheduled?: ScheduledTaskRow,
): SkillListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    sha: row.sha,
    runtimes: runtimeList(row.runtimes),
    category: row.category,
    tags: row.tags,
    trigger: setting?.trigger ?? DEFAULT_TRIGGER,
    scope: setting?.scope ?? DEFAULT_SCOPE,
    triggerCount7d: stat?.triggers_7d ?? 0,
    lastRun: stat?.last_at && stat.last_agent ? { at: stat.last_at, agent: stat.last_agent } : null,
    ...scheduleView(setting, lastScheduled),
  };
}

/** The scheduler's newest task per skill. A failed read leaves lastScheduledAt null; it does not fail the skills list. */
async function lastScheduledById(): Promise<Map<string, ScheduledTaskRow>> {
  try {
    return new Map((await listLastScheduledTasks()).map((row) => [row.skill_id, row]));
  } catch {
    return new Map();
  }
}
