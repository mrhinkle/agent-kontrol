import { NextResponse } from "next/server";
import { runMetrics } from "@/lib/run-store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Protected by the same dashboard/bearer middleware as /api/fleet. */
export async function GET() {
  try {
    return NextResponse.json(await runMetrics());
  } catch {
    return NextResponse.json({ error: "Run metrics unavailable" }, { status: 503 });
  }
}
