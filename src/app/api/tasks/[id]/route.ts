import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { updateTask, report } from "@/lib/store";
import type { TaskStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PATCH /api/tasks/:id { status?, result?, cost_usd?, session_id?, assigned_agent?, agent_id? }
 * Dispatchers report run progress and completion; the dashboard cancels or
 * requeues. `agent_id` (optional) attributes the change in the event feed.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true });
  }
  const { id } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isFinite(taskId)) {
    return NextResponse.json({ error: "invalid task id" }, { status: 400 });
  }
  let body: {
    status?: TaskStatus;
    result?: string;
    cost_usd?: number;
    session_id?: string;
    assigned_agent?: string;
    agent_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const task = await updateTask({ id: taskId, ...body });
    if (body.status && body.agent_id) {
      await report({
        agent_id: body.agent_id,
        kind: body.status === "failed" ? "error" : "status",
        title: `Task #${task.id} → ${body.status}: ${task.title}`,
        detail: { task_id: task.id, cost_usd: body.cost_usd },
      });
    }
    return NextResponse.json({ ok: true, task });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
