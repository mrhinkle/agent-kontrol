import { NextResponse } from "next/server";
import { enforceBearer } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { isUndefinedTableError, USAGE_SETUP_MESSAGE } from "@/lib/usage-errors";
import { ingestUsageBatch } from "@/lib/usage-store";
import type { AccountSnapshot } from "@/lib/providers/types";
import type { UsageIngestInput } from "@/lib/usage-types";

export const maxDuration = 60;

/**
 * POST /api/usage/ingest
 * Bearer MC_TOKEN. Body: { collected_at?, kind?, facts: UsageFact[], snapshot? }
 * Dedicated endpoint — do not overload /api/ingest (liveness only).
 */
export async function POST(req: Request) {
  const denied = await enforceBearer(req);
  if (denied) return denied;
  if (!isConfigured()) {
    return NextResponse.json({
      ok: true,
      demo: true,
      note: "DATABASE_URL not set; usage facts dropped",
    });
  }

  let body: UsageIngestInput & { snapshot?: AccountSnapshot };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json");
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.facts)) {
    return apiError("missing_field", { message: "facts[] is required", fields: { facts: "facts[] is required" } });
  }
  if (body.collected_at && Number.isNaN(Date.parse(body.collected_at))) {
    return apiError("validation_failed", {
      message: "collected_at must be ISO 8601",
      fields: { collected_at: "collected_at must be ISO 8601" },
    });
  }

  if (body.snapshot !== undefined) {
    const snapshot = body.snapshot;
    const objectOrNull = (value: unknown) => value == null || (typeof value === "object" && !Array.isArray(value));
    const validAmount = (value: unknown) => value == null || (typeof value === "number" && Number.isFinite(value));
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        typeof snapshot.account_id !== "string" || !snapshot.account_id.trim() ||
        (snapshot.collected_at !== undefined && (typeof snapshot.collected_at !== "string" || !Number.isFinite(Date.parse(snapshot.collected_at)))) ||
        !validAmount(snapshot.balance_usd) || !validAmount(snapshot.credits_remaining) ||
        !objectOrNull(snapshot.detail) || !objectOrNull(snapshot.quota_detail)) {
      return apiError("validation_failed", {
        message: "snapshot requires an account_id, a valid optional collected_at, numeric balances and object metadata",
        fields: { snapshot: "invalid snapshot" },
      });
    }
  }

  try {
    const written = await ingestUsageBatch(body);
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
