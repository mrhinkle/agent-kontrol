import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { runMetrics } from "@/lib/run-store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Dashboard session or MC_TOKEN; an agent credential cannot read it (same as /api/usage). */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await runMetrics());
  } catch {
    return NextResponse.json({ error: "Run metrics unavailable" }, { status: 503 });
  }
}
