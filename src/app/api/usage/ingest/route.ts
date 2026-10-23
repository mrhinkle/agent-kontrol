import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
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
    return apiError("unauthorized");
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
    return apiError("invalid_json");
  }
  if (!Array.isArray(body.facts)) {
    return apiError("missing_field", { message: "facts[] is required", fields: { facts: "facts[] is required" } });
  }
  if (body.collected_at && Number.isNaN(Date.parse(body.collected_at))) {
    return apiError("validation_failed", {
      message: "collected_at must be ISO 8601",
      fields: { collected_at: "collected_at must be ISO 8601" },
    });
  }

  try {
    const written = await ingestUsageFacts(body);
    if (body.snapshot?.account_id) {
      await ingestAccountSnapshot(body.snapshot);
    }
    return NextResponse.json({ ok: true, written });
  } catch (e) {
    if (isUndefinedTableError(e)) {
      return apiError("setup_required", {
        message: USAGE_SETUP_MESSAGE,
        fix: "Run supabase/schema.sql, then install the collector and retry.",
        extra: { setup_required: true, message: USAGE_SETUP_MESSAGE },
      });
    }
    return publicError("[usage] ingest failed", e);
  }
}
