import { windowDays, type TimeWindow } from "../progress-config";
import type { SkillsDigest } from "../progress-types";
import { skillNow } from "./clock";
import { isStalled, skillStallMs } from "./present";
import { digestRuns, listSettings, listSkillRows } from "./store";
import { RUNTIMES, type Runtime } from "./types";

const NOTE = "Only triggers routed through Agent Kontrol are counted." as const;

/**
 * Counts use the digest window. Stalled runs are current, including a run
 * that started before the window: a stall does not expire when the window rolls.
 * An agent that reads a skill from disk never appears here.
 */
export async function skillsDigest(window: TimeWindow): Promise<SkillsDigest> {
  const now = skillNow();
  const since = new Date(now.getTime() - windowDays(window) * 86_400_000).toISOString();
  const stallMs = skillStallMs();
  const [runs, skills, settings] = await Promise.all([digestRuns(since), listSkillRows(), listSettings()]);
  const inWindow = runs.filter((run) => run.started_at >= since);
  const counts = new Map<string, number>();
  const byRuntime: SkillsDigest["triggers_by_runtime"] = { claude: 0, codex: 0, grok: 0, hermes: 0, mini: 0, nemoclaw: 0 };
  for (const run of inWindow) {
    counts.set(run.skill_id, (counts.get(run.skill_id) ?? 0) + 1);
    if ((RUNTIMES as readonly string[]).includes(run.runtime)) {
      byRuntime[run.runtime as Runtime] += 1;
    }
  }
  const triggers_by_skill = [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
  const settingById = new Map(settings.map((row) => [row.skill_id, row]));
  const used = new Set(inWindow.map((run) => run.skill_id));
  const enabled_never_used = skills
    .filter((skill) => !skill.removed_at)
    .filter((skill) => (settingById.get(skill.id)?.trigger ?? "off") !== "off")
    .filter((skill) => !used.has(skill.id))
    .map((skill) => skill.id)
    .sort();
  const stalled = runs
    .filter((run) => isStalled(run, now, stallMs))
    .map((run) => ({ run_id: run.run_id, skill_id: run.skill_id, agent: run.agent_id, at: run.started_at }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.run_id < b.run_id ? -1 : 1));
  return { window, triggers_by_skill, triggers_by_runtime: byRuntime, stalled, enabled_never_used, note: NOTE };
}
