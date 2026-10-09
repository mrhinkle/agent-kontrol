import { NextResponse } from "next/server";
import { isConfigured } from "@/lib/db";
import { REPOS } from "@/lib/progress-config";
import { MAX_REPOS, validateRepoList } from "@/lib/repo-validation";
import { getWatchedRepos, replaceWatchedRepos } from "@/lib/watched-repos";

export const dynamic = "force-dynamic";

/**
 * The repos the progress board watches.
 *
 * GET  /api/settings/repos
 *      -> { source: "database" | "file", writable, max, repos: [...] }
 * PUT  /api/settings/repos  { repos: [...] }
 *      Replaces the whole list, in order. 400 { errors: [{ index, field, message }] }
 *      when invalid, 409 when no database is connected.
 *
 * Auth is enforced by middleware: dashboard session cookie or MC_TOKEN bearer.
 * The collector calls GET each tick to learn which repos to sweep.
 */
async function current() {
  const { source, repos } = await getWatchedRepos(REPOS);
  return { source, writable: isConfigured(), max: MAX_REPOS, repos };
}

export async function GET() {
  try {
    return NextResponse.json(await current());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
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
    await replaceWatchedRepos(checked.repos);
    return NextResponse.json(await current());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
