/**
 * Progress board configuration.
 *
 * Adding a repo is ONE entry in progress.config.json - no code changes here.
 * The JSON is validated at module load so a bad entry fails loudly at import
 * time, not silently at render time.
 */
import fileConfig from "../../progress.config.json";

type ProgressConfig = typeof fileConfig;

/** One repo's entry on the progress board. */
export interface RepoConfig {
  /** owner/name as GitHub knows it */
  repo: string;
  /** display name on the card */
  label: string;
  /** short key used in copy and alerts */
  short: string;
  /** accent used for this repo's line on the history graph */
  color: string;
  /** the label this repo uses for 'scoped but waiting on something'; null
   *  means blocked work is not tracked there, which the board says out loud
   *  rather than reporting a comforting 0% */
  blockedLabel: string | null;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function fail(entry: unknown, problem: string): never {
  throw new Error(
    `progress.config.json: ${problem}${
      entry === undefined ? "" : ` (entry: ${JSON.stringify(entry)})`
    }`,
  );
}

function validate(raw: ProgressConfig): void {
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    fail(undefined, "repos must be a non-empty array");
  }
  const seenRepos = new Set<string>();
  const seenShorts = new Set<string>();
  for (const entry of raw.repos) {
    const name =
      typeof entry?.repo === "string" ? entry.repo : JSON.stringify(entry);
    if (typeof entry.repo !== "string" || !REPO_RE.test(entry.repo)) {
      fail(name, "repo must be owner/name (letters, digits, ., -, _)");
    }
    if (typeof entry.label !== "string" || entry.label.length === 0) {
      fail(name, "label must be a non-empty string");
    }
    if (typeof entry.short !== "string" || entry.short.length === 0) {
      fail(name, "short must be a non-empty string");
    }
    if (entry.label.includes("|")) {
      fail(name, 'label must not contain "|" (the collector uses it as a field separator)');
    }
    if (typeof entry.color !== "string" || !COLOR_RE.test(entry.color)) {
      fail(name, "color must be a #rrggbb hex string");
    }
    if (
      entry.blockedLabel !== null &&
      typeof entry.blockedLabel !== "string"
    ) {
      fail(name, "blockedLabel must be a string or null");
    }
    if (typeof entry.blockedLabel === "string" && entry.blockedLabel.includes("|")) {
      fail(name, 'blockedLabel must not contain "|" (the collector uses it as a field separator)');
    }
    if (seenRepos.has(entry.repo)) {
      fail(name, `duplicate repo "${entry.repo}"`);
    }
    if (seenShorts.has(entry.short)) {
      fail(name, `duplicate short "${entry.short}"`);
    }
    seenRepos.add(entry.repo);
    seenShorts.add(entry.short);
  }
  if (typeof raw.laneBotPrefix !== "string") {
    fail(undefined, "laneBotPrefix must be a string");
  }
}

/**
 * The config the board runs on: progress.config.json, with any top-level keys
 * in the override JSON replacing the file's (so `{"repos":[...]}` alone is
 * enough). The override comes from NEXT_PUBLIC_MC_PROGRESS_CONFIG, a build-time
 * variable, because the progress page is a client component. It lets a
 * deployment point the board at its own repos without forking this file.
 */
export function resolveConfig(override: string | undefined): ProgressConfig {
  if (!override || !override.trim()) {
    validate(fileConfig);
    return fileConfig;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(override);
  } catch {
    throw new Error("NEXT_PUBLIC_MC_PROGRESS_CONFIG is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NEXT_PUBLIC_MC_PROGRESS_CONFIG must be a JSON object");
  }
  const merged = { ...fileConfig, ...(parsed as object) } as ProgressConfig;
  validate(merged);
  return merged;
}

const config = resolveConfig(process.env.NEXT_PUBLIC_MC_PROGRESS_CONFIG);

/** The repos the board tracks, in board order. */
export const REPOS: RepoConfig[] = config.repos.map((entry) => ({
  repo: entry.repo,
  label: entry.label,
  short: entry.short,
  color: entry.color,
  blockedLabel: entry.blockedLabel,
}));

/** Look up one repo's config by its owner/name. */
export function repoConfig(repo: string): RepoConfig | undefined {
  return REPOS.find((r) => r.repo === repo);
}

/** Prefix for bot-authored lane branches, from progress.config.json. */
export const LANE_BOT_PREFIX: string = config.laneBotPrefix;

/**
 * Thresholds. Each one is the line past which the board says something out
 * loud in "Needs you" - every number here is a claim you can argue with, which
 * is the point of keeping them in one place.
 */
export const THRESHOLDS = {
  /** open issues carrying the repo's blocked label, as a share of open issues */
  blockedRatio: 0.4,
  /** consecutive daily snapshots with net_backlog > 0 before it's an alert */
  backlogGrowingDays: 3,
  /** an open PR with green checks and no state change for this long is stalled */
  stalledPrHours: 24,
  /** mean review invocations per merged PR */
  reviewRounds: 3.0,
  /** share of review rounds that returned no parseable verdict */
  noVerdictRate: 0.15,
  /** a skill run with no end is stalled after this many minutes, unless AK_SKILL_STALL_MINUTES overrides it */
  skillStallMinutes: 60,
} as const;

