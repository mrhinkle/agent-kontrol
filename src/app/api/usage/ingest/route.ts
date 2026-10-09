import { NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { isUndefinedTableError, USAGE_SETUP_MESSAGE } from "@/lib/usage-errors";
import { ingestAccountSnapshot, ingestUsageFacts } from "@/lib/usage-store";
import type { UsageIngestInput } from "@/lib/usage-types";

export const maxDuration = 60;

/**
 * POST /api/usage/ingest
 * Bearer MC_TOKEN. Body: { collected_at?, kind?, facts: UsageFact[], snapshot? }
 * Dedicated endpoint — do not overload /api/ingest (liveness only).
 */
export async function POST(req: Request) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isConfigured()) {
    return NextResponse.json({
      ok: true,
      demo: true,
      note: "DATABASE_URL not set; usage facts dropped",
    });
  }

  let body: UsageIngestInput & {
    snapshot?: {
      account_id: string;
      collected_at?: string;
      balance_usd?: number | null;
      credits_remaining?: number | null;
      quota_detail?: unknown;
      detail?: unknown;
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.facts)) {
    return NextResponse.json({ error: "facts[] is required" }, { status: 400 });
  }
  if (body.collected_at && Number.isNaN(Date.parse(body.collected_at))) {
    return NextResponse.json({ error: "collected_at must be ISO 8601" }, { status: 400 });
  }

  try {
    const written = await ingestUsageFacts(body);
    if (body.snapshot?.account_id) {
      await ingestAccountSnapshot(body.snapshot);
    }
    return NextResponse.json({ ok: true, written });
  } catch (e) {
    if (isUndefinedTableError(e)) {
      return NextResponse.json(
        {
          error: USAGE_SETUP_MESSAGE,
          setup_required: true,
          message: USAGE_SETUP_MESSAGE,
        },
        { status: 503 },
      );
    }
    const msg = (e as Error).message || "ingest failed";
    const status = msg.startsWith("privacy:") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
