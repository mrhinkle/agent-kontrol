import type { TasksPayload } from "./gibson-derive";

// The task API accepts at most 200 rows per request. Keep the Gibson's existing
// 400-task budget by following a cursor, rather than sending an invalid limit.
export const GIBSON_TASK_PAGE_SIZE = 200;
export const GIBSON_TASK_LIMIT = 400;

export async function fetchGibsonTasks(fetcher: typeof fetch = fetch): Promise<TasksPayload> {
  const tasks: TasksPayload["tasks"] = [];
  let cursor: string | null = null;
  let demo = false;
  for (let page = 0; page < GIBSON_TASK_LIMIT / GIBSON_TASK_PAGE_SIZE; page++) {
    const params = new URLSearchParams({ status: "all", limit: String(GIBSON_TASK_PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const response = await fetcher(`/api/tasks?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`tasks API ${response.status}`);
    const data = await response.json() as TasksPayload & { next_cursor?: string | null };
    tasks.push(...data.tasks);
    demo ||= data.demo ?? false;
    cursor = data.next_cursor ?? null;
    if (!cursor) break;
  }
  return { tasks: tasks.slice(0, GIBSON_TASK_LIMIT), demo };
}
