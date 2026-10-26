import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { readDryRun, refusedDryRun } from "@/lib/dry-run";
import { previewTaskChange } from "@/lib/dry-run-actions";
import { updateTask, report } from "@/lib/store";
import type { TaskStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PATCH /api/tasks/:id { status?, result?, cost_usd?, session_id?, assigned_agent?, agent_id?, dry_run? }
 * Dispatchers report run progress and completion; the dashboard cancels or
 * requeues. `agent_id` (optional) attributes the change in the event feed.
 * `dry_run: true` returns the affected row and the field diff and writes nothing.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  if (!isConfigured()) {
    let peeked: { dry_run?: unknown; status?: TaskStatus } = {};
    try {
      peeked = await req.json();
    } catch {
      return NextResponse.json({ ok: true, demo: true });
    }
    const dry = readDryRun(peeked.dry_run);
    if (!dry.ok) {
      return apiError("validation_failed", {
        message: "dry_run must be a boolean.",
        fields: { dry_run: "Use true to preview, or false to apply." },
      });
    }
    if (dry.dryRun) {
      return NextResponse.json(
        refusedDryRun(
          peeked.status === "cancelled" ? "cancel_task" : "update_task",
          "DATABASE_URL not set; nothing would be written.",
        ),
      );
    }
    return NextResponse.json({ ok: true, demo: true });
  }
  const { id } = await ctx.params;
  const taskId = Number(id);
  if (!Number.isFinite(taskId)) {
    return apiError("validation_failed", { message: "invalid task id", fields: { id: "invalid task id" } });
  }
  let body: {
    status?: TaskStatus;
    result?: string;
    cost_usd?: number;
    session_id?: string;
    assigned_agent?: string;
    agent_id?: string;
    dry_run?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  const dry = readDryRun(body.dry_run);
  if (!dry.ok) {
    return apiError("validation_failed", {
      message: "dry_run must be a boolean.",
      fields: { dry_run: "Use true to preview, or false to apply." },
    });
  }
  try {
    if (dry.dryRun) {
      const preview = await previewTaskChange(taskId, body);
      if (!preview) return apiError("task_not_found");
      return NextResponse.json(preview);
    }
    const { dry_run: _ignored, ...patch } = body;
    const task = await updateTask({ id: taskId, ...patch });
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
    return publicError("[tasks] update failed", e);
  }
}
