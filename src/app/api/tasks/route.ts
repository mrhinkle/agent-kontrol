import { NextResponse } from "next/server";
import { actorFromPrincipal } from "@/lib/actor";
import { deny, resolveApiAccess } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { readIdempotencyHeader } from "@/lib/idempotency";
import { demoTasks } from "@/lib/demo-data";
import { ListParamError, TASK_REST, listBody, listParamError, parseSearchList } from "@/lib/list-params";
import { loadTaskPage } from "@/lib/list-read";
import { createTask } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Task queue.
 * Auth: dashboard session, legacy MC_TOKEN, or an agent credential with the
 * route's scope (tasks:read on GET, tasks:write on POST).
 *
 * GET  /api/tasks?status=open|all|<status>&limit=N&cursor=&fields=
 * POST /api/tasks { title, description?, project?, platform?, machine?,
 *                   priority?, reviewer_platform?, created_by? }
 * Optional header Idempotency-Key. Same key, actor, and route return the
 * original task for 24 hours. After that window the key starts a new write.
 * Same key and a different body is a conflict.
 */
export async function GET(req: Request) {
  const access = await resolveApiAccess(req);
  if (!access.ok) return deny(access);
  const url = new URL(req.url);
  let parsed;
  try {
    parsed = parseSearchList(TASK_REST, url.searchParams);
  } catch (e) {
    if (e instanceof ListParamError) return listParamError(e);
    throw e;
  }
  // No limit, cursor, or fields: the sample is the sample, filters included.
  if (!isConfigured() && !parsed.active) {
    return NextResponse.json({ demo: true, tasks: demoTasks() });
  }
  try {
    const page = await loadTaskPage(isConfigured() ? "database" : "demo-sample", {
      status: url.searchParams.get("status") ?? "all",
      parsed,
    });
    return NextResponse.json(listBody("tasks", page.rows, page.paging, page.next_cursor, !isConfigured()));
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
