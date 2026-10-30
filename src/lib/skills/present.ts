import { stallMinutes } from "./clock";
import { renderSkillDocument, type FormatSkill } from "./formats";
import type { RunRecord, Runtime, SkillTriggerView } from "./types";

/** Milliseconds. A bad AK_SKILL_STALL_MINUTES falls back to 60 so stalls stay visible. */
export function skillStallMs(env: NodeJS.ProcessEnv = process.env): number {
  return stallMinutes(env) * 60_000;
}

export function presentRun(run: RunRecord, now: Date, stallMs: number = skillStallMs()): SkillTriggerView {
  const ended = run.ended_at != null;
  const age = now.getTime() - Date.parse(run.started_at);
  const status: SkillTriggerView["status"] = ended ? "done" : age > stallMs ? "stalled" : "running";
  const outcome = ended && (run.status === "done" || run.status === "failed") ? run.status : null;
  return {
    at: run.started_at,
    agent: run.agent_id,
    lane: run.lane,
    started: true,
    ended,
    status,
    outcome,
  };
}

export function isStalled(run: Pick<RunRecord, "ended_at" | "started_at">, now: Date, stallMs: number): boolean {
  if (run.ended_at != null) return false;
  return now.getTime() - Date.parse(run.started_at) > stallMs;
}

/**
 * The skill text get_skill and run_skill put under the preamble.
 * hermes gets Hermes frontmatter. codex and grok get an Agent Skills document.
 * nemoclaw gets the NemoClaw frontmatter subset in the Agent Skills directory.
 * claude, mini, and a call with no runtime keep the stored body.
 */
export function presentSkillDocument(skill: FormatSkill, runtime: Runtime | null): string {
  try {
    return renderSkillDocument(runtime, skill).trimEnd();
  } catch {
    return skill.body.trimEnd();
  }
}
