import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
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
    return apiError("invalid_json");
  }
  if (!body.platform || !body.agent_id) {
    const fields: Record<string, string> = {};
    if (!body.platform) fields.platform = "platform is required";
    if (!body.agent_id) fields.agent_id = "agent_id is required";
    return apiError("missing_field", { message: "platform and agent_id are required", fields });
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
    return publicError("[tasks] claim failed", e);
  }
}
