import { createHash } from "node:crypto";
import type { Actor } from "../actor";
import { IdempotencyConflict } from "../idempotency";
import { createTask, updateTask } from "../store";
import { skillNow } from "./clock";
import {
  compileCron,
  countMatchesBetween,
  floorToMinute,
  latestDueSlot,
  nextDueSlot,
  parseSlot,
  slotId,
} from "./schedule-cron";
import {
  listLastScheduledTasks,
  listOpenScheduledTasks,
  SCHEDULED_TITLE_PREFIX,
  SCHEDULER_ACTOR_ID,
  type ScheduledTaskRow,
} from "./schedule-store";
import { listSettings, listSkillRows } from "./store";
import { runtimeList, type Runtime, type SettingsRecord, type SkillRecord } from "./types";

/**
 * Queues one task per scheduled skill whose cron is due. It never runs the
 * skill: a connected agent claims the task and calls run_skill, which is the
 * only thing that writes a run.
 */

export const SCHEDULED_CREATED_BY = "skill-scheduler";
export const SCHEDULER_ACTOR: Actor = { actor_type: "agent", actor_id: SCHEDULER_ACTOR_ID };

type Env = Record<string, string | undefined>;

const DEFAULT_CATCHUP_MINUTES = 10;

/** How far back a tick looks for a due minute. A late scheduler still queues; a long outage does not replay. */
export function catchupMinutes(env: Env = process.env): number {
  const raw = env.AK_SKILL_SCHEDULE_CATCHUP_MINUTES?.trim();
  if (!raw || !/^[0-9]+$/.test(raw)) return DEFAULT_CATCHUP_MINUTES;
  const n = Number(raw);
  return n >= 1 && n <= 1440 ? n : DEFAULT_CATCHUP_MINUTES;
}

export type SkipReason =
  | "previous_open"
  | "already_scheduled"
  | "duplicate"
  | "no_runtime";

export interface TickItem {
  skill_id: string;
  slot: string;
  outcome: "queued" | "skipped";
  reason?: SkipReason;
  task_id?: number;
  /** Due minutes since the last queued slot that no task covers. Coalesced into this one task. */
  missed?: number;
}

export interface TickResult {
  ok: true;
  now: string;
  /** Skills with trigger scheduled and a valid cron. */
  scheduled: number;
  queued: number;
  skipped: number;
  items: TickItem[];
}

export interface TickDeps {
  skills: () => Promise<SkillRecord[]>;
  settings: () => Promise<SettingsRecord[]>;
  open: () => Promise<ScheduledTaskRow[]>;
  last: () => Promise<ScheduledTaskRow[]>;
  cancel: (id: number, why: string) => Promise<void>;
  create: (input: {
    title: string;
    description: string;
    platform: string;
    machine?: string;
    idempotency_key: string;
  }) => Promise<{ id: number }>;
}

const defaultDeps: TickDeps = {
  skills: listSkillRows,
  settings: listSettings,
  open: listOpenScheduledTasks,
  last: listLastScheduledTasks,
  cancel: async (id, why) => {
    await updateTask({ id, status: "cancelled", result: why });
  },
  create: (input) =>
    createTask({
      ...input,
      priority: 2,
      created_by: SCHEDULED_CREATED_BY,
      actor: SCHEDULER_ACTOR,
    }),
};

const PLATFORM: Record<Exclude<Runtime, "mini">, string> = {
  claude: "claude-code",
  codex: "codex",
  grok: "grok",
  hermes: "hermes",
};

/**
 * One compatible runtime other than mini pins the platform. Anything else is
 * "any", and the description names the runtimes so a worker that is not
 * listed leaves the task alone. AK_SKILL_MINI_MACHINE pins a mini-only skill
 * to that machine's dispatcher.
 */
export function routeFor(
  runtimes: Runtime[],
  env: Env = process.env,
): { platform: string; machine?: string } {
  if (runtimes.length === 1 && runtimes[0] !== "mini") return { platform: PLATFORM[runtimes[0]] };
  const miniMachine = env.AK_SKILL_MINI_MACHINE?.trim();
  if (runtimes.length === 1 && runtimes[0] === "mini" && miniMachine) {
    return { platform: "any", machine: miniMachine };
  }
  return { platform: "any" };
}

export function taskTitle(skillId: string): string {
  return `${SCHEDULED_TITLE_PREFIX}${skillId}`;
}

export function idempotencyKeyFor(skillId: string, slot: string): string {
  const key = `skill-schedule:${skillId}:${slot}`;
  if (key.length <= 200) return key;
  return `skill-schedule:${createHash("sha256").update(skillId).digest("hex")}:${slot}`;
}

export function slotOf(description: string): string | null {
  return description.match(/^Scheduled slot: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)/m)?.[1] ?? null;
}

