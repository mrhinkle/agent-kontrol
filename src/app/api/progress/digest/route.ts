import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { isWindow, type TimeWindow } from "@/lib/progress-config";
import { progress } from "@/lib/progress-store";
import { demoProgress } from "@/lib/demo-progress";
import { formatDigest } from "@/lib/progress-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/progress/digest?window=24h — the board as plain text.
 *
 * For Hermes's scheduler, a cron job, or a terminal. Auth is the dashboard's
 * own gate (session cookie or MC_TOKEN bearer), handled in middleware.
 */
export async function GET(req: Request) {
  const param = new URL(req.url).searchParams.get("window");
  const window: TimeWindow = isWindow(param) ? param : "24h";

  try {
    const data = isConfigured()
      ? { demo: false as const, ...(await progress(window)), generated_at: new Date().toISOString() }
      : demoProgress(window);
    return new NextResponse(formatDigest(data), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, max-age=0, s-maxage=60" },
    });
  } catch (e) {
    return new NextResponse(`error: ${(e as Error).message}`, { status: 500 });
  }
}
