import type { RuntimeCompatibility, SkillPatch, SkillScope, SkillSummary, Trigger } from "./skills-types";

export const TRIGGER_OPTIONS: { value: Trigger; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on_request", label: "On request" },
  { value: "auto_inject", label: "Auto-inject" },
  { value: "scheduled", label: "Scheduled" },
];

export const RUNTIME_FILTERS = ["all", "claude", "codex", "grok", "hermes", "mini", "nemoclaw"] as const;

export const RUNTIME_KEYS = ["claude", "codex", "grok", "hermes", "mini", "nemoclaw"] as const;

const PLATFORM_BY_RUNTIME: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
  grok: "grok",
  hermes: "hermes",
};

const SOURCE_URL_KEYS = ["sourceUrl", "upstreamUrl", "url", "htmlUrl"] as const;

/** True when the only declared runtime is exactly `claude`. */
export function isClaudeOnly(runtimes: readonly string[]): boolean {
  return runtimes.length === 1 && runtimes[0] === "claude";
}

/** Active runtime filter excludes this skill. `all` and blank never exclude. */
export function excludedByRuntime(runtimes: readonly string[], runtime: string): boolean {
  const selected = runtime.trim().toLowerCase();
  if (!selected || selected === "all") return false;
  return !runtimes.some((item) => item.toLowerCase() === selected);
}

/**
 * Flag claude-only skills, and any skill the active runtime filter does not include.
 * The flag stays on the row; the row is not removed.
 */
export function showClaudeOnlyFlag(runtimes: readonly string[], runtime: string): boolean {
  return isClaudeOnly(runtimes) || excludedByRuntime(runtimes, runtime);
}

/** Dim when a non-claude runtime filter is on and this skill is hidden from it. */
export function dimSkillRow(runtimes: readonly string[], runtime: string): boolean {
  const selected = runtime.trim().toLowerCase();
  if (!selected || selected === "all" || selected === "claude") return false;
  return isClaudeOnly(runtimes) || excludedByRuntime(runtimes, runtime);
}

/** Note beside an unchecked Hermes box when the skill runs on Claude and not Hermes. */
export function showHermesClaudeOnlyNote(runtimes: RuntimeCompatibility): boolean {
  return runtimes.claude === true && runtimes.hermes === false;
}

