import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { claimNextTask, report } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/tasks/claim { platform, machine?, agent_id }
 * A dispatcher (or any agent) asks for its next queued task. Atomic: the
 * same task is never handed to two callers. Returns { task: null } when the
 * queue is empty for that platform.
 */
export async function POST(req: Request) {
  if (!isConfigured()) {
    return NextResponse.json({ task: null, demo: true });
  }
  let body: { platform?: string; machine?: string; agent_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.platform || !body.agent_id) {
    return NextResponse.json({ error: "platform and agent_id are required" }, { status: 400 });
  }
  try {
    const task = await claimNextTask({
      platform: body.platform,
      machine: body.machine,
      agent_id: body.agent_id,
    });
    if (task) {
      await report({
        agent_id: body.agent_id,
        platform: body.platform,
        machine: body.machine,
        kind: "status",
        title: `Claimed task #${task.id}: ${task.title}`,
        detail: { task_id: task.id },
      });
    }
    return NextResponse.json({ task });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
