import { NextResponse } from "next/server";
import { runWithPrincipal } from "@/lib/actor";
import { deny, resolveApiAccess } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { resolveAgentCredential } from "@/lib/credentials";
import { isConfigured } from "@/lib/db";
import { claimNextTask, claimTaskWithCoverage, report } from "@/lib/store";
import { isTaskLane } from "@/lib/task-lane";
import { readTaskNoticeObserverHeaders, unknownCoverage, type TaskNoticeObserverProof } from "@/lib/task-queue-notice";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/tasks/claim { platform, machine?, agent_id, project? }
 * A dispatcher (or any agent) asks for its next queued task. Atomic: the
 * same task is never handed to two callers. Returns { task: null } when the
 * queue is empty for that platform. `project`, when sent, is an exact
 * case-sensitive lane. A null, blank, malformed, or overlong project is
 * rejected and writes nothing. Omitting it keeps the unfiltered claim.
 */
export async function POST(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) {
    let peeked: unknown = null;
    try {
      peeked = await req.json();
    } catch {
      peeked = null;
    }
    const project = exactProject(peeked);
    if (!project.ok) return project.response;
    const coverage = isRecord(peeked) && peeked.coverage === true;
    if (!coverage) return NextResponse.json({ task: null, demo: true });
    return NextResponse.json({
      task: null,
      demo: true,
      coverage: unknownCoverage("unconfigured", new Date().toISOString()),
    });
  }
  let body: { platform?: string; machine?: string; agent_id?: string; coverage?: unknown; project?: unknown };
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
  const project = exactProject(body);
  if (!project.ok) return project.response;
  const platform = body.platform;
  const agentId = body.agent_id;
  const coverageRequested = body.coverage === true;
  try {
    const taskInput = {
      platform,
      machine: body.machine,
      agent_id: agentId,
      ...(project.project !== undefined ? { project: project.project } : {}),
    };
    // The events credential is resolved outside the task principal. The claim
    // itself runs once, inside that principal, so the receipt records the caller.
    const observer = coverageRequested ? await observerProof(req) : null;
    const outcome = await runWithPrincipal(access.principal, async () => {
      if (coverageRequested) {
        const claimed = await claimTaskWithCoverage({ ...taskInput, observer });
        if (claimed.task) await reportClaim(agentId, platform, body.machine, claimed.task);
        return { task: claimed.task, coverage: claimed.coverage };
      }
      const task = await claimNextTask(taskInput);
      if (task) await reportClaim(agentId, platform, body.machine, task);
      return { task, coverage: undefined };
    });
    if (outcome.coverage === undefined) return NextResponse.json({ task: outcome.task });
    return NextResponse.json({ task: outcome.task, coverage: outcome.coverage });
  } catch (e) {
    return publicError("[tasks] claim failed", e);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROJECT_FIELD = "must be 1-100 characters of letters, digits, and . _ : / -, starting with a letter or digit, and must not end with a newline.";

/** Omitted project stays unfiltered. A present value that is not a lane is a 400 and writes nothing. */
function exactProject(body: unknown): { ok: true; project?: string } | { ok: false; response: NextResponse } {
  if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, "project")) return { ok: true };
  if (!isTaskLane(body.project)) {
    return {
      ok: false,
      response: apiError("validation_failed", {
        message: "project must be an exact task lane",
        fields: { project: PROJECT_FIELD },
      }),
    };
  }
  return { ok: true, project: body.project };
}

function reportClaim(agentId: string, platform: string, machine: string | undefined, task: Task): Promise<unknown> {
  return report({
    agent_id: agentId,
    platform,
    machine,
    kind: "status",
    title: `Claimed task #${task.id}: ${task.title}`,
    detail: { task_id: task.id },
  });
}

/** Events proof only. The task Authorization header is never read here. */
async function observerProof(req: Request): Promise<TaskNoticeObserverProof | null> {
  const headers = readTaskNoticeObserverHeaders(req.headers);
  if (!headers) return null;
  const resolved = await resolveAgentCredential(headers.token);
  if (resolved.status !== "ok" || !resolved.credential.scopes.includes("events:read")) return null;
  return {
    consumer: headers.consumer,
    credentialId: resolved.credential.id,
    generation: headers.generation,
  };
}
