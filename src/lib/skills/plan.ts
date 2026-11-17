import { skillSha } from "./sha";
import type { RuntimeFlags, SkillRecord, SkillReference } from "./types";
import type { AssembledSkill, PreservedSkill } from "./assemble";

export interface SyncConflict {
  id: string;
  winner: { source_id: string; path: string };
  loser: { source_id: string; path: string };
}

export interface SyncPlan {
  upserts: AssembledSkill[];
  unchanged: string[];
  removals: { id: string; source_id: string }[];
  conflicts: SyncConflict[];
  /** A lower-priority source tried to replace a row whose source we could not re-read. */
  kept: { id: string; source_id: string; blocked_by: string; path: string }[];
}

/**
 * Decide the mirror write from one sync.
 * The first source by position owns an id. A source that failed to fetch
 * keeps its rows: those ids are not removals and are not given to a later source.
 */
export function planSync(input: {
  failedSourceIds: readonly string[];
  successfulSourceIds: readonly string[];
  existing: SkillRecord[];
  candidates: AssembledSkill[];
  preserved: PreservedSkill[];
}): SyncPlan {
  const failed = new Set(input.failedSourceIds);
  const successful = new Set(input.successfulSourceIds);
  const existingById = new Map(input.existing.map((row) => [row.id, row]));
  const sorted = [...input.candidates].sort((a, b) => a.position - b.position || a.path.localeCompare(b.path) || a.source_id.localeCompare(b.source_id));
  const winners = new Map<string, AssembledSkill>();
  const conflicts: SyncConflict[] = [];
  const kept: SyncPlan["kept"] = [];

  const preservedById = new Map<string, PreservedSkill>();
  for (const item of [...input.preserved].sort((a, b) => a.position - b.position)) {
    if (!preservedById.has(item.id)) preservedById.set(item.id, item);
  }

  for (const candidate of sorted) {
    const owned = existingById.get(candidate.id);
    if (
      owned &&
      owned.removed_at == null &&
      failed.has(owned.source_id) &&
      owned.source_id !== candidate.source_id
    ) {
      kept.push({
        id: candidate.id,
        source_id: candidate.source_id,
        blocked_by: owned.source_id,
        path: candidate.path,
      });
      continue;
    }
    const blocked = preservedById.get(candidate.id);
    if (blocked && blocked.position < candidate.position && blocked.source_id !== candidate.source_id) {
      kept.push({
        id: candidate.id,
        source_id: candidate.source_id,
        blocked_by: blocked.source_id,
        path: candidate.path,
      });
      continue;
    }
    const prior = winners.get(candidate.id);
    if (prior) {
      conflicts.push({
        id: candidate.id,
        winner: { source_id: prior.source_id, path: prior.path },
        loser: { source_id: candidate.source_id, path: candidate.path },
      });
      continue;
    }
    winners.set(candidate.id, candidate);
  }

  const upserts: AssembledSkill[] = [];
  const unchanged: string[] = [];
  for (const winner of winners.values()) {
    const owned = existingById.get(winner.id);
    if (!owned || owned.removed_at || fingerprint(owned) !== fingerprint(winner)) upserts.push(winner);
    else unchanged.push(winner.id);
  }

  const removals: { id: string; source_id: string }[] = [];
  for (const owned of input.existing) {
    if (owned.removed_at) continue;
    if (!successful.has(owned.source_id)) continue;
    if (failed.has(owned.source_id)) continue;
    if (preservedById.has(owned.id) && preservedById.get(owned.id)?.source_id === owned.source_id) continue;
    if (winners.has(owned.id)) continue;
    removals.push({ id: owned.id, source_id: owned.source_id });
  }

  return { upserts, unchanged, removals, conflicts, kept };
}

export function fingerprint(skill: {
  source_id: string;
  path: string;
  name: string;
  description: string;
  version: string | null;
  sha: string;
  body: string;
  references: SkillReference[];
  runtimes: RuntimeFlags;
  category?: string | null;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}): string {
  const refs = [...skill.references]
    .map((ref) => ({ path: ref.path, sha: skillSha(ref.content) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return skillSha(canonicalJson({
    source_id: skill.source_id,
    path: skill.path,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    sha: skill.sha,
    body: skill.body,
    refs,
    runtimes: skill.runtimes,
    category: skill.category ?? null,
    tags: skill.tags ?? [],
    frontmatter: skill.frontmatter ?? {},
  }));
}

/**
 * JSON with object keys sorted at every depth. Postgres jsonb does not keep
 * key order, so a stored frontmatter map reads back reordered. Array order,
 * scalar types and null are kept as JSON.stringify writes them.
 */
function canonicalJson(value: unknown): string {
  const json = value != null && typeof (value as { toJSON?: unknown }).toJSON === "function"
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (Array.isArray(json)) return `[${json.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (json !== null && typeof json === "object") {
    const record = json as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(json) ?? "null";
}
