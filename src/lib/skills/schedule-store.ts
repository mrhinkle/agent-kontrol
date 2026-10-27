import { sql } from "../db";

/**
 * SQL for the skill scheduler. It reads the tasks table. There is no
 * scheduler table: the slot id inside a task's description is the record.
 * Rows are matched on actor_id, which comes from the authenticated
 * principal, so an agent that creates a task with the same title or the same
 * created_by label cannot block or fake a scheduled slot.
 */

export const SCHEDULER_ACTOR_ID = "skill-scheduler";
export const SCHEDULED_TITLE_PREFIX = "Run scheduled skill ";
const OPEN_STATUSES = ["queued", "claimed", "running", "review"];

export interface ScheduledTaskRow {
  id: number;
  skill_id: string;
  status: string;
  description: string;
  created_at: string;
}

function mapRow(row: Record<string, unknown>): ScheduledTaskRow | null {
  const title = String(row.title ?? "");
  if (!title.startsWith(SCHEDULED_TITLE_PREFIX)) return null;
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? "");
  return {
    id: Number(row.id),
    skill_id: title.slice(SCHEDULED_TITLE_PREFIX.length),
    status: String(row.status ?? ""),
    description: String(row.description ?? ""),
    created_at: created,
  };
}

/** Scheduler tasks that have not finished. Any of them blocks the next tick for its skill. */
export async function listOpenScheduledTasks(): Promise<ScheduledTaskRow[]> {
  const rows = await sql()`
    select id, title, status, description, created_at
    from tasks
    where actor_id = ${SCHEDULER_ACTOR_ID}
      and title like ${`${SCHEDULED_TITLE_PREFIX}%`}
      and status = any(${OPEN_STATUSES}::text[])
  `;
  return (rows as Record<string, unknown>[]).map(mapRow).filter((r): r is ScheduledTaskRow => r !== null);
}

/** The newest scheduler task per skill, in any status. */
export async function listLastScheduledTasks(): Promise<ScheduledTaskRow[]> {
  const rows = await sql()`
    select distinct on (title) id, title, status, description, created_at
    from tasks
    where actor_id = ${SCHEDULER_ACTOR_ID}
      and title like ${`${SCHEDULED_TITLE_PREFIX}%`}
    order by title, created_at desc, id desc
  `;
  return (rows as Record<string, unknown>[]).map(mapRow).filter((r): r is ScheduledTaskRow => r !== null);
}
