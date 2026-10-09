import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { REPOS } from "@/lib/progress-config";
import { MAX_REPOS, validateRepoList } from "@/lib/repo-validation";
import { getWatchedRepos, listVersion, replaceWatchedRepos } from "@/lib/watched-repos";

export const dynamic = "force-dynamic";

/**
 * The repos the progress board watches.
 *
 * GET  /api/settings/repos
 *      -> { source: "database" | "file", writable, max, version, repos: [...] }
 * PUT  /api/settings/repos  { repos: [...], version?: string }
 *      Replaces the whole list, in order. 400 { errors: [{ index, field, message }] }
 *      when invalid, 409 when no database is connected. If `version` (from the GET
 *      the caller started from) is sent and the list has changed since, answers
 *      409 { code: "stale" } instead of overwriting someone else's change.
 *
 * Auth is enforced by middleware: dashboard session cookie or MC_TOKEN bearer.
 * The collector calls GET each tick to learn which repos to sweep.
 */
async function current() {
  const { source, repos } = await getWatchedRepos(REPOS);
  return { source, writable: isConfigured(), max: MAX_REPOS, version: listVersion(repos), repos };
}

// Log the real error server-side; the response stays generic so database details never reach the browser.
function failure(e: unknown, what: string) {
  console.error(`[settings/repos] ${what}`, e);
  return NextResponse.json({ error: `Could not ${what}.` }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "load settings");
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { errors: [{ index: -1, field: "repos", message: "Request body must be JSON." }] },
      { status: 400 },
    );
  }
  const checked = validateRepoList((body as { repos?: unknown } | null)?.repos);
  if (!checked.ok) return NextResponse.json({ errors: checked.errors }, { status: 400 });
  if (!isConfigured()) {
    return NextResponse.json({ error: "Settings can only be saved when a database is connected." }, { status: 409 });
  }
  try {
    const sent = (body as { version?: unknown } | null)?.version;
    if (typeof sent === "string" && sent !== (await current()).version) {
      return NextResponse.json(
        { code: "stale", error: "The list changed since you loaded it. Reload to see the latest, then make your change again." },
        { status: 409 },
      );
    }
    await replaceWatchedRepos(checked.repos);
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "save settings");
  }
}
