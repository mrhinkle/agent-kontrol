/**
 * Who may put a task back on the queue.
 * Pure. The demo store and the Postgres tool both call this so the rule
 * cannot drift. Stuck is not a status: only done, failed, and cancelled
 * can be requeued. A running, claimed, or review row that another agent
 * holds is a distinct refusal.
 */
import type { TaskStatus } from "./types";

const TERMINAL = new Set<TaskStatus>(["done", "failed", "cancelled"]);
const IN_FLIGHT = new Set<TaskStatus>(["claimed", "running", "review"]);

/** Same rule as store.slugify. Duplicated so this module stays free of the database. */
export function slugifyAgent(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

function sameAgent(left: string, right: string): boolean {
  if (left === right) return true;
  const a = slugifyAgent(left);
  const b = slugifyAgent(right);
  return a.length > 0 && a === b;
}

/**
 * The caller the requeue refusal compares against the task's assigned_agent.
 * An explicit agent_id wins. Otherwise the authenticated actor id. Neither
 * is a credential id unless the caller passed that string.
 */
export function requeueCallerId(
  args: { agent_id?: string | null },
  actorId: string | null | undefined,
): string | null {
  if (typeof args.agent_id === "string" && args.agent_id.length > 0) return args.agent_id;
  if (actorId) return actorId;
  return null;
}

export type RequeueBlock =
  | { ok: true }
  | { ok: false; code: "forbidden" | "conflict"; message: string };

export function requeueBlock(
  task: { status: TaskStatus; assigned_agent: string | null },
  callerId: string | null,
): RequeueBlock {
  if (TERMINAL.has(task.status)) return { ok: true };
  if (
    IN_FLIGHT.has(task.status) &&
    task.assigned_agent != null &&
    task.assigned_agent.length > 0 &&
    (callerId == null || !sameAgent(task.assigned_agent, callerId))
  ) {
    return { ok: false, code: "forbidden", message: "Task is running under another agent." };
  }
  return {
    ok: false,
    code: "conflict",
    message: `Task cannot be requeued from status ${task.status}.`,
  };
}
