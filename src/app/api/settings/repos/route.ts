import { NextResponse } from "next/server";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { REPOS } from "@/lib/progress-config";
import { MAX_REPOS, validateRepoList, type RepoError } from "@/lib/repo-validation";
import { getWatchedRepos, listVersion, replaceWatchedRepos } from "@/lib/watched-repos";

export const dynamic = "force-dynamic";

/**
 * The repos the progress board watches.
 *
 * GET  /api/settings/repos
 *      -> { source: "database" | "file", writable, max, version, repos: [...] }
 * PUT  /api/settings/repos  { repos: [...], version?: string }
 *      Replaces the whole list, in order. 400 keeps `errors: [{ index, field, message }]`
 *      and adds code, fix, retryable, and fields. 409 when no database is connected.
 *      If `version` (from the GET the caller started from) is sent and the list has
 *      changed since, answers 409 { code: "stale" } instead of overwriting someone
 *      else's change.
 *
 * Auth is enforced by middleware: dashboard session cookie or MC_TOKEN bearer.
 * The collector calls GET each tick to learn which repos to sweep.
 */
async function current() {
  const { source, repos } = await getWatchedRepos(REPOS);
  return { source, writable: isConfigured(), max: MAX_REPOS, version: listVersion(repos), repos };
}

function repoFields(errors: RepoError[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const row of errors) {
    const key = row.index < 0 ? row.field : `${row.index}.${row.field}`;
    fields[key] = fields[key] ? `${fields[key]} ${row.message}` : row.message;
  }
  return fields;
}

// Log the real error server-side; the response stays generic so database details never reach the browser.
function failure(e: unknown, what: string) {
  return publicError(`[settings/repos] ${what}`, e, `Could not ${what}.`);
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
    const row = { index: -1, field: "repos" as const, message: "Request body must be JSON." };
    return apiError("invalid_json", {
      message: row.message,
      fields: { repos: row.message },
      extra: { errors: [row] },
    });
  }
  const checked = validateRepoList((body as { repos?: unknown } | null)?.repos);
  if (!checked.ok) {
    return apiError("repo_list_invalid", {
      message: checked.errors[0]?.message ?? "The repo list is invalid.",
      fields: repoFields(checked.errors),
      extra: { errors: checked.errors },
    });
  }
  if (!isConfigured()) {
    return apiError("conflict", {
      message: "Settings can only be saved when a database is connected.",
      fix: "Connect a database (DATABASE_URL) and retry the save.",
    });
  }
  try {
    const sent = (body as { version?: unknown } | null)?.version;
    if (typeof sent === "string" && sent !== (await current()).version) {
      return apiError("stale");
    }
    await replaceWatchedRepos(checked.repos);
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "save settings");
  }
}
