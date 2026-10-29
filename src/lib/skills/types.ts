/**
 * Shared types for the skills mirror.
 *
 * A skill runs on the agent. Agent Kontrol stores the instruction text and a
 * start/end row. `sha` is the SHA-256 hex of the SKILL.md bytes, not the git
 * commit. `commit_sha` is the upstream commit the file was copied from.
 */

export const RUNTIMES = ["claude", "codex", "grok", "hermes", "mini"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const TRIGGERS = ["off", "on_request", "auto_inject", "scheduled"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const SYNC_TRIGGERS = ["manual", "scheduled"] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const RUN_STATUSES = ["running", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RuntimeFlags {
  claude: boolean;
  codex: boolean;
  grok: boolean;
  hermes: boolean;
  mini: boolean;
}

export interface SkillScope {
  mode: "all" | "selected";
  lanes: string[];
}

export interface SkillReference {
  path: string;
  content: string;
}

export interface SkillSourceRecord {
  id: string;
  repo: string;
  ref: string | null;
  path_globs: string[];
  label: string;
  enabled: boolean;
  position: number;
}

export interface SkillRecord {
  id: string;
  source_id: string;
  path: string;
  name: string;
  description: string;
  version: string | null;
  sha: string;
  commit_sha: string | null;
  body: string;
  references: SkillReference[];
  runtimes: RuntimeFlags;
  /** Trimmed SKILL.md `category`. Null when the file does not declare one. */
  category: string | null;
  /** Trimmed SKILL.md `tags`. Empty when the file does not declare any. */
  tags: string[];
  frontmatter: Record<string, unknown>;
  removed_at: string | null;
  synced_at: string;
}

export interface SkillSettingsRecord {
  skill_id: string;
  trigger: Trigger;
  /**
   * True when the stored trigger was not one of TRIGGERS.
   * `trigger` is off in that case. Absent on rows that were not read from storage.
   */
  triggerInvalid?: boolean;
  scope: SkillScope;
  schedule: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface SkillRunRecord {
  run_id: string;
  skill_id: string;
  skill_sha: string;
  agent_id: string;
  lane: string | null;
  runtime: string;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  note: string | null;
  actor_type: string | null;
  actor_id: string | null;
}

export interface DriftEntry {
  name: string;
  sha: string;
}

export interface DriftReport {
  host: string;
  dir: string;
  reported_at: string;
  entries: DriftEntry[];
}

export interface UpstreamInfo {
  source: string;
  sha: string | null;
  syncedAt: string | null;
  driftCount: number;
}

export const ALL_RUNTIMES: RuntimeFlags = {
  claude: true,
  codex: true,
  grok: true,
  hermes: true,
  mini: true,
};

export const CLAUDE_ONLY: RuntimeFlags = {
  claude: true,
  codex: false,
  grok: false,
  hermes: false,
  mini: false,
};

export const NO_RUNTIMES: RuntimeFlags = {
  claude: false,
  codex: false,
  grok: false,
  hermes: false,
  mini: false,
};

export function isRuntime(value: string): value is Runtime {
  return (RUNTIMES as readonly string[]).includes(value);
}

export function isTrigger(value: string): value is Trigger {
  return (TRIGGERS as readonly string[]).includes(value);
}

/** Unknown or corrupt stored values are off. They are not treated as on. */
export function triggerFromStored(value: unknown): Trigger {
  return typeof value === "string" && isTrigger(value) ? value : "off";
}

/**
 * A scope we cannot read is selected with no lanes, so it admits no lane.
 * It is not treated as all lanes.
 */
export function scopeFromStored(value: unknown): SkillScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { mode: "selected", lanes: [] };
  }
  const mode = (value as { mode?: unknown }).mode;
  const lanes = (value as { lanes?: unknown }).lanes;
  if (mode === "all") return { mode: "all", lanes: [] };
  if (mode === "selected" && Array.isArray(lanes) && lanes.every((lane) => typeof lane === "string" && lane.length > 0)) {
    return { mode: "selected", lanes: [...lanes] };
  }
  return { mode: "selected", lanes: [] };
}

/**
 * Explicit booleans are kept, including every flag false.
 * A value with no runtime booleans cannot be evaluated and is claude-only.
 */
export function flagsFromStored(value: unknown): RuntimeFlags {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...CLAUDE_ONLY };
  const record = value as Record<string, unknown>;
  const flags = { ...NO_RUNTIMES };
  let seen = false;
  for (const name of RUNTIMES) {
    if (typeof record[name] === "boolean") {
      flags[name] = record[name] as boolean;
      seen = true;
    }
  }
  return seen ? flags : { ...CLAUDE_ONLY };
}

export function runtimeNames(flags: RuntimeFlags): Runtime[] {
  return RUNTIMES.filter((name) => flags[name]);
}

/**
 * Exact match, case-insensitive, after trim.
 * A blank filter matches every skill.
 * The filter `uncategorized` matches a null or blank category, and a category
 * whose text is that word. Any other filter does not match a null category.
 */
export function matchesCategory(category: string | null | undefined, filter: string | null | undefined): boolean {
  if (filter == null) return true;
  const wanted = filter.trim().toLowerCase();
  if (!wanted) return true;
  const stored = (category ?? "").trim().toLowerCase();
  if (wanted === "uncategorized") return stored === "" || stored === "uncategorized";
  return stored === wanted;
}

/** List and pointer text use this name. Same function as `runtimeNames`. */
export const runtimeList = runtimeNames;

export type RuntimeMap = RuntimeFlags;
export type SkillSourceRow = SkillSourceRecord;
export type SettingsRecord = SkillSettingsRecord;
export type RunRecord = SkillRunRecord;

export const DEFAULT_TRIGGER: Trigger = "off";
export const DEFAULT_SCOPE: SkillScope = { mode: "all", lanes: [] };

/** skill_runs.note and the completion argument. Characters, not bytes. */
export const NOTE_MAX = 500;

export function emptyRuntimes(on: boolean): RuntimeFlags {
  return on ? { ...ALL_RUNTIMES } : { ...NO_RUNTIMES };
}

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  version: string | null;
  sha: string;
  /** Compatible runtime names. The detail object uses flags instead. */
  runtimes: Runtime[];
  category: string | null;
  tags: string[];
  trigger: Trigger;
  scope: SkillScope;
  triggerCount7d: number;
  lastRun: { at: string; agent: string } | null;
  /** The newest slot the scheduler queued a task for. Null when the scheduler has not queued one. */
  lastScheduledAt?: string | null;
  /** The next minute the schedule is due, UTC. Null unless trigger is scheduled with a valid cron. */
  nextDueAt?: string | null;
}

export interface SkillTriggerView {
  at: string;
  agent: string;
  lane: string | null;
  started: boolean;
  ended: boolean;
  status: "done" | "stalled" | "running";
  outcome: "done" | "failed" | null;
}

export interface SkillDetail extends Omit<SkillListItem, "runtimes"> {
  demo?: boolean;
  body: string;
  references: { path: string }[];
  /** Flags, not the list array. Callers must not treat these as the same type. */
  runtimes: RuntimeFlags;
  schedule: string | null;
  triggers: SkillTriggerView[];
  warnings?: string[];
}

export interface SyncSkillRef {
  id: string;
  version: string | null;
  sha: string;
}

export interface SyncConflict {
  id: string;
  kept_source: string;
  dropped_source: string;
  path: string;
}

export interface SyncError {
  source: string;
  message: string;
}

export interface SyncResult {
  status: "ok" | "failed" | "busy";
  added: SyncSkillRef[];
  changed: SyncSkillRef[];
  removed: string[];
  conflicts: SyncConflict[];
  errors: SyncError[];
  upstream: UpstreamInfo;
}
