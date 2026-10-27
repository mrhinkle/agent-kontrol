import { randomUUID } from "node:crypto";
import { currentActor } from "../actor";
import { upsertSpans } from "../trace-store";
import type { SpanInput } from "../traces";
import { skillNow } from "./clock";
import { scopeAdmits } from "./settings";
import { completeRun, deleteRun, getRun, getSkillRow, insertRun, listSettings } from "./store";
import {
  NOTE_MAX,
  isRuntime,
  runtimeList,
  type RunRecord,
  type Runtime,
  type SkillRecord,
} from "./types";

export type RunFail = { ok: false; code: "not_found" | "forbidden" | "validation_failed"; message: string };

const PREAMBLE: Record<Runtime, string> = {
  claude: "You are Claude. Follow this skill in your own session. Agent Kontrol does not execute it.",
  codex: "You are Codex. Follow this skill in your own session. Agent Kontrol does not execute it.",
  grok: "You are Grok. Follow this skill in your own session. Agent Kontrol does not execute it.",
  hermes: "You are Hermes. Follow this skill in your own session. Agent Kontrol does not execute it.",
  mini: "You are the Mini worker. Follow this skill in your own session. Agent Kontrol does not execute it.",
};

export async function loadVisibleSkill(id: string): Promise<SkillRecord | null> {
  return getSkillRow(id);
}

export async function gateSkill(input: {
  id: string;
  runtime?: string | null;
  lane?: string | null;
}): Promise<{ ok: true; skill: SkillRecord; trigger: string } | RunFail> {
  const skill = await loadVisibleSkill(input.id);
  if (!skill) return { ok: false, code: "not_found", message: "Skill is not available." };
  const settings = await listSettings();
  const setting = settings.find((row) => row.skill_id === skill.id);
  const trigger = setting?.trigger ?? "off";
  if (trigger === "off") return { ok: false, code: "not_found", message: "Skill is not available." };
  if (input.runtime) {
    if (!isRuntime(input.runtime) || !skill.runtimes[input.runtime]) {
      return { ok: false, code: "forbidden", message: "Skill is not compatible with this runtime." };
    }
  }
  const scope = setting?.scope ?? { mode: "all" as const, lanes: [] };
  if (scope.mode === "selected" && !input.lane) {
    return { ok: false, code: "forbidden", message: "Skill is limited to selected lanes; pass lane." };
  }
  if (!scopeAdmits(scope, input.lane)) {
    return { ok: false, code: "forbidden", message: "Skill is not in scope for this lane." };
  }
  return { ok: true, skill, trigger };
}

export function renderSkillText(skill: SkillRecord, runtime: Runtime | null): string {
  const lines = [
    `# ${skill.id}`,
    `Pinned SHA: ${skill.sha}`,
    runtime ? `Runtime: ${runtime}` : "Runtime: not filtered",
    "",
    runtime ? PREAMBLE[runtime] : "Follow this skill in your own session. Agent Kontrol does not execute it.",
    "",
    skill.body.trimEnd(),
    "",
    "References (fetch with get_skill):",
  ];
  if (skill.references.length === 0) lines.push("- none");
  else for (const ref of skill.references) lines.push(`- ${ref.path}`);
  return lines.join("\n");
}

export function renderReferenceText(skill: SkillRecord, path: string): { ok: true; text: string } | RunFail {
  const ref = skill.references.find((item) => item.path === path);
  if (!ref) return { ok: false, code: "not_found", message: "Reference not found." };
  return {
    ok: true,
    text: [`# ${skill.id}`, `Pinned SHA: ${skill.sha}`, `Reference: ${path}`, "", ref.content].join("\n"),
  };
}

export interface StartInput {
  id: string;
  agentId: string;
  runtime: string;
  lane?: string | null;
  note?: string | null;
}

