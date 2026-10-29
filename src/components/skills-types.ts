/** REST shapes for /api/skills. List `runtimes` is a string array; detail `runtimes` is a boolean map. */

export type Trigger = "off" | "on_request" | "auto_inject" | "scheduled";

export type ScopeMode = "all" | "selected";

export interface SkillScope {
  mode: ScopeMode;
  lanes: string[];
}

export interface SkillLastRun {
  at: string;
  agent: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  version: string | null;
  sha: string;
  runtimes: string[];
  category?: string | null;
  tags?: string[];
  trigger: Trigger;
  scope: SkillScope;
  triggerCount7d: number;
  lastRun: SkillLastRun | null;
  schedule?: string | null;
}

export interface SkillUpstream {
  source: string;
  sha: string | null;
  syncedAt: string | null;
  driftCount: number;
}

export interface SkillsListResponse {
  upstream: SkillUpstream;
  skills: SkillSummary[];
}

export interface RuntimeCompatibility {
  claude: boolean;
  codex: boolean;
  grok: boolean;
  hermes: boolean;
  mini: boolean;
  nemoclaw: boolean;
}

export type TriggerRunStatus = "done" | "stalled" | "running";

export interface SkillTriggerEvent {
  at: string;
  agent: string;
  lane: string | null;
  started: boolean;
  ended: boolean;
  status: TriggerRunStatus;
  outcome?: "done" | "failed" | null;
}

/** Detail payload. `runtimes` replaces the list's string array. Optional URL fields are rendered only when present. */
export interface SkillDetail extends Omit<SkillSummary, "runtimes"> {
  body: string;
  references: { path: string }[];
  runtimes: RuntimeCompatibility;
  triggers: SkillTriggerEvent[];
  sourceUrl?: string | null;
  upstreamUrl?: string | null;
  url?: string | null;
  htmlUrl?: string | null;
}

export interface SkillPatch {
  trigger?: Trigger;
  scope?: SkillScope;
  schedule?: string | null;
}

/** Counts derived from the API's added/changed/removed arrays. */
export interface SkillSyncResult {
  status: "ok" | "failed" | "busy";
  added: number;
  changed: number;
  removed: number;
  errors: string[];
}
