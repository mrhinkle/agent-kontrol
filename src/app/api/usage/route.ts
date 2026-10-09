import { NextResponse } from "next/server";
import { isUndefinedTableError, USAGE_SETUP_MESSAGE } from "@/lib/usage-errors";
import { resolveUsageWindow } from "@/lib/usage-window";
import { getUsageSummary } from "@/lib/usage-store";
import type { UsageSummary } from "@/lib/usage-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage?window=24h|7d|30d
 * GET /api/usage?since=ISO&until=ISO
 * Defaults: rolling 7d ending now (computed at request time).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const resolved = resolveUsageWindow({
    window: url.searchParams.get("window"),
    since: url.searchParams.get("since"),
    until: url.searchParams.get("until"),
  });
  if (Number.isNaN(Date.parse(resolved.since)) || Number.isNaN(Date.parse(resolved.until))) {
    return NextResponse.json({ error: "since/until must be ISO 8601" }, { status: 400 });
  }
  try {
    const summary = await getUsageSummary({
      since: resolved.since,
      until: resolved.until,
    });
    summary.window_label = resolved.window;
    return NextResponse.json(summary);
  } catch (e) {
    if (isUndefinedTableError(e)) {
      const body: UsageSummary & { setup_required: true; message: string } = {
        setup_required: true,
        setup_message: USAGE_SETUP_MESSAGE,
        message: USAGE_SETUP_MESSAGE,
        window: { since: resolved.since, until: resolved.until },
        window_label: resolved.window,
        demo: false,
        fleet: {
          paid_cost_usd: 0,
          shadow_cost_usd: 0,
          subscription_fees_usd: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          api_call_count: 0,
          rows: 0,
          cache_hit_rate: 0,
        },
        by_profile: [],
        by_cron: [],
        by_model: [],
        by_account: [],
        top_sessions: [],
        collected_at: null,
      };
      return NextResponse.json(body);
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
