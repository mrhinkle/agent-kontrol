import type { AgentStatus, FleetAgent, Task } from "./types";

/**
 * The attention strip in the site header: what needs the operator right now,
 * on every page. Same facts the Gibson banner reads (src/lib/gibson-derive.ts),
 * reduced to pills with a destination each.
 */

export type AttentionTone = "red" | "amber" | "cyan";

export interface AttentionItem {
  key: "failed-agents" | "failed-tasks" | "waiting" | "needs-you" | "review";
  count: number;
  label: string;
  tone: AttentionTone;
  href: string;
  title: string;
}

export interface AttentionInput {
  agents: Pick<FleetAgent, "derived_status">[];
  tasks: Pick<Task, "status" | "updated_at">[];
  /** Count of Progress-board alerts, or null when the progress feed is unavailable. */
  progressAlerts: number | null;
  now?: number;
}

/** A failed task stops nagging after this long; History keeps the record. */
export const FAILED_TASK_WINDOW_MS = 24 * 60 * 60 * 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function deriveAttention({ agents, tasks, progressAlerts, now = Date.now() }: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const failedAgents = agents.filter((a) => a.derived_status === "failed").length;
  const waiting = agents.filter((a) => a.derived_status === "waiting").length;
  const failedTasks = tasks.filter((t) => t.status === "failed" && now - Date.parse(t.updated_at) < FAILED_TASK_WINDOW_MS).length;
  const review = tasks.filter((t) => t.status === "review").length;

  if (failedAgents > 0) {
    items.push({ key: "failed-agents", count: failedAgents, label: plural(failedAgents, "agent failed", "agents failed"), tone: "red", href: "/", title: "Open the Fleet" });
  }
  if (failedTasks > 0) {
    items.push({ key: "failed-tasks", count: failedTasks, label: plural(failedTasks, "task failed", "tasks failed"), tone: "red", href: "/tasks", title: "Open the task queue" });
  }
  if (waiting > 0) {
    items.push({ key: "waiting", count: waiting, label: plural(waiting, "needs you", "need you"), tone: "amber", href: "/", title: "An agent is waiting on an answer or an approval" });
  }
  if (progressAlerts !== null && progressAlerts > 0) {
    items.push({ key: "needs-you", count: progressAlerts, label: `${progressAlerts} on Progress`, tone: "amber", href: "/progress", title: "The Progress board has alerts" });
  }
  if (review > 0) {
    items.push({ key: "review", count: review, label: `${review} in review`, tone: "cyan", href: "/tasks", title: "Tasks waiting on a review" });
  }
  return items;
}

/** Lower is more urgent. */
export const URGENCY: Record<AgentStatus, number> = { failed: 0, waiting: 1, active: 2, done: 3, offline: 4 };

/**
 * Urgent first: failed, needs you, active, done, offline. Stable within a tier,
 * so the server's order (most recently seen first) still holds and cards only
 * move when an agent's status changes, never on an ordinary poll.
 */
export function sortAgentsByUrgency<T extends { derived_status: AgentStatus }>(agents: T[]): T[] {
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (URGENCY[x.a.derived_status] ?? 9) - (URGENCY[y.a.derived_status] ?? 9) || x.i - y.i)
    .map(({ a }) => a);
}
