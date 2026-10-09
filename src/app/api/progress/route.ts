import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { isWindow, type TimeWindow } from "@/lib/progress-config";
import { progress } from "@/lib/progress-store";
import { demoProgress } from "@/lib/demo-progress";
import type { ProgressResponse } from "@/lib/progress-types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/progress?window=24h|7d|30d|90d
 * Everything the progress board needs in one call, read entirely from
 * Postgres — never from GitHub. The collector owns the API budget.
 */
export async function GET(req: Request) {
  const param = new URL(req.url).searchParams.get("window");
  const window: TimeWindow = isWindow(param) ? param : "24h";

  if (!isConfigured()) {
    return NextResponse.json(demoProgress(window));
  }

  try {
    const data = await progress(window);
    const res: ProgressResponse = {
      demo: false,
      ...data,
      generated_at: new Date().toISOString(),
    };
    return NextResponse.json(res, {
      // The collector ticks every 15 minutes; a minute of staleness is free.
      headers: { "Cache-Control": "private, max-age=0, s-maxage=60" },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
