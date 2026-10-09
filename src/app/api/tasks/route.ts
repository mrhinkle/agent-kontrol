import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { createTask, listTasks } from "@/lib/store";
import { demoTasks } from "@/lib/demo-data";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Task queue.
 * Auth is enforced by middleware: dashboard cookie or MC_TOKEN bearer.
 *
 * GET  /api/tasks?status=open|all|<status>&limit=N
 * POST /api/tasks { title, description?, project?, platform?, machine?,
 *                   priority?, reviewer_platform?, created_by? }
 */
export async function GET(req: Request) {
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
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
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
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  try {
    const task = await createTask({ ...body, title: body.title });
    return NextResponse.json({ ok: true, task });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
