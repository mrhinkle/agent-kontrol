/**
 * The JSON bodies GET /api/settings/repos and GET /api/settings/owners return.
 * MCP get_settings calls these. No SQL of its own.
 */
import { isConfigured } from "./db";
import { MAX_OWNERS } from "./owner-validation";
import { REPOS } from "./progress-config";
import { MAX_REPOS } from "./repo-validation";
import { listWatchedOwners, ownerListVersion } from "./watched-owners";
import { getWatchedRepos, listVersion, type WatchedRepo } from "./watched-repos";

export interface RepoSettingsBody {
  source: "database" | "file";
  writable: boolean;
  max: number;
  version: string;
  repos: WatchedRepo[];
}

export interface OwnerSettingsRow {
  owner: string;
  activity_days: number;
  include_forks: boolean;
  include_archived: boolean;
  last_error: string | null;
  last_error_at: string | null;
  last_discovered_at: string | null;
  actor_type: string | null;
  actor_id: string | null;
}

export interface OwnerSettingsBody {
  writable: boolean;
  max: number;
  version: string;
  owners: OwnerSettingsRow[];
}

/**
 * Rows a replace would overwrite. The file list is what GET shows when nothing
 * is stored. It is not the list the write diffs or versions, except in demo
 * mode, where there is no stored list.
 */
export function reposForReplaceDiff<T>(body: { source: RepoSettingsBody["source"]; repos: T[] }): T[] {
  if (!isConfigured() || body.source === "database") return body.repos;
  return [];
}

export async function readRepoSettings(): Promise<RepoSettingsBody> {
  const loaded = await getWatchedRepos(REPOS);
  return {
    source: loaded.source,
    writable: isConfigured(),
    max: MAX_REPOS,
    version: loaded.storedVersion ?? listVersion(loaded.repos),
    repos: loaded.repos,
  };
}

export async function readOwnerSettings(): Promise<OwnerSettingsBody> {
  const listed = await listWatchedOwners();
  return {
    writable: listed.writable,
    max: MAX_OWNERS,
    version: ownerListVersion(listed.owners),
    owners: listed.owners.map((owner) => ({
      owner: owner.owner,
      activity_days: owner.activityDays,
      include_forks: owner.includeForks,
      include_archived: owner.includeArchived,
      last_error: owner.lastError,
      last_error_at: owner.lastErrorAt,
      last_discovered_at: owner.lastDiscoveredAt,
      actor_type: owner.actorType,
      actor_id: owner.actorId,
    })),
  };
}