/** Sorted unique lane names declared on any skill. Blank names are dropped. */
export function laneOptions(skills: readonly { scope: { lanes: readonly string[] } }[]): string[] {
  const seen = new Set<string>();
  for (const skill of skills) {
    for (const lane of skill.scope.lanes) {
      const trimmed = lane.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** A cron value can be saved only when it has non-whitespace text. Syntax is not checked here. */
export function isCronNonEmpty(schedule: string | null | undefined): boolean {
  return typeof schedule === "string" && schedule.trim().length > 0;
}

export function applyOptimisticSkillPatch(skills: readonly SkillSummary[], id: string, patch: SkillPatch): SkillSummary[] {
  return skills.map((skill) => {
    if (skill.id !== id) return skill;
    const next: SkillSummary = { ...skill };
    if (patch.trigger !== undefined) next.trigger = patch.trigger;
    if (patch.schedule !== undefined) next.schedule = patch.schedule;
    if (patch.scope !== undefined) next.scope = copyScope(patch.scope);
    return next;
  });
}

export function rollbackSkill(skills: readonly SkillSummary[], previous: SkillSummary): SkillSummary[] {
  let found = false;
  const next = skills.map((skill) => {
    if (skill.id !== previous.id) return skill;
    found = true;
    return previous;
  });
  return found ? next : [...skills];
}

/**
 * Keep rows with an in-flight edit or an unsaved schedule draft. A poll must not
 * replace those with the server copy, and must not drop them if the server omits them.
 */
export function mergePolledSkills(
  current: readonly SkillSummary[],
  incoming: readonly SkillSummary[],
  heldIds: ReadonlySet<string>,
): SkillSummary[] {
  if (heldIds.size === 0) return [...incoming];
  const currentById = new Map(current.map((skill) => [skill.id, skill]));
  const seen = new Set<string>();
  const merged = incoming.map((skill) => {
    seen.add(skill.id);
    if (heldIds.has(skill.id)) return currentById.get(skill.id) ?? skill;
    return skill;
  });
  for (const skill of current) {
    if (heldIds.has(skill.id) && !seen.has(skill.id)) merged.push(skill);
  }
  return merged;
}

export function filterSkills(skills: readonly SkillSummary[], q: string): SkillSummary[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...skills];
  return skills.filter((skill) => {
    return (
      skill.name.toLowerCase().includes(needle) ||
      skill.id.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle)
    );
  });
}

/** `?runtime=&q=` with empty values omitted. `all` is not sent. Runtime comes before q. */
export function skillsQuery(input: { runtime?: string | null; q?: string | null; category?: string | null }): string {
  const params = new URLSearchParams();
  const runtime = (input.runtime ?? "").trim();
  const q = (input.q ?? "").trim();
  if (runtime && runtime.toLowerCase() !== "all") params.set("runtime", runtime);
  if (q) params.set("q", q);
  const category = (input.category ?? "").trim();
  if (category && category.toLowerCase() !== "all") params.set("category", category);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function skillDetailPath(id: string): string {
  return `/skills/${encodeURIComponent(id)}`;
}

export function formatVersion(version: string | null): string {
  if (!version) return "—";
  return version.startsWith("v") || version.startsWith("V") ? version : `v${version}`;
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "—";
}

export function triggerLabel(trigger: Trigger): string {
  return TRIGGER_OPTIONS.find((option) => option.value === trigger)?.label ?? trigger;
}

export function scopeLabel(scope: SkillScope): string {
  if (scope.mode === "all") return "All lanes";
  if (scope.lanes.length === 0) return "Selected lanes";
  return `Selected lanes: ${scope.lanes.join(", ")}`;
}

/** Platform id for PlatformMark, when this runtime matches a known fleet platform. */
export function runtimePlatformId(runtime: string): string | null {
  return PLATFORM_BY_RUNTIME[runtime] ?? null;
}

export function readApiError(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

export function isSkillSummary(value: unknown): value is SkillSummary {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.name !== "string") return false;
  if (!Array.isArray(row.runtimes) || !row.runtimes.every((item) => typeof item === "string")) return false;
  return row.trigger === "off" || row.trigger === "on_request" || row.trigger === "auto_inject" || row.trigger === "scheduled";
}

/** First http(s) URL on the skill, if the payload actually carries one. */
export function skillSourceUrl(skill: object): string | null {
  const record = skill as Record<string, unknown>;
  for (const key of SOURCE_URL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && isHttpUrl(value)) return value;
  }
  return null;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export type ScopeAction =
  | { type: "mode"; mode: SkillScope["mode"] }
  | { type: "toggle"; lane: string }
  | { type: "add"; lane: string };

/**
 * What a scope edit does. The API rejects `selected` with no lanes, so choosing Selected
 * lanes from an all-lanes skill stays local until the first lane is picked, and unchecking
 * the last lane is refused rather than sent or widened to all lanes.
 * - `none`: nothing to do.
 * - `local`: set or clear the unsaved Selected mode; nothing is sent.
 * - `patch`: send this scope.
 * - `last_lane`: refused; tell the operator to keep a lane or choose All lanes.
 */
export type ScopePlan =
  | { kind: "none" }
  | { kind: "local"; selected: boolean }
  | { kind: "patch"; scope: SkillScope }
  | { kind: "last_lane" };

/** The scope the control shows: the saved scope, or an empty Selected draft while one is unsaved. */
export function viewScope(saved: SkillScope, localSelected: boolean): SkillScope {
  if (localSelected && saved.mode === "all") return { mode: "selected", lanes: [] };
  return copyScope(saved);
}

export function planScopeChange(saved: SkillScope, localSelected: boolean, action: ScopeAction): ScopePlan {
  const view = viewScope(saved, localSelected);
  if (action.type === "mode") {
    if (action.mode === view.mode) return { kind: "none" };
    if (action.mode === "all") {
      if (saved.mode === "all") return { kind: "local", selected: false };
      return { kind: "patch", scope: { mode: "all", lanes: [] } };
    }
    if (view.lanes.length > 0) return { kind: "patch", scope: { mode: "selected", lanes: [...view.lanes] } };
    return { kind: "local", selected: true };
  }
  const lane = action.lane.trim();
  if (!lane) return { kind: "none" };
  if (action.type === "add") {
    if (view.lanes.includes(lane)) return { kind: "none" };
    return { kind: "patch", scope: { mode: "selected", lanes: [...view.lanes, lane] } };
  }
  const has = view.lanes.includes(lane);
  const next = has ? view.lanes.filter((item) => item !== lane) : [...view.lanes, lane];
  if (next.length === 0) return { kind: "last_lane" };
  return { kind: "patch", scope: { mode: "selected", lanes: next } };
}

function copyScope(scope: SkillScope): SkillScope {
  return { mode: scope.mode, lanes: [...scope.lanes] };
}

export const UNCATEGORIZED = "uncategorized";

/** Distinct, sorted category labels across skills. A missing or blank category is not listed; the page offers Uncategorized separately. */
export function categoryOptions(skills: readonly { category?: string | null }[]): string[] {
  const seen = new Map<string, string>();
  for (const skill of skills) {
    const label = (skill.category ?? "").trim();
    if (label && label.toLowerCase() !== UNCATEGORIZED && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function categoryLabel(category: string | null | undefined): string {
  const label = (category ?? "").trim();
  return label || "Uncategorized";
}

/** Count the entries of a sync result field that is an array on the wire. */
export function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" ? value : 0;
}

/**
 * Fold a successful PATCH response into the optimistic row. The API answers with the full detail
 * (runtimes as a flag map), so only the settings it owns are taken: trigger, scope, schedule.
 * A body without them (demo mode) leaves the optimistic row as is.
 */
export function reconcileSkill(optimistic: SkillSummary, body: unknown): SkillSummary {
  if (!body || typeof body !== "object") return optimistic;
  const row = body as Record<string, unknown>;
  const trigger = row.trigger;
  if (trigger !== "off" && trigger !== "on_request" && trigger !== "auto_inject" && trigger !== "scheduled") return optimistic;
  const scope = row.scope as { mode?: unknown; lanes?: unknown } | null | undefined;
  const next: SkillSummary = { ...optimistic, trigger, schedule: typeof row.schedule === "string" ? row.schedule : null };
  if (scope && (scope.mode === "all" || scope.mode === "selected") && Array.isArray(scope.lanes)) {
    next.scope = { mode: scope.mode, lanes: scope.lanes.filter((l): l is string => typeof l === "string") };
  }
  return next;
}
