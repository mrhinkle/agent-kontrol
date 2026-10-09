import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { fleet } from "@/lib/store";
import { demoFleet } from "@/lib/demo-data";
import type { FleetResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /api/fleet — everything the dashboard needs in one call. */
export async function GET() {
  if (!isConfigured()) {
    return NextResponse.json(demoFleet());
  }
  try {
    const { agents, events } = await fleet();
    const res: FleetResponse = {
      demo: false,
      agents,
      events,
      generated_at: new Date().toISOString(),
    };
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