export function describeTask(input: {
  skill: SkillRecord;
  setting: SettingsRecord;
  runtimes: Runtime[];
  slot: string;
  missed: number;
}): string {
  const { skill, setting, runtimes, slot, missed } = input;
  const scope = setting.scope.mode === "selected" ? `lanes ${setting.scope.lanes.join(", ")}` : "all lanes";
  const lines = [
    `Run skill ${skill.id} for scope: ${scope}.`,
    `Scheduled slot: ${slot} (cron "${setting.schedule}", UTC)`,
    `Compatible runtimes: ${runtimes.join(", ")}`,
  ];
  if (missed > 0) lines.push(`Earlier due minutes with no task: ${missed}. They are folded into this one run.`);
  lines.push(
    "",
    `1. Call run_skill with id "${skill.id}" and your runtime${setting.scope.mode === "selected" ? ", and lane set to one of the lanes above" : ""}.`,
    "2. Follow the instructions it returns.",
    "3. Call run_skill again with the run_id and complete:true when you finish. Omit id.",
    "",
    "Agent Kontrol queued this task. It does not execute the skill. If your runtime is not listed above, leave the task for another worker.",
  );
  return lines.join("\n");
}

export async function runScheduleTick(
  opts: { now?: Date; deps?: Partial<TickDeps>; env?: Env } = {},
): Promise<TickResult> {
  const now = floorToMinute(opts.now ?? skillNow());
  const env = opts.env ?? process.env;
  const deps: TickDeps = { ...defaultDeps, ...opts.deps };
  const [skills, settings, open, last] = await Promise.all([deps.skills(), deps.settings(), deps.open(), deps.last()]);
  const skillsById = new Map(skills.filter((s) => !s.removed_at).map((s) => [s.id, s]));
  const openIds = new Set(open.map((t) => t.skill_id));
  const lastById = new Map(last.map((t) => [t.skill_id, t]));
  const lookback = catchupMinutes(env);

  const items: TickItem[] = [];
  let scheduled = 0;
  for (const setting of [...settings].sort((a, b) => (a.skill_id < b.skill_id ? -1 : 1))) {
    const skill = skillsById.get(setting.skill_id);
    if (!skill || setting.trigger !== "scheduled" || !setting.schedule) continue;
    const cron = compileCron(setting.schedule);
    if (!cron) continue;
    scheduled += 1;
    const due = latestDueSlot(cron, now, lookback);
    if (!due) continue;
    const slot = slotId(due);
    const runtimes = runtimeList(skill.runtimes);
    if (runtimes.length === 0) {
      items.push({ skill_id: skill.id, slot, outcome: "skipped", reason: "no_runtime" });
      continue;
    }
    const prior = lastById.get(skill.id);
    const priorSlotText = prior ? slotOf(prior.description) : null;
    const priorSlot = priorSlotText ? parseSlot(priorSlotText) : null;
    if (priorSlot && priorSlot.getTime() >= due.getTime()) {
      items.push({ skill_id: skill.id, slot, outcome: "skipped", reason: "already_scheduled", task_id: prior?.id });
      continue;
    }
    if (openIds.has(skill.id)) {
      items.push({ skill_id: skill.id, slot, outcome: "skipped", reason: "previous_open" });
      continue;
    }
    const missed = priorSlot ? countMatchesBetween(cron, priorSlot, due) : 0;
    const route = routeFor(runtimes, env);
    try {
      const task = await deps.create({
        title: taskTitle(skill.id),
        description: describeTask({ skill, setting, runtimes, slot, missed }),
        platform: route.platform,
        machine: route.machine,
        idempotency_key: idempotencyKeyFor(skill.id, slot),
      });
      // Two ticks for different slots can both pass the open check above. After the
      // insert the lowest open task id wins and any later one cancels itself.
      const winner = Math.min(...(await deps.open()).filter((t) => t.skill_id === skill.id).map((t) => t.id), task.id);
      if (winner !== task.id) {
        await deps.cancel(task.id, "Cancelled: another scheduled task for this skill was queued first.");
        items.push({ skill_id: skill.id, slot, outcome: "skipped", reason: "duplicate" });
        continue;
      }
      items.push({ skill_id: skill.id, slot, outcome: "queued", task_id: task.id, ...(missed ? { missed } : {}) });
    } catch (err) {
      // Same slot key from a concurrent tick: that tick owns the task.
      if (err instanceof IdempotencyConflict) {
        items.push({ skill_id: skill.id, slot, outcome: "skipped", reason: "duplicate" });
        continue;
      }
      throw err;
    }
  }
  const queued = items.filter((i) => i.outcome === "queued").length;
  return { ok: true, now: now.toISOString(), scheduled, queued, skipped: items.length - queued, items };
}

export interface ScheduleView {
  lastScheduledAt: string | null;
  nextDueAt: string | null;
}

/** Read-only view for the skills REST response. */
export function scheduleView(
  setting: SettingsRecord | undefined,
  last: ScheduledTaskRow | undefined,
  now: Date = skillNow(),
): ScheduleView {
  const slot = last ? slotOf(last.description) : null;
  const lastAt = slot ? parseSlot(slot) : null;
  const cron = setting?.trigger === "scheduled" && setting.schedule ? compileCron(setting.schedule) : null;
  const next = cron ? nextDueSlot(cron, now) : null;
  return { lastScheduledAt: lastAt ? lastAt.toISOString() : null, nextDueAt: next ? next.toISOString() : null };
}
