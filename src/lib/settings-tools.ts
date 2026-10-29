/**
 * MCP get_settings and set_watched_repos.
 * Reads and writes go through the settings store functions. No SQL here.
 */
import { currentActor } from "./actor";
import { withReceipt } from "./activity";
import { mcpToolError, type McpToolResult } from "./api-error";
import { isConfigured } from "./db";
import { diffRepoList, readDryRun, type DryRunChange, type DryRunResult } from "./dry-run";
import { repoErrorFields, retainedAutoShortErrorsForSave, validateReposForSave } from "./repo-save";
import type { RepoError } from "./repo-validation";
import { readOwnerSettings, readRepoSettings } from "./settings-read";
import { recordToolReceipt } from "./store";
import { replaceWatchedRepos } from "./watched-repos";

function repoInvalid(errors: RepoError[]): McpToolResult {
  return mcpToolError("repo_list_invalid", {
    message: errors[0]?.message ?? "The repo list is invalid.",
    fields: repoErrorFields(errors),
    extra: { errors },
  });
}

function dryRunRejected(): McpToolResult {
  return mcpToolError("validation_failed", {
    message: "dry_run must be a boolean.",
    fields: { dry_run: "Use true to preview, or false to save." },
  });
}

function missingVersion(): McpToolResult {
  return mcpToolError("validation_failed", {
    message: "expected_version is required unless dry_run is true.",
    fields: { expected_version: "Send the version from get_settings." },
  });
}

function noDatabase(): McpToolResult {
  return mcpToolError("conflict", {
    message: "Settings can only be saved when a database is connected.",
    fix: "Connect a database (DATABASE_URL) and retry the save.",
  });
}

function uniqueConflict(): McpToolResult {
  return mcpToolError("conflict", {
    message: "A short name in this list is already used.",
    fix: "Reload the repo list and choose a short name that is not already taken.",
  });
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}

function repoName(change: DryRunChange): string {
  const row = change.after ?? change.before;
  const name = row && typeof row.repo === "string" ? row.repo : "";
  return name || change.summary;
}

/** REST diff plus the current list version and the three repo groups. */
export function repoDiffPreview(diff: DryRunResult, version: string) {
  return {
    ...diff,
    version,
    added: diff.changes.filter((change) => change.op === "add").map(repoName),
    removed: diff.changes.filter((change) => change.op === "remove").map(repoName),
    changed: diff.changes.filter((change) => change.op === "update" || change.op === "reorder").map(repoName),
  };
}

function preview(diff: DryRunResult, version: string): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(repoDiffPreview(diff, version)) }] };
}

export async function getSettingsTool(): Promise<McpToolResult> {
  const repos = await readRepoSettings();
  const owners = await readOwnerSettings();
  return { content: [{ type: "text", text: JSON.stringify({ repos, owners }) }] };
}

/**
 * Same validation and replace as PUT /api/settings/repos.
 * A real write requires expected_version. dry_run does not.
 * A mismatch is the REST stale error and writes nothing.
 * Only a successful replace records a receipt.
 */
export async function setWatchedReposTool(args: {
  repos?: unknown;
  expected_version?: unknown;
  dry_run?: unknown;
}): Promise<McpToolResult> {
  const checked = await validateReposForSave(args.repos);
  if (!checked.ok) return repoInvalid(checked.errors);
  const dry = readDryRun(args.dry_run);
  if (!dry.ok) return dryRunRejected();
  const collisions = await retainedAutoShortErrorsForSave(checked.repos);
  if (collisions) return repoInvalid(collisions);
  if (!dry.dryRun && typeof args.expected_version !== "string") return missingVersion();
  if (!isConfigured()) {
    if (dry.dryRun) {
      const cur = await readRepoSettings();
      return preview(diffRepoList(cur.repos, checked.repos, false), cur.version);
    }
    return noDatabase();
  }
  const cur = await readRepoSettings();
  const sent = typeof args.expected_version === "string" ? args.expected_version : undefined;
  if (sent !== undefined && sent !== cur.version) return mcpToolError("stale");
  if (dry.dryRun) return preview(diffRepoList(cur.repos, checked.repos, true), cur.version);
  try {
    const saved = await replaceWatchedRepos(checked.repos, sent);
    if (!saved.ok) return mcpToolError("stale");
  } catch (e) {
    if (isUniqueViolation(e)) return uniqueConflict();
    throw e;
  }
  const body = await readRepoSettings();
  const actor = currentActor();
  const text = actor
    ? `Watched repos saved. actor_type=${actor.actor_type} actor_id=${actor.actor_id}.\n${JSON.stringify(body)}`
    : `Watched repos saved.\n${JSON.stringify(body)}`;
  const receipt = await recordToolReceipt({
    kind: "set_watched_repos",
    title: "Watched repos replaced",
    extra: { version: body.version },
  });
  return withReceipt(text, receipt);
}