export const WINDOWS = ["24h", "7d", "30d", "90d"] as const;
export type TimeWindow = (typeof WINDOWS)[number];

export function windowDays(w: TimeWindow): number {
  return { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[w];
}

export function isWindow(v: string | null): v is TimeWindow {
  return !!v && (WINDOWS as readonly string[]).includes(v);
}

/** Thresholds for `GET /api/brief`. Defaults match `scripts/morning-brief.sh`. */
export interface BriefSettings {
  decisionLabels: string[];
  stuckPrHours: number;
  staleIssueDays: number;
  coordinator: {
    agentId: string | null;
    maxSilenceHours: number;
    /**
     * Exact event kinds that count as work. `heartbeat`, `telemetry`,
     * `turn_start`, `status_update`, and `error` are removed even when
     * configured. `status_update` is not `status`. An `error` is a failure,
     * not completed work.
     */
    workKinds: string[];
  };
  /**
   * Between-brief pushes. `enabled` defaults off: VELOCITY keeps alerts
   * quiet until the owner has cleared the decision backlog once.
   */
  alerts: BriefAlertSettings;
}

/** Thresholds for `GET /api/brief/alerts`. Missing keys keep these defaults. */
export interface BriefAlertSettings {
  /** False sends nothing. Only a boolean true turns delivery on. */
  enabled: boolean;
  /** Coordinator silence re-sends after this many hours while it still holds. */
  coordinatorRepeatHours: number;
  /** Quiet stretch that fires a zero-merge alert. */
  zeroMergeHours: number;
  /** The repo must have merged at least once inside this many days. */
  zeroMergeLookbackDays: number;
  /** An open decision older than this many days fires once. */
  decisionAgeDays: number;
}

export const DEFAULT_BRIEF_ALERTS: BriefAlertSettings = {
  enabled: false,
  coordinatorRepeatHours: 12,
  zeroMergeHours: 72,
  zeroMergeLookbackDays: 7,
  decisionAgeDays: 14,
};

const DEFAULT_WORK_KINDS = ["session_end", "milestone", "status"];

/** Never coordinator work. A configured list cannot put these back. */
const NEVER_WORK_KINDS = new Set(["heartbeat", "telemetry", "turn_start", "status_update", "error"]);

export function filterWorkKinds(kinds: readonly string[]): string[] {
  return kinds.filter((kind) => kind.length > 0 && !NEVER_WORK_KINDS.has(kind));
}

/** Filtered work kinds. An empty result, including an error-only list, is the default three. */
export function resolveWorkKinds(kinds: readonly string[]): string[] {
  const filtered = filterWorkKinds(kinds);
  return filtered.length > 0 ? filtered : [...DEFAULT_WORK_KINDS];
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A missing block, or any `enabled` other than boolean true, stays off. */
export function readBriefAlerts(raw: unknown): BriefAlertSettings {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: row.enabled === true,
    coordinatorRepeatHours: positiveNumber(row.coordinatorRepeatHours, DEFAULT_BRIEF_ALERTS.coordinatorRepeatHours),
    zeroMergeHours: positiveNumber(row.zeroMergeHours, DEFAULT_BRIEF_ALERTS.zeroMergeHours),
    zeroMergeLookbackDays: positiveNumber(row.zeroMergeLookbackDays, DEFAULT_BRIEF_ALERTS.zeroMergeLookbackDays),
    decisionAgeDays: positiveNumber(row.decisionAgeDays, DEFAULT_BRIEF_ALERTS.decisionAgeDays),
  };
}

/** Reads `brief` from the resolved progress config. A missing block keeps the script's defaults. */
export function readBriefSettings(raw: unknown): BriefSettings {
  const root = raw && typeof raw === "object" ? (raw as { brief?: unknown }).brief : undefined;
  const brief = root && typeof root === "object" ? (root as Record<string, unknown>) : {};
  const coord = brief.coordinator && typeof brief.coordinator === "object"
    ? (brief.coordinator as Record<string, unknown>)
    : {};
  const labels = Array.isArray(brief.decisionLabels)
    ? brief.decisionLabels.filter((item): item is string => typeof item === "string")
    : [];
  const agent = coord.agentId;
  const agentId = typeof agent === "string" && agent.trim() ? agent.trim() : null;
  let workKinds: string[] = DEFAULT_WORK_KINDS;
  if (typeof coord.workKinds === "string") {
    workKinds = coord.workKinds.split("|").map((kind) => kind.trim()).filter(Boolean);
  } else if (Array.isArray(coord.workKinds)) {
    workKinds = coord.workKinds.filter((kind): kind is string => typeof kind === "string" && kind.length > 0);
  }
  workKinds = resolveWorkKinds(workKinds);
  return {
    decisionLabels: labels,
    stuckPrHours: finiteNumber(brief.stuckPrHours, 48),
    staleIssueDays: finiteNumber(brief.staleIssueDays, 21),
    coordinator: {
      agentId,
      maxSilenceHours: finiteNumber(coord.maxSilenceHours, 3),
      workKinds,
    },
    alerts: readBriefAlerts(brief.alerts),
  };
}

export function briefConfig(): BriefSettings {
  return readBriefSettings(config);
}
