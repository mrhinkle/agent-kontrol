import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { recall } from "@/lib/store";
import { demoMemory } from "@/lib/demo-data";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /api/memory?query=&tag=&limit= — memory browser feed for the dashboard. */
export async function GET(req: Request) {
  if (!isConfigured()) {
    return NextResponse.json({ demo: true, items: demoMemory() });
  }
  const url = new URL(req.url);
  try {
    const items = await recall({
      query: url.searchParams.get("query") ?? undefined,
      tags: url.searchParams.get("tag") ? [url.searchParams.get("tag")!] : undefined,
      limit: Number(url.searchParams.get("limit") ?? 50),
    });
    return NextResponse.json({ demo: false, items });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
