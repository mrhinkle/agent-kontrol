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

export async function readRepoSettings(): Promise<RepoSettingsBody> {
  const { source, repos } = await getWatchedRepos(REPOS);
  return { source, writable: isConfigured(), max: MAX_REPOS, version: listVersion(repos), repos };
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
