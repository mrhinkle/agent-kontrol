import { isConfigured } from "../db";
import { demoSkillRows } from "./demo";
import { skillContentSha, shortSha } from "./sha";
import { scopeAdmits } from "./settings";
import { listSettings, listSkillRows } from "./store";
import { isRuntime, type Runtime, type SkillScope, type Trigger } from "./types";

/**
 * Pointer block for a lane's AGENTS.md.
 * An empty result is "" with no markers. applyPointerBlock (agents-md.ts)
 * inserts, replaces, or removes the block in a file; GET/POST
 * /api/skills/pointers expose both to a dispatcher outside this repo.
 */

export interface PointerSkill {
  id: string;
  version: string | null;
  sha: string;
  description: string;
}

export function renderPointers(skills: PointerSkill[], opts: { runtime: string; lane: string }): string {
  const ordered = [...skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ordered.length === 0) return "";
  const lines = ordered.map((skill) => {
    const version = skill.version ?? "unversioned";
    const run = JSON.stringify({ id: skill.id, runtime: opts.runtime, lane: opts.lane });
    const description = pointerDescription(skill.description);
    return `- ${skill.id} (${version}, ${shortSha(skill.sha)}) — ${description}. Fetch: get_skill {"id":"${skill.id}"}; run: run_skill ${run}`;
  });
  return ["<!-- ak-skills:begin -->", ...lines, "<!-- ak-skills:end -->"].join("\n");
}

/** One line, no comment delimiters, and no period of its own. The renderer adds the period. */
function pointerDescription(description: string): string {
  return description
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
}

export async function renderLaneSkillPointers(input: { lane: string; runtime: string }): Promise<string> {
  if (!isRuntime(input.runtime)) return "";
  const skills = await pointerSkills(input.runtime, input.lane);
  return renderPointers(skills, { runtime: input.runtime, lane: input.lane });
}

async function pointerSkills(runtime: Runtime, lane: string): Promise<PointerSkill[]> {
  if (!isConfigured()) {
    return demoSkillRows()
      .filter((skill) => skill.trigger === "auto_inject" && skill.runtimes[runtime] && scopeAdmits(skill.scope, lane))
      .map((skill) => ({
        id: skill.id,
        version: skill.version,
        sha: skillContentSha(skill.raw),
        description: skill.description,
      }));
  }
  const [rows, settings] = await Promise.all([listSkillRows(), listSettings()]);
  const byId = new Map(settings.map((row) => [row.skill_id, row]));
  const visible: PointerSkill[] = [];
  for (const row of rows) {
    if (row.removed_at) continue;
    const setting = byId.get(row.id);
    const trigger: Trigger = setting?.trigger ?? "off";
    const scope: SkillScope = setting?.scope ?? { mode: "all", lanes: [] };
    if (trigger !== "auto_inject") continue;
    if (!row.runtimes[runtime]) continue;
    if (!scopeAdmits(scope, lane)) continue;
    visible.push({ id: row.id, version: row.version, sha: row.sha, description: row.description });
  }
  return visible;
}
