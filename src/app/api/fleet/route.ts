import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { fleet } from "@/lib/store";
import { demoFleet } from "@/lib/demo-data";
import type { FleetResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /api/fleet — everything the dashboard needs in one call. */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
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
    return publicError("[fleet]", e);
  }
}
