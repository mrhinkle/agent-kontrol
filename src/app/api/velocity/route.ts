import { requireTrustedWriter } from "@/lib/auth";
import { isConfigured } from "@/lib/db";
import { readVelocity } from "@/lib/velocity-store";
import { privateResponse, velocityJSON } from "@/lib/velocity-http";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  // This private benchmark store deliberately has no agent/OAuth read scope.
  const access = await requireTrustedWriter(req, { allowSession: true });
  if (!access.ok) return privateResponse(access.response);
  const key = new URL(req.url).searchParams.get("series") ?? undefined;
  if (key !== undefined && !/^[0-9a-f]{64}$/.test(key)) return velocityJSON({ error: "Invalid benchmark series." }, 400);
  if (!isConfigured()) return velocityJSON({ error: "Benchmark history storage is not configured." }, 503);
  try { return velocityJSON(await readVelocity(key)); }
  catch { return velocityJSON({ error: "Benchmark history is unavailable. The approved history storage must be installed before captures can be saved." }, 503); }
}
