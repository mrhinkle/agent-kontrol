import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";
import { apiError, publicError } from "@/lib/api-error";
import { isConfigured } from "@/lib/db";
import { diffRepoList, readDryRun } from "@/lib/dry-run";
import { repoIdentity } from "@/lib/owner-discovery";
import { REPOS } from "@/lib/progress-config";
import { MAX_REPOS, retainedAutoShortErrors, validateRepoList, type RepoError, type RepoInput } from "@/lib/repo-validation";
import { getWatchedRepos, listVersion, loadTrackedRepos, replaceWatchedRepos, setRepoOverride } from "@/lib/watched-repos";

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
 *      else's change. A real save checks that version again under the discovery
 *      write lock, in the same transaction as the replace. `dry_run: true` returns that diff and writes nothing.
 *      Any other `dry_run` value is 400 and also writes nothing.
 *      Rows with origin "auto" are kept when the body omits them. Omitting one
 *      whose fields were overridden resets label, short, color, and blocked
 *      label to the discovery defaults and clears fields_overridden.
 * PATCH /api/settings/repos  { repo, pinned?, hidden?, dry_run? }
 *      Sets the override flags on one stored repo. Takes the same advisory
 *      lock as discovery and repo replacement. Changing a flag changes the
 *      list version. Hide wins over pin when
 *      both are true: the repo stays collected and is left off the brief.
 *      A repo marked gone stays off the brief even when pinned.
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
/**
 * An empty list still means "add at least one repo", unless auto-discovered
 * rows are already stored. Those stay, so the operator can clear every
 * hand-added override without wiping discovery.
 */
async function validateForSave(raw: unknown) {
  if (Array.isArray(raw) && raw.length === 0 && isConfigured()) {
    try {
      const tracked = await loadTrackedRepos();
      if (tracked.some((repo) => repo.origin === "auto")) {
        return { ok: true as const, repos: [] as RepoInput[] };
      }
    } catch {
      // Fall through to the ordinary "at least one repo" error.
    }
  }
  return validateRepoList(raw);
}

/** 400 when a submitted short name belongs to an auto row this save will keep. */
async function rejectRetainedShorts(repos: RepoInput[]): Promise<Response | null> {
  if (!isConfigured() || repos.length === 0) return null;
  try {
    const collisions = retainedAutoShortErrors(repos, await loadTrackedRepos());
    if (collisions.length === 0) return null;
    return apiError("repo_list_invalid", {
      message: collisions[0]?.message ?? "The repo list is invalid.",
      fields: repoFields(collisions),
      extra: { errors: collisions },
    });
  } catch {
    // A store error surfaces on the write. A concurrent unique violation is 409.
    return null;
  }
}

function failure(e: unknown, what: string) {
  return publicError(`[settings/repos] ${what}`, e, `Could not ${what}.`);
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
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
  const rawRepos = (body as { repos?: unknown } | null)?.repos;
  const checked = await validateForSave(rawRepos);
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
  const retained = await rejectRetainedShorts(checked.repos);
  if (retained) return retained;
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
    // A mismatch above is enough for a dry run. A real save checks again
    // under the discovery write lock, after a pin or hide may have landed.
    const saved = await replaceWatchedRepos(checked.repos, typeof sent === "string" ? sent : undefined);
    if (!saved.ok) return apiError("stale");
    return NextResponse.json(await current());
  } catch (e) {
    if (isUniqueViolation(e)) {
      return apiError("conflict", {
        message: "A short name in this list is already used.",
        fix: "Reload the repo list and choose a short name that is not already taken.",
      });
    }
    return failure(e, "save settings");
  }
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function repoNotFound(): Response {
  return apiError("not_found", {
    message: "That repo is not in the watched list.",
    fix: "Discover or add the repo, then set pin or hide.",
  });
}

export async function PATCH(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_json", { message: "Request body must be JSON.", fields: { repo: "Request body must be JSON." } });
  }
  const row = (body ?? {}) as { repo?: unknown; pinned?: unknown; hidden?: unknown; dry_run?: unknown };
  if (typeof row.repo !== "string" || !REPO_RE.test(row.repo.trim()) || row.repo.trim().length > 100) {
    return apiError("validation_failed", {
      message: "Use owner/name, for example acme/docs.",
      fields: { repo: "Use owner/name, for example acme/docs." },
    });
  }
  if (row.pinned === undefined && row.hidden === undefined) {
    return apiError("validation_failed", {
      message: "Send pinned, hidden, or both.",
      fields: { pinned: "Send pinned, hidden, or both." },
    });
  }
  if (row.pinned !== undefined && typeof row.pinned !== "boolean") {
    return apiError("validation_failed", { message: "pinned must be true or false.", fields: { pinned: "pinned must be true or false." } });
  }
  if (row.hidden !== undefined && typeof row.hidden !== "boolean") {
    return apiError("validation_failed", { message: "hidden must be true or false.", fields: { hidden: "hidden must be true or false." } });
  }
  const dry = readDryRun(row.dry_run);
  if (!dry.ok) {
    return apiError("validation_failed", {
      message: "dry_run must be a boolean.",
      fields: { dry_run: "Use true to preview, or false to save." },
    });
  }
  const repo = row.repo.trim();
  const patch = {
    ...(typeof row.pinned === "boolean" ? { pinned: row.pinned } : {}),
    ...(typeof row.hidden === "boolean" ? { hidden: row.hidden } : {}),
  };
  if (!isConfigured()) {
    if (dry.dryRun) {
      const found = REPOS.find((item) => repoIdentity(item.repo) === repoIdentity(repo));
      if (!found) return repoNotFound();
      const before = { pinned: false, hidden: false };
      const after = {
        pinned: patch.pinned ?? before.pinned,
        hidden: patch.hidden ?? before.hidden,
      };
      return NextResponse.json({
        dry_run: true,
        applied: false,
        would_write: false,
        repo,
        before,
        after,
        note: "No database is connected, so a save would be refused and nothing would be written.",
      });
    }
    return apiError("conflict", {
      message: "Settings can only be saved when a database is connected.",
      fix: "Connect a database (DATABASE_URL) and retry the save.",
    });
  }
  try {
    const tracked = await loadTrackedRepos();
    const found = tracked.find((item) => repoIdentity(item.repo) === repoIdentity(repo));
    if (!found) return repoNotFound();
    const after = {
      pinned: patch.pinned ?? found.pinned,
      hidden: patch.hidden ?? found.hidden,
    };
    if (dry.dryRun) {
      return NextResponse.json({
        dry_run: true,
        applied: false,
        would_write: true,
        repo,
        before: { pinned: found.pinned, hidden: found.hidden },
        after,
        note: after.hidden
          ? "Hide wins over pin. The repo stays collected and drops off the brief."
          : after.pinned
            ? "Pin keeps the repo on the brief after it goes quiet. A repo marked gone still stays off."
            : "The repo follows the activity window.",
      });
    }
    // The row can vanish between the read above and the locked update (a concurrent PUT).
    if (!(await setRepoOverride(repo, patch))) return repoNotFound();
    return NextResponse.json(await current());
  } catch (e) {
    return failure(e, "save settings");
  }
}
