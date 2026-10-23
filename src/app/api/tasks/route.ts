import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
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
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
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
  const denied = await enforceApi(req);
  if (denied) return denied;
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
    const task = await createTask({ ...body, title: body.title });
    return NextResponse.json({ ok: true, task });
  } catch (e) {
    return publicError("[tasks] create failed", e);
  }
}