export async function startSkillRun(input: StartInput): Promise<{ ok: true; text: string; runId: string } | RunFail> {
  if (!isRuntime(input.runtime)) {
    return { ok: false, code: "validation_failed", message: "runtime must be claude, codex, grok, hermes, or mini." };
  }
  const gated = await gateSkill({ id: input.id, runtime: input.runtime, lane: input.lane });
  if (!gated.ok) return gated;
  const actor = currentActor();
  if (!actor) return { ok: false, code: "forbidden", message: "This request has no actor, so the run cannot be completed later." };
  const runId = randomUUID();
  const now = skillNow().toISOString();
  const row: RunRecord = {
    run_id: runId,
    skill_id: gated.skill.id,
    skill_sha: gated.skill.sha,
    agent_id: input.agentId,
    lane: input.lane ?? null,
    runtime: input.runtime,
    started_at: now,
    ended_at: null,
    status: "running",
    note: null,
    actor_type: actor.actor_type,
    actor_id: actor.actor_id,
  };
  await insertRun(row);
  try {
    await upsertSpans([spanFor(row, null, "unset")]);
  } catch (err) {
    await deleteRun(runId).catch(() => undefined);
    throw err;
  }
  const text = [
    renderSkillText(gated.skill, input.runtime),
    "",
    `run_id: ${runId}`,
    "Call run_skill again with this run_id and complete:true when you finish.",
    "Omit id. The run already names the skill. If you pass id, it must match.",
    'Pass status "done" or "failed" and an optional note of at most 500 characters.',
  ].join("\n");
  return { ok: true, text, runId };
}

export async function finishSkillRun(input: {
  runId: string;
  /** When set, must be the skill stored on the run. Omit it to use that row. */
  skillId?: string | null;
  status?: "done" | "failed" | null;
  note?: string | null;
}): Promise<{ ok: true; text: string } | RunFail> {
  const actor = currentActor();
  if (!actor) return { ok: false, code: "forbidden", message: "This request has no actor." };
  const existing = await getRun(input.runId);
  if (!existing) return { ok: false, code: "not_found", message: "Skill run not found." };
  if (input.skillId != null && input.skillId !== existing.skill_id) {
    return { ok: false, code: "validation_failed", message: "id does not match the skill on this run." };
  }
  if (existing.actor_type !== actor.actor_type || existing.actor_id !== actor.actor_id) {
    return { ok: false, code: "forbidden", message: "Only the actor that started this run can complete it." };
  }
  if (existing.ended_at) return { ok: true, text: completionText(existing) };
  if (input.note != null && input.note.length > NOTE_MAX) {
    return { ok: false, code: "validation_failed", message: "note must be at most 500 characters." };
  }
  const status = input.status ?? "done";
  if (status !== "done" && status !== "failed") {
    return { ok: false, code: "validation_failed", message: "status must be done or failed." };
  }
  const endedAt = skillNow().toISOString();
  const updated = await completeRun({
    runId: input.runId,
    actorType: actor.actor_type,
    actorId: actor.actor_id,
    status,
    note: input.note ?? null,
    endedAt,
  });
  const row = updated ?? (await getRun(input.runId));
  if (!row) return { ok: false, code: "not_found", message: "Skill run not found." };
  if (!updated && row.ended_at) return { ok: true, text: completionText(row) };
  await upsertSpans([spanFor(row, row.ended_at, row.status === "failed" ? "error" : "ok")]);
  return { ok: true, text: completionText(row) };
}

export function completionText(row: RunRecord): string {
  const lines = [`run_id: ${row.run_id}`, `status: ${row.status}`];
  if (row.note) lines.push(`note: ${row.note}`);
  if (row.ended_at) lines.push(`Completed at: ${row.ended_at}`);
  return lines.join("\n");
}

function spanFor(row: RunRecord, endedAt: string | null, status: "ok" | "error" | "unset"): SpanInput {
  const traceId = row.run_id.replace(/-/g, "");
  const attributes: Record<string, string> = {
    skill_id: row.skill_id,
    sha: row.skill_sha,
    runtime: row.runtime,
  };
  if (row.lane) attributes.lane = row.lane;
  return {
    trace_id: traceId,
    span_id: traceId.slice(0, 16),
    parent_span_id: null,
    agent_id: row.agent_id,
    session_id: null,
    name: `skill:${row.skill_id}`.slice(0, 200),
    kind: "tool",
    status,
    status_message: null,
    started_at: row.started_at,
    ended_at: endedAt,
    attributes,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
  };
}

export function compatibleRuntimes(skill: SkillRecord): Runtime[] {
  return runtimeList(skill.runtimes);
}
