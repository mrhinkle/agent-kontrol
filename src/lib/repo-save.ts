/**
 * Shared checks for PUT /api/settings/repos and MCP set_watched_repos.
 * Both callers use these so a bad list gets the same errors. No SQL of their own.
 */
import { isConfigured } from "./db";
import { loadTrackedRepos } from "./watched-repos";
import {
  retainedAutoShortErrors,
  validateRepoList,
  type RepoError,
  type RepoInput,
  type RepoValidation,
} from "./repo-validation";

export function repoErrorFields(errors: RepoError[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const row of errors) {
    const key = row.index < 0 ? row.field : `${row.index}.${row.field}`;
    fields[key] = fields[key] ? `${fields[key]} ${row.message}` : row.message;
  }
  return fields;
}

/**
 * An empty list still means "add at least one repo", unless auto-discovered
 * rows are already stored. Those stay, so the operator can clear every
 * hand-added override without wiping discovery.
 */
export async function validateReposForSave(raw: unknown): Promise<RepoValidation> {
  if (Array.isArray(raw) && raw.length === 0 && isConfigured()) {
    try {
      const tracked = await loadTrackedRepos();
      if (tracked.some((repo) => repo.origin === "auto")) {
        return { ok: true, repos: [] as RepoInput[] };
      }
    } catch {
      // Fall through to the ordinary "at least one repo" error.
    }
  }
  return validateRepoList(raw);
}

/**
 * Short names of auto rows this save will keep. Null when there is no
 * collision, or when the store cannot be read (the write then surfaces it).
 */
export async function retainedAutoShortErrorsForSave(repos: RepoInput[]): Promise<RepoError[] | null> {
  if (!isConfigured() || repos.length === 0) return null;
  try {
    const collisions = retainedAutoShortErrors(repos, await loadTrackedRepos());
    return collisions.length === 0 ? null : collisions;
  } catch {
    return null;
  }
}
