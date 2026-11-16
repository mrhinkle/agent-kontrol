import { requireTrustedWriter } from "@/lib/auth";
import { describeDbError } from "@/lib/db-error";
import { isConfigured } from "@/lib/db";
import { readVelocity } from "@/lib/velocity-store";
import { privateResponse, velocityError, velocityJSON } from "@/lib/velocity-http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  // This private benchmark store deliberately has no agent/OAuth read scope.
  const access = await requireTrustedWriter(req, { allowSession: true });
  if (!access.ok) return privateResponse(access.response);
  const key = new URL(req.url).searchParams.get("series") ?? undefined;
  if (key !== undefined && !/^[0-9a-f]{64}$/.test(key)) {
    return velocityError("validation_failed", "Invalid benchmark series.", {
      fix: "Pass series as 64 lowercase hex characters, or omit it.",
    });
  }
  if (!isConfigured()) {
    return velocityError("setup_required", "Benchmark history storage is not configured.", {
      fix: "Set DATABASE_URL and install the velocity history storage, then retry.",
    });
  }
  try { return velocityJSON(await readVelocity(key)); }
  catch (e) {
    console.error("[velocity] read failed", describeDbError(e));
    return velocityError("setup_required", "Benchmark history is unavailable. The approved history storage must be installed before captures can be saved.", {
      retryable: true,
      fix: "Install the approved history storage, then retry this read.",
    });
  }
}
