import { NextResponse } from "next/server";
import { actorFromPrincipal } from "@/lib/actor";
import { deny, resolveApiAccess } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { readIdempotencyHeader } from "@/lib/idempotency";
import { createTask, listTasks } from "@/lib/store";
import { demoTasks } from "@/lib/demo-data";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Task queue.
 * Auth: dashboard session, legacy MC_TOKEN, or an agent credential with the
 * route's scope (tasks:read on GET, tasks:write on POST).
 *
 * GET  /api/tasks?status=open|all|<status>&limit=N
 * POST /api/tasks { title, description?, project?, platform?, machine?,
 *                   priority?, reviewer_platform?, created_by? }
 * Optional header Idempotency-Key. Same key, actor, and route return the
 * original task for 24 hours. After that window the key starts a new write.
 * Same key and a different body is a conflict.
 */
export async function GET(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) {
    return NextResponse.json({ demo: true, tasks: demoTasks() });
  }
  const url = new URL(req.url);
  try {
    const tasks = await listTasks({
      status: url.searchParams.get("status") ?? "all",
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    });
    return NextResponse.json({ demo: false, tasks });
  } catch (e) {
    return publicError("[tasks] list failed", e);
  }
}

export async function POST(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  if (!isConfigured()) {
    return NextResponse.json({ ok: true, demo: true, note: "DATABASE_URL not set; task dropped" });
  }
  let body: {
    title?: string;
    description?: string;
    project?: string;
    platform?: string;
    machine?: string;
    priority?: number;
    reviewer_platform?: string;
    created_by?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  if (!body.title) {
    return apiError("missing_field", { message: "title is required", fields: { title: "title is required" } });
  }
  try {
    const task = await createTask({
      title: body.title,
      description: body.description,
      project: body.project,
      platform: body.platform,
      machine: body.machine,
      priority: body.priority,
      reviewer_platform: body.reviewer_platform,
      created_by: body.created_by,
      actor: actorFromPrincipal(access.principal),
      idempotency_key: readIdempotencyHeader(req),
    });
    return NextResponse.json({ ok: true, task });
  } catch (e) {
    return publicError("[tasks] create failed", e);
  }
}
