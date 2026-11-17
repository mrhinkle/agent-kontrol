import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { enforceApi } from "@/lib/auth";
import { runMetrics } from "@/lib/run-store";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Dashboard session or MC_TOKEN. This path stays off the agent scope table,
 * so an agent credential cannot read it.
 */
export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await runMetrics());
  } catch {
    return apiError("internal_error", {
      message: "Run metrics unavailable",
      status: 503,
      retryable: true,
      fix: "Retry the request. If it keeps failing, check the server logs.",
      extra: { cause: "The run store did not answer." },
    });
  }
}
