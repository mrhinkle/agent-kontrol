import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { diffRepoList, readDryRun } from "@/lib/dry-run";
import { REPOS } from "@/lib/progress-config";
import { MAX_REPOS, validateRepoList, type RepoError } from "@/lib/repo-validation";
import { getWatchedRepos, listVersion, replaceWatchedRepos } from "@/lib/watched-repos";

export const dynamic = "force-dynamic";

/**
 * The repos the progress board watches.
 *
 * GET  /api/settings/repos
 *      -> { source: "database" | "file", writable, max, version, repos: [...] }
 * PUT  /api/settings/repos  { repos: [...], version?: string, dry_run?: boolean }
 *      Replaces the whole list, in order. 400 keeps `errors: [{ index, field, message }]`
 *      and adds code, fix, retryable, and fields. 409 when no database is connected.
 *      If `version` (from the GET the caller started from) is sent and the list has
 *      changed since, answers 409 { code: "stale" } instead of overwriting someone
 *      else's change. `dry_run: true` returns that diff and writes nothing.
 *      Any other `dry_run` value is 400 and also writes nothing.
 *
 * Auth: dashboard session or MC_TOKEN. An agent credential cannot call this
 * route (it is not in the scope table). The collector uses MC_TOKEN.
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

export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "load settings");
  }
}

export async function PUT(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
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
  const dry = readDryRun((body as { dry_run?: unknown } | null)?.dry_run);
  if (!dry.ok) {
    return apiError("validation_failed", {
      message: "dry_run must be a boolean.",
      fields: { dry_run: "Use true to preview, or false to save." },
    });
  }
  if (!isConfigured()) {
    if (dry.dryRun) {
      try {
        const cur = await current();
        return NextResponse.json(diffRepoList(cur.repos, checked.repos, false));
      } catch (e) {
        return failure(e, "load settings");
      }
    }
    return apiError("conflict", {
      message: "Settings can only be saved when a database is connected.",
      fix: "Connect a database (DATABASE_URL) and retry the save.",
    });
  }
  try {
    const sent = (body as { version?: unknown } | null)?.version;
    const cur = await current();
    if (typeof sent === "string" && sent !== cur.version) {
      return apiError("stale");
    }
    if (dry.dryRun) {
      return NextResponse.json(diffRepoList(cur.repos, checked.repos, true));
    }
    await replaceWatchedRepos(checked.repos);
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "save settings");
  }
}
